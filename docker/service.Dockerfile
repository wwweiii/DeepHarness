FROM oven/bun:1.3.13 AS workspace-deps

ARG NPM_REGISTRY=https://registry.npmmirror.com/
ARG BUN_NETWORK_CONCURRENCY=8

WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
RUN bun install --frozen-lockfile --ignore-scripts \
    --network-concurrency "${BUN_NETWORK_CONCURRENCY}" \
    --registry "${NPM_REGISTRY}"

FROM workspace-deps AS web-build

RUN bun run build:web

FROM oven/bun:1.3.13 AS vendor-builder

ARG NPM_REGISTRY=https://registry.npmmirror.com/

WORKDIR /opt/claude-code
COPY vendor/claude-code/ ./
RUN bun install --frozen-lockfile --ignore-scripts --registry "${NPM_REGISTRY}"
RUN bun scripts/postinstall.cjs
RUN bun run build

FROM workspace-deps AS gateway

COPY artifacts/capabilities/vendor-capability-manifest.json ./artifacts/capabilities/vendor-capability-manifest.json
COPY config/provider-profiles.json ./config/provider-profiles.json
COPY --from=web-build /app/apps/web/dist ./apps/web/dist

ENV NODE_ENV=production \
    WEB_ROOT=/app/apps/web/dist

USER bun
CMD ["bun", "run", "apps/gateway/src/server.ts"]

FROM oven/bun:1.3.13 AS worker

ARG DEBIAN_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/debian
ARG DEBIAN_SECURITY_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/debian-security

RUN sed -i \
      -e "s|http://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" \
      -e "s|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g" \
      /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 update \
    && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 agent \
    && useradd --uid 10001 --gid agent --create-home --shell /bin/bash agent \
    && mkdir -p /workspace/source /workspace/runs /workspace/non-git /home/agent/.claude \
    && chown -R agent:agent /workspace /home/agent

WORKDIR /app
COPY --from=workspace-deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY apps/worker ./apps/worker
COPY config/provider-profiles.json ./config/provider-profiles.json
COPY packages/protocol ./packages/protocol
COPY --from=vendor-builder /opt/claude-code/dist /opt/claude-code/dist

ENV NODE_ENV=production \
    HOME=/home/agent \
    USE_BUILTIN_RIPGREP=0 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_TELEMETRY=1

USER agent
CMD ["bun", "run", "apps/worker/src/main.ts"]

FROM workspace-deps AS test-model

ENV NODE_ENV=test
USER bun
CMD ["bun", "run", "apps/test-model/src/server.ts"]

FROM node:24.14.0-bookworm-slim AS browser-runtime

ARG DEBIAN_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/debian
ARG DEBIAN_SECURITY_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/debian-security

USER root
COPY --from=workspace-deps /usr/local/bin/bun /usr/local/bin/bun
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    sed -i \
      -e "s|http://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" \
      -e "s|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g" \
      /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 update \
    && for attempt in 1 2 3; do \
         if apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
              ca-certificates chromium fonts-liberation; then \
           break; \
         fi; \
         if [ "${attempt}" -eq 3 ]; then exit 1; fi; \
         apt-get -o Acquire::Retries=3 update; \
       done
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

FROM browser-runtime AS e2e

WORKDIR /app
COPY --from=workspace-deps /app ./
COPY playwright.config.ts ./
COPY tests ./tests
COPY config ./config
COPY compose.yaml compose.test.yaml compose.providers.yaml .gitmodules Makefile ./

ENV NODE_ENV=test \
    HOME=/home/node \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

USER node
CMD ["node", "node_modules/@playwright/test/cli.js", "test", "--config", "playwright.config.ts"]
