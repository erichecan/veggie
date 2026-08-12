import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  LOSS_STAGES,
  LOSS_STAGE_HINT,
  LOSS_STAGE_LABEL,
  LOSS_STAGE_LABEL_EN,
  inferStageFromReason,
  isLossStage,
  summarizeByStage,
} from '../lib/loss-attribution'
import { SCRAP_REASONS } from '../lib/scrap-reasons'

describe('环节目录', () => {
  test('每个环节都有中英标签和责任提示（漏一个界面上就是 undefined）', () => {
    for (const s of LOSS_STAGES) {
      assert.ok(LOSS_STAGE_LABEL[s], `${s} 缺中文标签`)
      assert.ok(LOSS_STAGE_LABEL_EN[s], `${s} 缺英文标签`)
      assert.ok(LOSS_STAGE_HINT[s], `${s} 缺责任提示`)
    }
  })

  test('需求点名的三个环节都在（分拣/运输/仓储）', () => {
    for (const s of ['SORTING', 'TRANSPORT', 'STORAGE']) {
      assert.ok((LOSS_STAGES as readonly string[]).includes(s), `缺少环节 ${s}`)
    }
  })

  test('只认白名单，伪造值一律不通过（接口据此返回 400）', () => {
    assert.equal(isLossStage('SORTING'), true)
    assert.equal(isLossStage('sorting'), false)
    assert.equal(isLossStage(''), false)
    assert.equal(isLossStage(undefined), false)
  })
})

describe('历史行按原因反推环节', () => {
  test('客退类 → 客退环节', () => {
    assert.equal(inferStageFromReason('CUSTOMER_RETURN_EXPIRED'), 'CUSTOMER_RETURN')
    assert.equal(inferStageFromReason('CUSTOMER_RETURN_DAMAGED'), 'CUSTOMER_RETURN')
  })

  test('到货即损坏 → 收货环节（这条决定能不能向供应商索赔）', () => {
    assert.equal(inferStageFromReason('RECEIPT_DAMAGE'), 'RECEIPT')
  })

  test('仓库过期/损坏 → 仓储环节', () => {
    assert.equal(inferStageFromReason('WAREHOUSE_EXPIRY'), 'STORAGE')
    assert.equal(inferStageFromReason('WAREHOUSE_DAMAGE'), 'STORAGE')
  })

  test('⛔ 推不出来时返回 null，不能塞进「其他」假装已归因', () => {
    assert.equal(inferStageFromReason('OTHER'), null)
    assert.equal(inferStageFromReason(null), null)
    assert.equal(inferStageFromReason(''), null)
  })

  test('每个既有原因要么能推出环节、要么明确推不出 —— 不许抛错', () => {
    for (const r of SCRAP_REASONS) {
      const stage = inferStageFromReason(r)
      assert.ok(stage === null || isLossStage(stage), `${r} 推出了非法环节 ${stage}`)
    }
  })
})

describe('按环节汇总', () => {
  test('SCRAP 流水的负数量按绝对值统计（看板要的是「损失了多少」）', () => {
    const rows = summarizeByStage([{ qty: -12, lossStage: 'SORTING' }])
    assert.equal(rows[0].qty, 12)
  })

  test('结构化环节优先于按原因推断', () => {
    // 原因写着「仓库过期」（推断会是仓储），但录入时明确选了分拣 —— 以录入的为准
    const rows = summarizeByStage([{ qty: -5, lossStage: 'SORTING', lossReason: 'WAREHOUSE_EXPIRY' }])
    assert.equal(rows[0].stage, 'SORTING')
    assert.equal(rows[0].inferredQty, 0, '明确填的不算推断')
  })

  test('历史行计入推断量，与明确填写的分开计数', () => {
    const rows = summarizeByStage([
      { qty: -3, lossStage: 'STORAGE' },                      // 明确
      { qty: -7, lossStage: null, lossReason: 'WAREHOUSE_EXPIRY' }, // 推断
    ])
    const storage = rows.find(r => r.stage === 'STORAGE')!
    assert.equal(storage.qty, 10)
    assert.equal(storage.inferredQty, 7)
  })

  test('推不出环节的归入 UNKNOWN（未归因），不并进任何真实环节', () => {
    const rows = summarizeByStage([{ qty: -4, lossStage: null, lossReason: 'OTHER' }])
    assert.equal(rows[0].stage, 'UNKNOWN')
    assert.equal(rows[0].stageLabel, '未归因')
  })

  test('note 反解出来的原因只作兜底，结构化 lossReason 优先', () => {
    const rows = summarizeByStage([
      { qty: -6, lossStage: null, lossReason: 'RECEIPT_DAMAGE', fallbackReason: 'WAREHOUSE_EXPIRY' },
    ])
    assert.equal(rows[0].stage, 'RECEIPT')
  })

  test('按数量倒序，合计等于各行绝对值之和', () => {
    const rows = summarizeByStage([
      { qty: -1, lossStage: 'SORTING' },
      { qty: -9, lossStage: 'TRANSPORT' },
      { qty: -5, lossStage: 'STORAGE' },
    ])
    assert.deepEqual(rows.map(r => r.stage), ['TRANSPORT', 'STORAGE', 'SORTING'])
    assert.equal(rows.reduce((s, r) => s + r.qty, 0), 15)
  })

  test('空输入返回空数组，不报错也不造行', () => {
    assert.deepEqual(summarizeByStage([]), [])
  })
})
