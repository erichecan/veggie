/**
 * 权限中心的前端数据类型与取数封装。
 *
 * 这些类型是 `/api/rbac/*` 响应的镜像 —— 服务端改了形状，这里编译不过，
 * 好过页面上静默地少显示一列。
 */
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api'

export type DataScope = 'ALL' | 'TEAM' | 'OWN'

export interface RoleRow {
  id: string
  code: string
  name: string
  description: string | null
  isSystem: boolean
  dataScope: DataScope
  permissions: string[]
  permissionCount: number
  userCount: number
}

export interface CatalogAction {
  id: string
  action: string
  labelZh: string
  labelEn: string
}

export interface CatalogModule {
  module: string
  labelZh: string
  labelEn: string
  note: string | null
  actions: CatalogAction[]
}

export interface CatalogGroup {
  key: string
  labelZh: string
  labelEn: string
  modules: CatalogModule[]
}

export interface PermissionCatalog {
  total: number
  groups: CatalogGroup[]
}

export interface UserGrant {
  permissionId: string
  granted: boolean
  reason: string | null
  grantedBy?: string | null
}

export interface UserPermissionDetail {
  user: {
    id: string
    name: string
    email: string
    isActive: boolean
    manager: { id: string; name: string } | null
    permVersion: number
  }
  roles: Array<{ id: string; code: string; name: string; dataScope: DataScope; permissionCount: number }>
  grants: UserGrant[]
  effective: {
    dataScope: DataScope
    total: number
    permissions: Array<{ id: string; source: 'role' | 'grant' }>
  }
}

export const SCOPE_LABEL_ZH: Record<DataScope, string> = {
  ALL: '全部数据',
  TEAM: '本人及下属',
  OWN: '仅本人',
}

export const SCOPE_LABEL_EN: Record<DataScope, string> = {
  ALL: 'All records',
  TEAM: 'Own + reports',
  OWN: 'Own only',
}

export const fetchRoles = () => apiGet<{ roles: RoleRow[] }>('/api/rbac/roles').then((r) => r.roles)

export const fetchCatalog = () => apiGet<PermissionCatalog>('/api/rbac/permissions')

export const fetchUserPermissions = (userId: string) =>
  apiGet<UserPermissionDetail>(`/api/rbac/users/${userId}`)

export const createRole = (body: {
  code: string
  name: string
  description?: string | null
  dataScope: DataScope
  permissions: string[]
}) => apiPost<{ role: RoleRow }>('/api/rbac/roles', body)

export const updateRole = (
  id: string,
  body: Partial<{ name: string; description: string | null; dataScope: DataScope; permissions: string[] }>,
) => apiPut<{ role: RoleRow; affectedUsers: number }>(`/api/rbac/roles/${id}`, body)

export const deleteRole = (id: string, force = false) =>
  apiDelete<{ ok: true; affectedUsers: number }>(`/api/rbac/roles/${id}${force ? '?force=true' : ''}`)

export const saveUserPermissions = (
  userId: string,
  body: { roleIds?: string[]; grants?: Array<{ permissionId: string; granted: boolean; reason?: string | null }> },
) => apiPut<{ ok: true }>(`/api/rbac/users/${userId}`, body)

/** 权限点 id → 中文/英文标签，供「生效权限」只读列表显示人话 */
export function buildPermissionLabels(catalog: PermissionCatalog, isEn: boolean): Map<string, string> {
  const map = new Map<string, string>()
  for (const g of catalog.groups) {
    for (const m of g.modules) {
      for (const a of m.actions) {
        map.set(a.id, `${isEn ? m.labelEn : m.labelZh} — ${isEn ? a.labelEn : a.labelZh}`)
      }
    }
  }
  return map
}
