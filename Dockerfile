# syntax=docker/dockerfile:1.7
# Image processing service: API + built UI in one image.
#   docker build -t image-service .
#   docker run -p 3000:3000 image-service

# Pinned by digest for reproducible builds (node:24-slim, Debian 12). Bump deliberately.
ARG NODE_IMAGE=node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

# ---------- build: install all deps, compile every workspace, prune to the API's prod deps ----------
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# Manifests first so the dependency layer is cached until a lockfile or package.json changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contract/package.json packages/contract/
COPY packages/sdk/package.json packages/sdk/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm --filter "./packages/**" --filter "./apps/**" build

# Self-contained API folder: dist + production node_modules (workspace deps included as built packages).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @image-service/api deploy --prod --legacy /out/api && \
    cp -r apps/web/dist /out/web

# ---------- runtime: no package manager, no sources, non-root ----------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    STATIC_DIR=/app/web
WORKDIR /app/api
COPY --from=build --chown=root:root /out/api /app/api
COPY --from=build --chown=root:root /out/web /app/web

# Code is owned by root and read-only to the runtime user.
USER node
EXPOSE 3000

# No curl in slim images; Node's fetch does the probe.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Node is PID 1 but handles SIGTERM itself (graceful drain in main.ts).
CMD ["node", "dist/main.js"]
