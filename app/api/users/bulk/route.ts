import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import {
  runBulkImport, str, isUniqueConstraintError, isTransactionTimeoutError, lastErrorLine,
  type MatchKeyDef,
} from '@/lib/import/bulk-import-engine'
import { VALID_ROLES, validateNewUser, hashNewPassword, insertUserAccount } from '@/lib/user-account'

/**
 * POST /api/users/bulk —— 批量导入员工账号(CSV，20261006)
 * ============================================================================
 * body: { rows: [{ name*, email*, roles*, password*, managerEmail? }], rowOffset? }
 * 走全站统一的 lib/import/bulk-import-engine.ts(逐行事务、单行失败不影响其它行、分批提交)。
 *
 * ⛔ 只新建、不修改(同 uoms/bulk 的 create-only 写法：matchKeys 为空，按"名字"判重)——
 * 这里的"名字"就是邮箱(User.email 唯一)，邮箱已存在的行进 skipped，绝不改动已有账号。
 * 改角色/停用这类权限变化走列表行上的「权限」入口或批量操作，不开放"用一张表格成批改
 * 别人权限"这条路。
 *
 * - roles 只认角色代码(OPERATOR / SALES / DRIVER …，多个用 ; 分隔，区分大小写)，
 *   不认界面上的显示名：界面上 OPERATOR 显示成 "Sales"，而 SALES 是另一个角色
 *   "Sales Assistant"，大小写不敏感或按显示名匹配会把两者搞混、给错权限。
 *   RESTAURANT 不允许——餐馆账号要跟客户档案绑定，走餐馆 tab 和注册审核流程。
 * - 校验/建号/挂角色跟单个建号 POST /api/users 是同一份逻辑(lib/user-account.ts)；
 *   初始密码过同一套强度校验，并且强制首次登录改密——密码在表格里明文流转过。
 * - managerEmail(上级邮箱)可选，找不到就不设上级并给出提示，不拦整行。
 */

const MAX_ROWS_PER_REQUEST = 100
const STAFF_ROLES: readonly string[] = VALID_ROLES.filter(r => r !== 'RESTAURANT')

/** 行内容本身不合格(角色/密码)——整行不导入，原因原样给用户看 */
class RowRejected extends Error {}

interface ResolvedRow {
  rowLabel: string
  /** 引擎按它判重 —— 用邮箱(小写)，不是姓名：同名的人很正常，同邮箱才是同一个账号 */
  name: string
  displayName: string
  email: string
  roles: string[]
  password?: string
  managerEmail?: string
}

/** 角色代码原样匹配(区分大小写)，不做 toUpperCase，理由见文件头注释 */
function parseRoles(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  return [...new Set(raw.split(/[;,|]/).map(s => s.trim()).filter(Boolean))]
}

export async function POST(req: Request) {
  return withAuth(req, async (me) => {
    try {
      const data = await req.json()
      const rawRows = Array.isArray(data.rows) ? data.rows : []
      if (rawRows.length === 0) return NextResponse.json({ error: 'rows 不能为空' }, { status: 400 })
      if (rawRows.length > MAX_ROWS_PER_REQUEST) {
        return NextResponse.json({ error: `单次请求最多 ${MAX_ROWS_PER_REQUEST} 行(导入弹窗会自动分批提交)` }, { status: 400 })
      }
      const rowOffset = Number.isInteger(data.rowOffset) && data.rowOffset >= 0 ? data.rowOffset as number : 0

      const matchKeys: MatchKeyDef<ResolvedRow>[] = [] // create-only，见上方说明

      const result = await runBulkImport<Record<string, unknown>, ResolvedRow, { name: string; roles: string[] }>({
        rawRows,
        rowOffset,
        matchKeys,

        resolveRow(r, rowNo, warn) {
          const email = str(r.email, 200)?.toLowerCase()
          const displayName = str(r.name, 100)
          if (!email) { warn(`Row ${rowNo}${displayName ? ` (${displayName})` : ''}: missing required 'email', skipped`); return null }
          if (!displayName) { warn(`Row ${rowNo} (${email}): missing required 'name', skipped`); return null }
          return {
            rowLabel: `Row ${rowNo} (${email})`,
            name: email,
            displayName,
            email,
            roles: parseRoles(r.roles),
            password: r.password === undefined || r.password === null ? undefined : String(r.password),
            managerEmail: str(r.managerEmail, 200)?.toLowerCase(),
          }
        },

        async findMatchCandidates() {
          return [] // 无匹配键，恒落回按邮箱判重
        },

        async findExistingNames() {
          const existing = await prisma.user.findMany({ select: { email: true } })
          return new Set(existing.map(u => u.email.toLowerCase()))
        },

        async writeRow(tx, row) {
          if (row.roles.length === 0) throw new RowRejected('roles is required (role codes, e.g. OPERATOR; SALES)')
          const bad = row.roles.filter(x => !STAFF_ROLES.includes(x))
          if (bad.length > 0) {
            throw new RowRejected(`unknown or not allowed role code(s): ${bad.join(', ')} — use the exact upper-case codes listed in the import dialog (e.g. OPERATOR, SALES)`)
          }
          const v = validateNewUser(
            { name: row.displayName, email: row.email, password: row.password, roles: row.roles },
            { allowedRoles: STAFF_ROLES },
          )
          if (!v.ok) throw new RowRejected(v.error)

          let managerId: string | null = null
          let warning: string | undefined
          if (row.managerEmail) {
            const manager = await tx.user.findUnique({ where: { email: row.managerEmail }, select: { id: true } })
            if (manager) managerId = manager.id
            // 引擎只在本行事务提交成功后才收这条提示，跳过/失败的行不会说"建了但没设上级"
            else warning = `${row.rowLabel}: manager '${row.managerEmail}' not found, created without a manager`
          }

          const passwordHash = await hashNewPassword(v.value.password)
          const created = await insertUserAccount(tx, v.value, passwordHash, { mustChangePassword: true, managerId })
          return { id: created.id, warning, data: { name: created.name, roles: v.value.roles } }
        },

        describeRowError(e, row) {
          if (e instanceof RowRejected) return e.message
          if (isUniqueConstraintError(e)) return `email '${row.email}' is already used by another account, row not imported`
          if (isTransactionTimeoutError(e)) return 'database timed out, row not imported — please re-import this row'
          return lastErrorLine(e)
        },

        // 跟单个建号一样，每个新账号单独留一条审计记录(引擎另写一条整批汇总)
        async onRowCommitted(_row, _existingId, outcome) {
          await writeLog({
            userId: me.userId, userEmail: me.email, userName: me.name,
            action: 'CREATE', resource: 'user', resourceId: outcome.id,
            detail: `批量导入创建用户 ${outcome.data?.name ?? ''}（${outcome.data?.roles.join('+') ?? ''}）`,
          })
        },

        auditLog: { userId: me.userId, userEmail: me.email, userName: me.name, resource: 'user', resourceLabel: '用户' },
      })

      return NextResponse.json(result)
    } catch (error) {
      console.error('[POST /api/users/bulk]', error)
      return NextResponse.json({ error: '批量导入用户失败' }, { status: 500 })
    }
  }, { require: 'system.user.manage' })
}
