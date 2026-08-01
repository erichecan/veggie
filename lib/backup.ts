import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Storage } from '@google-cloud/storage'
import { prisma } from '@/lib/db'

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

let _storage: Storage | null = null
function getStorage(): Storage {
  if (!_storage) _storage = new Storage()
  return _storage
}

function getBackupBucketName(): string {
  return process.env.GCS_BACKUP_BUCKET_NAME ?? 'veggie-db-backups'
}

async function dumpToFile(directUrl: string, tmpFile: string): Promise<void> {
  const pgDump = spawn('pg_dump', ['--format=plain', '--no-owner', '--no-privileges', directUrl])
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

    const bucket = getStorage().bucket(getBackupBucketName())
    await bucket.upload(tmpFile, { destination: objectPath, metadata: { contentType: 'application/gzip' } })
    const [metadata] = await bucket.file(objectPath).getMetadata()
    const sizeBytes = Number(metadata.size ?? 0)

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

  const bucket = getStorage().bucket(getBackupBucketName())
  const deletable: string[] = []
  for (const job of expired) {
    try {
      if (job.gcsPath) {
        await bucket.file(job.gcsPath).delete({ ignoreNotFound: true })
      }
      deletable.push(job.id)
    } catch (err) {
      console.error(`[cleanupExpiredBackups] failed to delete GCS object for job ${job.id}:`, err)
    }
  }

  if (deletable.length === 0) return { deleted: 0 }
  const { count } = await prisma.backupJob.deleteMany({
    where: { id: { in: deletable } },
  })
  return { deleted: count }
}

export async function getBackupDownloadUrl(id: string): Promise<string | null> {
  const job = await prisma.backupJob.findUnique({ where: { id } })
  if (!job || job.status !== 'success' || !job.gcsPath) return null

  const bucket = getStorage().bucket(getBackupBucketName())
  const [url] = await bucket.file(job.gcsPath).getSignedUrl({
    action: 'read',
    expires: Date.now() + 10 * 60 * 1000,
  })
  return url
}
