/**
 * 更新「角色 × 端点」可达性快照。
 *
 * 刻意做成一个**显式动作**而不是测试里自动重写：自动更新等于没有守卫，
 * 改动把某个角色的边界放开了也不会有人看见。跑完之后 `git diff` 那份 JSON，
 * 每一格变化都要能说出理由，再连同代码一起提交。
 *
 *   npx tsx scripts/audit/save-reachability.ts
 */
import { writeFileSync } from 'node:fs'
import { buildReachabilityMatrix } from '../../lib/role-reachability'

const OUT = 'scripts/audit/role-reachability.json'
const matrix = buildReachabilityMatrix()
writeFileSync(OUT, JSON.stringify(matrix, null, 1) + '\n')

const handlers = Object.keys(matrix).length
const openCells = Object.values(matrix).flatMap(r => Object.values(r)).filter(v => v !== 'n').length
console.log(`已写入 ${OUT}：${handlers} 个 handler，可达格 ${openCells} 个`)
