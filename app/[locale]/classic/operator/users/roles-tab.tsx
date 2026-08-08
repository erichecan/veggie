'use client'
/** 角色 tab：列表 + 新建 / 复制 / 编辑 / 删除。 */
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import RoleEditorDialog, {
  draftCopyOf, draftFromRole, emptyDraft, type RoleDraft,
} from './role-editor-dialog'
import {
  deleteRole, SCOPE_LABEL_EN, SCOPE_LABEL_ZH,
  type PermissionCatalog, type RoleRow,
} from './rbac-client'

const PURPLE = '#875A7B'

export default function RolesTab({ roles, catalog, loading, isEn, canManage, onReload }: {
  roles: RoleRow[]
  catalog: PermissionCatalog | null
  loading: boolean
  isEn: boolean
  canManage: boolean
  onReload: () => void
}) {
  const SCOPE_LABEL = isEn ? SCOPE_LABEL_EN : SCOPE_LABEL_ZH
  const [draft, setDraft] = useState<RoleDraft | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  function open(d: RoleDraft) {
    setDraft(d)
    setDialogOpen(true)
  }

  async function handleDelete(r: RoleRow) {
    if (deleting) return
    setDeleting(r.id)
    try {
      // 第一次不带 force：有人在用的话服务端会回 409 并说清影响几个人，
      // 拿这句话去问管理员，而不是前端自己编一句「确定删除吗」
      await deleteRole(r.id)
      toast.success(isEn ? `Role "${r.name}" deleted` : `角色「${r.name}」已删除`)
      onReload()
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      const inUse = r.userCount > 0 && msg.includes(String(r.userCount))
      if (inUse && confirm(`${msg}\n\n${isEn ? 'Delete anyway?' : '仍要删除吗？'}`)) {
        try {
          const res = await deleteRole(r.id, true)
          toast.success(isEn
            ? `Deleted — ${res.affectedUsers} user(s) must sign in again`
            : `已删除 —— ${res.affectedUsers} 人需要重新登录`)
          onReload()
        } catch (e2) {
          toast.error(e2 instanceof Error ? e2.message : (isEn ? 'Delete failed' : '删除失败'))
        }
      } else if (!inUse) {
        toast.error(msg || (isEn ? 'Delete failed' : '删除失败'))
      }
    } finally {
      setDeleting(null)
    }
  }

  if (loading) {
    return (
      <div className="bg-white border border-gray-200 py-16 text-center text-gray-400">
        {isEn ? 'Loading…' : '加载中…'}
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-gray-500">
          {isEn
            ? `${roles.length} roles. Preset roles 🔒 cannot be deleted, but their permissions can be edited.`
            : `共 ${roles.length} 个角色。带 🔒 的是预置角色，不能删除，但权限可以改。`}
        </p>
        {canManage && catalog && (
          <Button
            onClick={() => open(emptyDraft())}
            style={{ background: PURPLE, borderColor: PURPLE }}
            className="text-white hover:opacity-90 h-8 text-xs"
          >
            {isEn ? 'New Role' : '新建角色'}
          </Button>
        )}
      </div>

      <div className="bg-white border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead style={{ background: '#f3eff5', borderBottom: '1px solid #ddd' }}>
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-600">{isEn ? 'Role' : '角色'}</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">{isEn ? 'Code' : '标识'}</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Data scope' : '数据范围'}</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Permissions' : '权限点'}</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Users' : '在用人数'}</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Actions' : '操作'}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {roles.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center py-16 text-gray-400 text-sm">
                  {isEn ? 'No roles yet' : '暂无角色'}
                </td>
              </tr>
            )}
            {roles.map((r) => (
              <tr key={r.id} className="hover:bg-[#f3eff5]">
                <td className="px-4 py-3">
                  <div className="font-medium text-gray-900">
                    {r.isSystem && <span className="mr-1" title={isEn ? 'Preset role' : '预置角色'}>🔒</span>}
                    {r.name}
                  </div>
                  {r.description && <div className="text-xs text-gray-400 mt-0.5">{r.description}</div>}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.code}</td>
                <td className="px-4 py-3 text-center text-xs text-gray-600">{SCOPE_LABEL[r.dataScope]}</td>
                <td className="px-4 py-3 text-center">
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-50 text-purple-700">
                    {r.permissionCount}
                  </span>
                </td>
                <td className="px-4 py-3 text-center text-xs text-gray-600">{r.userCount}</td>
                <td className="px-4 py-3 text-center">
                  <div className="flex items-center justify-center gap-2">
                    <button
                      onClick={() => catalog && open(draftFromRole(r))}
                      disabled={!catalog}
                      className="text-xs hover:underline disabled:opacity-40"
                      style={{ color: PURPLE }}
                    >
                      {canManage ? (isEn ? 'Edit' : '编辑') : (isEn ? 'View' : '查看')}
                    </button>
                    {canManage && (
                      <>
                        <span className="text-gray-300">|</span>
                        <button
                          onClick={() => catalog && open(draftCopyOf(r))}
                          disabled={!catalog}
                          className="text-xs text-gray-600 hover:underline disabled:opacity-40"
                        >
                          {isEn ? 'Duplicate' : '复制'}
                        </button>
                        <span className="text-gray-300">|</span>
                        <button
                          onClick={() => handleDelete(r)}
                          disabled={r.isSystem || deleting === r.id}
                          title={r.isSystem ? (isEn ? 'Preset role cannot be deleted' : '预置角色不能删除') : undefined}
                          className="text-xs text-red-500 hover:underline disabled:text-gray-300 disabled:no-underline disabled:cursor-not-allowed"
                        >
                          {isEn ? 'Delete' : '删除'}
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {catalog && (
        <RoleEditorDialog
          open={dialogOpen}
          draft={draft}
          catalog={catalog}
          isEn={isEn}
          readOnly={!canManage}
          onClose={() => setDialogOpen(false)}
          onSaved={onReload}
        />
      )}
    </div>
  )
}
