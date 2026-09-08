/**
 * 打印模板语言切换 — 公共类型
 *
 * 各 `lib/print/*-template.ts` 是纯字符串拼接的服务端/同构函数，不在 React 组件树里，
 * 用不了 next-intl 的 `useTranslations`；改用「每个模板文件内部就近定义一份 zh/en 字典」
 * 的方式（跟 `invoices/[id]/print/page.tsx` 已有的 TERM_LABEL_ZH/EN 思路一致，只是合并
 * 成一个对象）。这个文件只放跨模板共用的类型和「怎么从请求里解析出语言」，不放具体文案。
 */

export type PrintLang = 'zh' | 'en'

/** 非 'en' 一律按 'zh'，保证旧链接/漏传 lang 参数时行为跟改造前逐字一致 */
export function resolvePrintLang(v: string | null | undefined): PrintLang {
  return v === 'en' ? 'en' : 'zh'
}
