/**
 * 司机身份单一真相 —— 只读探针（台账 C6）
 *
 * 与 `db:validate` 里那几条是同一段实现（`lib/validation/driver-identity.ts`），
 * 这个脚本只是把结果单独打出来，便于在**生产副本**上只读体检而不跑整套校验。
 *
 * 只读，不写任何数据。
 * 用法：npx tsx --env-file=.env.test scripts/audit/driver-identity-probe.ts
 *      npx tsx --env-file=.env.local scripts/audit/driver-identity-probe.ts   ← 生产副本只读
 */
import { createPrismaClient } from '../../lib/prisma-factory'
import { checkDriverIdentity } from '../../lib/validation/driver-identity'

async function main() {
  const prisma = createPrismaClient()
  try {
    const findings = await checkDriverIdentity(prisma)
    console.log('\n司机身份单一真相体检\n' + '='.repeat(78))
    let failed = 0
    for (const f of findings) {
      const ok = f.bad === 0
      const icon = ok ? '✅' : f.advisory ? '⚠️ ' : '❌'
      console.log(`${icon} ${f.title}`)
      console.log(`     ${ok ? `✓ ${f.total} 条全部一致` : `${f.bad}/${f.total} 条`}`)
      for (const e of f.examples) console.log(`       · ${e}`)
      if (!ok && !f.advisory) failed++
    }
    console.log('='.repeat(78))
    console.log(failed === 0
      ? '✅ 司机身份的每一层派生都与源头一致'
      : `❌ ${failed} 条不变量被破坏 —— 司机真相出现分叉`)
    process.exit(failed > 0 ? 1 : 0)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
