'use client'
import { useState } from 'react'
import { DriverCashBoard } from '@/components/accounting/DriverCashBoard'
import { WriteOffBoard } from '@/components/accounting/WriteOffBoard'
import { MissingReturnsQuery } from '@/components/accounting/MissingReturnsQuery'

const FLOW_STEPS = [
  { step: 1, icon: '📋', title: '确认已送订单', desc: '查看当日所有已确认（CONFIRMED）的订单，这些货已出仓' },
  { step: 2, icon: '🚚', title: '司机带回签收单/现金', desc: '司机送货回来后，签收单（纸质）与收款交到会计手里' },
  { step: 3, icon: '💰', title: '钱：核对后确认', desc: '按司机核对现金/转账金额，无误后点「确认」——真正入账，不可撤销' },
  { step: 4, icon: '📷', title: '单：扫码标记待确认', desc: '扫码枪逐单扫，比对今日所有送出去的单，扫中先标记「待确认」' },
  { step: 5, icon: '✅', title: '单：确认核销 / 退回核实', desc: '核对无误点「确认核销」；单据有问题点「退回核实」并写明原因' },
]

/**
 * 会计核销：原「司机交账」「司机对账」「会计核销」三个独立入口（20260924）合并
 * 成这一个页面，钱和单各自成一块，见 DEV-PLAN 20260924-会计核销重构-tasks.md。
 * 20260925：从独立顶层路由 /classic/accounting 搬进 /classic/finance/accounting，
 * 跟发票/供应商账单/对账单共用同一套财务模块布局，不再有自己单独的导航栏
 * （之前每次从财务其它页面点过来都会整个导航条重新挂载，体验上像切去另一个系统）。
 */
export default function AccountingPage() {
  const [showGuide, setShowGuide] = useState(true)
  const [businessDate, setBusinessDate] = useState<string | null>(null)

  return (
    <div className="space-y-4">
      <div className="bg-white rounded border border-gray-200 shadow-sm overflow-hidden">
        <button className="w-full flex items-center justify-between px-5 py-3 bg-gray-50 hover:bg-gray-100 transition-colors" onClick={() => setShowGuide(g => !g)}>
          <span className="font-semibold text-gray-700 text-sm">📌 会计核销业务流程指引</span>
          <span className="text-xs" style={{ color: '#875A7B' }}>{showGuide ? '收起 ▲' : '展开 ▼'}</span>
        </button>
        {showGuide && (
          <div className="px-5 py-4 grid grid-cols-5 gap-3">
            {FLOW_STEPS.map((s, i) => (
              <div key={s.step} className="relative flex flex-col items-center text-center">
                {i < FLOW_STEPS.length - 1 && (
                  <div className="absolute top-5 left-[calc(50%+20px)] w-[calc(100%-20px)] h-0.5 bg-gray-200 -z-0" />
                )}
                <div className="w-10 h-10 rounded-full bg-gray-100 border-2 border-gray-300 flex items-center justify-center text-lg z-10">{s.icon}</div>
                <div className="mt-2 text-xs font-semibold text-gray-700">{s.title}</div>
                <div className="mt-1 text-xs text-gray-500 leading-tight">{s.desc}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <DriverCashBoard onBusinessDate={setBusinessDate} />
      <WriteOffBoard businessDate={businessDate} />
      {businessDate && <MissingReturnsQuery today={businessDate} />}
    </div>
  )
}
