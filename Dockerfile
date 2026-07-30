# Container build for API-evaluator. Multi-stage: build the frontend, then a slim runtime.
# 运行时数据（配置/报告/SQLite/.vault）全部落在挂载卷 /data 上，不进镜像。

# ---- 构建阶段：装依赖 + 构建前端 ----
FROM node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS build
WORKDIR /app
RUN corepack enable
# pnpm-workspace.yaml carries the esbuild build approval (allowBuilds) — needed at install
# time or `--frozen-lockfile` fails on the unapproved build script.
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile
COPY . .
# Build the frontend, then remove devDependencies in the build stage. The runtime stage
# copies the resulting production node_modules and never installs or retains a package manager.
RUN pnpm rebuild esbuild \
    && node_modules/.bin/vite build \
    && pnpm prune --prod --ignore-scripts

# ---- 运行阶段：只带运行所需，不运行 pnpm / Corepack ----
FROM node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5180 \
    EVALUATOR_DATA_DIR=/data
# Runtime dependencies were resolved from the frozen lockfile and pruned in the build stage.
# Copying them avoids downloading packages at runtime and avoids leaving pnpm/Corepack caches.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/server.mjs ./server.mjs
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/dist ./dist
# 前后端共用的纯函数（server/auto-test-digest.mjs 用 shared/trend-chart.mjs 出趋势图）。后端在运行时
# import 它，故必须随镜像带上 shared/——历史上后端曾误引 src/、而 src/ 不打包，导致 0.5.7 升级启动崩溃。
COPY --from=build --chown=node:node /app/shared ./shared
# 运行时数据文件：server/ 会按 ../scripts/*.json 相对路径读取 Claude 分词基线
# (tokenizer-fingerprint-audit.mjs) 与档位判别参考 (tier-admission.mjs)。漏拷会导致
# 上线后报「未找到本地分词基线」，故必须随镜像带上 scripts/。
COPY --from=build --chown=node:node /app/scripts ./scripts
# The application only needs `node` at runtime. Remove bundled package managers to reduce
# attack surface, then run as the unprivileged user provided by the official Node image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && mkdir -p /data \
    && chown node:node /data
EXPOSE 5180
VOLUME ["/data"]
USER node
CMD ["node", "server.mjs"]
