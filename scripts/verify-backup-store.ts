/**
 * 备份落点连通性自检 —— 在部署之前跑，别用 14 分钟的构建去试凭据对不对。
 *
 *   BACKUP_DRIVER=s3 \
 *   S3_BUCKET=veggie-backups \
 *   S3_ENDPOINT=https://fra1.digitaloceanspaces.com \
 *   S3_REGION=fra1 \
 *   S3_ACCESS_KEY_ID=xxx S3_SECRET_ACCESS_KEY=yyy \
 *   npx tsx scripts/verify-backup-store.ts
 *
 * 做四件事：写一个小对象 → 签下载 URL 并真的取回来比对内容 → 删掉 → 确认删干净。
 * 全过程只碰自己写的那个 `_verify/` 前缀，不动任何既有备份。
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getBackupStore, BackupStoreConfigError } from '../lib/storage/backup-store'

const OBJECT_PATH = `_verify/connectivity-check-${process.pid}.bin`

async function main() {
  let store
  try {
    store = getBackupStore()
  } catch (err) {
    if (err instanceof BackupStoreConfigError) {
      console.error('✗ 配置不完整\n  ' + err.message)
      process.exitCode = 1
      return
    }
    throw err
  }

  console.log(`落点: ${store.describe()}  (driver=${store.driver})`)

  const dir = await mkdtemp(join(tmpdir(), 'backup-verify-'))
  const local = join(dir, 'probe.bin')
  const payload = Buffer.from(`veggie backup store connectivity check ${new Date().toISOString()}`)
  await writeFile(local, payload)

  try {
    const { sizeBytes } = await store.upload(local, OBJECT_PATH)
    console.log(`✓ 写入成功 ${OBJECT_PATH} (${sizeBytes} bytes)`)
    if (sizeBytes !== payload.length) {
      console.error(`✗ 大小对不上：写进去 ${payload.length}，落点报告 ${sizeBytes}`)
      process.exitCode = 1
      return
    }

    const dl = await store.download(OBJECT_PATH, 5 * 60 * 1000)
    if (dl.kind === 'url') {
      console.log(`✓ 签名 URL 生成成功（${new URL(dl.url).host}）`)
      const res = await fetch(dl.url)
      if (!res.ok) {
        console.error(`✗ 签名 URL 取不回来: HTTP ${res.status}——桶权限或 endpoint/region 可能不对`)
        process.exitCode = 1
        return
      }
      const got = Buffer.from(await res.arrayBuffer())
      if (!got.equals(payload)) {
        console.error('✗ 取回的内容与写入的不一致')
        process.exitCode = 1
        return
      }
      console.log('✓ 通过签名 URL 取回并逐字节比对一致')
    } else {
      // 必须把流读完再往下走：createReadStream 是惰性打开的，
      // 只 destroy() 不消费的话，open 会在文件被删之后才发生，抛出没人接的 error 事件。
      const chunks: Buffer[] = []
      await new Promise<void>((resolve, reject) => {
        dl.stream.on('data', c => chunks.push(Buffer.from(c)))
        dl.stream.on('end', resolve)
        dl.stream.on('error', reject)
      })
      const got = Buffer.concat(chunks)
      if (!got.equals(payload)) {
        console.error('✗ 读回的内容与写入的不一致')
        process.exitCode = 1
        return
      }
      console.log(`✓ 本地流读回 ${got.length} bytes 并逐字节比对一致`)
    }

    await store.remove(OBJECT_PATH)
    console.log('✓ 删除成功')

    console.log('\n落点可用。可以切生产了。')
  } catch (err) {
    console.error(`✗ 失败: ${err instanceof Error ? err.message : String(err)}`)
    console.error('\n常见原因：桶名写错 / endpoint 与 region 不匹配 / access key 没有该桶的读写权限')
    process.exitCode = 1
    // 尽量别留垃圾
    await store.remove(OBJECT_PATH).catch(() => {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch(err => { console.error(err); process.exitCode = 1 })
