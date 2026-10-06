# syntax=docker/dockerfile:1.7
#
# Production image for the API, the background worker and the migration runner. ONE image, three
# commands:
#   node dist/server.js    the HTTP API            (default)
#   node dist/worker.js    the job worker (media processing, email, push, analytics, purges)
#   node dist/migrate.js   apply database migrations, then exit (run it as a release/init step)
#
# Build from the REPOSITORY ROOT:  docker build -f apps/api/Dockerfile -t runningapp-api .
#
# NOTE: this file could not be built in the authoring environment (no Docker daemon). CI builds it
# on every push (see .github/workflows/ci.yml, job "docker"); treat a green CI run as its proof.

# ---- build: install everything, bundle, then carve out a production-only node_modules ---------
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# Dependency manifests first so the install layer is cached until a package.json changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/api-client/package.json packages/api-client/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

COPY . .
# The bundle inlines @runningapp/contracts, so only third-party packages are needed at runtime.
RUN pnpm --filter @runningapp/api build
RUN pnpm --filter @runningapp/api deploy --prod --legacy /out

# ---- runtime ---------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
# ffmpeg/ffprobe are required by the media pipeline (worker). tini reaps zombies (ffmpeg children)
# and forwards signals so graceful shutdown works.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
# migrations/ must sit beside dist/ (see src/platform/db/migrate.ts).
COPY --from=build /repo/apps/api/migrations ./migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
