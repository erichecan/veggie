import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 登录页不许再出现「一键登录」和任何写死的凭据。
 * ============================================================================
 * ⛔ 这条守的是一个**实际发生过**的问题：`/enter` 上曾有 6 个演示账号按钮，
 * 密码 `Demo1234!` 写死在前端，点一下就以 BOSS 身份进系统 —— 而这套代码
 * 现在跑在客户的公网域名 www.johnstonebros.ie 上。
 *
 * 开发期图方便加的东西，上线后就是把管理员入口摆在门外。加这条测试是因为
 * 「顺手加回来调试一下」太容易了，而且加回来不会有任何东西报错。
 *
 * 详见 docs/20260807-production-credentials-audit.md
 */

const LOGIN_PAGE = 'app/[locale]/enter/page.tsx'
const src = readFileSync(LOGIN_PAGE, 'utf-8')

/** 注释里为了说明历史会提到这些词，判定只看代码 —— 去掉注释再匹配 */
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释（含 JSX 里的 {/* */}）
    .replace(/^\s*\/\/.*$/gm, '')       // 行注释
}

const code = stripComments(src)

test('登录页代码里没有写死的密码', () => {
  const suspects = [/Demo1234!/, /test123/, /password\s*[:=]\s*['"][^'"]{4,}['"]/i]
  for (const re of suspects) {
    assert.ok(!re.test(code), `登录页出现了写死的凭据：${re}`)
  }
})

test('登录页代码里没有内置账号清单', () => {
  assert.ok(!/DEMO_ACCOUNTS/.test(code), '演示账号清单又回来了')
  assert.ok(
    !/@veggie\.com/.test(code),
    '登录页硬编码了具体账号邮箱 —— 等于告诉所有人拿哪个邮箱去试密码',
  )
})

test('登录只能通过用户自己填的邮箱与密码发起', () => {
  // doLogin 的两个参数必须来自受控输入框的 state，不能有别的调用点喂常量进去。
  // 排除函数声明本身 —— 它的形参当然是标识符，匹配上只会掩盖真正的调用点。
  const calls = [...code.matchAll(/(?<!function\s+)\bdoLogin\(([^)]*)\)/g)].map((m) => m[1].trim())
  assert.ok(calls.length > 0, '找不到 doLogin 的调用，测试本身可能已经失效')
  for (const args of calls) {
    // 允许 doLogin(email, password, 'form')：前两个实参必须是变量名，不是字面量
    const [a1, a2] = args.split(',').map((x) => x.trim())
    assert.ok(
      /^[a-zA-Z_$][\w$]*$/.test(a1) && /^[a-zA-Z_$][\w$]*$/.test(a2),
      `doLogin 被喂了字面量凭据：doLogin(${args})`,
    )
  }
})

test('密码输入框是 type=password 且不禁用浏览器密码管理', () => {
  assert.ok(/type="password"/.test(code), '密码框不是 type=password')
  assert.ok(/autoComplete="current-password"/.test(code), '缺 autoComplete，密码管理器认不出来')
})
