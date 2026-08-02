import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@/lib/db'
import { getBackupStore, type BackupDownload } from '@/lib/storage/backup-store'

export function getDirectDatabaseUrl(databaseUrl: string): string {
  return databaseUrl.replace('-pooler', '')
}

export function buildBackupObjectPath(date: Date, id: string): string {
  const stamp = date.toISOString().replace(/[:.]/g, '-')
  return `backups/${stamp}-${id}.sql.gz`
}

export function isExpired(startedAt: Date, now: Date, retentionDays: number): boolean {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
  return startedAt.getTime() < cutoff.getTime()
}

const RETENTION_DAYS = 30

async function dumpToFile(directUrl: string, tmpFile: string): Promise<void> {
  const pgDump = spawn('pg_dump', ['--format=plain', '--no-owner', '--no-privileges', '--clean', '--if-exists', directUrl])
  let stderr = ''
  pgDump.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

  const pipelinePromise = pipeline(pgDump.stdout, createGzip(), createWriteStream(tmpFile))
  const exitPromise = new Promise<number | null>((resolve, reject) => {
    pgDump.on('error', reject)
    pgDump.on('close', (code) => resolve(code))
  })

  const [, code] = await Promise.all([pipelinePromise, exitPromise])
  if (code !== 0) {
    throw new Error(`pg_dump exited with code ${code}: ${stderr}`)
  }
}

export async function runBackup(
  triggerType: 'AUTO' | 'MANUAL',
  triggeredBy?: string,
): Promise<{ id: string; status: string; gcsPath?: string; sizeBytes?: number }> {
  const running = await prisma.backupJob.findFirst({ where: { status: 'running' } })
  if (running) {
    throw Object.assign(new Error('已有备份任务在进行中'), { status: 409 })
  }

  const job = await prisma.backupJob.create({
    data: { status: 'running', triggerType, triggeredBy: triggeredBy ?? null },
  })

  const rawUrl = process.env.DATABASE_URL
  if (!rawUrl) {
    await prisma.backupJob.update({
      where: { id: job.id },
      data: { status: 'failed', errorMessage: 'DATABASE_URL 未配置', finishedAt: new Date() },
    })
    throw new Error('DATABASE_URL 未配置')
  }

  const directUrl = getDirectDatabaseUrl(rawUrl)
  const objectPath = buildBackupObjectPath(new Date(), job.id)
  const tmpFile = join(tmpdir(), `backup-${job.id}.sql.gz`)

  try {
    await dumpToFile(directUrl, tmpFile)

    // 落点由 BACKUP_DRIVER 决定（local / s3 / gcs），见 lib/storage/backup-store.ts。
    // 配置不全时这里抛 BackupStoreConfigError，错误信息直接写明缺哪几个环境变量，
    // 会连同 job.errorMessage 一起落库，运维在备份管理页就能看到该配什么。
    const { sizeBytes } = await getBackupStore().upload(tmpFile, objectPath)

    const updated = await prisma.backupJob.update({
      where: { id: job.id },
      data: { status: 'success', gcsPath: objectPath, sizeBytes, finishedAt: new Date() },
    })
    return { id: updated.id, status: updated.status, gcsPath: updated.gcsPath ?? undefined, sizeBytes: updated.sizeBytes ?? undefined }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    await prisma.backupJob.update({
      where: { id: job.id },
      data: { status: 'failed', errorMessage, finishedAt: new Date() },
    })
    throw err
  } finally {
    await unlink(tmpFile).catch(() => {})
  }
}

export async function cleanupExpiredBackups(now: Date = new Date()): Promise<{ deleted: number }> {
  const candidates = await prisma.backupJob.findMany({ where: { status: 'success' } })
  const expired = candidates.filter((job) => isExpired(job.startedAt, now, RETENTION_DAYS))
  if (expired.length === 0) return { deleted: 0 }

  const store = getBackupStore()
  const deletable: string[] = []
  for (const job of expired) {
    try {
      if (job.gcsPath) await store.remove(job.gcsPath)
      deletable.push(job.id)
    } catch (err) {
      console.error(`[cleanupExpiredBackups] ${store.describe()} 删除对象失败 job=${job.id}:`, err)
    }
  }

  if (deletable.length === 0) return { deleted: 0 }
  const { count } = await prisma.backupJob.deleteMany({
    where: { id: { in: deletable } },
  })
  return { deleted: count }
}

const DOWNLOAD_TTL_MS = 10 * 60 * 1000

/**
 * 取备份下载方式。对象存储返回签名 URL；本地磁盘没有 URL 可签，返回可读流由路由转发。
 * 注：BackupJob.gcsPath 这个列名是 GCS 时期留下的，现在存的是与 driver 无关的对象路径。
 * 改列名要迁移，暂不动，此处统一按"对象路径"理解。
 */
export async function getBackupDownload(id: string): Promise<BackupDownload | null> {
  const job = await prisma.backupJob.findUnique({ where: { id } })
  if (!job || job.status !== 'success' || !job.gcsPath) return null
  return getBackupStore().download(job.gcsPath, DOWNLOAD_TTL_MS)
}
