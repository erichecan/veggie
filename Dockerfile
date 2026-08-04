FROM node:20-alpine AS base

# ── 依赖安装 ─────────────────────────────────────────────────────────────────
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── 构建 ─────────────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# 重新生成 Prisma Client（output 指向 lib/generated/prisma，需要在此阶段执行）
RUN npx prisma generate
RUN npm run build

# ── 迁移 / 运维镜像 ──────────────────────────────────────────────────────────
# 为什么单独一层：运行时镜像是 Next standalone 产物，**不含 prisma CLI**
# （node_modules/.bin 里没有，2026-08-04 T1.4 实测）。在那里跑
# `npx prisma migrate deploy` 会去 npm 现拉 CLI，依赖外网且脆弱——部署流水线
# 的迁移步骤不能建立在"npm registry 此刻可达"上。
#
# 从 deps 而不是 builder 派生：builder 带着 next build 的产物，实测 3.4 GB，
# 而迁移一个字节都用不到。更要命的是每次部署 TAG 都变，那些层要重新拉到 droplet。
# 这里只拷迁移与脚本真正需要的东西，跑 prisma generate（不跑 next build）。
#
# 用途：migrate deploy / seed / scripts 下的订正与诊断脚本。跑完即退，不常驻。
FROM deps AS migrator
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY prisma ./prisma
COPY lib ./lib
COPY scripts ./scripts
COPY prisma.config.ts tsconfig.json package.json ./
# Prisma Client 的 output 指向 lib/generated/prisma，种子与运维脚本都要它
RUN npx prisma generate
CMD ["npx", "prisma", "migrate", "deploy"]

# ── 运行时镜像 ───────────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# 汇总单服务端 PDF：装系统 Chromium(Alpine 原生 musl 构建，puppeteer-core 只驱动它，不下载
# 自己的浏览器)。用 apk 装而不是 @sparticuz/chromium 这类打包 glibc 二进制的包——那是给
# Lambda 这种镜像不可控的环境用的，Alpine 上会因 musl/glibc 不匹配跑不起来。
# font-noto-cjk：ttf-freefont 只有拉丁字符集，之前中文客户名/备注在 PDF 里全乱码/方块
# (20260715 客户截图反馈)，根因是镜像里压根没有中文字体可供 Chromium 回退渲染——
# 装 Noto Sans CJK 并 fc-cache 刷新字体缓存，彻底解决，不再需要把打印文案改成纯英文。
# font-noto-emoji：打印模板里的 📦/🧴/⚠️ 图标同理没有对应字形会变缺字方框，一并装上。
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont font-noto-cjk font-noto-emoji fontconfig postgresql17-client \
    && fc-cache -f
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# 私有化下上传文件与备份产物落本地磁盘（STORAGE_DRIVER=local / BACKUP_DRIVER=local）。
# 这两个目录必须由 nextjs(uid 1001) 拥有，否则运行时 mkdir 报 EACCES，表现是上传接口
# 500「图片上传失败」——2026-08-04 本地 compose 验证时实测到（docker 具名卷会继承镜像里
# 该目录的属主，所以在这里建好就能一并解决具名卷的情况）。
#
# ⚠️ 宿主机 bind mount **不继承**镜像里的属主。服务器上 /data/veggie/{uploads,backups}
#    必须在宿主机侧 chown 1001:1001，见部署手册。
RUN mkdir -p /data/uploads /data/backups && chown -R nextjs:nodejs /data

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV NODE_OPTIONS="--max-old-space-size=768"

CMD ["node", "server.js"]
