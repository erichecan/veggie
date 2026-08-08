'use client'
/** 角色编辑弹窗：改名 / 描述 / 数据范围 / 权限点勾选。新建与复制共用这一个。 */
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import PermissionTree from './permission-tree'
import {
  createRole, updateRole,
  SCOPE_LABEL_EN, SCOPE_LABEL_ZH,
  type DataScope, type PermissionCatalog, type RoleRow,
} from './rbac-client'

const PURPLE = '#875A7B'
const SCOPES: DataScope[] = ['ALL', 'TEAM', 'OWN']

export interface RoleDraft {
  /** 有 id 表示改已有角色；没有表示新建（复制也是新建，只是带了一份权限） */
  id?: string
  code: string
  name: string
  description: string | null
  dataScope: DataScope
  permissions: string[]
  isSystem: boolean
}

export function draftFromRole(r: RoleRow): RoleDraft {
  return {
    id: r.id, code: r.code, name: r.name, description: r.description,
    dataScope: r.dataScope, permissions: r.permissions, isSystem: r.isSystem,
  }
}

export function draftCopyOf(r: RoleRow): RoleDraft {
  return {
    code: '', name: `${r.name} (copy)`, description: r.description,
    dataScope: r.dataScope, permissions: r.permissions, isSystem: false,
  }
}

export function emptyDraft(): RoleDraft {
  return { code: '', name: '', description: null, dataScope: 'ALL', permissions: [], isSystem: false }
}

export default function RoleEditorDialog({ open, draft, catalog, isEn, readOnly = false, onClose, onSaved }: {
  open: boolean
  draft: RoleDraft | null
  catalog: PermissionCatalog
  isEn: boolean
  /** 只有查看权限没有管理权限时，整个弹窗降级为只读 —— 免得点了保存才吃 403 */
  readOnly?: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const SCOPE_LABEL = isEn ? SCOPE_LABEL_EN : SCOPE_LABEL_ZH
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [dataScope, setDataScope] = useState<DataScope>('ALL')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!draft) return
    setCode(draft.code)
    setName(draft.name)
    setDescription(draft.description ?? '')
    setDataScope(draft.dataScope)
    setSelected(new Set(draft.permissions))
  }, [draft])

  if (!draft) return null
  const isEdit = Boolean(draft.id)

  async function handleSave() {
    if (!draft || saving) return
    if (!name.trim()) { toast.error(isEn ? 'Role name is required' : '角色名称不能为空'); return }
    if (!isEdit && !/^[a-z][a-z0-9_]{1,39}$/.test(code.trim())) {
      toast.error(isEn
        ? 'Code: lowercase letters, digits and underscore, starting with a letter, 2–40 chars'
        : '角色标识只能用小写字母、数字与下划线，字母开头，2–40 位')
      return
    }
    setSaving(true)
    try {
      if (isEdit) {
        const r = await updateRole(draft.id!, {
          name: name.trim(),
          description: description.trim() || null,
          dataScope,
          permissions: [...selected],
        })
        toast.success(isEn
          ? `Role saved — ${r.affectedUsers} user(s) must sign in again`
          : `角色已保存 —— ${r.affectedUsers} 人需要重新登录`)
      } else {
        await createRole({
          code: code.trim().toLowerCase(),
          name: name.trim(),
          description: description.trim() || null,
          dataScope,
          permissions: [...selected],
        })
        toast.success(isEn ? 'Role created' : '角色已创建')
      }
      onSaved()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Save failed' : '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle style={{ color: PURPLE }}>
            {isEdit
              ? `${isEn ? 'Edit Role' : '编辑角色'} — ${draft.name}`
              : (isEn ? 'New Role' : '新建角色')}
            {draft.isSystem && (
              <span className="ml-2 text-xs font-normal text-amber-600">
                🔒 {isEn ? 'Preset role: code cannot change, cannot be deleted' : '预置角色：标识不可改、不可删除，权限可改'}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="r-name">{isEn ? 'Name *' : '名称 *'}</Label>
              <Input id="r-name" className="mt-1" value={name} disabled={readOnly}
                onChange={(e) => setName(e.target.value)}
                placeholder={isEn ? 'e.g. Office Sales' : '如 办公室销售'} />
            </div>
            <div>
              <Label htmlFor="r-code">{isEn ? 'Code *' : '标识 *'}</Label>
              {isEdit ? (
                <p className="mt-2 text-sm font-mono text-gray-500">{code}</p>
              ) : (
                <Input id="r-code" className="mt-1 font-mono" value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="office_sales" />
              )}
            </div>
          </div>

          <div>
            <Label htmlFor="r-desc">{isEn ? 'Description' : '说明'}</Label>
            <Input id="r-desc" className="mt-1" value={description} disabled={readOnly}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={isEn ? 'What this role is for' : '这个角色是干什么的'} />
          </div>

          <div>
            <Label>{isEn ? 'Data scope' : '数据范围'}</Label>
            <div className="mt-1 flex gap-2">
              {SCOPES.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={readOnly}
                  onClick={() => setDataScope(s)}
                  className="px-3 py-1.5 rounded-lg border text-xs font-medium disabled:cursor-not-allowed"
                  style={dataScope === s
                    ? { borderColor: PURPLE, background: '#f3eff5', color: PURPLE }
                    : { borderColor: '#e5e7eb', color: '#6b7280' }}
                >
                  {SCOPE_LABEL[s]}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-gray-400 mt-1">
              {isEn
                ? 'Scope limits which records this role sees; "Own + reports" follows the manager chain.'
                : '数据范围限制这个角色能看到哪些记录；「本人及下属」按上级关系向下展开。'}
            </p>
          </div>

          <div>
            <Label>{isEn ? 'Permissions' : '权限点'}</Label>
            <div className="mt-1">
              <PermissionTree catalog={catalog} selected={selected} disabled={readOnly} isEn={isEn} onChange={setSelected} />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {readOnly ? (isEn ? 'Close' : '关闭') : (isEn ? 'Cancel' : '取消')}
          </Button>
          {!readOnly && (
            <Button
              onClick={handleSave}
              disabled={saving}
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
