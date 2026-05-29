'use client'
import { useState, useEffect, useCallback } from 'react'

// ─── Tour step definitions ────────────────────────────────────────────────────

interface TourStep {
  title: string
  description: string
  hint?: string          // optional pointer hint (e.g. "右上角 +" )
  emoji?: string
}

const TOUR_STEPS: Record<string, TourStep[]> = {
  OPERATOR: [
    {
      emoji: '👋',
      title: '欢迎使用运营控制台',
      description: '这是运营控制台，您可以在这里管理商品、客户和订单，监控每日配送进度。',
    },
    {
      emoji: '📦',
      title: '商品管理',
      description: '在"商品管理"页面查看和管理所有蔬菜商品。点击任意商品行即可编辑价格、库存和描述。',
      hint: '👆 顶部导航 → 商品管理',
    },
    {
      emoji: '➕',
      title: '新建商品',
      description: '点击商品列表右上角的「+ 新建商品」按钮，填写名称、单位和价格，上传图片后记得点「激活上架」才能让餐馆看到。',
      hint: '📍 商品管理页面 → 右上角 +',
    },
    {
      emoji: '💰',
      title: '价格表管理',
      description: '在"价格表"页面为不同客户组设置差异化价格，支持固定价、折扣价和阶梯定价。修改后立即对餐馆下单生效。',
      hint: '👆 顶部导航 → 价格表',
    },
    {
      emoji: '🗂️',
      title: '拣货波次',
      description: '收到订单后，在"拣货波次"页面创建波次，将多张订单打包交给拣货员统一处理，提高仓库效率。',
      hint: '👆 顶部导航 → 拣货波次',
    },
    {
      emoji: '🚛',
      title: '配送行程',
      description: '拣货完成后，在"配送行程"页面创建行程并指定司机，司机扫码确认逐站送达，全程可追踪。',
      hint: '👆 顶部导航 → 配送行程',
    },
  ],

  RESTAURANT: [
    {
      emoji: '👋',
      title: '欢迎使用在线采购系统',
      description: '您好！这里是您的在线采购平台。每天可在这里快速下单，无需电话，订单实时同步到仓库。',
    },
    {
      emoji: '🛒',
      title: '浏览并选购商品',
      description: '左侧按分类筛选商品，找到需要的蔬菜后点击「加入购物车」。您的专属价格已自动应用。',
      hint: '📍 当前页面左侧分类栏',
    },
    {
      emoji: '✅',
      title: '确认并提交订单',
      description: '右侧购物车确认商品和数量，选择支付方式（线上转账或司机现收），点「提交订单」完成下单。',
      hint: '📍 页面右侧购物车区域',
    },
    {
      emoji: '📋',
      title: '查看订单历史',
      description: '在「我的订单」页面可查看所有历史订单，追踪配送状态（待拣货→配送中→已送达）。',
      hint: '👆 顶部导航 → 我的订单',
    },
  ],

  PICKER: [
    {
      emoji: '👋',
      title: '欢迎！你是拣货员',
      description: '你的工作是按波次完成仓库拣货任务。每个波次包含若干订单，按单拣出对应商品即可。',
    },
    {
      emoji: '📋',
      title: '查看分配给你的波次',
      description: '这里列出了分配给你的所有拣货波次，显示状态（待拣货/进行中/已完成）和商品总数。点进去开始拣货。',
      hint: '📍 当前波次列表',
    },
    {
      emoji: '✅',
      title: '完成拣货操作',
      description: '进入波次后，逐行查看商品和数量。拣好一样就勾选并输入实际拣货数量，全部完成后点「提交完成」。',
      hint: '📍 波次详情页 → 逐项勾选',
    },
  ],

  DRIVER: [
    {
      emoji: '👋',
      title: '你好，司机！',
      description: '你的工作是按行程完成今日配送任务。每个行程包含多家餐馆，按顺序逐站送达即可。',
    },
    {
      emoji: '🗺️',
      title: '查看今日行程',
      description: '这里显示分配给你的所有配送行程，包含每家餐馆的地址和商品清单。点击行程开始配送。',
      hint: '📍 当前行程列表',
    },
    {
      emoji: '📸',
      title: '确认配送完成',
      description: '到达餐馆后，展开该站点，核对商品清单，填写收款金额，拍照签收后点「确认送达」。全部完成后点「行程完成」。',
      hint: '📍 行程详情 → 逐站确认',
    },
  ],
}

