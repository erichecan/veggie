'use client'
/**
 * 权限总览：角色 × 模块 的只读全景矩阵，供肉眼核对「谁能碰什么」。
 *
 * 格子里放的是**该模块下这个角色勾了几个动作**，而不是简单的有/无 ——
 * 「有」这个字会把「只能看」和「能删」显示成同一个样子，那正是最需要一眼看出的差别。
 */
import { useMemo, useState } from 'react'
import type { PermissionCatalog, RoleRow } from './rbac-client'

const PURPLE = '#875A7B'

export default function MatrixTab({ roles, catalog, loading, isEn }: {
  roles: RoleRow[]
  catalog: PermissionCatalog | null
  loading: boolean
  isEn: boolean
}) {
  const [groupKey, setGroupKey] = useState<string>('')

  const roleSets = useMemo(
    () => new Map(roles.map((r) => [r.id, new Set(r.permissions)])),
    [roles],
  )

  if (loading) {
    return (
      <div className="bg-white border border-gray-200 py-16 text-center text-gray-400">
        {isEn ? 'Loading…' : '加载中…'}
      </div>
    )
  }
  if (!catalog) {
    return (
      <div className="bg-white border border-gray-200 py-16 text-center text-gray-400 text-sm">
        {isEn ? 'Permission catalog unavailable' : '权限点目录加载失败'}
      </div>
    )
  }

  const activeGroup = groupKey || catalog.groups[0]?.key
  const group = catalog.groups.find((g) => g.key === activeGroup) ?? catalog.groups[0]

  return (
    <div>
      <p className="text-xs text-gray-500 mb-3">
        {isEn
          ? 'Each cell shows how many actions of that module the role holds. Hover to see which.'
          : '格子里是该角色在这个模块下勾了几个动作，鼠标悬停能看到具体是哪几个。'}
      </p>

      <div className="flex flex-wrap gap-1.5 mb-3">
        {catalog.groups.map((g) => (
          <button
            key={g.key}
            onClick={() => setGroupKey(g.key)}
            className="px-3 py-1.5 rounded-lg border text-xs font-medium"
            style={g.key === group?.key
              ? { borderColor: PURPLE, background: '#f3eff5', color: PURPLE }
              : { borderColor: '#e5e7eb', color: '#6b7280' }}
          >
            {isEn ? g.labelEn : g.labelZh}
          </button>
        ))}
      </div>

      <div className="bg-white border border-gray-200 overflow-x-auto">
        <table className="text-xs" style={{ minWidth: '100%' }}>
          <thead style={{ background: '#f3eff5', borderBottom: '1px solid #ddd' }}>
            <tr>
              <th className="text-left px-3 py-2 font-medium text-gray-600 sticky left-0 bg-[#f3eff5] z-10 min-w-[180px]">
                {isEn ? 'Module' : '模块'}
              </th>
              {roles.map((r) => (
                <th key={r.id} className="px-2 py-2 font-medium text-gray-600 text-center whitespace-nowrap">
                  {r.isSystem && '🔒'}{r.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {group?.modules.map((m) => (
              <tr key={m.module} className="hover:bg-gray-50">
                <td className="px-3 py-1.5 sticky left-0 bg-white z-10">
                  <div className="text-gray-700">{isEn ? m.labelEn : m.labelZh}</div>
                  <div className="font-mono text-[10px] text-gray-300">{m.module}</div>
                </td>
                {roles.map((r) => {
                  const set = roleSets.get(r.id) ?? new Set<string>()
                  const held = m.actions.filter((a) => set.has(a.id))
                  const all = held.length === m.actions.length
                  return (
                    <td
                      key={r.id}
                      className="px-2 py-1.5 text-center"
                      title={held.length === 0
                        ? (isEn ? 'none' : '无')
                        : held.map((a) => (isEn ? a.labelEn : a.labelZh)).join(' / ')}
                    >
                      {held.length === 0 ? (
                        <span className="text-gray-200">·</span>
                      ) : (
                        <span
                          className="inline-block min-w-[2.2rem] px-1.5 py-0.5 rounded font-medium"
                          style={all
                            ? { background: '#ede9fe', color: '#6d28d9' }
                            : { background: '#f3f4f6', color: '#6b7280' }}
                        >
                          {held.length}/{m.actions.length}
                        </span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
