/**
 * 功能开关。
 *
 * DRIVER_APP_ENABLED —— 司机端 + 拣货 iPad 尚未上线,配送中心的
 * "确认出发 / 在途 / 标记完成"链路暂时关灯:仅隐藏前端 UI 入口,
 * 后端 dispatch / complete / createTripFromWave 逻辑完整保留。
 * 关灯期配送中心 = 排货台(分配 → 分配完成 → 波次视图,到此为止)。
 *
 * 上线后设环境变量 NEXT_PUBLIC_DRIVER_APP_ENABLED=true 即全链路复活。
 * 注意:NEXT_PUBLIC_ 变量在构建时烧录进前端 bundle,切换值后需重新构建 + 部署,
 * 运行时改环境变量不生效。
 */
export const DRIVER_APP_ENABLED = process.env.NEXT_PUBLIC_DRIVER_APP_ENABLED === 'true'
