'use client'
/**
 * useHotkeys - 页面级快捷键 + 「?」提示浮层
 * -----------------------------------------------------------------------
 * 在这之前本项目**没有页面级快捷键**：20 来个文件里的 keydown 全是输入框内的
 * 局部处理（Enter 跳下一格、方向键选下拉项、Tab 回绕），各写各的。缺的不是
 * 「把散的收拢」，而是这一层压根不存在 —— 开单页面每加一行都得把手从键盘挪到
 * 鼠标上。
 *
 * 三条不可省的行为，任何自己手写 keydown 的地方都容易漏：
 *   1. 正在输入框里打字时，无修饰键的快捷键必须让路（否则输入 "n" 就触发新建）
 *   2. 组合要按平台映射（mod = mac 的 ⌘ / 其他平台的 Ctrl），见 lib/hotkeys.ts
 *   3. 按「?」能列出当前页所有快捷键 —— 快捷键最大的问题从来不是难用，是没人知道有
 *
 * 用法：
 *   const { helpOverlay } = useHotkeys([
 *     { combo: 'mod+s', label: '保存', run: handleSave, when: () => canSave },
 *     { combo: 'alt+n', label: '新增一行', run: focusProductSearch },
 *   ])
 *   return <>{...页面内容}{helpOverlay}</>
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { comboMatches, formatCombo, isTypingTarget, parseCombo } from '@/lib/hotkeys'

export interface Hotkey {
  /** 组合串，如 'mod+s' / 'alt+n' / 'Escape'。修饰键顺序与大小写无所谓 */
  combo: string
  /** 给人看的说明，会出现在「?」浮层里 */
  label: string
  /** 浮层里的分组标题，省略则归到「操作」 */
  group?: string
  /** 返回 false 时这条快捷键当次不触发（如保存按钮置灰时） */
  when?: () => boolean
  run: (e: KeyboardEvent) => void
  /** 默认在输入框里打字时不触发；带修饰键的组合不受此限，无需设置本项 */
  allowInInput?: boolean
  /** 不在「?」浮层里列出（如 Escape 这类约定俗成的） */
  hidden?: boolean
}

const HELP_COMBO = '?'

export function useHotkeys(hotkeys: Hotkey[], opts?: { enabled?: boolean }) {
  const enabled = opts?.enabled ?? true
  const [helpOpen, setHelpOpen] = useState(false)

  // 用 ref 存最新的 hotkeys，这样监听器只注册一次；否则每次渲染都要拆/装监听器，
  // 而 hotkeys 数组通常是行内字面量，每次渲染都是新引用 —— 那等于每帧都在重装。
  const ref = useRef(hotkeys)
  ref.current = hotkeys

  // 监听器只注册一次，闭包里读不到最新的 helpOpen，因此另用 ref 镜像一份。
  // 不能在 setHelpOpen 的 updater 里带副作用去判断「浮层是否开着」——
  // StrictMode 下 updater 会被调用两次，那样写出来的判断是不确定的。
  const helpOpenRef = useRef(false)
  helpOpenRef.current = helpOpen

  const isMac = useMemo(
    () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent),
    [],
  )

  useEffect(() => {
    if (!enabled) return

    function onKeyDown(e: KeyboardEvent) {
      const typing = isTypingTarget(e.target as HTMLElement | null)

      // 「?」先处理：它是元操作，且 Escape 要能关掉浮层
      if (!typing && comboMatches(parseCombo(HELP_COMBO), e, isMac)) {
        e.preventDefault()
        setHelpOpen(v => !v)
        return
      }
      // 只在浮层开着时吃掉这次 Escape，否则会抢走弹窗/下拉自己的关闭逻辑
      if (e.key === 'Escape' && helpOpenRef.current) {
        e.preventDefault()
        setHelpOpen(false)
        return
      }

      for (const hk of ref.current) {
        const parsed = parseCombo(hk.combo)
        const hasModifier = parsed.mod || parsed.ctrl || parsed.alt
        if (typing && !hasModifier && !hk.allowInInput) continue
        if (!comboMatches(parsed, e, isMac)) continue
        if (hk.when && !hk.when()) continue
        e.preventDefault()
        hk.run(e)
        return
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled, isMac])

  const helpOverlay = helpOpen
    ? <HotkeyHelpOverlay hotkeys={hotkeys} isMac={isMac} onClose={() => setHelpOpen(false)} />
    : null

  return { helpOpen, setHelpOpen, helpOverlay }
}

function HotkeyHelpOverlay({
  hotkeys, isMac, onClose,
}: { hotkeys: Hotkey[]; isMac: boolean; onClose: () => void }): ReactElement {
  const groups = new Map<string, Hotkey[]>()
  for (const hk of hotkeys) {
    if (hk.hidden) continue
    const g = hk.group ?? '操作'
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(hk)
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="键盘快捷键"
    >
      <div
        className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-lg bg-white p-5 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">键盘快捷键</h2>
          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-sm text-gray-500 hover:bg-gray-100"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        {[...groups.entries()].map(([group, items]) => (
          <div key={group} className="mb-4 last:mb-0">
            <div className="mb-1.5 text-xs font-medium tracking-wide text-gray-400 uppercase">{group}</div>
            <ul className="space-y-1">
              {items.map(hk => (
                <li key={hk.combo} className="flex items-center justify-between gap-4 text-sm">
                  <span className="text-gray-700">{hk.label}</span>
                  <kbd className="shrink-0 rounded border border-gray-300 bg-gray-50 px-1.5 py-0.5 font-mono text-xs text-gray-600">
                    {formatCombo(hk.combo, isMac)}
                  </kbd>
                </li>
              ))}
            </ul>
          </div>
        ))}

        <div className="mt-4 border-t border-gray-100 pt-3 text-xs text-gray-400">
          按 <kbd className="rounded border border-gray-300 bg-gray-50 px-1 font-mono">?</kbd> 随时唤出本表，
          <kbd className="rounded border border-gray-300 bg-gray-50 px-1 font-mono">Esc</kbd> 关闭
        </div>
      </div>
    </div>
  )
}
