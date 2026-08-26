# syntax=docker/dockerfile:1
# HMusic Server 多阶段镜像。
# builder：装构建工具链，按目标架构编译 better-sqlite3 原生模块 + 编译 TS。
# runtime：node:22-slim 精简运行，非 root 用户，只带运行期必需产物。
# 多架构（amd64/arm64）由 buildx 通过 --platform 驱动，TARGETPLATFORM 自动传入。

# ---------- builder ----------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# better-sqlite3 是原生模块，node-gyp 编译需要 python3 + make + g++。
# 这些只留在 builder 阶段，不进最终镜像。
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# 先只拷依赖清单，命中 Docker 层缓存：源码变了但依赖没变时不必重装。
COPY package.json package-lock.json ./

# npm ci 严格按 lockfile 安装，并为当前 TARGETPLATFORM 架构编译原生模块。
RUN npm ci

# 拷源码与前端资源后编译 TypeScript（tsc → dist/）。
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build

# 剔除 devDependencies，只留运行时依赖（含已编译的 better-sqlite3 二进制）。
RUN npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# 容器内禁用一键自升级（升级=拉新镜像重建容器），/system/update 据此判定。
ENV HMUSIC_IN_DOCKER=1

# node:*-slim 自带非 root 的 node 用户（uid/gid 1000）。
# 数据目录预建好并归属 node，避免挂载后容器内无写权限。
RUN mkdir -p /app/data && chown -R node:node /app

# 只带运行期必需产物：已编译依赖、后端产物、前端静态资源、启动清单。
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/web ./web
COPY --chown=node:node package.json ./
COPY --chown=node:node LICENSE THIRD-PARTY-NOTICES.md ./

USER node

# 数据目录固定在 /app/data，compose 挂载卷到这里做持久化。
ENV HMUSIC_DATA_DIR=/app/data \
    HMUSIC_DATABASE_URL=/app/data/hmusic.db \
    HMUSIC_HOST=0.0.0.0 \
    HMUSIC_PORT=6650

EXPOSE 6650

# 数据库表由 src/db/index.ts 启动时 CREATE TABLE IF NOT EXISTS 自建，无需迁移步骤。
CMD ["node", "dist/main.js"]
