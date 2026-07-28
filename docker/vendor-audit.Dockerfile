FROM oven/bun:1.3.13 AS vendor-builder

ARG NPM_REGISTRY=https://registry.npmmirror.com/

WORKDIR /opt/claude-code
COPY vendor/claude-code/ ./
RUN bun install --frozen-lockfile --ignore-scripts --registry "${NPM_REGISTRY}"
RUN bun scripts/postinstall.cjs
RUN bun run build

FROM oven/bun:1.3.13 AS audit

ARG NPM_REGISTRY=https://registry.npmmirror.com/

WORKDIR /workspace
COPY --chown=bun:bun package.json bun.lock tsconfig.json ./
COPY --chown=bun:bun apps ./apps
COPY --chown=bun:bun packages ./packages
RUN bun install --frozen-lockfile --ignore-scripts --registry "${NPM_REGISTRY}"
COPY --chown=bun:bun tests ./tests
COPY --chown=bun:bun config ./config
COPY --chown=bun:bun compose.yaml compose.test.yaml compose.providers.yaml ./
COPY --chown=bun:bun Makefile ./
COPY --chown=bun:bun .gitmodules ./
COPY --chown=root:root vendor/claude-code ./vendor/claude-code
COPY --from=vendor-builder --chown=root:root /opt/claude-code/dist /opt/claude-code/dist

RUN mkdir -p /workspace/artifacts/capabilities && chown -R bun:bun /workspace/artifacts

ENV NODE_ENV=production \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_TELEMETRY=1

USER bun

CMD ["bun", "run", "packages/vendor-capabilities/src/cli.ts", "audit"]
