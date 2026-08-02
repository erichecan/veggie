'use client'
import { useState, useEffect } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut } from '@/lib/api'
import type { SystemUser, UserRole } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import OdooControlPanel from '@/components/classic/OdooControlPanel'
import { useFacets } from '@/lib/use-facets'
import { filterByFacets, type ClientFacetDef } from '@/lib/facet-client'

const PURPLE = '#875A7B'

// 新建用户可选角色：销售/司机/销售助理/餐馆/老板/调度/财务/其他
const ALL_ROLES: UserRole[] = ['OPERATOR', 'DRIVER', 'SALES', 'RESTAURANT', 'BOSS', 'DISPATCH', 'FINANCE', 'OTHER']

const ROLE_LABEL_ZH: Record<UserRole, string> = {
  OPERATOR: '销售',
  RESTAURANT: '餐馆',
  PICKER: '拣货员',
  SORTER: '分拣员',
  DRIVER: '司机',
  BOSS: '老板',
  FINANCE: '财务',
  WAREHOUSE: '仓管',
  SALES: '销售助理',
  DISPATCH: '调度',
  OTHER: '其他',
}

const ROLE_LABEL_EN: Record<UserRole, string> = {
  OPERATOR: 'Sales',
  RESTAURANT: 'Restaurant',
  PICKER: 'Picker',
  SORTER: 'Sorter',
  DRIVER: 'Driver',
  BOSS: 'Boss',
  FINANCE: 'Finance',
  WAREHOUSE: 'Warehouse',
  SALES: 'Sales Assistant',
  DISPATCH: 'Dispatch',
  OTHER: 'Other',
}

const ROLE_COLOR: Record<UserRole, string> = {
  OPERATOR:   'bg-purple-100 text-purple-700',
  RESTAURANT: 'bg-orange-100 text-orange-700',
  PICKER:     'bg-blue-100 text-blue-700',
  SORTER:     'bg-cyan-100 text-cyan-700',
  DRIVER:     'bg-green-100 text-green-700',
  BOSS:       'bg-red-100 text-red-700',
  FINANCE:    'bg-yellow-100 text-yellow-700',
  WAREHOUSE:  'bg-gray-100 text-gray-700',
  SALES:      'bg-pink-100 text-pink-700',
  DISPATCH:   'bg-indigo-100 text-indigo-700',
  OTHER:      'bg-gray-100 text-gray-600',
}

interface FormState {
  name: string
  email: string
  role: UserRole
  password: string
}

function emptyForm(): FormState {
  return { name: '', email: '', role: 'RESTAURANT', password: '' }
}

function userInitials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase() || '?'
}

