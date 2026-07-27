FROM oven/bun:1.3.13

WORKDIR /app

COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun apps ./apps

ENV NODE_ENV=production

USER bun
