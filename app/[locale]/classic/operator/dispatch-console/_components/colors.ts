// 给餐馆分配稳定颜色：同一餐馆名永远同色，用于托盘混装的来源色标
const PALETTE = [
  '#16a34a', '#2563eb', '#d97706', '#7c3aed', '#dc2626',
  '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5',
]

export function restaurantColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}