function UserRow({ u, isEn, roleLabel, onEdit, onChangePwd, onToggle }: {
  u: SystemUser
  isEn: boolean
  roleLabel: Record<UserRole, string>
  onEdit: () => void
  onChangePwd: () => void
  onToggle: () => void
}) {
  const [hover, setHover] = useState(false)
  return (
    <tr
      style={{ background: hover ? '#f3eff5' : undefined }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={!u.isActive ? 'opacity-50' : ''}
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 ${ROLE_COLOR[u.role]}`}>
            {userInitials(u.name)}
          </div>
          <span className="font-medium text-gray-900">{u.name}</span>
        </div>
      </td>
      <td className="px-4 py-3 text-gray-500 font-mono text-xs">{u.email}</td>
      <td className="px-4 py-3 text-center">
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${ROLE_COLOR[u.role]}`}>
          {roleLabel[u.role]}
        </span>
      </td>
      <td className="px-4 py-3 text-center">
        {u.isActive ? (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-200">
            {isEn ? 'Active' : '启用'}
          </span>
        ) : (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-600 border border-red-200">
            {isEn ? 'Inactive' : '停用'}
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-center text-xs text-gray-400">
        {new Date(u.createdAt).toLocaleDateString('en-GB')}
      </td>
      <td className="px-4 py-3 text-center">
        <div className="flex items-center justify-center gap-2">
          <button onClick={onEdit} className="text-xs hover:underline" style={{ color: PURPLE }}>
            {isEn ? 'Edit' : '编辑'}
          </button>
          <span className="text-gray-300">|</span>
          <button onClick={onChangePwd} className="text-xs text-orange-500 hover:underline">
            {isEn ? 'Change Password' : '修改密码'}
          </button>
          <span className="text-gray-300">|</span>
          <button
            onClick={onToggle}
            className={`text-xs hover:underline ${u.isActive ? 'text-red-500' : 'text-green-600'}`}
          >
            {isEn ? (u.isActive ? 'Deactivate' : 'Activate') : (u.isActive ? '停用' : '启用')}
          </button>
        </div>
      </td>
    </tr>
  )
}

const FACET_DEFS: ClientFacetDef<SystemUser>[] = [
  { key: 'name',  label: '姓名', values: r => [r.name] },
  { key: 'email', label: '邮箱', values: r => [r.email] },
  { key: 'role',  label: '角色', values: r => [r.role] },
]

export default function ClassicUsersPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const ROLE_LABEL = isEn ? ROLE_LABEL_EN : ROLE_LABEL_ZH
  const [users, setUsers] = useState<SystemUser[]>([])
  const [loading, setLoading] = useState(false)
  const [searchInput, setSearchInput] = useState('')

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [saving, setSaving] = useState(false)

  const [pwdDialogOpen, setPwdDialogOpen] = useState(false)
  const [pwdUser, setPwdUser] = useState<SystemUser | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [savingPwd, setSavingPwd] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const data = await apiGet<SystemUser[]>('/api/users')
      setUsers(data)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load user list' : '加载用户列表失败'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  function openAdd() {
    setEditingId(null)
    setForm(emptyForm())
    setDialogOpen(true)
  }

  function openEdit(u: SystemUser) {
    setEditingId(u.id)
    setForm({ name: u.name, email: u.email, role: u.role, password: '' })
    setDialogOpen(true)
  }

  async function handleSave() {
    if (saving) return
    if (!form.name.trim()) { toast.error(isEn ? 'Name cannot be empty' : '姓名不能为空'); return }
    if (!form.email.trim()) { toast.error(isEn ? 'Email cannot be empty' : '邮箱不能为空'); return }
    if (!editingId && form.password.length < 6) { toast.error(isEn ? 'Password must be at least 6 characters' : '密码至少 6 位'); return }

    setSaving(true)
    try {
      if (editingId) {
        const updated = await apiPut<SystemUser>(`/api/users/${editingId}`, {
          name: form.name.trim(),
          role: form.role,
        })
        setUsers(prev => prev.map(u => u.id === editingId ? { ...u, ...updated } : u))
        toast.success(isEn ? 'User info updated' : '用户信息已更新')
      } else {
        await apiPost<SystemUser>('/api/users', {
          name: form.name.trim(),
          email: form.email.trim().toLowerCase(),
          role: form.role,
          password: form.password,
        })
        await load()
        toast.success(isEn ? 'User created' : '用户已创建')
      }
      setDialogOpen(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Save failed' : '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  async function handleToggleActive(u: SystemUser) {
    try {
      const updated = await apiPut<SystemUser>(`/api/users/${u.id}`, { isActive: !u.isActive })
      setUsers(prev => prev.map(x => x.id === u.id ? { ...x, ...updated } : x))
      toast.success(isEn
        ? (u.isActive ? `${u.name} deactivated` : `${u.name} activated`)
        : (u.isActive ? `${u.name} 已停用` : `${u.name} 已启用`))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Operation failed' : '操作失败'))
    }
  }

  function openChangePwd(u: SystemUser) {
    setPwdUser(u)
    setNewPassword('')
    setConfirmPassword('')
    setPwdDialogOpen(true)
  }

  async function handleChangePwd() {
    if (!pwdUser || savingPwd) return
    if (newPassword.length < 6) { toast.error(isEn ? 'Password must be at least 6 characters' : '密码至少 6 位'); return }
    if (newPassword !== confirmPassword) { toast.error(isEn ? 'Passwords do not match' : '两次密码不一致'); return }
    setSavingPwd(true)
    try {
      await apiPut(`/api/users/${pwdUser.id}`, { newPassword })
      toast.success(isEn ? `Password changed for ${pwdUser.name}` : `${pwdUser.name} 的密码已修改`)
      setPwdDialogOpen(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Change failed' : '修改失败'))
    } finally {
      setSavingPwd(false)
    }
  }

  const { facets, chips, controlPanelProps } = useFacets(FACET_DEFS.map(d => ({ key: d.key, label: d.label })))

  const searched = searchInput
    ? users.filter(u =>
        u.name.toLowerCase().includes(searchInput.toLowerCase()) ||
        u.email.toLowerCase().includes(searchInput.toLowerCase())
      )
    : users
  const filtered = filterByFacets(searched, facets, FACET_DEFS)

  return (
    <div>
      <OdooControlPanel
        {...controlPanelProps}
        activeFilters={chips}
        breadcrumb={isEn ? ['System', 'User Management'] : ['系统', '用户管理']}
        permanentActions={[
          { label: isEn ? 'New User' : '新建用户', onClick: openAdd },
          { label: isEn ? 'Refresh' : '刷新', onClick: load },
        ]}
        searchValue={searchInput}
        onSearch={setSearchInput}
        onSearchSubmit={() => {}}
        total={filtered.length}
        page={1}
        pageSize={filtered.length || 1}
      />
      <div className="p-4">
        {loading && (
          <div className="bg-white border border-gray-200 py-16 text-center text-gray-400">
            {isEn ? 'Loading...' : '加载中...'}
          </div>
        )}
        {!loading && (
          <div className="bg-white border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead style={{ background: '#f3eff5', borderBottom: '1px solid #ddd' }}>
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">{isEn ? 'User' : '用户'}</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">{isEn ? 'Email' : '邮箱'}</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Role' : '角色'}</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Status' : '状态'}</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Created' : '创建时间'}</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">{isEn ? 'Actions' : '操作'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center py-16 text-gray-400 text-sm">
                      {isEn ? 'No users' : '暂无用户'}
                    </td>
                  </tr>
                )}
                {filtered.map(u => (
                  <UserRow
                    key={u.id}
                    u={u}
                    isEn={isEn}
                    roleLabel={ROLE_LABEL}
                    onEdit={() => openEdit(u)}
                    onChangePwd={() => openChangePwd(u)}
                    onToggle={() => handleToggleActive(u)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle style={{ color: PURPLE }}>{editingId ? (isEn ? 'Edit User' : '编辑用户') : (isEn ? 'New User' : '新建用户')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label htmlFor="u-name">{isEn ? 'Name *' : '姓名 *'}</Label>
              <Input
                id="u-name"
                className="mt-1"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder={isEn ? 'e.g. John Smith' : '如 张三'}
              />
            </div>
            {!editingId && (
              <div>
                <Label htmlFor="u-email">{isEn ? 'Email *' : '邮箱 *'}</Label>
                <Input
                  id="u-email"
                  type="email"
                  className="mt-1"
                  value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="user@example.com"
                />
              </div>
            )}
            {editingId && (
              <div>
                <Label>{isEn ? 'Email' : '邮箱'}</Label>
                <p className="mt-1 text-sm text-gray-500 font-mono">{form.email}</p>
                <p className="text-xs text-gray-400">{isEn ? 'Email cannot be changed after creation' : '邮箱创建后不可修改'}</p>
              </div>
            )}
            <div>
              <Label>{isEn ? 'Role *' : '角色 *'}</Label>
              <div className="mt-1 grid grid-cols-4 gap-1.5">
                {ALL_ROLES.map(r => (
                  <button
                    key={r}
                    onClick={() => setForm(f => ({ ...f, role: r }))}
                    className="py-1.5 rounded-lg border text-xs font-medium transition-colors"
                    style={form.role === r
                      ? { borderColor: PURPLE, background: '#f3eff5', color: PURPLE }
                      : { borderColor: '#e5e7eb', color: '#6b7280' }
                    }
                  >
                    {ROLE_LABEL[r]}
                  </button>
                ))}
              </div>
            </div>
            {!editingId && (
              <div>
                <Label htmlFor="u-pass">{isEn ? 'Initial Password *' : '初始密码 *'} <span className="text-gray-400 font-normal text-xs">{isEn ? '(at least 6 characters)' : '（至少 6 位）'}</span></Label>
                <Input
                  id="u-pass"
                  type="password"
                  className="mt-1"
                  value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  placeholder={isEn ? 'Enter initial password' : '输入初始密码'}
                  autoComplete="new-password"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>{isEn ? 'Cancel' : '取消'}</Button>
            <Button
              onClick={handleSave}
              disabled={saving}
              style={{ background: PURPLE, borderColor: PURPLE }}
              className="text-white hover:opacity-90"
            >
              {saving ? (isEn ? 'Saving…' : '保存中…') : (editingId ? (isEn ? 'Save Changes' : '保存修改') : (isEn ? 'Confirm Create' : '确认新建'))}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pwdDialogOpen} onOpenChange={v => { setPwdDialogOpen(v) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle style={{ color: PURPLE }}>{isEn ? 'Change Password' : '修改密码'} — {pwdUser?.name}</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-4">
            <p className="text-xs text-gray-400">{pwdUser?.email}</p>
            <div>
              <Label htmlFor="admin-new-pwd">{isEn ? 'New Password' : '新密码'} <span className="text-gray-400 font-normal text-xs">{isEn ? '(at least 6 characters)' : '（至少 6 位）'}</span></Label>
              <Input
                id="admin-new-pwd"
                type="password"
                className="mt-1"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder={isEn ? 'Enter new password' : '输入新密码'}
                autoComplete="new-password"
              />
            </div>
            <div>
              <Label htmlFor="admin-confirm-pwd">{isEn ? 'Confirm New Password' : '确认新密码'}</Label>
              <Input
                id="admin-confirm-pwd"
                type="password"
                className="mt-1"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder={isEn ? 'Re-enter new password' : '再次输入新密码'}
                autoComplete="new-password"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPwdDialogOpen(false)} disabled={savingPwd}>{isEn ? 'Cancel' : '取消'}</Button>
            <Button
              onClick={handleChangePwd}
              disabled={savingPwd}
              style={{ background: '#d97706', borderColor: '#d97706' }}
              className="text-white hover:opacity-90"
            >
              {savingPwd ? (isEn ? 'Saving…' : '保存中…') : (isEn ? 'Confirm' : '确认修改')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
