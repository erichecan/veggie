'use client'
import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut } from '@/lib/api'
import type { SystemUser, UserRole } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import OdooControlPanel from '@/components/classic/OdooControlPanel'

const PURPLE = '#875A7B'

// 新建用户可选角色：运营/司机/餐馆/老板/调度/财务/其他
const ALL_ROLES: UserRole[] = ['OPERATOR', 'DRIVER', 'RESTAURANT', 'BOSS', 'DISPATCH', 'FINANCE', 'OTHER']

const ROLE_LABEL: Record<UserRole, string> = {
  OPERATOR: '运营',
  RESTAURANT: '餐馆',
  PICKER: '拣货员',
  SORTER: '分拣员',
  DRIVER: '司机',
  BOSS: '老板',
  FINANCE: '财务',
  WAREHOUSE: '仓管',
  DISPATCH: '调度',
  OTHER: '其他',
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

function UserRow({ u, onEdit, onChangePwd, onToggle }: {
  u: SystemUser
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
          {ROLE_LABEL[u.role]}
        </span>
      </td>
      <td className="px-4 py-3 text-center">
        {u.isActive ? (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-200">
            启用
          </span>
        ) : (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-600 border border-red-200">
            停用
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-center text-xs text-gray-400">
        {new Date(u.createdAt).toLocaleDateString('en-GB')}
      </td>
      <td className="px-4 py-3 text-center">
        <div className="flex items-center justify-center gap-2">
          <button onClick={onEdit} className="text-xs hover:underline" style={{ color: PURPLE }}>
            编辑
          </button>
          <span className="text-gray-300">|</span>
          <button onClick={onChangePwd} className="text-xs text-orange-500 hover:underline">
            修改密码
          </button>
          <span className="text-gray-300">|</span>
          <button
            onClick={onToggle}
            className={`text-xs hover:underline ${u.isActive ? 'text-red-500' : 'text-green-600'}`}
          >
            {u.isActive ? '停用' : '启用'}
          </button>
        </div>
      </td>
    </tr>
  )
}

export default function ClassicUsersPage() {
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
      toast.error(e instanceof Error ? e.message : '加载用户列表失败')
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
    if (!form.name.trim()) { toast.error('姓名不能为空'); return }
    if (!form.email.trim()) { toast.error('邮箱不能为空'); return }
    if (!editingId && form.password.length < 6) { toast.error('密码至少 6 位'); return }

    setSaving(true)
    try {
      if (editingId) {
        const updated = await apiPut<SystemUser>(`/api/users/${editingId}`, {
          name: form.name.trim(),
          role: form.role,
        })
        setUsers(prev => prev.map(u => u.id === editingId ? { ...u, ...updated } : u))
        toast.success('用户信息已更新')
      } else {
        await apiPost<SystemUser>('/api/users', {
          name: form.name.trim(),
          email: form.email.trim().toLowerCase(),
          role: form.role,
          password: form.password,
        })
        await load()
        toast.success('用户已创建')
      }
      setDialogOpen(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function handleToggleActive(u: SystemUser) {
    try {
      const updated = await apiPut<SystemUser>(`/api/users/${u.id}`, { isActive: !u.isActive })
      setUsers(prev => prev.map(x => x.id === u.id ? { ...x, ...updated } : x))
      toast.success(u.isActive ? `${u.name} 已停用` : `${u.name} 已启用`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败')
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
    if (newPassword.length < 6) { toast.error('密码至少 6 位'); return }
    if (newPassword !== confirmPassword) { toast.error('两次密码不一致'); return }
    setSavingPwd(true)
    try {
      await apiPut(`/api/users/${pwdUser.id}`, { newPassword })
      toast.success(`${pwdUser.name} 的密码已修改`)
      setPwdDialogOpen(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '修改失败')
    } finally {
      setSavingPwd(false)
    }
  }

  const filtered = searchInput
    ? users.filter(u =>
        u.name.toLowerCase().includes(searchInput.toLowerCase()) ||
        u.email.toLowerCase().includes(searchInput.toLowerCase())
      )
    : users

  return (
    <div>
      <OdooControlPanel
        breadcrumb={['系统', '用户管理']}
        permanentActions={[
          { label: '新建用户', onClick: openAdd },
          { label: '刷新', onClick: load },
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
            加载中...
          </div>
        )}
        {!loading && (
          <div className="bg-white border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead style={{ background: '#f3eff5', borderBottom: '1px solid #ddd' }}>
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">用户</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">邮箱</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">角色</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">状态</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">创建时间</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center py-16 text-gray-400 text-sm">
                      暂无用户
                    </td>
                  </tr>
                )}
                {filtered.map(u => (
                  <UserRow
                    key={u.id}
                    u={u}
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
            <DialogTitle style={{ color: PURPLE }}>{editingId ? '编辑用户' : '新建用户'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label htmlFor="u-name">姓名 *</Label>
              <Input
                id="u-name"
                className="mt-1"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="如 张三"
              />
            </div>
            {!editingId && (
              <div>
                <Label htmlFor="u-email">邮箱 *</Label>
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
                <Label>邮箱</Label>
                <p className="mt-1 text-sm text-gray-500 font-mono">{form.email}</p>
                <p className="text-xs text-gray-400">邮箱创建后不可修改</p>
              </div>
            )}
            <div>
              <Label>角色 *</Label>
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
                <Label htmlFor="u-pass">初始密码 * <span className="text-gray-400 font-normal text-xs">（至少 6 位）</span></Label>
                <Input
                  id="u-pass"
                  type="password"
                  className="mt-1"
                  value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  placeholder="输入初始密码"
                  autoComplete="new-password"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>取消</Button>
            <Button
              onClick={handleSave}
              disabled={saving}
              style={{ background: PURPLE, borderColor: PURPLE }}
              className="text-white hover:opacity-90"
            >
              {saving ? '保存中…' : (editingId ? '保存修改' : '确认新建')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pwdDialogOpen} onOpenChange={v => { setPwdDialogOpen(v) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle style={{ color: PURPLE }}>修改密码 — {pwdUser?.name}</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-4">
            <p className="text-xs text-gray-400">{pwdUser?.email}</p>
            <div>
              <Label htmlFor="admin-new-pwd">新密码 <span className="text-gray-400 font-normal text-xs">（至少 6 位）</span></Label>
              <Input
                id="admin-new-pwd"
                type="password"
                className="mt-1"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="输入新密码"
                autoComplete="new-password"
              />
            </div>
            <div>
              <Label htmlFor="admin-confirm-pwd">确认新密码</Label>
              <Input
                id="admin-confirm-pwd"
                type="password"
                className="mt-1"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder="再次输入新密码"
                autoComplete="new-password"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPwdDialogOpen(false)} disabled={savingPwd}>取消</Button>
            <Button
              onClick={handleChangePwd}
              disabled={savingPwd}
              style={{ background: '#d97706', borderColor: '#d97706' }}
              className="text-white hover:opacity-90"
            >
              {savingPwd ? '保存中…' : '确认修改'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
