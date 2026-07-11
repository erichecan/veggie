'use client'
import Link from 'next/link'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'

const ODOO_PURPLE = '#875A7B'
const ODOO_PURPLE_LIGHT = '#f3eff2'
const ODOO_PURPLE_BORDER = '#d4c3d0'

interface FlowStep {
  id: string
  emoji: string
  title: string
  who: string
  whoColor: string
  desc: string
  href: string
  details: string[]
}

const FLOW_STEPS_ZH: FlowStep[] = [
  {
    id: 'order',
    emoji: '🛒',
    title: '接收 / 代客下单',
    who: '销售',
    whoColor: ODOO_PURPLE,
    desc: '餐馆通过采购平台自助下单，或由销售人员代替餐馆下单。',
    href: '/classic/operator/orders',
    details: [
      '餐馆在线选购商品并提交订单',
      '销售可在「下单」页面代客操作',
      '订单自动进入「待处理」状态',
    ],
  },
  {
    id: 'wave',
    emoji: '🗂️',
    title: '生成拣货波次',
    who: '销售',
    whoColor: ODOO_PURPLE,
    desc: '销售勾选一批待处理订单，合并生成一个拣货波次，分配给仓库拣货员。',
    href: '/classic/operator/dispatch-console',
    details: [
      '勾选订单 → 点「生成拣货波次」',
      '系统汇总所有商品拣货清单',
      '将波次分配给指定拣货员',
    ],
  },
  {
    id: 'pick',
    emoji: '📦',
    title: '仓库拣货',
    who: '拣货员',
    whoColor: '#1d4ed8',
    desc: '拣货员按波次清单在仓库逐行拣货，填写实际数量并提交完成。',
    href: '/classic/operator/dispatch-console',
    details: [
      '拣货员登录后查看分配的波次',
      '按商品清单逐行拣货并填写数量',
      '全部完成后提交，状态变为「已完成」',
    ],
  },
  {
    id: 'sort',
    emoji: '🔀',
    title: '分货装箱',
    who: '销售',
    whoColor: ODOO_PURPLE,
    desc: '按各餐馆订单将拣好的商品分装，生成每车次的配送清单。',
    href: '/classic/operator/sorting',
    details: [
      '将波次商品按订单分拣到不同箱子',
      '确认各餐馆的实际配送数量',
      '生成对应配送行程的装车清单',
    ],
  },
  {
    id: 'trip',
    emoji: '🚛',
    title: '指派司机配送',
    who: '销售',
    whoColor: ODOO_PURPLE,
    desc: '销售在配送单页面为行程指定司机和出发时间，司机登录后即可查看行程。',
    href: '/classic/operator/trips',
    details: [
      '在「配送单」找到橙色待指定行程',
      '展开「指定司机」面板选择司机',
      '设置出发时间并确认',
    ],
  },
  {
    id: 'deliver',
    emoji: '📍',
    title: '司机配送签收',
    who: '司机',
    whoColor: '#be123c',
    desc: '司机按行程顺序逐站送货，餐馆签收后司机拍照确认并填写实收金额。',
    href: '/classic/operator/trips',
    details: [
      '司机打开行程列表，按站点导航',
      '核对商品、填写实收金额、拍照签收',
      '所有站点完成后点「行程完成」',
    ],
  },
  {
    id: 'invoice',
    emoji: '🧾',
    title: '开票与对账',
    who: '销售 / 财务',
    whoColor: '#047857',
    desc: '系统根据实际送达数量自动生成发票草稿，销售确认后发送给餐馆。',
    href: '/classic/operator/invoices',
    details: [
      '配送完成后系统生成发票草稿',
      '核对数量与金额后点「确认发票」',
      '发票状态变为「已开票」，记入应收账款',
    ],
  },
]

