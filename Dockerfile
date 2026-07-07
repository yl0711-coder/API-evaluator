# Container build for API-evaluator. Multi-stage: build the frontend, then a slim runtime.
# 运行时数据（配置/报告/SQLite/.vault）全部落在挂载卷 /data 上，不进镜像。

# ---- 构建阶段：装依赖 + 构建前端 ----
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
# pnpm-workspace.yaml carries the esbuild build approval (allowBuilds) — needed at install
# time or `--frozen-lockfile` fails on the unapproved build script.
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile
COPY . .
# Build the frontend. `pnpm rebuild esbuild` is a harmless safety net; build via the vite
# binary directly to avoid pnpm's pre-script deps-status check.
RUN pnpm rebuild esbuild && node_modules/.bin/vite build

# ---- 运行阶段：只带运行所需 ----
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5180 \
    EVALUATOR_DATA_DIR=/data
# Install ONLY runtime deps (gpt-tokenizer) — devDeps (vite/esbuild) are excluded, so the
# image stays lean while the server's lone runtime dependency is present.
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY --from=build /app/server.mjs ./server.mjs
COPY --from=build /app/server ./server
COPY --from=build /app/dist ./dist
# 运行时数据文件：server/ 会按 ../scripts/*.json 相对路径读取 Claude 分词基线
# (tokenizer-fingerprint-audit.mjs) 与档位判别参考 (tier-admission.mjs)。漏拷会导致
# 上线后报「未找到本地分词基线」，故必须随镜像带上 scripts/。
COPY --from=build /app/scripts ./scripts
RUN mkdir -p /data
EXPOSE 5180
VOLUME ["/data"]
CMD ["node", "server.mjs"]
