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