const FLOW_STEPS_EN: FlowStep[] = [
  {
    id: 'order',
    emoji: '🛒',
    title: 'Receive / Place Order for Customer',
    who: 'Sales',
    whoColor: ODOO_PURPLE,
    desc: 'Restaurants order self-service through the ordering platform, or sales places the order on their behalf.',
    href: '/classic/operator/orders',
    details: [
      'Restaurant selects items online and submits an order',
      'Sales can place an order on the customer\'s behalf on the "Place Order" page',
      'Order automatically enters "Pending" status',
    ],
  },
  {
    id: 'wave',
    emoji: '🗂️',
    title: 'Generate Pick Wave',
    who: 'Sales',
    whoColor: ODOO_PURPLE,
    desc: 'Sales selects a batch of pending orders and merges them into a pick wave, assigned to a warehouse picker.',
    href: '/classic/operator/dispatch-console',
    details: [
      'Select orders → click "Generate Pick Wave"',
      'System consolidates the picking list for all items',
      'Assigns the wave to a designated picker',
    ],
  },
  {
    id: 'pick',
    emoji: '📦',
    title: 'Warehouse Picking',
    who: 'Picker',
    whoColor: '#1d4ed8',
    desc: 'Picker picks each line item in the warehouse per the wave list, enters actual quantities, and submits when complete.',
    href: '/classic/operator/dispatch-console',
    details: [
      'Picker logs in and views assigned waves',
      'Picks each item line by line and enters quantities',
      'Submits when done; status changes to "Completed"',
    ],
  },
  {
    id: 'sort',
    emoji: '🔀',
    title: 'Sorting & Packing',
    who: 'Sales',
    whoColor: ODOO_PURPLE,
    desc: 'Picked items are sorted and packed per each restaurant\'s order, generating a delivery list for each trip.',
    href: '/classic/operator/sorting',
    details: [
      'Sort wave items into boxes by order',
      'Confirm actual delivery quantities per restaurant',
      'Generate the loading list for the corresponding delivery trip',
    ],
  },
  {
    id: 'trip',
    emoji: '🚛',
    title: 'Assign Driver for Delivery',
    who: 'Sales',
    whoColor: ODOO_PURPLE,
    desc: 'Sales assigns a driver and departure time to the trip on the Trips page; the driver can view the trip after logging in.',
    href: '/classic/operator/trips',
    details: [
      'Find the orange "driver pending" trip on the "Trips" page',
      'Expand the "Assign Driver" panel and select a driver',
      'Set the departure time and confirm',
    ],
  },
  {
    id: 'deliver',
    emoji: '📍',
    title: 'Driver Delivery & Sign-off',
    who: 'Driver',
    whoColor: '#be123c',
    desc: 'The driver delivers stop by stop per the trip order; after the restaurant signs off, the driver takes a photo and confirms the amount received.',
    href: '/classic/operator/trips',
    details: [
      'Driver opens the trip list and navigates stop by stop',
      'Checks items, enters amount received, takes a photo for sign-off',
      'Clicks "Trip Complete" once all stops are done',
    ],
  },
  {
    id: 'invoice',
    emoji: '🧾',
    title: 'Invoicing & Reconciliation',
    who: 'Sales / Accounting',
    whoColor: '#047857',
    desc: 'The system auto-generates a draft invoice based on actual delivered quantities; sales confirms it and sends it to the restaurant.',
    href: '/classic/operator/invoices',
    details: [
      'A draft invoice is generated once delivery is complete',
      'Verify quantities and amounts, then click "Confirm Invoice"',
      'Invoice status becomes "Invoiced" and is recorded in accounts receivable',
    ],
  },
]

