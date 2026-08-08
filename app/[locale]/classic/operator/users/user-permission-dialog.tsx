'use client'
/**
 * 单个用户的权限弹窗：挂角色 / 设上级 / 加减个人级例外 / 看合并后的生效权限。
 *
 * 个人例外没有做成「三态勾选树」—— 那种 UI 分不清「没勾」和「显式收回」，
 * 而这两者在 resolve 里的含义完全不同。改成显式的例外清单：加了什么、减了什么、
 * 为什么，一眼看得见。
 */
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { apiPut } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import {
  buildPermissionLabels, fetchUserPermissions, saveUserPermissions,
  SCOPE_LABEL_EN, SCOPE_LABEL_ZH,
  type PermissionCatalog, type RoleRow, type UserGrant, type UserPermissionDetail,
} from './rbac-client'

const PURPLE = '#875A7B'

interface PickerUser {
  id: string
  name: string
  email: string
  isActive: boolean
}

export default function UserPermissionDialog({
  open, userId, roles, catalog, allUsers, isEn, canManage, onClose, onSaved,
}: {
  open: boolean
  userId: string | null
  roles: RoleRow[]
  catalog: PermissionCatalog | null
  allUsers: PickerUser[]
  isEn: boolean
  canManage: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const SCOPE_LABEL = isEn ? SCOPE_LABEL_EN : SCOPE_LABEL_ZH
  const [detail, setDetail] = useState<UserPermissionDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const [roleIds, setRoleIds] = useState<string[]>([])
  const [managerId, setManagerId] = useState<string>('')
  const [grants, setGrants] = useState<UserGrant[]>([])
  const [newPermId, setNewPermId] = useState('')
  const [newGranted, setNewGranted] = useState(true)
  const [showEffective, setShowEffective] = useState(false)

  useEffect(() => {
    if (!open || !userId) return
    let cancelled = false
    setLoading(true)
    setDetail(null)
    fetchUserPermissions(userId)
      .then((d) => {
        if (cancelled) return
        setDetail(d)
        setRoleIds(d.roles.map((r) => r.id))
        setManagerId(d.user.manager?.id ?? '')
        setGrants(d.grants)
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : (isEn ? 'Load failed' : '加载失败')))
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, userId, isEn])

  const permLabels = useMemo(
    () => (catalog ? buildPermissionLabels(catalog, isEn) : new Map<string, string>()),
    [catalog, isEn],
  )
  const allPermIds = useMemo(
    () => (catalog ? catalog.groups.flatMap((g) => g.modules.flatMap((m) => m.actions.map((a) => a.id))) : []),
    [catalog],
  )

  /** 选中角色权限的并集 —— 用来算「这条例外是不是多余的」 */
  const rolePermissions = useMemo(() => {
    const s = new Set<string>()
    for (const id of roleIds) {
      const r = roles.find((x) => x.id === id)
      if (r) for (const p of r.permissions) s.add(p)
    }
    return s
  }, [roleIds, roles])

  /** 挂了多个角色时，数据范围取最宽 —— 与服务端 combinePermissions 同口径 */
  const previewScope = useMemo(() => {
    const order = { OWN: 0, TEAM: 1, ALL: 2 } as const
    let best: 'ALL' | 'TEAM' | 'OWN' = 'OWN'
    for (const id of roleIds) {
      const r = roles.find((x) => x.id === id)
      if (r && order[r.dataScope] > order[best]) best = r.dataScope
    }
    return roleIds.length === 0 ? null : best
  }, [roleIds, roles])

  function toggleRole(id: string) {
    setRoleIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  function addGrant() {
    if (!newPermId) return
    if (grants.some((g) => g.permissionId === newPermId)) {
      toast.error(isEn ? 'This permission already has an exception' : '这个权限点已经有例外了')
      return
    }
    setGrants((prev) => [...prev, { permissionId: newPermId, granted: newGranted, reason: null }])
    setNewPermId('')
  }

  async function handleSave() {
    if (!detail || saving) return
    setSaving(true)
    try {
      const managerChanged = (detail.user.manager?.id ?? '') !== managerId
      if (managerChanged) {
        await apiPut(`/api/users/${detail.user.id}`, { managerId: managerId || null })
      }
      await saveUserPermissions(detail.user.id, {
        roleIds,
        grants: grants.map((g) => ({
          permissionId: g.permissionId, granted: g.granted, reason: g.reason,
        })),
      })
      toast.success(isEn
        ? `Saved — ${detail.user.name} must sign in again for it to take effect`
        : `已保存 —— ${detail.user.name} 需要重新登录后生效`)
      onSaved()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Save failed' : '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const managerCandidates = allUsers.filter((u) => u.id !== userId && u.isActive)

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      {/* 高度卡住视口，头尾固定中间滚 —— 弹窗绝对居中，超出视口就是上下各溢出一半，
          「保存」会跑到屏幕外点不到。理由同 role-editor-dialog。 */}
      <DialogContent className="flex flex-col max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] sm:max-w-[min(1280px,calc(100vw-3rem))]">
        <DialogHeader className="shrink-0">
          <DialogTitle style={{ color: PURPLE }}>
            {isEn ? 'Permissions' : '权限'} — {detail?.user.name ?? ''}
            <span className="ml-2 text-xs font-normal text-gray-400">{detail?.user.email}</span>
          </DialogTitle>
        </DialogHeader>

        {loading && (
          <div className="flex-1 py-16 text-center text-sm text-gray-400">{isEn ? 'Loading…' : '加载中…'}</div>
        )}

        {!loading && detail && (
          <div className="flex-1 min-h-0 overflow-y-auto space-y-4 py-1 pr-1">
            <div>
              <Label>{isEn ? 'Roles' : '角色'}</Label>
              {roles.length === 0 && (
                <p className="text-xs text-gray-400 mt-1">{isEn ? 'No roles defined' : '还没有任何角色'}</p>
              )}
              <div className="mt-1 grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                {roles.map((r) => {
                  const on = roleIds.includes(r.id)
                  return (
                    <button
                      key={r.id}
                      type="button"
                      disabled={!canManage}
                      onClick={() => toggleRole(r.id)}
                      className="px-2 py-1.5 rounded-lg border text-xs font-medium text-left disabled:cursor-not-allowed"
                      style={on
                        ? { borderColor: PURPLE, background: '#f3eff5', color: PURPLE }
                        : { borderColor: '#e5e7eb', color: '#6b7280' }}
                    >
                      {r.isSystem && '🔒 '}{r.name}
                      <span className="block text-[10px] font-normal opacity-70">
                        {r.permissionCount} {isEn ? 'perms' : '个权限点'} · {SCOPE_LABEL[r.dataScope]}
                      </span>
                    </button>
                  )
                })}
              </div>
              {roleIds.length === 0 && (
                <p className="text-xs text-red-500 mt-1.5">
                  {isEn
                    ? 'No role selected — this account will have no permissions at all.'
                    : '一个角色都没选 —— 这个账号将没有任何权限。'}
                </p>
              )}
              {previewScope && (
                <p className="text-[11px] text-gray-400 mt-1.5">
                  {isEn ? 'Effective data scope (widest of the roles): ' : '生效数据范围（取所选角色中最宽的）：'}
                  <b style={{ color: PURPLE }}>{SCOPE_LABEL[previewScope]}</b>
                </p>
              )}
            </div>

            <div>
              <Label htmlFor="u-manager">{isEn ? 'Manager' : '上级'}</Label>
              <select
                id="u-manager"
                value={managerId}
                disabled={!canManage}
                onChange={(e) => setManagerId(e.target.value)}
                className="mt-1 w-full text-sm px-2 py-2 border border-gray-200 rounded outline-none focus:border-gray-400 disabled:bg-gray-50"
              >
                <option value="">{isEn ? '— none —' : '— 无 —'}</option>
                {managerCandidates.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}（{u.email}）</option>
                ))}
              </select>
              <p className="text-[11px] text-gray-400 mt-1">
                {isEn
                  ? 'Only matters for roles scoped to "Own + reports": they will see this person\'s records too.'
                  : '只有数据范围为「本人及下属」的角色才用得上：上级能看到下属的单据。'}
              </p>
            </div>

            <div>
              <div className="flex items-center justify-between">
                <Label>{isEn ? 'Personal exceptions' : '个人级例外'}</Label>
                <span className="text-[11px] text-gray-400">
                  {isEn ? 'Applied on top of roles' : '在角色之上叠加'}
                </span>
              </div>

              {grants.length === 0 && (
                <p className="text-xs text-gray-400 mt-1.5">
                  {isEn ? 'None — permissions come from roles only.' : '没有例外，权限完全来自角色。'}
                </p>
              )}

              <div className="mt-1.5 space-y-1">
                {grants.map((g) => {
                  const redundant = g.granted && rolePermissions.has(g.permissionId)
                  const noop = !g.granted && !rolePermissions.has(g.permissionId)
                  return (
                    <div key={g.permissionId} className="flex items-center gap-2 text-xs bg-gray-50 rounded px-2 py-1.5">
                      <span className={`px-1.5 py-0.5 rounded font-medium ${g.granted ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                        {g.granted ? (isEn ? '+ grant' : '＋ 加') : (isEn ? '− revoke' : '－ 减')}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="text-gray-700">{permLabels.get(g.permissionId) ?? g.permissionId}</span>
                        <span className="ml-1.5 font-mono text-[10px] text-gray-300">{g.permissionId}</span>
                        {(redundant || noop) && (
                          <span className="ml-1.5 text-amber-600">
                            {redundant
                              ? (isEn ? '(role already grants this)' : '（角色本来就有，这条多余）')
                              : (isEn ? '(no role grants this anyway)' : '（角色本来就没有，这条无效）')}
                          </span>
                        )}
                      </span>
                      {canManage && (
                        <button
                          onClick={() => setGrants((prev) => prev.filter((x) => x.permissionId !== g.permissionId))}
                          className="text-red-500 hover:underline"
                        >
                          {isEn ? 'Remove' : '移除'}
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>

              {canManage && catalog && (
                <div className="mt-2 flex items-center gap-2">
                  <select
                    value={newPermId}
                    onChange={(e) => setNewPermId(e.target.value)}
                    className="flex-1 text-xs px-2 py-1.5 border border-gray-200 rounded outline-none focus:border-gray-400"
                  >
                    <option value="">{isEn ? '— pick a permission —' : '— 选一个权限点 —'}</option>
                    {allPermIds
                      .filter((id) => !grants.some((g) => g.permissionId === id))
                      .map((id) => (
                        <option key={id} value={id}>{permLabels.get(id) ?? id}（{id}）</option>
                      ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setNewGranted(true)}
                    className="px-2 py-1.5 rounded border text-xs"
                    style={newGranted
                      ? { borderColor: '#16a34a', background: '#dcfce7', color: '#15803d' }
                      : { borderColor: '#e5e7eb', color: '#6b7280' }}
                  >
                    {isEn ? '+ grant' : '＋ 加'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewGranted(false)}
                    className="px-2 py-1.5 rounded border text-xs"
                    style={!newGranted
                      ? { borderColor: '#dc2626', background: '#fee2e2', color: '#b91c1c' }
                      : { borderColor: '#e5e7eb', color: '#6b7280' }}
                  >
                    {isEn ? '− revoke' : '－ 减'}
                  </button>
                  <Button onClick={addGrant} disabled={!newPermId} variant="outline" className="h-8 text-xs">
                    {isEn ? 'Add' : '添加'}
                  </Button>
                </div>
              )}
            </div>

            <div>
              <button
                type="button"
                onClick={() => setShowEffective((v) => !v)}
                className="text-xs hover:underline"
                style={{ color: PURPLE }}
              >
                {showEffective ? '▾' : '▸'}{' '}
                {isEn
                  ? `Effective permissions currently in force (${detail.effective.total}, scope ${SCOPE_LABEL[detail.effective.dataScope]})`
                  : `当前实际生效的权限（${detail.effective.total} 个，范围 ${SCOPE_LABEL[detail.effective.dataScope]}）`}
              </button>
              {showEffective && (
                <>
                  <p className="text-[11px] text-gray-400 mt-1">
                    {isEn
                      ? 'This is what is stored right now — it does not reflect unsaved edits above.'
                      : '这是库里当前的状态，不包含上面还没保存的改动。'}
                  </p>
                  <div className="mt-1 max-h-48 overflow-y-auto border border-gray-200 rounded divide-y divide-gray-100">
                    {detail.effective.permissions.length === 0 && (
                      <div className="py-6 text-center text-xs text-gray-400">
                        {isEn ? 'No permission at all' : '没有任何权限'}
                      </div>
                    )}
                    {detail.effective.permissions.map((p) => (
                      <div key={p.id} className="flex items-center gap-2 px-2 py-1 text-xs">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] ${p.source === 'role' ? 'bg-purple-50 text-purple-600' : 'bg-green-50 text-green-700'}`}>
                          {p.source === 'role' ? (isEn ? 'role' : '角色') : (isEn ? 'exception' : '例外')}
                        </span>
                        <span className="text-gray-700">{permLabels.get(p.id) ?? p.id}</span>
                        <span className="font-mono text-[10px] text-gray-300">{p.id}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {canManage ? (isEn ? 'Cancel' : '取消') : (isEn ? 'Close' : '关闭')}
          </Button>
          {canManage && (
            <Button
              onClick={handleSave}
              disabled={saving || loading || !detail}
              style={{ background: PURPLE, borderColor: PURPLE }}
              className="text-white hover:opacity-90"
            >
              {saving ? (isEn ? 'Saving…' : '保存中…') : (isEn ? 'Save' : '保存')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export type { PickerUser }
