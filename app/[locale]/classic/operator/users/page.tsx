'use client'
/**
 * 权限中心 —— 用户 / 角色 / 权限总览三 tab。
 *
 * 角色与权限总览两个 tab 要 `system.rbac.read`，没有这个权限的人只看得到用户 tab，
 * 不是把 tab 显示出来再让他点了吃 403。
 */
import { useCallback, useEffect, useState } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import type { SystemUser } from '@/lib/types'
import { hasPermission, useAbility } from '@/lib/permissions'
import UsersTab from './users-tab'
import RolesTab from './roles-tab'
import MatrixTab from './matrix-tab'
import { fetchCatalog, fetchRoles, type PermissionCatalog, type RoleRow } from './rbac-client'

const PURPLE = '#875A7B'

type TabKey = 'users' | 'roles' | 'matrix'

/**
 * 旧登录态没有权限位图（`pm`），`hasPermission` 一律返回 false，权限 tab 会整个消失 ——
 * 表现是「管理员打不开权限配置」。所以位图缺失时按旧口径回退。
 * ⛔ 这只是前端显隐，接口那一层照样会拦。全部旧 token 过期后（部署日 + 7 天）可以删掉，
 *    与 `lib/rbac/legacy-roles.ts` 一起。
 */
const LEGACY_RBAC_ROLES = ['BOSS', 'OPERATOR']

export default function PermissionCenterPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const ability = useAbility()

  const hasBitmap = Boolean(ability.pm)
  const legacyRoles = ability.roles && ability.roles.length > 0
    ? ability.roles
    : (ability.role ? [ability.role] : [])
  const legacyFallback = !hasBitmap && legacyRoles.some((r) => LEGACY_RBAC_ROLES.includes(String(r)))

  const canSeeRbac = hasPermission(ability, 'system.rbac.read') || legacyFallback
  const canManageRbac = hasPermission(ability, 'system.rbac.manage') || legacyFallback

  const [tab, setTab] = useState<TabKey>('users')
  const [users, setUsers] = useState<SystemUser[]>([])
  const [usersLoading, setUsersLoading] = useState(false)
  const [roles, setRoles] = useState<RoleRow[]>([])
  const [catalog, setCatalog] = useState<PermissionCatalog | null>(null)
  const [rbacLoading, setRbacLoading] = useState(false)

  const loadUsers = useCallback(async () => {
    setUsersLoading(true)
    try {
      setUsers(await apiGet<SystemUser[]>('/api/users'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load user list' : '加载用户列表失败'))
    } finally {
      setUsersLoading(false)
    }
  }, [isEn])

  const loadRbac = useCallback(async () => {
    if (!canSeeRbac) return
    setRbacLoading(true)
    try {
      const [r, c] = await Promise.all([fetchRoles(), fetchCatalog()])
      setRoles(r)
      setCatalog(c)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load roles' : '加载角色失败'))
    } finally {
      setRbacLoading(false)
    }
  }, [canSeeRbac, isEn])

  useEffect(() => { loadUsers() }, [loadUsers])
  useEffect(() => { loadRbac() }, [loadRbac])

  const reloadAll = useCallback(() => { loadUsers(); loadRbac() }, [loadUsers, loadRbac])

  const TABS: Array<{ k: TabKey; icon: string; label: string }> = [
    { k: 'users', icon: '👤', label: isEn ? 'Users' : '用户' },
    ...(canSeeRbac
      ? ([
          { k: 'roles' as TabKey, icon: '🎭', label: isEn ? 'Roles' : '角色' },
          { k: 'matrix' as TabKey, icon: '🗂', label: isEn ? 'Overview' : '权限总览' },
        ])
      : []),
  ]

  return (
    <div className="p-4">
      <div className="flex gap-1 bg-white p-1.5 rounded-xl border mb-4" style={{ borderColor: '#e5e7eb' }}>
        {TABS.map((t) => {
          const on = tab === t.k
          return (
            <button
              key={t.k}
              onClick={() => setTab(t.k)}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-semibold transition-colors"
              style={on ? { background: PURPLE, color: '#fff' } : { color: '#6b7280' }}
            >
              <span>{t.icon}</span>{t.label}
            </button>
          )
        })}
      </div>

      {tab === 'users' && (
        <UsersTab
          users={users}
          loading={usersLoading}
          isEn={isEn}
          roles={roles}
          catalog={catalog}
          canSeeRbac={canSeeRbac}
          canManageRbac={canManageRbac}
          onReload={reloadAll}
        />
      )}

      {tab === 'roles' && canSeeRbac && (
        <RolesTab
          roles={roles}
          catalog={catalog}
          loading={rbacLoading}
          isEn={isEn}
          canManage={canManageRbac}
          onReload={reloadAll}
        />
      )}

      {tab === 'matrix' && canSeeRbac && (
        <MatrixTab roles={roles} catalog={catalog} loading={rbacLoading} isEn={isEn} />
      )}
    </div>
  )
}
