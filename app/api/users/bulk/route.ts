import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { createUserAccount, VALID_ROLES } from '@/lib/user-account'

/**
 * POST /api/users/bulk —— 批量导入员工账号(CSV，20261006)
 * ============================================================================
 * body: { rows: [{ name*, email*, roles*, password*, managerEmail? }], rowOffset? }
 *
 * 只新建、不修改：邮箱已存在的行直接跳过，不会改动已有账号。改角色/停用这类权限
 * 变化走列表行上的「权限」入口或批量操作——不开放"用一张表格成批改别人权限"这条路。
 *
 * - roles 只认角色代码(OPERATOR / SALES / DRIVER …，多个用 ; 分隔，区分大小写)，
 *   不认界面上的显示名：界面上 OPERATOR 显示成 "Sales"，而 SALES 是另一个角色
 *   "Sales Assistant"，按显示名匹配会把两者搞混、给错权限。RESTAURANT 不允许——
 *   餐馆账号要跟客户档案绑定，走餐馆 tab 和注册审核流程。
 * - 初始密码过与手工建号同一套强度校验(assessNewPassword)，并且强制首次登录改密：
 *   密码在表格里明文流转过，不能让它一直有效。
 * - managerEmail(上级邮箱)可选，找不到就不设上级并给出提示，不拦整行。
 * - 逐行处理，单行失败只记进 failed[]，不影响其它行；校验与落库跟 POST /api/users
 *   是同一份逻辑(lib/user-account.ts)。
 *
 * bcrypt 每个密码约 250ms，单次请求最多 MAX_ROWS_PER_REQUEST 行；导入弹窗会自动
 * 按更小的批次分批提交，并用 rowOffset 让 "Row N" 按整个文件计数。
 */

const MAX_ROWS_PER_REQUEST = 100
const STAFF_ROLES = VALID_ROLES.filter(r => r !== 'RESTAURANT')

/**
 * 角色代码必须原样匹配(区分大小写)，不做 toUpperCase：界面上 OPERATOR 的英文显示名就是
 * "Sales"，大小写不敏感的话有人照着界面填 "Sales" 会被当成 SALES(销售助理)，悄悄给错权限。
 * 导出文件里的角色代码本来就是大写原样，直接回填不受影响。
 */
function parseRoles(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  return [...new Set(raw.split(/[;,|]/).map(s => s.trim()).filter(Boolean))]
}

export async function POST(req: Request) {
  return withAuth(req, async (me) => {
    try {
      const data = await req.json()
      const rawRows: Record<string, unknown>[] = Array.isArray(data.rows) ? data.rows : []
      if (rawRows.length === 0) return NextResponse.json({ error: 'rows 不能为空' }, { status: 400 })
      if (rawRows.length > MAX_ROWS_PER_REQUEST) {
        return NextResponse.json({ error: `单次请求最多 ${MAX_ROWS_PER_REQUEST} 行(导入弹窗会自动分批提交)` }, { status: 400 })
      }
      const rowOffset = Number.isInteger(data.rowOffset) && data.rowOffset >= 0 ? data.rowOffset as number : 0

      let created = 0
      const skipped: string[] = []
      const failed: string[] = []
      const warnings: string[] = []

      for (let i = 0; i < rawRows.length; i++) {
        const r = rawRows[i]
        const email = typeof r.email === 'string' ? r.email.trim().toLowerCase() : ''
        const label = `Row ${rowOffset + i + 1} (${email || String(r.name ?? '').trim() || '?'})`
        try {
          const roles = parseRoles(r.roles)
          if (roles.length === 0) { failed.push(`${label}: roles is required (role codes, e.g. OPERATOR; SALES)`); continue }
          const bad = roles.filter(x => !STAFF_ROLES.includes(x as typeof STAFF_ROLES[number]))
          if (bad.length > 0) {
            failed.push(`${label}: unknown or not allowed role code(s): ${bad.join(', ')} — use the exact upper-case codes listed in the import dialog (e.g. OPERATOR, SALES)`)
            continue
          }

          let managerId: string | null = null
          let managerMissing = false
          const managerEmail = typeof r.managerEmail === 'string' ? r.managerEmail.trim().toLowerCase() : ''
          if (managerEmail) {
            const manager = await prisma.user.findUnique({ where: { email: managerEmail }, select: { id: true } })
            if (manager) managerId = manager.id
            else managerMissing = true
          }

          const result = await createUserAccount(
            { name: r.name, email, password: r.password, roles },
            { allowedRoles: STAFF_ROLES, mustChangePassword: true, managerId },
          )
          if (!result.ok) {
            if (result.status === 409) skipped.push(`${email} (already exists)`)
            else failed.push(`${label}: ${result.error}`)
            continue
          }
          created++
          // 只在真的建了号时才提示——邮箱已存在被跳过的行，说"建了但没设上级"是假话
          if (managerMissing) warnings.push(`${label}: manager '${managerEmail}' not found, created without a manager`)
          await writeLog({
            userId: me.userId, userEmail: me.email, userName: me.name,
            action: 'CREATE', resource: 'user', resourceId: result.user.id,
            detail: `批量导入创建用户 ${result.user.name}（${result.roles.join('+')}）`,
          })
        } catch (e) {
          console.error(`[POST /api/users/bulk] ${label}`, e)
          const msg = e instanceof Error ? e.message : String(e)
          failed.push(`${label}: ${(msg.split('\n').map(l => l.trim()).filter(Boolean).pop() ?? 'unknown error').slice(0, 200)}`)
        }
      }

      await writeLog({
        userId: me.userId, userEmail: me.email, userName: me.name,
        action: 'CREATE', resource: 'user', resourceId: 'bulk',
        detail: `批量导入用户：新建 ${created}，已存在跳过 ${skipped.length}，失败 ${failed.length}`,
      })

      return NextResponse.json({ created, skipped, failed, warnings })
    } catch (error) {
      console.error('[POST /api/users/bulk]', error)
      return NextResponse.json({ error: '批量导入用户失败' }, { status: 500 })
    }
  }, { require: 'system.user.manage' })
}