// ─── Component ────────────────────────────────────────────────────────────────

interface GuidedTourProps {
  role: string           // e.g. "OPERATOR", "RESTAURANT", "PICKER", "DRIVER"
  onReplay?: (fn: () => void) => void  // parent can call this to trigger replay
}

export default function GuidedTour({ role, onReplay }: GuidedTourProps) {
  const [visible, setVisible] = useState(false)
  const [step, setStep] = useState(0)

  const steps = TOUR_STEPS[role] ?? []
  const storageKey = `hasSeenTour_${role}`

  const startTour = useCallback(() => {
    setStep(0)
    setVisible(true)
  }, [])

  // Auto-trigger on first visit
  useEffect(() => {
    if (steps.length === 0) return
    const hasSeen = localStorage.getItem(storageKey)
    if (!hasSeen) {
      // Small delay so the page renders first
      const t = setTimeout(() => {
        setVisible(true)
      }, 600)
      return () => clearTimeout(t)
    }
  }, [role, steps.length, storageKey])

  // Expose replay function to parent
  useEffect(() => {
    if (onReplay) {
      onReplay(startTour)
    }
  }, [onReplay, startTour])

  if (!visible || steps.length === 0) return null

  const current = steps[step]
  const isLast = step === steps.length - 1

  function handleNext() {
    if (isLast) {
      handleClose()
    } else {
      setStep(s => s + 1)
    }
  }

  function handlePrev() {
    if (step > 0) setStep(s => s - 1)
  }

  function handleClose() {
    localStorage.setItem(storageKey, '1')
    setVisible(false)
  }

  function handleSkip() {
    localStorage.setItem(storageKey, '1')
    setVisible(false)
  }

  return (
    <>
      {/* Semi-transparent overlay */}
      <div
        className="fixed inset-0 z-[9990] bg-black/50 backdrop-blur-[1px]"
        onClick={handleSkip}
      />

      {/* Tour card — bottom-right corner */}
      <div
        className="fixed z-[9999] bottom-6 right-6 w-80 bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Progress bar */}
        <div className="h-1 bg-gray-100">
          <div
            className="h-full bg-emerald-500 transition-all duration-500"
            style={{ width: `${((step + 1) / steps.length) * 100}%` }}
          />
        </div>

        <div className="px-5 pt-4 pb-5">
          {/* Header row */}
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-2xl">{current.emoji ?? '💡'}</span>
              <span className="text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
                {step + 1} / {steps.length}
              </span>
            </div>
            <button
              onClick={handleSkip}
              className="text-gray-400 hover:text-gray-600 text-xs transition-colors"
              aria-label="跳过引导"
            >
              跳过
            </button>
          </div>

          {/* Content */}
          <h3 className="font-semibold text-gray-900 text-sm mb-1.5">{current.title}</h3>
          <p className="text-gray-600 text-xs leading-relaxed">{current.description}</p>

          {/* Hint */}
          {current.hint && (
            <div className="mt-3 flex items-center gap-1.5 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <span className="text-xs text-amber-700">{current.hint}</span>
            </div>
          )}

          {/* Navigation */}
          <div className="flex items-center justify-between mt-4 gap-2">
            <button
              onClick={handlePrev}
              disabled={step === 0}
              className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors rounded-lg hover:bg-gray-100"
            >
              ← 上一步
            </button>

            <button
              onClick={handleNext}
              className="flex-1 px-4 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-colors"
            >
              {isLast ? '🎉 完成引导' : '下一步 →'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
