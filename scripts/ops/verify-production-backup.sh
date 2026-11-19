#!/usr/bin/env bash
# Read-only diagnostics plus the existing authenticated backup operation. Never prints secrets.
set -euo pipefail
cd "${COMPOSE_DIR:-/opt/veggie}"
docker compose exec -T app node -e '
  (async () => {
    const response = await fetch("http://127.0.0.1:3000/api/cron/backup-database", {
      method: "POST", headers: { "x-cron-secret": process.env.CRON_SECRET || "" },
      signal: AbortSignal.timeout(15 * 60 * 1000),
    })
    const result = await response.json()
    let reason = String(result.error || result.backup?.status || "unknown")
    for (const key of ["DATABASE_URL", "DIRECT_URL", "CRON_SECRET", "PGPASSWORD", "AWS_SECRET_ACCESS_KEY", "S3_SECRET_ACCESS_KEY"]) {
      const secret = process.env[key]
      if (secret) reason = reason.split(secret).join("[redacted]")
    }
    reason = reason.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[database URL redacted]")
    console.log(JSON.stringify({ httpStatus: response.status, backupStatus: result.backup?.status, backupId: result.backup?.id, sizeBytes: result.backup?.sizeBytes, reason: reason.slice(0, 2000) }))
    if (!response.ok || result.backup?.status !== "success") process.exitCode = 1
  })().catch(error => { console.error(error.name); process.exitCode = 1 })
' < /dev/null
