/**
 * 地理计算纯函数（台账 C7）
 *
 * 这层的风险不是算错，是**算出来的东西被当成实测值用**。所以除了距离本身，
 * 也钉住「估算必须自报家门」这件事。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { haversineKm, estimateRoute, formatRouteSummary } from '../lib/geo'

// 都柏林几个真实坐标，用来对已知距离
const SPIRE = { lat: 53.3498, lng: -6.2603 }        // 市中心尖塔
const DUN_LAOGHAIRE = { lat: 53.2939, lng: -6.1350 }  // 东南约 9.5 km
const CORK = { lat: 51.8985, lng: -8.4756 }           // 西南约 220 km

describe('haversineKm', () => {
  test('同一点距离为 0', () => {
    assert.equal(haversineKm(SPIRE, SPIRE), 0)
  })

  test('都柏林市中心 → 邓莱里 ≈ 9.5 km', () => {
    const d = haversineKm(SPIRE, DUN_LAOGHAIRE)
    assert.ok(d > 9 && d < 10.5, `实得 ${d.toFixed(2)} km`)
  })

  test('都柏林 → 科克 ≈ 220 km（长距离也不失真）', () => {
    const d = haversineKm(SPIRE, CORK)
    assert.ok(d > 215 && d < 230, `实得 ${d.toFixed(1)} km`)
  })

  test('对称：A→B == B→A', () => {
    assert.equal(
      haversineKm(SPIRE, CORK).toFixed(6),
      haversineKm(CORK, SPIRE).toFixed(6),
    )
  })

  test('跨经度 180 度不产生荒谬值', () => {
    const d = haversineKm({ lat: 0, lng: 179.9 }, { lat: 0, lng: -179.9 })
    assert.ok(d < 30, `跨日期变更线应是短距离，实得 ${d.toFixed(1)} km`)
  })
})

describe('estimateRoute', () => {
  test('少于 2 个点没有"路线"可言 → null', () => {
    assert.equal(estimateRoute([]), null)
    assert.equal(estimateRoute([SPIRE]), null)
  })

  test('两点路线：里程含绕行系数，比直线长', () => {
    const straight = haversineKm(SPIRE, DUN_LAOGHAIRE)
    const est = estimateRoute([SPIRE, DUN_LAOGHAIRE])!
    assert.ok(est.totalDistanceKm > straight, '实际道路不可能短于直线')
    assert.ok(est.totalDistanceKm < straight * 1.6, '绕行系数不该离谱')
  })

  test('时长 = 行驶 + 每站停留，站点越多时长越长', () => {
    const two = estimateRoute([SPIRE, DUN_LAOGHAIRE])!
    const three = estimateRoute([SPIRE, DUN_LAOGHAIRE, SPIRE])!
    assert.ok(three.totalDurationMin > two.totalDurationMin)
    assert.equal(two.stopCount, 2)
    assert.equal(three.stopCount, 3)
  })

  test('⛔ 永远标记 estimated —— 不能被当成实际道路里程', () => {
    assert.equal(estimateRoute([SPIRE, CORK])!.estimated, true)
  })

  test('同一批点顺序不同，里程不同（顺序即送货顺序，不做重排）', () => {
    const a = estimateRoute([SPIRE, DUN_LAOGHAIRE, CORK])!
    const b = estimateRoute([SPIRE, CORK, DUN_LAOGHAIRE])!
    assert.notEqual(a.totalDistanceKm, b.totalDistanceKm)
  })
})

describe('formatRouteSummary', () => {
  test('不足一小时用分钟', () => {
    assert.equal(formatRouteSummary(12.3, 45), '12.3 km / 45 min')
  })
  test('超过一小时换算成小时', () => {
    assert.equal(formatRouteSummary(60, 90), '60.0 km / 1.5 h')
  })
  test('估算值前面带「约」，不让人误当实测', () => {
    assert.ok(formatRouteSummary(12.3, 45, true).startsWith('约 '))
    assert.ok(!formatRouteSummary(12.3, 45, false).startsWith('约'))
  })
})
