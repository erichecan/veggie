import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  comboMatches, formatCombo, isTypingTarget, parseCombo,
  type KeyboardEventLike,
} from '../lib/hotkeys'

/** 造一个按键事件，默认所有修饰键抬起 */
function ev(key: string, mods: Partial<KeyboardEventLike> = {}): KeyboardEventLike {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }
}

// ─── 解析 ──────────────────────────────────────────────────────────────────

test('parseCombo 解析修饰键，顺序与大小写都不影响结果', () => {
  const a = parseCombo('mod+shift+s')
  const b = parseCombo('SHIFT+Mod+S')
  assert.deepEqual(a, b)
  assert.equal(a.key, 's')
  assert.equal(a.mod, true)
  assert.equal(a.shift, true)
  assert.equal(a.alt, false)
})

test('parseCombo 归一化具名键的各种写法', () => {
  assert.equal(parseCombo('esc').key, 'Escape')
  assert.equal(parseCombo('ESCAPE').key, 'Escape')
  assert.equal(parseCombo('enter').key, 'Enter')
  assert.equal(parseCombo('arrowdown').key, 'ArrowDown')
  assert.equal(parseCombo('del').key, 'Delete')
})

test('需要 shift 才能打出的字符会被标记 shiftImplied', () => {
  assert.equal(parseCombo('?').shiftImplied, true)
  assert.equal(parseCombo('s').shiftImplied, false)
  assert.equal(parseCombo('1').shiftImplied, false)
})

// ─── 平台映射：写死任意一侧都会让另一类平台按不出来 ────────────────────────

test('mod 在 mac 上映射 ⌘、在其他平台映射 Ctrl', () => {
  const combo = parseCombo('mod+s')
  assert.equal(comboMatches(combo, ev('s', { metaKey: true }), true), true, 'mac + ⌘S 应命中')
  assert.equal(comboMatches(combo, ev('s', { ctrlKey: true }), false), true, 'win + Ctrl+S 应命中')
})

test('mac 上按 Ctrl+S 不得触发本该 ⌘+S 的动作', () => {
  const combo = parseCombo('mod+s')
  assert.equal(comboMatches(combo, ev('s', { ctrlKey: true }), true), false)
})

test('非 mac 上按 ⌘（Win 键）+S 不得触发 mod+s', () => {
  const combo = parseCombo('mod+s')
  assert.equal(comboMatches(combo, ev('s', { metaKey: true }), false), false)
})

test('组合没要求的修饰键必须是抬起的', () => {
  const combo = parseCombo('s')
  assert.equal(comboMatches(combo, ev('s'), true), true)
  assert.equal(comboMatches(combo, ev('s', { metaKey: true }), true), false)
  assert.equal(comboMatches(combo, ev('s', { altKey: true }), true), false)
})

// ─── shift 语义：'?' 必须在真实键盘上匹配得上 ─────────────────────────────

test("'?' 命中时不比对 shiftKey —— 该字符本身就要按住 shift 才打得出", () => {
  const combo = parseCombo('?')
  assert.equal(comboMatches(combo, ev('?', { shiftKey: true }), true), true)
  assert.equal(comboMatches(combo, ev('?'), true), true, '某些布局下不报 shiftKey，也应命中')
})

test('显式写 shift+ 时才严格比对 shiftKey', () => {
  const combo = parseCombo('shift+Enter')
  assert.equal(comboMatches(combo, ev('Enter', { shiftKey: true }), true), true)
  assert.equal(comboMatches(combo, ev('Enter'), true), false)
})

test('主键大小写不影响匹配（按 shift 时 event.key 会变大写）', () => {
  const combo = parseCombo('mod+s')
  assert.equal(comboMatches(combo, ev('S', { metaKey: true, shiftKey: false }), true), true)
})

// ─── 展示 ──────────────────────────────────────────────────────────────────

test('formatCombo 按平台渲染成给人看的样子', () => {
  assert.equal(formatCombo('mod+s', true), '⌘S')
  assert.equal(formatCombo('mod+s', false), 'Ctrl+S')
  assert.equal(formatCombo('alt+n', true), '⌥N')
  assert.equal(formatCombo('alt+n', false), 'Alt+N')
  assert.equal(formatCombo('Escape', true), 'Escape')
})

test('formatCombo 不给 shiftImplied 的字符再画一个 ⇧', () => {
  assert.equal(formatCombo('?', true), '?')
  assert.equal(formatCombo('shift+Enter', true), '⇧Enter')
})

// ─── 打字让路 ──────────────────────────────────────────────────────────────

test('文本输入元素上视为正在打字', () => {
  assert.equal(isTypingTarget({ tagName: 'INPUT', type: 'text' }), true)
  assert.equal(isTypingTarget({ tagName: 'input' }), true, '默认 type 是 text')
  assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true)
  assert.equal(isTypingTarget({ tagName: 'SELECT' }), true)
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true)
})

test('勾选框/按钮类 input 不算在打字，快捷键该照常生效', () => {
  assert.equal(isTypingTarget({ tagName: 'INPUT', type: 'checkbox' }), false)
  assert.equal(isTypingTarget({ tagName: 'INPUT', type: 'radio' }), false)
  assert.equal(isTypingTarget({ tagName: 'INPUT', type: 'submit' }), false)
})

test('普通元素与 null 不算在打字', () => {
  assert.equal(isTypingTarget({ tagName: 'DIV' }), false)
  assert.equal(isTypingTarget({ tagName: 'BUTTON' }), false)
  assert.equal(isTypingTarget(null), false)
  assert.equal(isTypingTarget(undefined), false)
})
