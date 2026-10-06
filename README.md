# RunningApp backend

The backend for an **athlete-focused social platform** built around one loop:

> **DO → LOG → SHOW.** An athlete _does_ a workout, _logs_ it (manually, by GPX import, or later through
> a sync provider), and is then encouraged to _show_ it with a short vertical video or photo. The
> activity and the post are related but independent objects: you can log without posting, and post
> without an activity.

This repository holds the API, the background worker, the shared contract, a typed client for
front-ends, and everything needed to run, test, seed and deploy them. It deliberately contains **no
UI**: a front-end consumes the API through [`@runningapp/api-client`](packages/api-client) and the
generated OpenAPI contract.

**Status:** feature-complete foundation (identity, social graph, activities for many sports, media
pipeline, posts, creators and sponsorship, ranked feeds, engagement, notifications, search,
discovery, moderation, data export/deletion). 450+ automated tests. Real third-party services (push,
email delivery, object storage, OAuth, Strava/Garmin) are behind interfaces and need human setup —
see [`HANDOFF.md`](HANDOFF.md).

## Quick start (5 minutes)

Prerequisites: **Node 22+**, **pnpm 10** (`corepack enable`), **PostgreSQL 16** (Docker or native),
and **ffmpeg** (only for video/photo processing and the full seed).

```bash
pnpm install
docker compose up -d                  # Postgres on :5432 (or point DATABASE_URL at your own)
cp .env.example apps/api/.env         # optional: the defaults already work for local dev
pnpm db:migrate                       # create the schema
pnpm db:seed                          # a believable demo world (~4 min with media, `-- --no-media` ~1 min)
pnpm dev                              # API + background worker on http://localhost:3000
```

Then sign in as the main demo account:

```bash
curl -s -X POST localhost:3000/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"maya_runs@seed.example","password":"Seed-Pass-Running-2026"}'
```

All 17 demo accounts (public, private, minor, creator, brand, moderator, admin, unverified,
pending-deletion…) are listed in [`HANDOFF.md`](HANDOFF.md#seed-accounts). Interactive API docs are
the OpenAPI document at `GET /v1/openapi.json` (also committed as [`docs/openapi.json`](docs/openapi.json)).

Full setup, troubleshooting and a no-Docker path: [`docs/LOCAL_DEVELOPMENT.md`](docs/LOCAL_DEVELOPMENT.md).

## Repository map

```
apps/api/                 The API + worker (Fastify, Kysely, PostgreSQL)
  src/platform/             Infrastructure: config, db, http, jobs, storage, mail, ports (no business rules)
  src/modules/              One folder per bounded context (auth, social, activities, media, posts, feed, …)
  src/flows/                The few operations that must span modules (log activity → post, purge account)
  src/services.ts           Composition root: the whole dependency graph in one file
  migrations/               Forward-only SQL migrations (checksummed)
  scripts/                  migrate, reset, codegen, seed, admin:grant, OpenAPI generation
  test/                     426 tests: unit, integration, API, authz, privacy, N+1, security audits
packages/contracts/       Zod schemas + enums + error catalog: the single source of truth for the API shape
packages/api-client/      Typed client (generated types + token refresh, pagination, event buffer, uploads)
docs/                     Architecture, API conventions, database, security, media, feed, front-end guide
HANDOFF.md                Start here if you are taking over (state, decisions, limits, next steps)
```

## Everyday commands

| Command                                              | What it does                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| `pnpm dev` / `pnpm worker`                           | API (inline worker) / standalone worker                                      |
| `pnpm test`                                          | All tests (needs Postgres; media tests need ffmpeg)                          |
| `pnpm check`                                         | The full CI gate: format, lint, dead code, typecheck, tests, build           |
| `pnpm db:migrate` · `db:reset` · `db:seed`           | Schema, wipe + recreate (dev only), demo data                                |
| `pnpm openapi`                                       | Regenerate `docs/openapi.json`, `docs/API_REFERENCE.md` and the client types |
| `pnpm db:codegen`                                    | Regenerate typed DB access from the live schema after a migration            |
| `pnpm admin:grant -- --email you@x.com --role ADMIN` | Bootstrap staff (no API for this, by design)                                 |

## Documentation

| Document                                                                   | Read it for                                                                            |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [`HANDOFF.md`](HANDOFF.md)                                                 | Current state, how to run/test, key decisions, limits, external setup, next milestones |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)                             | How the pieces fit: layers, modules, jobs, request lifecycle                           |
| [`docs/API.md`](docs/API.md) · [`API_REFERENCE.md`](docs/API_REFERENCE.md) | Conventions (auth, errors, pagination…) and the generated endpoint table               |
| [`docs/FRONTEND_INTEGRATION.md`](docs/FRONTEND_INTEGRATION.md)             | **For UI developers**: screen → endpoint map, recipes, gotchas                         |
| [`docs/DATABASE.md`](docs/DATABASE.md)                                     | Schema, constraints, triggers, indexes, retention                                      |
| [`docs/SECURITY.md`](docs/SECURITY.md)                                     | Threat model, controls, privacy rules, what is tested, what still needs a decision     |
| [`docs/MEDIA_PIPELINE.md`](docs/MEDIA_PIPELINE.md)                         | Upload → process → deliver, states, limits, storage setup                              |
| [`docs/FEED.md`](docs/FEED.md)                                             | Ranking v1, snapshots, events, learning, tuning                                        |
| [`docs/DECISIONS.md`](docs/DECISIONS.md)                                   | Why things are the way they are, and when to revisit                                   |
| [`docs/LOCAL_DEVELOPMENT.md`](docs/LOCAL_DEVELOPMENT.md)                   | Environment, services, scripts, troubleshooting                                        |