export default function ClassicFlowPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const FLOW_STEPS = isEn ? FLOW_STEPS_EN : FLOW_STEPS_ZH

  return (
    <div className="min-h-screen" style={{ background: '#f9f9f9' }}>
      {/* Page header */}
      <div className="px-6 py-5 border-b border-gray-200" style={{ background: ODOO_PURPLE }}>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-white/60 text-xs">{isEn ? 'Sales Console' : '销售控制台'}</span>
          <span className="text-white/40 text-xs">›</span>
          <span className="text-white text-xs font-medium">{isEn ? 'Business Flow' : '业务流程图'}</span>
        </div>
        <h1 className="text-xl font-bold text-white mb-0.5">{isEn ? 'Business Flow' : '业务流程图'}</h1>
        <p className="text-white/70 text-xs">{isEn ? 'The complete supply chain flow from order to invoice — click any step to jump to that module' : '从接单到开票的完整供应链流程 — 点击任意步骤跳转到对应模块'}</p>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-8">

        {/* Legend */}
        <div className="flex flex-wrap gap-4 mb-8 text-xs">
          <span className="font-semibold text-gray-500">{isEn ? 'Roles:' : '角色说明：'}</span>
          {[
            { who: isEn ? 'Sales' : '销售', color: ODOO_PURPLE },
            { who: isEn ? 'Picker' : '拣货员', color: '#1d4ed8' },
            { who: isEn ? 'Driver' : '司机', color: '#be123c' },
            { who: isEn ? 'Accounting' : '财务', color: '#047857' },
          ].map(r => (
            <span key={r.who} className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full" style={{ background: r.color }} />
              <span className="text-gray-600">{r.who}</span>
            </span>
          ))}
        </div>

        {/* Flow steps */}
        <div className="relative">
          {FLOW_STEPS.map((step, idx) => (
            <div key={step.id} className="flex gap-4 mb-0">
              {/* Left: connector line + circle */}
              <div className="flex flex-col items-center w-10 shrink-0">
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center text-xl shrink-0 shadow-sm border-2 border-white"
                  style={{ background: ODOO_PURPLE_LIGHT }}
                >
                  {step.emoji}
                </div>
                {idx < FLOW_STEPS.length - 1 && (
                  <div className="w-0.5 flex-1 min-h-[2rem]" style={{ background: ODOO_PURPLE_BORDER }} />
                )}
              </div>

              {/* Right: card */}
              <div className="flex-1 mb-4">
                <Link
                  href={`${prefix}${step.href}`}
                  className="block bg-white rounded-lg border border-gray-200 p-4 shadow-sm hover:shadow-md transition-all hover:border-gray-300 group"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-semibold text-gray-900 text-sm group-hover:underline">
                          {step.title}
                        </h3>
                        <span
                          className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full text-white shrink-0"
                          style={{ background: step.whoColor }}
                        >
                          {step.who}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 leading-relaxed mb-2">{step.desc}</p>
                      <ul className="space-y-1">
                        {step.details.map((d, i) => (
                          <li key={i} className="flex items-start gap-2 text-xs text-gray-600">
                            <span className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0" style={{ background: step.whoColor }} />
                            {d}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <span className="text-gray-300 group-hover:text-gray-400 text-lg shrink-0 mt-1">›</span>
                  </div>
                </Link>
              </div>
            </div>
          ))}
        </div>

        {/* Footer tip */}
        <div
          className="rounded-lg border p-4 flex items-start gap-3 mt-2"
          style={{ background: ODOO_PURPLE_LIGHT, borderColor: ODOO_PURPLE_BORDER }}
        >
          <span className="text-lg shrink-0">💡</span>
          <div className="text-xs leading-relaxed" style={{ color: ODOO_PURPLE }}>
            {isEn ? (
              <>
                <strong>Tip:</strong> The system follows a linear "Order → Pick → Deliver → Invoice" flow.
                Once each step is completed, the next step&apos;s status updates automatically — no manual intervention needed.
                If you run into issues, check the quick tips for your role via the &quot;<strong>?</strong>&quot; help button in the top right.
              </>
            ) : (
              <>
                <strong>小提示：</strong>系统设计遵循「接单 → 拣货 → 配送 → 开票」的线性流程。
                每个步骤完成后，下一步骤的状态会自动更新，无需手动干预。
                如遇问题可在右上角「<strong>?</strong>」帮助按钮查看当前角色的快速提示。
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
