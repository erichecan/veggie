/**
 * 快捷键组合的解析与匹配 —— 纯函数，不碰 DOM，可直接单测。
 *
 * 为什么单独成文件：匹配逻辑里有两个容易写错、且错了很难被人肉发现的点
 * （见下面 shift 与 mod 的注释）。放在 React hook 里就只能靠手点验证，
 * 而手点恰恰验不出「某个键盘布局下 shift 状态不一致」这类问题。
 */

export interface KeyboardEventLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export interface ParsedCombo {
  /** 归一化后的主键：单字符统一小写，具名键保留原样（Enter / Escape / ArrowDown…） */
  key: string
  /** mod = macOS 上的 ⌘，其他平台的 Ctrl */
  mod: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  /**
   * 主键本身是否是「需要 shift 才能打出来的字符」（如 ? : _）。
   * 这类组合不能再去比对 shiftKey —— 字符本身已经蕴含了 shift。
   */
  shiftImplied: boolean
}

const NAMED_KEYS = new Set([
  'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
])

/** 归一化具名键的大小写，让 'escape' / 'ESC' / 'Escape' 都能写 */
function normalizeNamed(raw: string): string | null {
  const lower = raw.toLowerCase()
  if (lower === 'esc') return 'Escape'
  if (lower === 'space' || lower === ' ') return 'Space'
  if (lower === 'del') return 'Delete'
  for (const k of NAMED_KEYS) if (k.toLowerCase() === lower) return k
  return null
}

/**
 * 解析 "mod+s" / "alt+n" / "shift+Enter" / "?" 这样的组合串。
 * 修饰键顺序无所谓，大小写无所谓。
 */
export function parseCombo(combo: string): ParsedCombo {
  const parts = combo.split('+').map(p => p.trim()).filter(Boolean)
  const result: ParsedCombo = {
    key: '', mod: false, ctrl: false, alt: false, shift: false, shiftImplied: false,
  }

  for (const part of parts) {
    switch (part.toLowerCase()) {
      case 'mod': case 'cmdorctrl': result.mod = true; continue
      case 'ctrl': case 'control':  result.ctrl = true; continue
      case 'alt': case 'option':    result.alt = true; continue
      case 'shift':                 result.shift = true; continue
    }
    const named = normalizeNamed(part)
    if (named) { result.key = named; continue }
    // 单字符主键统一小写，比对时用 event.key.toLowerCase()
    result.key = part.length === 1 ? part.toLowerCase() : part
  }

  // 需要按住 shift 才能打出的字符（? ! : 等），其 shift 状态由字符本身承载。
  // 若还要求 event.shiftKey === false，「?」在任何键盘上都永远匹配不上。
  if (result.key.length === 1 && !/[a-z0-9]/.test(result.key)) {
    result.shiftImplied = true
  }

  return result
}

/**
 * 判断一次按键是否命中某个组合。
 *
 * isMac 决定 mod 映射到 metaKey 还是 ctrlKey —— 写死任意一个都会让另一类平台
 * 的用户按不出快捷键，而这种问题在开发者自己的机器上永远复现不了。
 */
export function comboMatches(parsed: ParsedCombo, e: KeyboardEventLike, isMac: boolean): boolean {
  const eventKey = e.key.length === 1 ? e.key.toLowerCase() : e.key
  const wantKey = parsed.key === 'Space' ? ' ' : parsed.key
  const gotKey = e.key === ' ' ? ' ' : eventKey
  if (wantKey !== gotKey) return false

  // 对 metaKey / ctrlKey 各自算出期望值再逐一比对。
  // 不这么写的话很容易漏掉「组合没要求的修饰键必须是抬起的」这一半，
  // 结果就是 mac 上按 Ctrl+S 误触发了本该 ⌘+S 才有的保存。
  const wantMeta = isMac ? parsed.mod : false
  const wantCtrl = isMac ? parsed.ctrl : (parsed.mod || parsed.ctrl)

  if (e.metaKey !== wantMeta) return false
  if (e.ctrlKey !== wantCtrl) return false
  if (parsed.alt !== e.altKey) return false
  if (!parsed.shiftImplied && parsed.shift !== e.shiftKey) return false

  return true
}

/** 按平台把组合串渲染成给人看的样子：mod+s → ⌘S / Ctrl+S */
export function formatCombo(combo: string, isMac: boolean): string {
  const p = parseCombo(combo)
  const out: string[] = []
  if (p.mod)   out.push(isMac ? '⌘' : 'Ctrl')
  if (p.ctrl)  out.push(isMac ? '⌃' : 'Ctrl')
  if (p.alt)   out.push(isMac ? '⌥' : 'Alt')
  if (p.shift && !p.shiftImplied) out.push(isMac ? '⇧' : 'Shift')

  const keyLabel = p.key === 'Space' ? 'Space'
    : p.key.length === 1 ? p.key.toUpperCase()
    : p.key
  out.push(keyLabel)

  return isMac ? out.join('') : out.join('+')
}

/**
 * 焦点是否落在「用户正在打字」的元素上。
 *
 * 参数刻意收成最小形状而不是 HTMLElement，这样单测里传个普通对象就能验，
 * 不用起 jsdom。
 */
export function isTypingTarget(
  el: { tagName?: string; isContentEditable?: boolean; type?: string } | null | undefined,
): boolean {
  if (!el) return false
  if (el.isContentEditable) return true
  const tag = (el.tagName ?? '').toUpperCase()
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    // checkbox / radio / button 类 input 上按 N 不算在打字，快捷键该照常生效
    const t = (el.type ?? 'text').toLowerCase()
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range'].includes(t)
  }
  return false
}
