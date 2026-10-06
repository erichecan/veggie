import bcrypt from 'bcryptjs'
import type { Prisma } from './generated/prisma/client'
import { prisma } from './db'
import { assessNewPassword } from './password-policy'

/**
 * 新建用户账号的校验 + 落库 —— 从 POST /api/users 抽出(20261006)，供该路由与批量导入
 * POST /api/users/bulk 共用。这里出过"两份白名单各自漂移"的事故(VALID_ROLES 当年少了
 * EXTERNAL_SALES/DISPATCH/OTHER，管理员建不出外部销售账号)，所以只留一份。
 *
 * 拆成三层：validateNewUser(纯校验，不碰库) / insertUserAccount(在调用方给的事务里建号 +
 * 挂角色) / createUserAccount(单个建号的完整流程)。批量导入走 lib/import/bulk-import-engine.ts，
 * 引擎自己开每行的事务，所以用前两层，不能再套一层 createUserAccount 的事务。
 */

/** ⛔ 与 prisma enum Role 一致，加角色时这里必须同步 */
export const VALID_ROLES = [
  'OPERATOR', 'RESTAURANT', 'PICKER', 'SORTER', 'DRIVER', 'BOSS', 'FINANCE',
  'WAREHOUSE', 'SALES', 'EXTERNAL_SALES', 'DISPATCH', 'OTHER',
] as const

/** 建号 + 挂角色是一个事务：Neon 上每条查询都是网络往返，给足余量(默认 5 秒) */
const CREATE_TX_TIMEOUT_MS = 15_000

export interface CreateUserInput {
  name?: unknown
  email?: unknown
  password?: unknown
  /** 单角色(旧客户端)；与 roles[] 至少给一个，role 作为主角色 */
  role?: unknown
  roles?: unknown
}

export interface CreateUserOptions {
  /** 只允许这些角色(批量导入员工时排除 RESTAURANT)；不传 = VALID_ROLES 全部 */
  allowedRoles?: readonly string[]
  /** 首次登录必须改密(批量导入建的号：初始密码写在表格里流转过，不能一直用) */
  mustChangePassword?: boolean
  managerId?: string | null
}

export interface ValidNewUser {
  name: string
  email: string
  password: string
  primaryRole: string
  roles: string[]
}

export interface CreatedUser {
  id: string
  userNo: number
  email: string
  name: string
  role: string
  roles: string[]
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

/** 纯校验 + 归一化，不碰数据库(邮箱是否已存在由调用方判断) */
export function validateNewUser(
  input: CreateUserInput,
  options: Pick<CreateUserOptions, 'allowedRoles'> = {},
): { ok: true; value: ValidNewUser } | { ok: false; error: string } {
  const name = typeof input.name === 'string' || typeof input.name === 'number' ? String(input.name).trim() : ''
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
  const password = input.password === undefined || input.password === null ? '' : String(input.password)

  if (!name) return { ok: false, error: '姓名不能为空' }
  if (!email) return { ok: false, error: '邮箱不能为空' }
  // 建号时设的初始密码同样要过强度校验 —— 生产上那 42 个 `test123` 就是
  // 从这条路进来的。这里不校验，等于给弱口令留了唯一一个还开着的入口。
  if (!password) return { ok: false, error: '密码不能为空' }
  const pwVerdict = assessNewPassword(password, { email, name })
  if (!pwVerdict.ok) return { ok: false, error: pwVerdict.reason ?? '密码不符合要求' }

  // 入参可以传 role (单角色，旧客户端) 或 roles[] (新多角色)，至少有一个。
  // role 当作主角色；roles[] 至少包含 role。
  let primaryRole = typeof input.role === 'string' && input.role ? input.role : undefined
  let roles: string[] = Array.isArray(input.roles) ? input.roles.map(String) : []
  if (!primaryRole && roles.length > 0) primaryRole = roles[0]
  if (primaryRole && !roles.includes(primaryRole)) roles = [primaryRole, ...roles]
  if (!primaryRole) return { ok: false, error: '必须指定 role 或 roles' }
  const allowed: readonly string[] = options.allowedRoles ?? VALID_ROLES
  const invalid = roles.find(r => !allowed.includes(r))
  if (invalid) return { ok: false, error: `无效角色: ${invalid}` }

  return { ok: true, value: { name: name.slice(0, 100), email: email.slice(0, 200), password, primaryRole, roles } }
}

/** bcrypt 故意慢(~250ms)；单个建号时放在事务外，免得占着事务连接 */
export function hashNewPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12)
}

/** 在调用方的事务里建号 + 挂角色，两者同进同退，不会出现"号建了、角色没挂上"的半成品 */
export async function insertUserAccount(
  tx: Prisma.TransactionClient,
  value: ValidNewUser,
  passwordHash: string,
  options: Pick<CreateUserOptions, 'mustChangePassword' | 'managerId'> = {},
): Promise<CreatedUser> {
  const created = await tx.user.create({
    data: {
      name: value.name,
      email: value.email,
      passwordHash,
      role: value.primaryRole as never,
      roles: value.roles,
      isActive: true,
      mustChangePassword: options.mustChangePassword === true,
      managerId: options.managerId ?? null,
    },
    select: { id: true, userNo: true, email: true, name: true, role: true, roles: true, isActive: true, createdAt: true, updatedAt: true },
  })
  // ⛔ 必须建 UserRoleLink：权限判定的真相是它，不是 role/roles[]。
  // 漏了的话新账号登录后权限集为空 —— 人建出来了，却什么都点不动。
  const appRoles = await tx.appRole.findMany({
    where: { code: { in: value.roles.map((r) => r.toLowerCase()) } },
    select: { id: true },
  })
  if (appRoles.length > 0) {
    await tx.userRoleLink.createMany({
      data: appRoles.map((r) => ({ userId: created.id, roleId: r.id })),
      skipDuplicates: true,
    })
  }
  return { ...created, role: String(created.role) }
}

export type CreateUserResult =
  | { ok: true; user: CreatedUser; roles: string[] }
  | { ok: false; status: 400 | 409; error: string }

/** 单个建号的完整流程(POST /api/users) */
export async function createUserAccount(input: CreateUserInput, options: CreateUserOptions = {}): Promise<CreateUserResult> {
  const v = validateNewUser(input, options)
  if (!v.ok) return { ok: false, status: 400, error: v.error }

  const existing = await prisma.user.findUnique({ where: { email: v.value.email }, select: { id: true } })
  if (existing) return { ok: false, status: 409, error: '该邮箱已被注册' }

  const passwordHash = await hashNewPassword(v.value.password)
  const user = await prisma.$transaction(
    (tx) => insertUserAccount(tx, v.value, passwordHash, options),
    { timeout: CREATE_TX_TIMEOUT_MS },
  )
  return { ok: true, user, roles: v.value.roles }
}
