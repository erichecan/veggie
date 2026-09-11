/**
 * lib/print-export.ts
 * 统一打印弹窗工具 —— 新开窗口渲染一段 HTML 表格后调用 window.print()。
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function openPrintWindow(title: string, bodyHtml: string) {
  // ⛔ 不能传 noopener——规范要求传了就返回 null（拿不到句柄写不进内容），
  // 这里是自己写的同源空白窗口，没有第三方 URL，不存在需要 noopener 防的风险。
  const win = window.open('', '_blank')
  if (!win) return
  win.document.write(`<!DOCTYPE html><html><head><title>${escapeHtml(title)}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 12px; margin: 20px; }
  h2 { font-size: 16px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #875A7B; color: white; padding: 6px 8px; text-align: left; font-size: 11px; }
  td { padding: 5px 8px; border-bottom: 1px solid #eee; font-size: 11px; }
  tr:nth-child(even) td { background: #faf5ff; }
  .total-row td { font-weight: bold; border-top: 2px solid #875A7B; }
  @media print { body { margin: 0; } }
</style></head><body>${bodyHtml}<script>window.print();<\/script></body></html>`)
  win.document.close()
  win.focus()
}
