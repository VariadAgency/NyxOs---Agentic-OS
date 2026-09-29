# NyxOS server mode: API + web app in one container (see infra/docker-compose.yml).
FROM node:26-alpine AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/bridge/package.json apps/bridge/
RUN pnpm install --frozen-lockfile --filter @nyxos/server... --filter @nyxos/web...
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web apps/web
RUN pnpm --filter @nyxos/server run build && pnpm --filter @nyxos/web run build

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 ARCHIVE_DIR=/archive WEB_DIR=/app/web
COPY --from=build /src/apps/server/dist ./dist
COPY --from=build /src/apps/server/drizzle ./drizzle
COPY --from=build /src/apps/web/dist ./web
# Optional revision of the image: write the commit into a file `REVISION` in the repo root before building
# (e.g. `git rev-parse HEAD > REVISION`). The pattern `REVISIO[N]` keeps it optional; package.json is always there.
COPY package.json REVISIO[N] ./meta/
RUN mkdir -p /archive && chown node:node /archive
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
CMD ["node", "--enable-source-maps", "dist/main.js"]
