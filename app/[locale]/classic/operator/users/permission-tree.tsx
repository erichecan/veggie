'use client'
/**
 * 权限点勾选树：模块组 → 模块 → 动作，父节点有半选态。
 *
 * 用原生 input[type=checkbox] 而不是 UI 库的 Checkbox —— 半选（indeterminate）
 * 是 DOM 属性不是 HTML 属性，只能用 ref 设。自己控这一层比跟组件库较劲省事。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CatalogGroup, PermissionCatalog } from './rbac-client'

const PURPLE = '#875A7B'

type TriState = 'on' | 'off' | 'partial'

function TriCheckbox({ state, disabled, onToggle }: {
  state: TriState
  disabled?: boolean
  onToggle: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'partial'
  }, [state])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === 'on'}
      disabled={disabled}
      onChange={onToggle}
      className="w-4 h-4 shrink-0 cursor-pointer accent-[#875A7B] disabled:cursor-not-allowed disabled:opacity-40"
      style={{ accentColor: PURPLE }}
    />
  )
}

function stateOf(ids: string[], selected: Set<string>): TriState {
  if (ids.length === 0) return 'off'
  let hit = 0
  for (const id of ids) if (selected.has(id)) hit++
  return hit === 0 ? 'off' : hit === ids.length ? 'on' : 'partial'
}

function GroupBlock({ group, selected, disabled, isEn, onSet }: {
  group: CatalogGroup
  selected: Set<string>
  disabled: boolean
  isEn: boolean
  onSet: (ids: string[], on: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const groupIds = useMemo(
    () => group.modules.flatMap((m) => m.actions.map((a) => a.id)),
    [group],
  )
  const gState = stateOf(groupIds, selected)
  const picked = groupIds.filter((id) => selected.has(id)).length

  return (
    <div className="border-b border-gray-100 last:border-b-0">
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-50/70">
        <TriCheckbox
          state={gState}
          disabled={disabled}
          onToggle={() => onSet(groupIds, gState !== 'on')}
        />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex-1 flex items-center gap-2 text-left text-sm font-semibold"
          style={{ color: PURPLE }}
        >
          <span className="text-gray-400 text-xs w-3">{open ? '▾' : '▸'}</span>
          {isEn ? group.labelEn : group.labelZh}
          <span className="text-xs font-normal text-gray-400">
            {picked}/{groupIds.length}
          </span>
        </button>
      </div>

      {open && group.modules.map((m) => {
        const modIds = m.actions.map((a) => a.id)
        const mState = stateOf(modIds, selected)
        return (
          <div key={m.module} className="pl-8 pr-3 py-1.5 flex items-start gap-2 hover:bg-gray-50">
            <div className="pt-0.5">
              <TriCheckbox
                state={mState}
                disabled={disabled}
                onToggle={() => onSet(modIds, mState !== 'on')}
              />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-gray-700">
                {isEn ? m.labelEn : m.labelZh}
                <span className="ml-1.5 font-mono text-[10px] text-gray-300">{m.module}</span>
              </div>
              {m.note && <div className="text-[11px] text-amber-600 mt-0.5">{m.note}</div>}
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {m.actions.map((a) => {
                  const on = selected.has(a.id)
                  return (
                    <label
                      key={a.id}
                      className={`flex items-center gap-1.5 text-xs ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
                    >
                      <TriCheckbox
                        state={on ? 'on' : 'off'}
                        disabled={disabled}
                        onToggle={() => onSet([a.id], !on)}
                      />
                      <span className={on ? 'text-gray-800' : 'text-gray-500'}>
                        {isEn ? a.labelEn : a.labelZh}
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function PermissionTree({ catalog, selected, disabled = false, isEn, onChange }: {
  catalog: PermissionCatalog
  selected: Set<string>
  disabled?: boolean
  isEn: boolean
  onChange: (next: Set<string>) => void
}) {
  const [keyword, setKeyword] = useState('')

  function onSet(ids: string[], on: boolean) {
    if (disabled) return
    const next = new Set(selected)
    for (const id of ids) { if (on) next.add(id); else next.delete(id) }
    onChange(next)
  }

  const kw = keyword.trim().toLowerCase()
  const groups = kw
    ? catalog.groups
        .map((g) => ({
          ...g,
          modules: g.modules.filter(
            (m) =>
              m.module.toLowerCase().includes(kw) ||
              m.labelZh.includes(keyword.trim()) ||
              m.labelEn.toLowerCase().includes(kw),
          ),
        }))
        .filter((g) => g.modules.length > 0)
    : catalog.groups

  const allIds = catalog.groups.flatMap((g) => g.modules.flatMap((m) => m.actions.map((a) => a.id)))

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 bg-white">
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder={isEn ? 'Filter modules…' : '筛选模块…'}
          className="flex-1 text-xs px-2 py-1 border border-gray-200 rounded outline-none focus:border-gray-400"
        />
        <span className="text-xs text-gray-400">
          {isEn ? 'Selected' : '已选'} <b style={{ color: PURPLE }}>{selected.size}</b> / {catalog.total}
        </span>
        {!disabled && (
          <>
            <button
              type="button"
              onClick={() => onChange(new Set(allIds))}
              className="text-xs hover:underline"
              style={{ color: PURPLE }}
            >
              {isEn ? 'All' : '全选'}
            </button>
            <button
              type="button"
              onClick={() => onChange(new Set())}
              className="text-xs text-gray-500 hover:underline"
            >
              {isEn ? 'None' : '清空'}
            </button>
          </>
        )}
      </div>
      <div className="max-h-[46vh] overflow-y-auto bg-white">
        {groups.length === 0 && (
          <div className="py-10 text-center text-xs text-gray-400">
            {isEn ? 'No module matches the filter' : '没有匹配的模块'}
          </div>
        )}
        {groups.map((g) => (
          <GroupBlock
            key={g.key}
            group={g}
            selected={selected}
            disabled={disabled}
            isEn={isEn}
            onSet={onSet}
          />
        ))}
      </div>
    </div>
  )
}
