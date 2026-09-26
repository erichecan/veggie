import { NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'
import { assessNewPassword } from '@/lib/password-policy'
import { rateLimit } from '@/lib/rate-limit'
import { writeLog } from '@/lib/action-log'

/**
 * POST /api/auth/register — 餐馆自助注册（唯一允许匿名写入的接口）。
 *
 * 提交即新建一条 Customer（仅基础联系信息）+ 一个 pendingApproval=true / isActive=false
 * 的 User（role=RESTAURANT），两者都不能立即使用——内部人工审核通过（PUT /api/users/[id]
 * { approve: true }）后才翻转成可登录。信用额度/价格表/税号等业务字段这里不填，
 * 留给审核人员在客户详情页补齐（见 DEV-PLAN.md 20260926）。
 *
 * ⛔ 匿名可达，必须只返回「提交成功」这类无业务数据的信息，不能回显任何已存在的
 * 客户/用户数据——否则等于给了一个匿名可查询客户库的接口（历史教训见
 * lib/public-routes.ts 顶部注释）。
 */
export async function POST(req: Request) {
  // 公开表单最容易被脚本刷 —— 按 IP 限流，不做短信/邮箱验证码（记入技术债，
  // 靠后面的人工审核兜底，见 DEV-PLAN.md 风险点）
  const denied = rateLimit(req, { id: 'register', max: 5, windowMs: 60_000 })
  if (denied) return denied

  try {
    const body = await req.json() as {
      restaurantName?: string
      contactName?: string
      email?: string
      password?: string
      phone?: string
      address?: string
    }
    const restaurantName = body.restaurantName?.toString().trim() ?? ''
    const contactName = body.contactName?.toString().trim() ?? ''
    const email = body.email?.toString().trim().toLowerCase() ?? ''
    const password = body.password?.toString() ?? ''
    const phone = body.phone?.toString().trim() ?? ''
    const address = body.address?.toString().trim() ?? ''

    if (!restaurantName) return NextResponse.json({ error: '餐馆名称不能为空' }, { status: 400 })
    if (!contactName) return NextResponse.json({ error: '联系人姓名不能为空' }, { status: 400 })
    if (!email) return NextResponse.json({ error: '邮箱不能为空' }, { status: 400 })
    if (!phone) return NextResponse.json({ error: '联系电话不能为空' }, { status: 400 })
    if (!address) return NextResponse.json({ error: '送货地址不能为空' }, { status: 400 })

    const pwVerdict = assessNewPassword(password, { email, name: contactName })
    if (!pwVerdict.ok) return NextResponse.json({ error: pwVerdict.reason }, { status: 400 })

    // ⛔ 安全审查发现（20260926）：这条不能像 app/api/users/route.ts 那样用 409 +
    // 「该邮箱已被注册」——那个接口在管理员登录之后调用，泄露给的是自己人；这里是
    // 匿名公网接口，谁都能拿一份邮箱列表来探，409 等于告诉攻击者"这是一个有效账号"，
    // 连内部员工/老板的邮箱都探得出来。跟 login 路由同一个原则（那边的注释：
    // "账号不存在也要记失败并走同一条返回路径，否则「哪个邮箱存在」会从行为差异里漏出去"）——
    // 已存在就静默跳过创建，回同一个 { ok: true }，不吐出任何能区分"存在/不存在"的信号。
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } })
    if (existing) {
      await writeLog({
        userId: 'anonymous', userEmail: email, userName: contactName,
        action: 'CREATE', resource: 'user-self-register-duplicate',
        detail: `餐馆自助注册提交了已存在的邮箱（未创建新账号，未告知提交方）：${restaurantName}`,
      })
      return NextResponse.json({ ok: true }, { status: 201 })
    }

    const passwordHash = await bcrypt.hash(password, 12)

    const { user, customer } = await prisma.$transaction(async (tx) => {
      const customer = await tx.customer.create({
        data: {
          name: restaurantName.slice(0, 200),
          phone: phone.slice(0, 50),
          email: email.slice(0, 200),
          address: address.slice(0, 500),
        },
        select: { id: true },
      })
      const user = await tx.user.create({
        data: {
          name: contactName.slice(0, 100),
          email,
          passwordHash,
          role: 'RESTAURANT',
          roles: ['RESTAURANT'],
          customerId: customer.id,
          isActive: false,
          pendingApproval: true,
        },
        select: { id: true, email: true, name: true },
      })
      return { user, customer }
    })

    // 权限位图判定走 UserRoleLink（20260807 起），跟 app/api/users/route.ts 的建号
    // 路径同一套逻辑：漏了这步的话，账号批准后登录也是权限集为空、什么都点不动。
    const restaurantAppRole = await prisma.appRole.findUnique({ where: { code: 'restaurant' } })
    if (restaurantAppRole) {
      await prisma.userRoleLink.create({ data: { userId: user.id, roleId: restaurantAppRole.id } })
    }

    // 没有 me（匿名提交），resourceId 记新建的 user.id 方便审核时溯源
    await writeLog({
      userId: 'anonymous', userEmail: email, userName: contactName,
      action: 'CREATE', resource: 'user-self-register', resourceId: user.id,
      detail: `餐馆自助注册待审核：${restaurantName}（customerId=${customer.id}）`,
    })

    return NextResponse.json({ ok: true }, { status: 201 })
  } catch (error) {
    console.error('[POST /api/auth/register]', error)
    return NextResponse.json({ error: '提交失败，请重试' }, { status: 500 })
  }
}
