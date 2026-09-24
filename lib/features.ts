/**
 * 功能开关。
 *
 * DRIVER_APP_ENABLED —— 配送中心的"确认出发 / 在途 / 标记完成"链路开关。
 * 20260924 用户拍板开灯(Dockerfile 里 NEXT_PUBLIC_DRIVER_APP_ENABLED=true)，
 * 之前因司机端 + 拣货 iPad 未上线关闭过，当时仅隐藏前端 UI 入口，
 * 后端 dispatch / complete / createTripFromWave 逻辑一直完整保留。
 *
 * 注意:NEXT_PUBLIC_ 变量在构建时烧录进前端 bundle，改值后需重新构建 + 部署，
 * 运行时改环境变量不生效——开关位置见 Dockerfile 的 builder 阶段。
 */
export const DRIVER_APP_ENABLED = process.env.NEXT_PUBLIC_DRIVER_APP_ENABLED === 'true'
