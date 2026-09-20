// Next 的 'server-only' 守卫包在打包器里由 Next 提供，node/tsx 直接跑脚本时解析不到。
// 它没有运行时行为，只是个「这个模块不许进客户端包」的编译期标记，所以 stub 成空模块即可。
export {}
