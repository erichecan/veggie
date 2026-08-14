/**
 * 订单行录入的键盘流（台账 X7）
 * ============================================================================
 * 客户 20260814：「quotation 或 sale order Edit 时 增加产品 Tab 跳到下个字段，
 * 回车键 下一行。这个与新建订单时功能要一样。」
 *
 * 基准是新建订单页（`place-order` 的 `handleFieldKey`）的两条规则：
 *   · **Enter = 下一行** —— 在任意可编辑字段上按回车，直接去录下一个商品
 *   · **Tab = 下一个字段**，走到本行最后一个字段再 Tab，同样去下一行
 *
 * 编辑态此前是"做了一半"：数量与单价接了 Enter，描述/备注/税率没接；
 * 销售单详情页连税率那格的 Tab 都没有（而报价单有）。两页各写一遍的结果就是
 * 它们自己先不一致 —— 所以这里收口成一个 handler，两页共用。
 *
 * ## 两个必须守住的细节
 *
 * 1. **中文输入法正在选词时的 Enter 不是"下一行"**。备注/描述是文本框，
 *    用中文输入法打字时 Enter 是"确认候选词"。不判 `isComposing` 就拦截的话，
 *    用户每敲完一个词就被弹去下一行，中文根本没法输入。
 *
 * 2. **只有最后一行才拦 Tab**。中间行的原生 Tab 顺序本来就会走到下一行的字段，
 *    拦截会打断"顺着已有多行往下 Tab 逐行改"这个场景。最后一行后面就是
 *    「Add a product」搜索框，拦不拦结果一样，拦是为了跳过中间那些按钮。
 */
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

export interface LineFieldKeyOptions {
  /** 进入下一行 —— 编辑态里就是聚焦「Add a product」搜索框 */
  onNextRow: () => void
  /**
   * 本字段是否是**最后一行的最后一个可编辑字段**。
   * 只有它需要拦 Tab，见文件头第 2 点。
   */
  isLastFieldOfLastRow?: boolean
}

/** 判断这次 Enter 是不是输入法在确认候选词 */
function isComposing(e: ReactKeyboardEvent): boolean {
  const native = e.nativeEvent as unknown as { isComposing?: boolean; keyCode?: number }
  // keyCode 229 是老浏览器表示"输入法处理中"的约定，isComposing 缺失时用它兜底
  return native?.isComposing === true || native?.keyCode === 229
}

/**
 * 生成挂在订单行可编辑字段上的 `onKeyDown`。
 *
 * 刻意不处理 Shift+Tab：反向走位保持浏览器原生行为，改它只会让人找不回上一格。
 */
export function lineFieldKeyHandler(opts: LineFieldKeyOptions) {
  return (e: ReactKeyboardEvent) => {
    if (e.key === 'Enter') {
      if (isComposing(e)) return
      e.preventDefault()
      opts.onNextRow()
      return
    }
    if (e.key === 'Tab' && !e.shiftKey && opts.isLastFieldOfLastRow) {
      e.preventDefault()
      opts.onNextRow()
    }
  }
}
