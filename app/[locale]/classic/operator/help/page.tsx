'use client'
import { useState, useMemo } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'

// ─── Content ──────────────────────────────────────────────────────────────────

interface HelpArticle {
  id: string
  title: string
  steps?: string[]
  note?: string
  tip?: string
}

interface HelpSection {
  id: string
  title: string
  emoji: string
  articles: HelpArticle[]
}

interface HelpRole {
  id: string
  label: string
  emoji: string
  sections: HelpSection[]
}

const HELP_CONTENT_ZH: HelpRole[] = [
  {
    id: 'operator',
    label: '销售人员',
    emoji: '🏭',
    sections: [
      {
        id: 'op-dispatch-console',
        title: '配送调度中心（派车 · 打印锁定）',
        emoji: '🚚',
        articles: [
          {
            id: 'op-dispatch-flow',
            title: '散户流程：派车 → 打印锁定（止于「已排车」）',
            steps: [
              '【① 进入配送中心】销售电话接单后录入系统（含客户要的交货日期），与客户核对无误点「确认」。此时库存被锁定（预留，不是真实扣减），订单状态为「已确认 CONFIRMED」，出现在订单页面等待派车。此刻订单的每个小车都是深灰色，代表未派司机。',
              '【② 派车】在配送调度台，从左侧「未分配」把订单拖到某个司机的列，小车由深灰变绿，代表已派司机。当一张订单的所有小车都变绿，就是「分配完成」，订单状态自动从「已确认」升级为「已排车 WAVE_ASSIGNED」（界面显示「司机分配结束」）。',
              '【③ 打印锁定】打印员锁定订单并打印拣货单，被锁的小车变琥珀色，这张车的内容和司机归属就冻结了。注意：打印锁定只改小车颜色、不改订单状态，订单一直是「已排车」。锁是每个小车各自独立的，所以同一订单可以有的绿、有的琥珀。要改被锁的部分，必须先解锁。',
            ],
            note: '当前流程到「已排车」为止：派完车、打印锁定后，订单就一直停在「已排车」，线下继续分拣、装车、配送，但系统状态不再往后走。系统里虽然还有「配送中 / 已完成 / 锁定」这些后续状态，但因为当前没人点「确认出发」，实际不会走到，生产数据里也不会出现。',
            tip: '小车就是订单的货按「司机+批次」拆出来的配送单元，一辆车对应一个司机。三种颜色：深灰=未派司机、绿色=已派未锁、琥珀=打印锁定（内容冻结）。',
          },
          {
            id: 'op-dispatch-errors',
            title: '配送调度：拦截与报错速查',
            steps: [
              '把订单拖到已锁定（琥珀色）的司机列，系统会弹「该车已锁定,无法分配」并拒绝。正确做法：换一台未锁的车，或先给目标车解锁。',
              '改动已锁定订单的内容或订单行，返回 409「订单已进入拣货流程,内容与车辆已锁定,无法修改」。正确做法：先解锁，再修改。',
              '给已锁定订单换车（改派），同样返回 409 拒绝（内容与车辆已锁定）。正确做法：先解锁，再改派。',
              '取消一张订单后，已取消订单不进销售汇总和日报（列表与打印口径一致）。',
            ],
            note: '「锁定」代表拣货流程已经开始，内容与车辆归属被冻结，这是保护拣货准确性的闸门。任何修改都必须先解锁。',
          },
          {
            id: 'op-dispatch-unlock',
            title: '解锁：要改动被锁定的订单怎么办',
            steps: [
              '锁定是怎么来的：① 打印员打印拣货单时，系统自动给该批次上锁；② 也可以在「打印中心」手动点「锁定」。上锁后该批次的小车变琥珀色，订单内容和司机归属被冻结。',
              '去哪解锁：进入「日销售管理中心」的「打印中心」，找到对应批次，「锁定 / 解锁」是一对开关，点「解锁」即可，成功会提示「已解锁」。',
              '谁能解锁：系统上任何已登录用户都能解锁；但按工作约定，调度台遇到锁定批次会提示「请到打印中心 / 找打印员解锁」，通常由打印员统一在打印中心操作。',
              '解锁之后：小车从琥珀色恢复，就能重新改派司机、改订单内容、增删订单行了。改完若要继续拣货，重新打印拣货单会再次自动上锁。',
            ],
            note: '对一个没有锁定的批次点「解锁」，会提示「该批次未锁定」。锁定 / 解锁是保护拣货准确性的开关：拣货中锁住防止有人误改，要改就先解锁、改完重打拣货单再锁。',
            tip: '记住三步：先到「打印中心」解锁 → 回配送调度台改（改派 / 改内容）→ 重打拣货单会自动重新上锁。',
          },
        ],
      },
      {
        id: 'op-workflow',
        title: '完整业务流程',
        emoji: '🔄',
        articles: [
          {
            id: 'op-workflow-overview',
            title: '从下单到开票：完整操作流程一览',
            steps: [
              '【下单】餐馆自助下单，或销售在「下单」页面代客下单，选好商品提交。',
              '【接单】进入「订单」页面，查看状态为「待处理」的新订单，确认内容无误。',
              '【生成波次】勾选一批待处理订单 → 点「生成拣货波次」，系统汇总拣货清单并通知仓库。',
              '【拣货】拣货员在仓库按波次清单逐行拣货，填入实际数量后提交完成。',
              '【分货】进入「分货」页面，将拣好的商品按各餐馆订单分装到对应箱子，确认数量。',
              '【指派司机】进入「配送单」，为橙色「待指定司机」的行程选择司机和出发时间，点「确认指定」。',
              '【配送签收】司机按行程逐站送货，餐馆核对商品后签收，司机拍照上传并确认送达。',
              '【开票】配送完成后系统自动生成发票草稿，销售核对后点「确认发票」完成开票。',
            ],
            tip: '整个流程环环相扣，每步完成后下一步状态自动更新。可在「业务流程图」页面查看可视化全图。',
          },
          {
            id: 'op-place-order',
            title: '① 代客下单：替餐馆提交订单',
            steps: [
              '进入顶部导航「下单」页面。',
              '在页面顶部的客户选择栏中，选择要代下单的餐馆名称。',
              '系统自动加载该客户的专属价格表，页面显示其个性化价格。',
              '按左侧分类浏览商品，点「+ 加入购物车」，在购物车中调整数量。',
              '确认商品和数量无误后，点「提交订单」。',
              '选择付款方式：💳 线上转账（按账期结算）或 💵 司机现收（送货时收现金）。',
              '点「确认下单」，订单生成，状态显示为「待处理」。',
            ],
            note: '代客下单后，餐馆客户在其「我的订单」页面也能看到此笔订单记录。',
          },
          {
            id: 'op-order-to-wave',
            title: '② 接单处理：确认订单并生成拣货波次',
            steps: [
              '进入「订单」页面，状态为「待处理」的订单需要尽快处理。',
              '点击订单可查看详细商品清单，确认内容无误。',
              '勾选需要合并处理的订单（同一批次配送的订单建议合并为一个波次）。',
              '点击「生成拣货波次」按钮，系统自动汇总所有商品并生成波次。',
              '在「拣货波次」页面将波次分配给对应的拣货员。',
            ],
            note: '一个订单只能加入一个波次，已加入波次的订单无法重复选取。',
          },
          {
            id: 'op-sorting',
            title: '③ 分货：将拣好的商品分装到各餐馆',
            steps: [
              '待拣货员提交波次完成后，进入「分货」页面。',
              '找到对应波次的分货任务，点击进入。',
              '页面按餐馆分组，显示每家餐馆需要的商品和数量。',
              '将仓库中已拣好的商品，按餐馆标签分装到各自的箱子或托盘中。',
              '如实际数量与订单不符，在对应行修改实际数量并填写备注。',
              '所有餐馆分货完成后，点「完成分货」，系统自动生成配送行程。',
            ],
          },
          {
            id: 'op-trip-assign',
            title: '④ 配送：指定司机并跟踪配送进度',
            steps: [
              '进入「配送单」页面，找到状态为橙色「待指定司机」的行程。',
              '点击该行程，在详情中展开「指定司机」面板。',
              '从下拉菜单中选择负责该行程的司机。',
              '填写预计出发时间（给司机的参考时间节点）。',
              '点「确认指定」，司机登录后即可看到并接受行程。',
              '配送过程中，可在「配送单」页面实时查看每个站点的送达状态。',
            ],
            tip: '可同时创建多条行程并分配给不同司机，系统支持多司机并行配送。',
          },
          {
            id: 'op-invoice',
            title: '⑤ 开票：确认发票并完成账务',
            steps: [
              '司机完成所有站点配送后，系统根据实际送达数量自动生成发票草稿。',
              '进入「发票」页面，找到状态为「草稿」的发票。',
              '核对发票上的商品、数量和金额是否与实际配送一致。',
              '如有差异（如餐馆拒收），点击发票行进入详情修改对应数量。',
              '确认无误后点「确认发票」，发票状态变为「已开票」。',
              '已开票的金额自动记入该客户的应收账款，可在财务报表中查看。',
            ],
            note: '发票一旦确认无法直接修改，如需更正请先点「重置为草稿」后再编辑。',
          },
        ],
      },
      {
        id: 'op-products',
        title: '商品管理',
        emoji: '📦',
        articles: [
          {
            id: 'op-product-create',
            title: '如何新建商品',
            steps: [
              '进入顶部导航「商品管理」页面。',
              '点击右上角「+ 新建商品」按钮，弹出新建表单。',
              '填写商品名称、销售单位（如 公斤、颗、扎）、默认价格。',
              '点击图片区域上传商品图片（建议尺寸 400×400，JPG/PNG）。',
              '点「保存」创建商品，此时状态为「草稿」，餐馆暂时看不到。',
              '回到商品列表，点击该商品行右侧「激活上架」按钮，状态变为「在售」，餐馆即可下单。',
            ],
            note: '只有「在售」状态的商品才会在餐馆下单界面显示。',
          },
          {
            id: 'op-product-edit',
            title: '修改商品价格或信息',
            steps: [
              '在商品列表页面，点击任意商品所在行即可进入编辑模式。',
              '修改需要更改的字段（名称、单位、价格、图片等）。',
              '点「保存」立即生效，价格更改对餐馆实时可见。',
            ],
            tip: '如果需要为特定客户单独定价，请使用「价格表」和「客户定价」功能，而不是修改商品默认价格。',
          },
          {
            id: 'op-product-fields',
            title: '字段说明',
            steps: [
              'Internal Reference（内部编码）：SKU 编号，用于内部追踪，不显示给客户。格式自定义，如 VEG-001。',
              'Commission Price（提成基准价）：用于计算销售人员提成的基准价格，不影响客户显示价格。',
              'Customer Taxes（客户税率）：默认 13.5% VAT，对应爱尔兰食品税率，系统自动计算含税价格。',
            ],
          },
        ],
      },
      {
        id: 'op-pricing',
        title: '价格表与定价',
        emoji: '💰',
        articles: [
          {
            id: 'op-pricelist-create',
            title: '创建价格表',
            steps: [
              '进入顶部导航「价格表」页面。',
              '点「+ 新建价格表」，填写名称（如"大客户折扣"）和生效日期。',
              '在价格表详情中逐行添加商品，设置该表的价格规则。',
              '计算类型说明：「固定价」直接设定每单位价格；「折扣」基于商品售价百分比打折；「公式」基于成本价加价计算。',
              '点「保存」完成创建，价格表此时还未关联给任何客户。',
            ],
            note: '价格表是模板，需要在「客户定价」页面关联给具体客户才会生效。',
          },
          {
            id: 'op-pricing-customer',
            title: '为客户分配价格表',
            steps: [
              '进入「客户定价」页面，左侧列出所有餐馆客户。',
              '点击要设置的客户，右侧显示该客户当前价格配置。',
              '在「关联价格表」下拉菜单中选择已创建的价格表。',
              '如需为该客户单独覆盖某个商品的价格，在「单品专属覆盖」区域添加商品并输入价格。',
              '点「保存」生效，客户下次下单时自动使用新价格。',
            ],
          },
          {
            id: 'op-pricing-tiered',
            title: '设置阶梯定价',
            steps: [
              '在价格表商品行中，找到「Min. Quantity（最小数量）」字段。',
              '设置数量阈值：只有客户订购数量达到此值时，该价格才生效。',
              '例如：设置 1 公斤 = €3.00，5 公斤 = €2.70，表示购买 5 公斤及以上享受更低单价。',
              '可以为同一商品添加多行不同数量阈值，系统自动匹配最合适的价格。',
            ],
          },
        ],
      },
      {
        id: 'op-customers',
        title: '客户管理',
        emoji: '👥',
        articles: [
          {
            id: 'op-customer-create',
            title: '新增餐馆客户',
            steps: [
              '进入「客户管理」页面，点右上角「+ 新增客户」。',
              '填写餐馆名称、联系人、电话、配送地址。',
              '税号格式：IE + 7位数字 + 1-2字母（如 IE1234567T）。',
              '选择付款方式：现付（每单送达时付款）/ 周结 / 月结。',
              '设置信用额度（0 = 不限）：客户欠款超过此值时系统会发出警告。',
              '点「保存」完成新增。',
            ],
          },
          {
            id: 'op-customer-commission',
            title: '设置佣金率',
            steps: [
              '在客户详情页找到「佣金率」字段，填入 0–100 之间的百分比。',
              '例如填入 5 表示该客户订单金额的 5% 作为销售佣金。',
              '在「财务」页面可查看每位客户汇总的应付佣金总额。',
            ],
            tip: '佣金率只影响财务报表，不影响客户看到的商品价格。',
          },
        ],
      },
      {
        id: 'op-waves',
        title: '拣货波次',
        emoji: '🗂️',
        articles: [
          {
            id: 'op-wave-what',
            title: '什么是波次？',
            steps: [
              '波次（Wave）是一批需要同时拣货的订单集合。',
              '将多张订单合并为一个波次，拣货员可以按商品品类统一拣货，减少仓库内走动路线，显著提升效率。',
              '每个波次会生成一张拣货单，列出所有需要拣出的商品及总数量。',
            ],
          },
          {
            id: 'op-wave-create',
            title: '创建拣货波次',
            steps: [
              '进入「订单管理」页面，查看状态为「待处理」的订单。',
              '勾选需要合并的订单（可全选）。',
              '点「生成拣货波次」按钮，系统自动创建波次并汇总拣货清单。',
              '在「拣货波次」页面可以查看已创建的波次，并将其分配给拣货员。',
            ],
            note: '一个订单只能属于一个波次，已加入波次的订单不可重复选取。',
          },
        ],
      },
      {
        id: 'op-trips',
        title: '配送行程',
        emoji: '🚛',
        articles: [
          {
            id: 'op-trip-create',
            title: '创建配送行程',
            steps: [
              '生成拣货波次时，系统会自动预建对应的配送行程。',
              '进入「配送行程」页面，找到橙色「待指定司机」状态的行程。',
              '点击行程，在详情弹窗中展开「指定司机」面板。',
              '从下拉菜单选择司机，设置预计出发时间。',
              '点「确认指定」完成分配，司机登录后即可看到行程。',
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'restaurant',
    label: '餐馆',
    emoji: '🍜',
    sections: [
      {
        id: 'rest-ordering',
        title: '如何下单',
        emoji: '🛒',
        articles: [
          {
            id: 'rest-order-steps',
            title: '下单完整流程',
            steps: [
              '登录后进入「商品选购」页面，左侧按蔬菜类别筛选商品。',
              '找到需要的商品，点「加入购物车」，可调整数量后再加入。',
              '右侧购物车区域确认商品列表和数量，点「+」「-」微调，或直接输入数量。',
              '确认无误后点「提交订单」按钮。',
              '选择支付方式：💳 线上转账 或 💵 司机现收（送货时交现金给司机）。',
              '点「确认付款」完成下单，订单状态进入「待拣货」。',
            ],
            tip: '页面显示的价格已是您的专属价格（含税），无需手动计算。',
          },
          {
            id: 'rest-order-modify',
            title: '下单后能修改吗？',
            steps: [
              '订单提交后，如状态为「待拣货」，请联系销售人员协助修改或取消。',
              '一旦进入「拣货中」状态，订单已进入仓库作业流程，无法直接修改。',
            ],
            note: '建议在截单时间前完成下单，一般截单时间由销售人员告知。',
          },
        ],
      },
      {
        id: 'rest-orders',
        title: '订单管理',
        emoji: '📋',
        articles: [
          {
            id: 'rest-order-status',
            title: '查看订单状态',
            steps: [
              '点击顶部导航「我的订单」进入订单列表。',
              '每张订单显示下单时间、商品总数、金额和当前状态。',
              '状态说明：「待拣货」→ 已收单，等待仓库处理；「配送中」→ 司机正在配送；「已送达」→ 配送完成。',
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'picker',
    label: '拣货员',
    emoji: '📦',
    sections: [
      {
        id: 'pick-waves',
        title: '拣货波次',
        emoji: '🗂️',
        articles: [
          {
            id: 'pick-view-waves',
            title: '查看分配给我的波次',
            steps: [
              '登录后，系统自动显示分配给你的拣货波次列表。',
              '每个波次显示：波次编号、包含订单数、商品总数量、当前状态。',
              '状态说明：「待拣货」→ 尚未开始；「进行中」→ 已开始作业；「已完成」→ 已提交。',
              '优先处理状态为「待拣货」的波次，按紧急程度排序。',
            ],
          },
          {
            id: 'pick-do-picking',
            title: '完成拣货操作',
            steps: [
              '点击波次进入拣货详情页，页面列出所有需要拣出的商品。',
              '按商品逐行核对：找到对应商品，拣出相应数量。',
              '拣好一样后，勾选该商品复选框，并在数量输入框输入实际拣货数量。',
              '如果某商品库存不足，输入实际能拣出的数量，并在备注栏说明原因。',
              '所有商品处理完毕后，点击底部「提交完成」按钮。',
              '波次状态变为「已完成」，销售人员和分货员会收到通知。',
            ],
            note: '如实际数量与订单不符，必须填写备注说明，方便销售跟进处理。',
          },
        ],
      },
    ],
  },
  {
    id: 'driver',
    label: '司机',
    emoji: '🚛',
    sections: [
      {
        id: 'drv-trips',
        title: '配送行程',
        emoji: '🗺️',
        articles: [
          {
            id: 'drv-view-trips',
            title: '查看今日配送行程',
            steps: [
              '登录后进入「我的行程」页面，显示分配给你的所有行程。',
              '每个行程显示：行程编号、餐馆站数、预计出发时间、状态。',
              '点击行程展开，查看所有配送站点的地址和商品清单。',
              '按照行程顺序依次前往各餐馆完成配送。',
            ],
          },
          {
            id: 'drv-confirm-delivery',
            title: '确认配送完成',
            steps: [
              '到达餐馆后，在行程详情中找到该餐馆站点。',
              '展开该站点，核对商品清单与实际送货内容。',
              '如有退货或数量不符，修改实际送达数量并填写备注。',
              '填写本次收款金额（现金金额）。',
              '点「拍照签收」→ 拍摄餐馆签收单照片或门店照片作为送达凭证。',
              '点「确认送达」完成该站配送，状态变为绿色「已送达」。',
              '重复以上步骤完成所有站点后，点「行程完成」结束今日行程。',
            ],
            tip: '每一站必须完成「确认送达」才能进行下一站，系统会记录每站的送达时间。',
          },
          {
            id: 'drv-abnormal',
            title: '遇到异常情况怎么处理',
            steps: [
              '餐馆拒收某件商品：在商品数量处填入 0，备注说明拒收原因（如"质量问题"、"数量错误"），再确认送达。',
              '客户不在无人收货：拍摄门口照片作为凭证，在备注填写"无人收货"，联系销售人员协调处理。',
              '收款金额有误：据实填入实际收到的金额，如有差异在备注中说明，财务会对账跟进。',
            ],
            note: '所有异常情况都必须在备注中记录说明，方便销售人员后续处理。',
          },
        ],
      },
    ],
  },
]

const HELP_CONTENT_EN: HelpRole[] = [
  {
    id: 'operator',
    label: 'Sales Staff',
    emoji: '🏭',
    sections: [
      {
        id: 'op-dispatch-console',
        title: 'Dispatch Console (Assign Drivers · Print Lock)',
        emoji: '🚚',
        articles: [
          {
            id: 'op-dispatch-flow',
            title: 'Retail Flow: Assign Driver → Print Lock (Stops at "Wave Assigned")',
            steps: [
              '【① Enter the Dispatch Console】After taking a phone order, sales enters it into the system (including the delivery date the customer wants), confirms the details with the customer, and clicks "Confirm". At this point stock is reserved (held, not actually deducted), the order status becomes "Confirmed (CONFIRMED)", and it appears on the Orders page waiting to be assigned a driver. At this stage every "car" for the order is dark gray, meaning no driver has been assigned yet.',
              '【② Assign a Driver】On the Dispatch Console, drag the order from "Unassigned" on the left into a driver\'s column. The car turns from dark gray to green, meaning a driver has been assigned. Once every car for an order is green, that\'s "Assignment Done" — the order status automatically upgrades from "Confirmed" to "Wave Assigned (WAVE_ASSIGNED)" (shown in the UI as "Driver Assigned").',
              '【③ Print Lock】The print operator locks the order and prints the picking list; the locked car turns amber, and that car\'s contents and driver assignment are frozen. Note: a print lock only changes the car\'s color, not the order status — the order stays "Wave Assigned" throughout. Locking is independent per car, so the same order can have some cars green and others amber. To change a locked part, you must unlock it first.',
            ],
            note: 'The current workflow stops at "Wave Assigned": once a driver is assigned and the print lock is applied, the order stays at "Wave Assigned" — sorting, loading, and delivery continue offline, but the system status doesn\'t advance further. The system does have later statuses ("In Delivery / Completed / Locked"), but since no one currently clicks "Confirm Departure", the order never actually reaches them, and they won\'t show up in production data.',
            tip: 'A "car" is the delivery unit an order\'s goods get split into by "driver + batch" — one car corresponds to one driver. Three colors: dark gray = no driver assigned, green = assigned but not locked, amber = print-locked (contents frozen).',
          },
          {
            id: 'op-dispatch-errors',
            title: 'Dispatch Console: Blocks & Error Quick Reference',
            steps: [
              'Dragging an order onto a locked (amber) driver column pops up "This trip is locked, cannot assign" and the drop is rejected. Correct approach: pick a different, unlocked car, or unlock the target car first.',
              'Editing the content or lines of a locked order returns a 409 error: "This order has entered the picking process; its content and driver assignment are locked and cannot be modified." Correct approach: unlock first, then edit.',
              'Reassigning a locked order to a different car also returns a 409 rejection (content and driver assignment are locked). Correct approach: unlock first, then reassign.',
              'Once an order is cancelled, it no longer counts toward sales summaries or the daily report (the list view and printed reports use the same basis).',
            ],
            note: '"Locked" means the picking process has already started, and both content and driver assignment are frozen — this is a gate that protects picking accuracy. Any change requires unlocking first.',
          },
          {
            id: 'op-dispatch-unlock',
            title: 'Unlocking: What to Do When You Need to Change a Locked Order',
            steps: [
              'How a lock happens: ① when the print operator prints a picking list, the system automatically locks that batch; ② you can also manually click "Lock" in the "Print Center". Once locked, that batch\'s cars turn amber, and order content and driver assignment are frozen.',
              'Where to unlock: go to "Print Center" inside the "Daily Sales Center", find the batch, and click "Unlock" — "Lock / Unlock" is a toggle pair. On success you\'ll see "Unlocked".',
              'Who can unlock: any logged-in user on the system can unlock a batch; but by working convention, when the Dispatch Console hits a locked batch it prompts "Please go to the Print Center / ask the print operator to unlock it" — this is normally handled by the print operator at the Print Center.',
              'After unlocking: the car reverts from amber, and you can reassign drivers, edit order content, or add/remove order lines again. If picking needs to continue after your edits, reprinting the picking list automatically re-locks it.',
            ],
            note: 'Clicking "Unlock" on a batch that isn\'t locked shows "This batch is not locked". Lock / Unlock is a switch that protects picking accuracy: it locks during picking to prevent accidental changes — to make a change, unlock first, edit, then re-lock by reprinting the picking list.',
            tip: 'Remember the three steps: unlock at the "Print Center" first → go back to the Dispatch Console to make the change (reassign / edit content) → reprinting the picking list automatically re-locks it.',
          },
        ],
      },
      {
        id: 'op-workflow',
        title: 'Full Business Workflow',
        emoji: '🔄',
        articles: [
          {
            id: 'op-workflow-overview',
            title: 'From Order to Invoice: Full Workflow Overview',
            steps: [
              '【Place Order】The restaurant self-serves an order, or sales places one on the customer\'s behalf on the "Place Order" page, selecting products and submitting.',
              '【Receive Order】Go to the "Orders" page, review new orders with status "Pending", and confirm the content is correct.',
              '【Generate Wave】Select a batch of pending orders → click "Generate Pick Wave"; the system consolidates the picking list and notifies the warehouse.',
              '【Picking】The picker works through the wave\'s list line by line in the warehouse, enters the actual quantities, and submits when done.',
              '【Sorting】Go to the "Sorting" page and pack the picked goods into the correct boxes for each restaurant\'s order, confirming the quantities.',
              '【Assign Driver】Go to "Trips" and, for orange "Driver Not Assigned" trips, choose a driver and departure time, then click "Confirm Assignment".',
              '【Delivery & Sign-off】The driver delivers stop by stop along the trip; the restaurant checks the goods and signs off, and the driver uploads a photo and confirms delivery.',
              '【Invoicing】Once delivery is complete, the system automatically generates a draft invoice; sales reviews it and clicks "Post invoice" to finish invoicing.',
            ],
            tip: 'The whole workflow is chained together — completing each step automatically updates the status for the next. You can view the full visual diagram on the "Workflow Diagram" page.',
          },
          {
            id: 'op-place-order',
            title: '① Place Order on a Customer\'s Behalf: Submit an Order for a Restaurant',
            steps: [
              'Go to the "Place Order" page from the top navigation.',
              'In the customer selector at the top of the page, choose the name of the restaurant you\'re ordering for.',
              'The system automatically loads that customer\'s dedicated pricelist, and the page shows their personalized prices.',
              'Browse products by category on the left, click "+ Add to Cart", and adjust the quantity in the cart.',
              'Once the products and quantities are correct, click "Submit Order".',
              'Choose a payment method: 💳 Online Transfer (settled on account terms) or 💵 Cash on Delivery (driver collects cash at delivery).',
              'Click "Confirm Order" — the order is created with status "Pending".',
            ],
            note: 'After placing the order on the customer\'s behalf, the restaurant customer can also see this order record on their "My Orders" page.',
          },
          {
            id: 'op-order-to-wave',
            title: '② Process Incoming Orders: Confirm and Generate a Pick Wave',
            steps: [
              'Go to the "Orders" page — orders with status "Pending" need to be handled promptly.',
              'Click an order to view its detailed product list and confirm the content is correct.',
              'Check the orders you want to process together (orders in the same delivery batch should be merged into one wave).',
              'Click "Generate Pick Wave" — the system automatically consolidates all products and creates the wave.',
              'On the "Pick Waves" page, assign the wave to the appropriate picker.',
            ],
            note: 'An order can only belong to one wave — orders already in a wave can\'t be selected again.',
          },
          {
            id: 'op-sorting',
            title: '③ Sorting: Pack Picked Goods for Each Restaurant',
            steps: [
              'Once the picker submits the wave as complete, go to the "Sorting" page.',
              'Find the sorting task for that wave and click into it.',
              'The page groups goods by restaurant, showing the products and quantities each restaurant needs.',
              'Pack the picked goods from the warehouse into each restaurant\'s own box or pallet, according to the restaurant labels.',
              'If the actual quantity differs from the order, update the actual quantity on that line and add a note.',
              'Once sorting for all restaurants is done, click "Complete Sorting" — the system automatically generates the delivery trip.',
            ],
          },
          {
            id: 'op-trip-assign',
            title: '④ Delivery: Assign a Driver and Track Delivery Progress',
            steps: [
              'Go to the "Trips" page and find trips with the orange "Driver Not Assigned" status.',
              'Click the trip and expand the "Assign Driver" panel in the detail view.',
              'Select the driver responsible for the trip from the dropdown.',
              'Enter the expected departure time (a reference time for the driver).',
              'Click "Confirm Assignment" — once the driver logs in, they can see and accept the trip.',
              'During delivery, you can view each stop\'s delivery status in real time on the "Trips" page.',
            ],
            tip: 'You can create multiple trips at once and assign them to different drivers — the system supports parallel deliveries across multiple drivers.',
          },
          {
            id: 'op-invoice',
            title: '⑤ Invoicing: Post the Invoice and Complete Accounting',
            steps: [
              'Once the driver completes all stops, the system automatically generates a draft invoice based on the actual delivered quantities.',
              'Go to the "Invoices" page and find invoices with status "Draft".',
              'Check that the products, quantities, and amounts on the invoice match the actual delivery.',
              'If there\'s a discrepancy (e.g. the restaurant refused an item), click the invoice line to open the detail and adjust the quantity.',
              'Once everything checks out, click "Post invoice" — the invoice status becomes "Posted".',
              'Posted amounts are automatically recorded to that customer\'s accounts receivable, viewable in the financial reports.',
            ],
            note: 'Once an invoice is posted it can\'t be edited directly — to make a correction, click "Reset to Draft" first, then edit.',
          },
        ],
      },
      {
        id: 'op-products',
        title: 'Product Management',
        emoji: '📦',
        articles: [
          {
            id: 'op-product-create',
            title: 'How to Create a New Product',
            steps: [
              'Go to the "Products" page from the top navigation.',
              'Click the "+ New Product" button in the top-right corner to open the creation form.',
              'Fill in the product name, sales unit (e.g. kg, piece, bunch), and default price.',
              'Click the image area to upload a product photo (recommended size 400×400, JPG/PNG).',
              'Click "Save" to create the product — it starts as "Draft" status and isn\'t visible to restaurants yet.',
              'Back on the product list, click the "Activate" button on the right of that product\'s row — the status becomes "Active", and restaurants can then order it.',
            ],
            note: 'Only products with "Active" status appear on the restaurant ordering screen.',
          },
          {
            id: 'op-product-edit',
            title: 'Edit Product Price or Info',
            steps: [
              'On the product list page, click any product\'s row to enter edit mode.',
              'Edit the fields you need to change (name, unit, price, image, etc.).',
              'Click "Save" to apply immediately — price changes are visible to restaurants in real time.',
            ],
            tip: 'If you need special pricing for a specific customer, use the "Pricelists" and "Customer Pricing" features instead of changing the product\'s default price.',
          },
          {
            id: 'op-product-fields',
            title: 'Field Reference',
            steps: [
              'Internal Reference: the SKU code used for internal tracking, not shown to customers. Format is free-form, e.g. VEG-001.',
              'Commission Price: the base price used to calculate sales staff commission — it does not affect the price shown to customers.',
              'Customer Taxes: defaults to 13.5% VAT, matching the Irish food tax rate — the system automatically calculates the tax-inclusive price.',
            ],
          },
        ],
      },
      {
        id: 'op-pricing',
        title: 'Pricelists & Pricing',
        emoji: '💰',
        articles: [
          {
            id: 'op-pricelist-create',
            title: 'Create a Pricelist',
            steps: [
              'Go to the "Pricelists" page from the top navigation.',
              'Click "+ New Pricelist", and fill in a name (e.g. "Key Account Discount") and effective date.',
              'In the pricelist detail, add products line by line and set the pricing rules for this list.',
              'Computation type reference: "Fixed Price" sets a direct price per unit; "Discount" applies a percentage off the product\'s selling price; "Formula" computes a markup on top of the cost price.',
              'Click "Save" to finish creating it — at this point the pricelist isn\'t linked to any customer yet.',
            ],
            note: 'A pricelist is a template — it only takes effect once linked to a specific customer on the "Customer Pricing" page.',
          },
          {
            id: 'op-pricing-customer',
            title: 'Assign a Pricelist to a Customer',
            steps: [
              'Go to the "Customer Pricing" page — all restaurant customers are listed on the left.',
              'Click the customer you want to configure — their current pricing setup shows on the right.',
              'In the "Linked Pricelist" dropdown, select an existing pricelist.',
              'If you need to override the price of a specific product just for this customer, add the product in the "Item-Specific Override" section and enter a price.',
              'Click "Save" to apply — the customer will automatically use the new price on their next order.',
            ],
          },
          {
            id: 'op-pricing-tiered',
            title: 'Set Up Tiered Pricing',
            steps: [
              'On a pricelist product line, find the "Min. Quantity" field.',
              'Set a quantity threshold: this price only applies once the customer\'s order quantity reaches this value.',
              'For example: set 1 kg = €3.00 and 5 kg = €2.70, meaning purchases of 5 kg or more get the lower unit price.',
              'You can add multiple lines with different quantity thresholds for the same product — the system automatically matches the most suitable price.',
            ],
          },
        ],
      },
      {
        id: 'op-customers',
        title: 'Customer Management',
        emoji: '👥',
        articles: [
          {
            id: 'op-customer-create',
            title: 'Add a New Restaurant Customer',
            steps: [
              'Go to the "Customers" page and click "+ New Customer" in the top-right corner.',
              'Fill in the restaurant name, contact person, phone number, and delivery address.',
              'VAT number format: IE + 7 digits + 1–2 letters (e.g. IE1234567T).',
              'Choose a payment method: Cash on Delivery (paid at each delivery) / Weekly Terms / Monthly Terms.',
              'Set a credit limit (0 = unlimited): the system will warn you if the customer\'s outstanding balance exceeds this value.',
              'Click "Save" to finish adding the customer.',
            ],
          },
          {
            id: 'op-customer-commission',
            title: 'Set the Commission Rate',
            steps: [
              'On the customer detail page, find the "Commission Rate" field and enter a percentage between 0–100.',
              'For example, entering 5 means 5% of this customer\'s order amount is paid as sales commission.',
              'On the "Finance" page you can view the total commission payable, summarized per customer.',
            ],
            tip: 'The commission rate only affects financial reports — it doesn\'t affect the prices customers see.',
          },
        ],
      },
      {
        id: 'op-waves',
        title: 'Pick Waves',
        emoji: '🗂️',
        articles: [
          {
            id: 'op-wave-what',
            title: 'What Is a Wave?',
            steps: [
              'A wave is a group of orders that need to be picked together.',
              'By merging multiple orders into one wave, the picker can pick by product category all at once, cutting down walking distance in the warehouse and significantly improving efficiency.',
              'Each wave generates a picking list showing all the products that need to be picked and their total quantities.',
            ],
          },
          {
            id: 'op-wave-create',
            title: 'Create a Pick Wave',
            steps: [
              'Go to the "Orders" page and review orders with status "Pending".',
              'Check the orders you want to merge (you can select all).',
              'Click "Generate Pick Wave" — the system automatically creates the wave and consolidates the picking list.',
              'On the "Pick Waves" page you can view created waves and assign them to pickers.',
            ],
            note: 'An order can only belong to one wave — orders already in a wave can\'t be selected again.',
          },
        ],
      },
      {
        id: 'op-trips',
        title: 'Delivery Trips',
        emoji: '🚛',
        articles: [
          {
            id: 'op-trip-create',
            title: 'Create a Delivery Trip',
            steps: [
              'When a pick wave is generated, the system automatically pre-creates the corresponding delivery trip.',
              'Go to the "Trips" page and find trips with the orange "Driver Not Assigned" status.',
              'Click the trip and expand the "Assign Driver" panel in the detail dialog.',
              'Select a driver from the dropdown and set the expected departure time.',
              'Click "Confirm Assignment" to finish — once the driver logs in, they can see the trip.',
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'restaurant',
    label: 'Restaurant',
    emoji: '🍜',
    sections: [
      {
        id: 'rest-ordering',
        title: 'How to Place an Order',
        emoji: '🛒',
        articles: [
          {
            id: 'rest-order-steps',
            title: 'Full Ordering Process',
            steps: [
              'After logging in, go to the "Shop" page — filter products by vegetable category on the left.',
              'Find the product you need and click "Add to Cart" — you can adjust the quantity before adding.',
              'Confirm the product list and quantities in the cart area on the right; use "+" / "-" to fine-tune, or type the quantity directly.',
              'Once everything is correct, click "Submit Order".',
              'Choose a payment method: 💳 Online Transfer or 💵 Cash on Delivery (pay the driver cash at delivery).',
              'Click "Confirm Payment" to complete the order — the order status becomes "Pending Picking".',
            ],
            tip: 'The prices shown on the page are already your dedicated prices (tax included) — no need to calculate manually.',
          },
          {
            id: 'rest-order-modify',
            title: 'Can I Modify an Order After Submitting?',
            steps: [
              'After an order is submitted, if its status is still "Pending Picking", contact your sales rep for help modifying or cancelling it.',
              'Once the order reaches "Picking" status, it has entered the warehouse workflow and can no longer be modified directly.',
            ],
            note: 'We recommend placing your order before the cutoff time — your sales rep will usually let you know what that is.',
          },
        ],
      },
      {
        id: 'rest-orders',
        title: 'Order Management',
        emoji: '📋',
        articles: [
          {
            id: 'rest-order-status',
            title: 'Check Order Status',
            steps: [
              'Click "My Orders" in the top navigation to view your order list.',
              'Each order shows the order time, total item count, amount, and current status.',
              'Status reference: "Pending Picking" → order received, awaiting warehouse processing; "In Delivery" → the driver is on the way; "Delivered" → delivery complete.',
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'picker',
    label: 'Picker',
    emoji: '📦',
    sections: [
      {
        id: 'pick-waves',
        title: 'Pick Waves',
        emoji: '🗂️',
        articles: [
          {
            id: 'pick-view-waves',
            title: 'View Waves Assigned to Me',
            steps: [
              'After logging in, the system automatically shows the list of pick waves assigned to you.',
              'Each wave shows: wave number, number of orders included, total product quantity, and current status.',
              'Status reference: "Pending" → not started yet; "In Progress" → work has started; "Completed" → submitted.',
              'Prioritize waves with "Pending" status, ordered by urgency.',
            ],
          },
          {
            id: 'pick-do-picking',
            title: 'Complete a Picking Task',
            steps: [
              'Click a wave to open its picking detail page, which lists all the products that need to be picked.',
              'Go through the products line by line: locate each product and pick out the required quantity.',
              'Once a product is picked, check its checkbox and enter the actual picked quantity in the quantity field.',
              'If a product is short on stock, enter the quantity you were actually able to pick and explain why in the notes field.',
              'Once all products are handled, click "Submit" at the bottom.',
              'The wave status becomes "Completed", and sales and the sorter will be notified.',
            ],
            note: 'If the actual quantity differs from the order, you must fill in a note explaining why, so sales can follow up.',
          },
        ],
      },
    ],
  },
  {
    id: 'driver',
    label: 'Driver',
    emoji: '🚛',
    sections: [
      {
        id: 'drv-trips',
        title: 'Delivery Trips',
        emoji: '🗺️',
        articles: [
          {
            id: 'drv-view-trips',
            title: 'View Today\'s Delivery Trips',
            steps: [
              'After logging in, go to the "My Trips" page, which shows all trips assigned to you.',
              'Each trip shows: trip number, number of restaurant stops, expected departure time, and status.',
              'Click a trip to expand it and view the address and product list for every delivery stop.',
              'Follow the trip order and visit each restaurant in sequence to complete deliveries.',
            ],
          },
          {
            id: 'drv-confirm-delivery',
            title: 'Confirm Delivery Completion',
            steps: [
              'After arriving at a restaurant, find that stop in the trip detail.',
              'Expand the stop and check the product list against what you\'re actually delivering.',
              'If there\'s a return or a quantity mismatch, update the actual delivered quantity and add a note.',
              'Enter the amount collected at this stop (cash amount).',
              'Click "Photo Sign-off" → take a photo of the restaurant\'s signed receipt or the storefront as proof of delivery.',
              'Click "Confirm Delivered" to complete that stop — the status turns green "Delivered".',
              'Repeat these steps for every stop, then click "Complete Trip" to finish today\'s trip.',
            ],
            tip: 'Every stop must have "Confirm Delivered" completed before you can move to the next — the system records the delivery time for each stop.',
          },
          {
            id: 'drv-abnormal',
            title: 'Handling Unusual Situations',
            steps: [
              'If a restaurant refuses an item: enter 0 in the quantity field, note the reason for refusal (e.g. "quality issue", "wrong quantity"), then confirm delivery.',
              'If no one is available to receive the delivery: take a photo of the doorway as proof, note "no one to receive" in the remarks, and contact sales to coordinate.',
              'If the collected amount is wrong: enter the amount actually received, note any discrepancy in the remarks, and finance will follow up during reconciliation.',
            ],
            note: 'All unusual situations must be recorded in the notes so sales can follow up afterward.',
          },
        ],
      },
    ],
  },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function flatArticles(roles: HelpRole[]) {
  const result: Array<{ role: HelpRole; section: HelpSection; article: HelpArticle }> = []
  for (const role of roles) {
    for (const section of role.sections) {
      for (const article of section.articles) {
        result.push({ role, section, article })
      }
    }
  }
  return result
}

const ODOO_PURPLE = '#875A7B'
const ODOO_PURPLE_LIGHT = '#f3eff2'
const ODOO_PURPLE_BORDER = '#d4c3d0'

// ─── ArticleCard ──────────────────────────────────────────────────────────────

function ArticleCard({ article }: { article: HelpArticle }) {
  return (
    <div className="border border-gray-200 rounded-lg bg-white p-4 shadow-sm">
      <h3 className="font-semibold text-gray-900 text-sm mb-3">{article.title}</h3>
      {article.steps && (
        <ol className="space-y-2">
          {article.steps.map((step, i) => (
            <li key={i} className="flex gap-3 text-xs text-gray-600 leading-relaxed">
              <span
                className="w-5 h-5 rounded-full text-white text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5"
                style={{ background: ODOO_PURPLE }}
              >
                {i + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      )}
      {article.note && (
        <div className="mt-3 flex gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
          <span className="text-amber-500 text-sm shrink-0">⚠️</span>
          <p className="text-xs text-amber-800 leading-relaxed">{article.note}</p>
        </div>
      )}
      {article.tip && (
        <div className="mt-3 flex gap-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2.5">
          <span className="text-blue-500 text-sm shrink-0">💡</span>
          <p className="text-xs text-blue-800 leading-relaxed">{article.tip}</p>
        </div>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ClassicHelpPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const HELP_CONTENT = isEn ? HELP_CONTENT_EN : HELP_CONTENT_ZH

  const [activeRoleId, setActiveRoleId] = useState('operator')
  const [query, setQuery] = useState('')

  const allArticles = useMemo(() => flatArticles(HELP_CONTENT), [HELP_CONTENT])
  const activeRole = HELP_CONTENT.find(r => r.id === activeRoleId)!

  const searchResults = useMemo(() => {
    if (!query.trim()) return null
    const q = query.toLowerCase()
    return allArticles.filter(({ article, section, role }) =>
      article.title.toLowerCase().includes(q) ||
      article.steps?.some(s => s.toLowerCase().includes(q)) ||
      section.title.toLowerCase().includes(q) ||
      role.label.toLowerCase().includes(q)
    )
  }, [query, allArticles])

  return (
    <div className="min-h-screen" style={{ background: '#f9f9f9' }}>
      {/* Page header — Odoo-style purple banner */}
      <div className="px-6 py-5 border-b border-gray-200" style={{ background: ODOO_PURPLE }}>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-white/60 text-xs">{isEn ? 'Sales Console' : '销售控制台'}</span>
          <span className="text-white/40 text-xs">›</span>
          <span className="text-white text-xs font-medium">{isEn ? 'Help Center' : '帮助中心'}</span>
        </div>
        <h1 className="text-xl font-bold text-white mb-0.5">{isEn ? 'Help Center' : '帮助中心'}</h1>
        <p className="text-white/70 text-xs">{isEn ? 'Find operating guides, learn what each module does, and get up to speed with the system quickly.' : '查找操作指南、了解各模块功能，快速上手系统'}</p>

        {/* Search bar */}
        <div className="mt-3 relative max-w-md">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none">🔍</span>
          <input
            type="text"
            placeholder={isEn ? 'Search help articles (e.g. "order", "wave", "price")' : '搜索帮助文档（如"下单"、"波次"、"价格"）'}
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="w-full pl-9 pr-8 py-2 rounded text-sm text-gray-900 bg-white placeholder-gray-400 border-0 outline-none focus:ring-2"
            style={{ '--tw-ring-color': ODOO_PURPLE_BORDER } as React.CSSProperties}
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-lg leading-none"
            >
              ×
            </button>
          )}
        </div>
      </div>

      <div className="flex h-full">
        {/* Left sidebar */}
        <aside className="w-48 shrink-0 border-r border-gray-200 bg-white min-h-[calc(100vh-120px)] py-4 px-3">
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2 px-2">{isEn ? 'Browse by Role' : '按角色浏览'}</p>
          <nav className="space-y-0.5">
            {HELP_CONTENT.map(role => {
              const isActive = activeRoleId === role.id && !searchResults
              return (
                <button
                  key={role.id}
                  onClick={() => { setActiveRoleId(role.id); setQuery('') }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded text-sm font-medium transition-colors text-left"
                  style={
                    isActive
                      ? { background: ODOO_PURPLE_LIGHT, color: ODOO_PURPLE, fontWeight: 600 }
                      : { color: '#555' }
                  }
                >
                  <span className="text-base">{role.emoji}</span>
                  <span>{role.label}</span>
                  {isActive && (
                    <span className="ml-auto w-1 h-4 rounded-full" style={{ background: ODOO_PURPLE }} />
                  )}
                </button>
              )
            })}
          </nav>

          <div className="mt-6 mx-1 p-3 rounded border text-xs leading-relaxed" style={{ background: ODOO_PURPLE_LIGHT, borderColor: ODOO_PURPLE_BORDER, color: ODOO_PURPLE }}>
            <p className="font-semibold mb-1">{isEn ? 'Need more help?' : '还需要帮助？'}</p>
            <p className="opacity-80">{isEn ? <>Click the <strong>?</strong> button in the top-right corner anytime to see quick tips for your current role.</> : <>点击页面右上角 <strong>?</strong> 按钮可随时查看当前角色的快速提示。</>}</p>
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 min-w-0 p-6">
          {searchResults ? (
            /* Search results */
            <div>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-gray-700">
                  {isEn ? `Search "${query}" — ${searchResults.length} results` : `搜索「${query}」— 共 ${searchResults.length} 条结果`}
                </h2>
                <button
                  onClick={() => setQuery('')}
                  className="text-xs hover:underline"
                  style={{ color: ODOO_PURPLE }}
                >
                  {isEn ? 'Clear Search' : '清除搜索'}
                </button>
              </div>
              {searchResults.length === 0 ? (
                <div className="text-center py-20">
                  <div className="text-4xl mb-3">🔍</div>
                  <p className="text-gray-500 text-sm">{isEn ? 'No matching results found, please try different keywords' : '没有找到相关内容，请尝试其他关键词'}</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {searchResults.map(({ role, section, article }) => (
                    <div key={article.id}>
                      <div className="flex items-center gap-2 mb-2">
                        <span
                          className="text-xs font-medium px-2 py-0.5 rounded-full text-white"
                          style={{ background: ODOO_PURPLE }}
                        >
                          {role.emoji} {role.label}
                        </span>
                        <span className="text-xs text-gray-400">→ {section.title}</span>
                      </div>
                      <ArticleCard article={article} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            /* Role content */
            <div>
              <div className="flex items-center gap-2 mb-5">
                <span className="text-2xl">{activeRole.emoji}</span>
                <h2 className="text-lg font-bold text-gray-900">{activeRole.label} — {isEn ? 'User Guide' : '操作指南'}</h2>
              </div>

              <div className="space-y-8">
                {activeRole.sections.map(section => (
                  <div key={section.id}>
                    <div
                      className="flex items-center gap-2 mb-3 pb-2 border-b-2"
                      style={{ borderColor: ODOO_PURPLE_BORDER }}
                    >
                      <span className="text-base">{section.emoji}</span>
                      <h3 className="font-semibold text-base" style={{ color: ODOO_PURPLE }}>
                        {section.title}
                      </h3>
                    </div>
                    <div className="space-y-3">
                      {section.articles.map(article => (
                        <ArticleCard key={article.id} article={article} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
