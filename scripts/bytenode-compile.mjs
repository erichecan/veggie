// 只在 Dockerfile 的 builder 阶段跑，把 standalone 产物里的服务端代码编译成 V8 字节码，
// 原地把 foo.js 换成 3 行 loader（require('bytenode') + require('./foo.jsc')），
// 其余代码 require('./foo') 不用改——文件名和导出行为不变。
//
// ⛔ 不要在宿主机手动跑这个脚本。字节码跟编译它的 V8 版本是绑定的，必须和 runner
// 阶段跑同一个 node:20-alpine 基础镜像的 Node 才能加载成功，宿主机 Node 版本一旦
// 不同（本机是 v25），编译出来的 .jsc 在容器里会直接 "Invalid or incompatible cached data"。
//
// 只覆盖 app/pages/chunks 三个目录（真正的路由与业务逻辑所在），跳过 edge/——
// Edge Runtime 走的是另一套沙箱执行模型，不是普通 Node require 加载，bytenode 的
// Module._extensions 钩子在那套模型里不生效。
import fs from 'node:fs'
import path from 'node:path'
import bytenode from 'bytenode'

const EXPECTED_NODE_MAJOR = 20
const actualMajor = Number.parseInt(process.versions.node, 10)
if (actualMajor !== EXPECTED_NODE_MAJOR && !process.env.ALLOW_BYTENODE_VERSION_MISMATCH) {
  console.error(
    `[bytenode-compile] 期望在 node ${EXPECTED_NODE_MAJOR}.x 下编译（要跟运行时镜像的 V8 版本完全一致），` +
      `当前是 ${process.version}。\n` +
      `这一步只应该在 Dockerfile builder 阶段跑。如果是故意把基础镜像升级到了新的 Node 大版本，` +
      `改这里的 EXPECTED_NODE_MAJOR 并设 ALLOW_BYTENODE_VERSION_MISMATCH=1 跳过这个检查。`
  )
  process.exit(1)
}

const STANDALONE_ROOT = path.join(process.cwd(), '.next/standalone')
const SERVER_DIR = path.join(STANDALONE_ROOT, '.next/server')
const TARGET_DIR_NAMES = ['app', 'pages', 'chunks']
const EXCLUDE_DIR_NAMES = new Set(['edge'])

// Next 自己在启动时会用 fs.readFileSync + vm.runInNewContext（不是 require()）直接
// 吃这些 *manifest*.js 文件——那个 vm 沙箱里压根没有 require，塞进去的 loader stub
// （require('bytenode')）会直接炸 ReferenceError: require is not defined，首页直接 500
// （本地 docker-compose 实测复现，route-module.js 里 CLIENT_REFERENCE_MANIFEST 那个
// useEval:true 调用点就是这种文件）。这些文件本身也只是路由/模块 id 登记表，不是业务
// 逻辑，不值得为了编译它们冒这个险。
const EXCLUDE_NAME_PATTERN = /manifest/i

function collectJsFiles(dir, out) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (EXCLUDE_DIR_NAMES.has(entry.name)) continue
      collectJsFiles(full, out)
    } else if (entry.isFile() && entry.name.endsWith('.js') && !EXCLUDE_NAME_PATTERN.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

const files = TARGET_DIR_NAMES.flatMap((name) => collectJsFiles(path.join(SERVER_DIR, name), []))

if (files.length === 0) {
  console.error(`[bytenode-compile] 在 ${SERVER_DIR} 下没找到待编译的 .js 文件，是不是还没 next build？`)
  process.exit(1)
}

console.log(`[bytenode-compile] 待检查 ${files.length} 个文件`)

// bytenode 用 vm.Script 手搓执行，没接 Node 的 importModuleDynamically 钩子——文件里
// 只要有一处动态 import()，运行到那一行就是 ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING
// （本地实测命中：Prisma 7 的 WASM 查询编译器、next-intl 的按 locale 动态 import 消息
// JSON，登录接口直接 500）。这类动态 import 全部来自框架/vendor 自身的运行时代码，
// 不是业务逻辑，跳过不编译的代价很小；逐文件按内容过滤，不写死文件名——Turbopack
// 的 chunk 文件名是内容哈希，每次构建都变。
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(/

let compiled = 0
let skippedDynamicImport = 0
for (const file of files) {
  const source = fs.readFileSync(file, 'utf-8')
  if (DYNAMIC_IMPORT_PATTERN.test(source)) {
    skippedDynamicImport++
    continue
  }
  const output = file.slice(0, -'.js'.length) + '.jsc'
  await bytenode.compileFile({
    filename: file,
    output,
    compileAsModule: true,
    createLoader: 'commonjs',
    loaderFilename: path.basename(file),
  })
  compiled++
}
if (skippedDynamicImport > 0) {
  console.log(`[bytenode-compile] 跳过 ${skippedDynamicImport} 个含动态 import() 的文件（保持明文）`)
}

// loader stub 里 require('bytenode')，standalone 自己的 node_modules 里要能找到它——
// 它不是被任何业务代码字面量 import 的包，Next 构建期的依赖追踪看不到它，不会自动带上。
fs.cpSync(path.join(process.cwd(), 'node_modules/bytenode'), path.join(STANDALONE_ROOT, 'node_modules/bytenode'), {
  recursive: true,
})

console.log(`[bytenode-compile] 完成：${compiled} 个文件已替换为字节码 + loader`)
