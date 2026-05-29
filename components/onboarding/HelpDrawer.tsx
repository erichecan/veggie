'use client'
import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'

// ─── Role-specific help content ───────────────────────────────────────────────

interface HelpItem {
  q: string
  a: string
}

interface RoleHelp {
  label: string
  emoji: string
  intro: string
  tips: HelpItem[]
}

const ROLE_HELP: Record<string, RoleHelp> = {
  OPERATOR: {
    label: '运营控制台',
    emoji: '🏭',
    intro: '运营控制台覆盖从代客下单到开票的完整业务流程，以下是各环节的快速操作提示。',
    tips: [
      {
        q: '① 代客下单：如何替餐馆下单？',
        a: '进入「下单」页面 → 在顶部选择客户 → 按分类浏览商品并加入购物车 → 确认数量后点「提交订单」→ 选择付款方式（转账 / 司机现收）→ 确认下单。订单自动进入「待处理」状态。',
      },
      {
        q: '② 处理订单：如何生成拣货波次？',
        a: '进入「订单」页面 → 勾选一批待处理订单（可全选）→ 点「生成拣货波次」→ 系统自动汇总拣货清单并通知拣货员开始作业。一个订单只能属于一个波次。',
      },
      {
        q: '③ 分货：拣货完成后如何分货？',
        a: '拣货员提交完成后，进入「分货」页面 → 按波次找到对应任务 → 将拣好的商品按各餐馆订单分装到对应箱子 → 确认各餐馆实际数量后完成分货，系统自动生成配送行程。',
      },
      {
        q: '④ 配送：如何指定司机并跟踪配送？',
        a: '进入「配送单」→ 点击橙色「待指定司机」的行程 → 展开「指定司机」面板 → 选择司机和出发时间 → 点「确认指定」。司机登录后可查看行程并逐站确认送达。',
      },
      {
        q: '⑤ 发票：配送完成后如何开票？',
        a: '配送完成后系统自动生成发票草稿。进入「发票」页面 → 核对实际送达数量和金额 → 点「确认发票」完成开票。发票状态变为「已开票」，记入客户应收账款。',
      },
      {
        q: '整体流程是什么？',
        a: '下单 → 生成波次 → 拣货 → 分货 → 指派司机 → 司机配送签收 → 自动生成发票 → 确认开票。可在「业务流程图」页面查看完整可视化流程图。',
      },
    ],
  },

  RESTAURANT: {
    label: '在线采购',
    emoji: '🍜',
    intro: '欢迎使用在线采购平台！以下是下单相关的常见问题。',
    tips: [
      {
        q: '如何快速找到想要的商品？',
        a: '使用左侧分类栏按蔬菜类型筛选，或在搜索框输入商品名称。价格已自动显示您的专属价格。',
      },
      {
        q: '购物车里的商品能修改数量吗？',
        a: '可以。在购物车右侧直接点击数量旁的「+」/「-」按钮，或直接输入数量，实时更新合计金额。',
      },
      {
        q: '支付方式有哪些？',
        a: '目前支持两种方式：💳 线上转账（下单后按账期结算）和 💵 司机现收（送货时向司机支付现金）。',
      },
      {
        q: '如何查看订单是否已配送？',
        a: '在顶部「我的订单」页面查看所有订单，状态会从「待拣货」→「配送中」→「已送达」自动更新。',
      },
    ],
  },

  PICKER: {
    label: '拣货作业',
    emoji: '📦',
    intro: '拣货系统帮助你快速完成波次任务。以下是操作中常见的问题。',
    tips: [
      {
        q: '怎么知道哪些波次是分配给我的？',
        a: '登录后自动显示分配给你的波次列表，状态为「待拣货」的需要尽快处理，「进行中」表示已开始作业。',
      },
      {
        q: '实际拣货数量与订单不符怎么办？',
        a: '在拣货界面直接修改数量输入框，填入实际拣出的数量。系统会记录差异并自动通知运营人员处理。',
      },
      {
        q: '完成后需要做什么操作？',
        a: '所有商品勾选完毕后，点击底部「提交完成」按钮，波次状态自动变为「已完成」，仓库主管会看到通知。',
      },
    ],
  },

  DRIVER: {
    label: '配送作业',
    emoji: '🚛',
    intro: '配送系统帮助你按行程高效完成今日配送。以下是常见问题。',
    tips: [
      {
        q: '怎么看今天要送哪些地方？',
        a: '登录后「我的行程」页面显示所有分配给你的行程，包含餐馆名称、地址和预计出发时间。',
      },
      {
        q: '到达餐馆后怎么操作？',
        a: '展开该站点 → 核对商品清单 → 填写实收金额 → 点「拍照签收」上传签收照片 → 点「确认送达」完成该站。',
      },
      {
        q: '餐馆拒收某件商品怎么处理？',
        a: '在商品清单旁修改实际送达数量，填入备注说明原因，再点「确认送达」。异常会同步通知运营处理。',
      },
      {
        q: '全部送完后需要做什么？',
        a: '所有站点确认送达后，点击「行程完成」按钮结束今日行程，系统自动汇总收款和签收记录。',
      },
    ],
  },
}

// ─── Component ────────────────────────────────────────────────────────────────

interface HelpDrawerProps {
  role: string
  onReplayTour?: () => void
}

export default function HelpDrawer({ role, onReplayTour }: HelpDrawerProps) {
  const [open, setOpen] = useState(false)
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const drawerRef = useRef<HTMLDivElement>(null)

  const help = ROLE_HELP[role]

  // Close on ESC
  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    // slight delay to avoid closing immediately on button click
    const t = setTimeout(() => {
      document.addEventListener('mousedown', handleClick)
    }, 100)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', handleClick)
    }
  }, [open])

  if (!help) return null

  return (
    <>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(o => !o)}
        aria-label="打开帮助中心"
        title="帮助"
        className="w-7 h-7 rounded-full border border-gray-200 bg-white hover:bg-emerald-50 hover:border-emerald-300 text-gray-500 hover:text-emerald-700 text-sm font-bold flex items-center justify-center transition-all shadow-sm"
      >
        ?
      </button>

      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-[990] bg-black/20"
          aria-hidden="true"
        />
      )}

      {/* Drawer */}
      <div
        ref={drawerRef}
        className={`fixed top-0 right-0 z-[991] h-full w-80 bg-white shadow-2xl border-l border-gray-200 flex flex-col transition-transform duration-300 ease-in-out ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="bg-emerald-700 px-5 py-4 shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xl">{help.emoji}</span>
              <span className="text-white font-semibold text-sm">{help.label} · 帮助</span>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="text-emerald-200 hover:text-white transition-colors text-lg leading-none"
              aria-label="关闭"
            >
              ×
            </button>
          </div>
          <p className="text-emerald-200 text-xs mt-2 leading-relaxed">{help.intro}</p>
        </div>

        {/* FAQ list */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">常见问题</p>
          {help.tips.map((item, idx) => (
            <div key={idx} className="border border-gray-100 rounded-xl overflow-hidden">
              <button
                onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
                className="w-full text-left px-3.5 py-3 flex items-center justify-between gap-2 hover:bg-gray-50 transition-colors"
              >
                <span className="text-xs font-medium text-gray-800 leading-snug">{item.q}</span>
                <span className={`text-gray-400 text-sm shrink-0 transition-transform duration-200 ${expandedIdx === idx ? 'rotate-180' : ''}`}>
                  ↓
                </span>
              </button>
              {expandedIdx === idx && (
                <div className="px-3.5 pb-3.5 pt-0">
                  <p className="text-xs text-gray-600 leading-relaxed border-t border-gray-50 pt-2">
                    {item.a}
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Footer actions */}
        <div className="border-t border-gray-100 px-4 py-4 shrink-0 space-y-2">
          {onReplayTour && (
            <button
              onClick={() => {
                setOpen(false)
                onReplayTour()
              }}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-medium text-emerald-700 border border-emerald-200 rounded-xl hover:bg-emerald-50 transition-colors"
            >
              <span>▶</span> 重新播放新手引导
            </button>
          )}
          <Link
            href="/classic/operator/help"
            onClick={() => setOpen(false)}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-medium text-gray-600 border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors"
          >
            <span>📖</span> 查看完整帮助文档
          </Link>
        </div>
      </div>
    </>
  )
}
