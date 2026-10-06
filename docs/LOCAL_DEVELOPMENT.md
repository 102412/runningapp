# Local development

Everything below was exercised on Linux with Node 22 and PostgreSQL 16. The API runs on the host (fast
reloads); Docker is only used for backing services and is optional.

## 1. Prerequisites

| Tool             | Version       | Notes                                                                                                                                                                  |
| ---------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js          | 22 (`.nvmrc`) | `nvm use`                                                                                                                                                              |
| pnpm             | 10.28         | `corepack enable` picks the pinned version from `package.json`                                                                                                         |
| PostgreSQL       | 16            | needs the `citext`, `pg_trgm` and `pgcrypto` extensions (all ship with Postgres; they are "trusted", so a non-superuser with `CREATE` on the database can create them) |
| ffmpeg + ffprobe | 5+            | only for media processing, the media tests and the full seed. Without ffmpeg everything else works; uploads end `FAILED`                                               |
| Docker           | optional      | for Postgres / MinIO / Mailpit / Redis via `docker-compose.yml`                                                                                                        |

## 2. First run

```bash
pnpm install
docker compose up -d            # Postgres only. Or use your own (see "Without Docker")
cp .env.example apps/api/.env   # optional; the built-in defaults already match docker-compose
pnpm db:migrate
pnpm db:seed                    # optional but recommended: the demo world
pnpm dev
```

- `apps/api/.env` is loaded automatically in development (`loadDotEnv`). **Real environment variables
  always win** over the file, and nothing is loaded when `NODE_ENV=production`.
- Every variable is documented in [`.env.example`](../.env.example); a test fails if the file and
  `apps/api/src/config.ts` ever disagree.
- `pnpm dev` runs the API with the background worker **inline** (`WORKER_INLINE` defaults to true
  outside production), so uploads get processed and emails get "sent" without a second process. To
  run them separately: `WORKER_INLINE=false pnpm dev` and `pnpm worker` in another terminal.

Check it is alive: `curl localhost:3000/healthz` (process) and `/readyz` (database + migrations).

### Without Docker

```sql
-- as a Postgres superuser
create role runningapp login password 'runningapp' createdb;
create database runningapp owner runningapp;
```

`createdb` matters: the test suite creates a throw-away database per test file.

## 3. The seeded demo world

`pnpm db:seed` replays about eight weeks of activity through the **real services** with a simulated
clock, so every rule, trigger, counter, notification and background job behaves exactly as in
production: activities with GPS routes and metrics for six sports, ffmpeg-generated video and photo
posts that go through the real media pipeline, sponsored posts, follows/requests/blocks, comments,
reactions, a moderation story, behavioural events with rolled-up stats and learned affinities.

```bash
pnpm db:reset && pnpm db:seed                 # ~4 minutes with media
pnpm db:seed -- --no-media                    # ~1 minute, no video/photo posts
pnpm db:seed -- --weeks=4 --seed=7            # shorter story / different (still deterministic) world
```

- Same `--seed` ⇒ same people, activities, captions and engagement (ids and wall-clock stamps differ).
- It refuses to run if users already exist (use `db:reset`) and refuses `NODE_ENV=production`.
- Password for every demo account: `Seed-Pass-Running-2026` (override with `SEED_PASSWORD`).
- The account list and what each one is for: [`HANDOFF.md`](../HANDOFF.md#seed-accounts).

## 4. Backing services you may want

```bash
docker compose --profile mail up -d     # Mailpit: SMTP :1025, web UI http://localhost:8025
docker compose --profile s3 up -d       # MinIO: S3 API :9000, console :9001, bucket "runningapp-media"
docker compose --profile redis up -d    # Redis: shared rate-limit state across API replicas
```

**Email.** By default (`MAIL_DRIVER=console`) emails are written to the `dev_mail_outbox` table and
exposed at `GET /v1/dev/outbox?to=<email>` — including the raw verification / reset tokens, which is
exactly what you need to click through flows without an inbox. (`DEV_AUTO_VERIFY_EMAIL=true` in `.env`
skips verification entirely.) For real SMTP, e.g. Mailpit: `MAIL_DRIVER=smtp SMTP_URL=smtp://localhost:1025`.

**Media storage.** The default `STORAGE_DRIVER=local` stores files under `apps/api/.local-storage` and the
API itself serves signed URLs (`/v1/storage/files/…`). To exercise the S3 code path against MinIO:

```bash
STORAGE_DRIVER=s3 S3_ENDPOINT=http://localhost:9000 S3_BUCKET=runningapp-media \
S3_ACCESS_KEY_ID=minioadmin S3_SECRET_ACCESS_KEY=minioadmin S3_FORCE_PATH_STYLE=true pnpm dev
```

> The S3 driver is covered by an in-test fake S3 (request shapes, presigning, error handling). Signature
> validation against a real S3/MinIO has **not** been exercised in this repository's automated tests:
> do it once as part of setting up real storage ([`MEDIA_PIPELINE.md`](MEDIA_PIPELINE.md#s3-setup)).

## 5. Tests

```bash
pnpm test                                   # everything (API, client, contracts)
pnpm --filter @runningapp/api test:watch    # watch mode
cd apps/api && pnpm exec vitest run test/feed.test.ts           # one file
cd apps/api && pnpm exec vitest run -t "not interested"          # by name
```

How the suite works:

- A global setup migrates a **template database** once; every test file clones it
  (`CREATE DATABASE … TEMPLATE`, milliseconds) and gets a fully wired app against its own database —
  real Postgres, no mocks for data access. Databases are dropped afterwards.
- It needs a role that can `CREATE DATABASE`. Override the connection with `TEST_DATABASE_URL`
  (defaults to `DATABASE_URL` / the docker-compose one).
- Time is a `ManualClock` (`t.clock.advanceSeconds(…)`); advancing past the 15-minute access-token
  lifetime requires `relogin(t, user)`.
- `drainJobs(t)` runs due background jobs (media processing, email…) synchronously.
- `test/client.e2e.test.ts` starts the real server on a free port and drives it with the real
  `@runningapp/api-client`.
- Media tests generate fixtures with ffmpeg. No ffmpeg ⇒ those tests fail loudly (they are not skipped).

Beyond feature tests there are **system-wide audits** worth knowing about (they fail when someone forgets
something): `route-security` (every route's auth), `architecture` (allowed dependencies between
modules), `query-budget` (no N+1 on 12 listings), `hardening` (production config guards, headers,
redaction, rate limits), `enum-parity` (contract ⇄ database enums).

## 6. Common tasks

**Add an endpoint**

1. Request/response schemas in `packages/contracts/src/<area>.ts` (responses and shared enums get a
   `.meta({ id })`; request bodies stay anonymous and **must be `.strict()`**).
2. Logic in the module's `service.ts`; the route in `routes.ts` (auth guard, rate limit, `errors(...)`
   for documented failures, `operationId`, tag, summary).
3. `pnpm openapi` (regenerates the contract, the endpoint table and the client types — commit them).
4. Tests: happy path, auth, **privacy/blocks** if it returns other people's data, validation. Run
   `route-security` and `query-budget` — they cover the generic rules.

**Add a migration** — create `apps/api/migrations/NNNN_name.sql` (next number). Never edit an applied
file (checksums are enforced; fix forward instead). Then `pnpm db:migrate && pnpm db:codegen` and commit
the regenerated `generated.ts`. New enum? Add it to `DB_ENUM_PARITY` in `packages/contracts/src/enums.ts`
(or `INTERNAL_DB_ENUMS` in the parity test).

**Add a sport** — a row in a migration _and_ the key in `SPORT_KEYS` (contracts). The parity test
checks both agree.

**Add a notification type** — enum value in contracts + a migration for the Postgres enum, the push
text in `notifications/service.ts` (`renderPush`), and emit it through `Notifier.notify(…, trx)`.

**Add a background job** — `jobSpec(name, schema)` next to the module, handler on the service,
register it (and a schedule if recurring) in `src/jobs.ts`. Handlers must be idempotent: jobs retry.

## 7. Troubleshooting

| Symptom                                         | Likely cause / fix                                                                                                                |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `Invalid environment configuration: …` at boot  | A variable failed validation; the message lists each one.                                                                         |
| `Unsafe production configuration`               | `NODE_ENV=production` refuses dev defaults and placeholder secrets by design ([`SECURITY.md`](SECURITY.md#configuration-guards)). |
| `permission denied to create database` in tests | The test role needs `CREATEDB` (see "Without Docker").                                                                            |
| `extension "citext" is not available`           | Install the `postgresql-contrib` package for your OS.                                                                             |
| Uploads stay `PROCESSING` forever               | No worker running: use `pnpm dev` (inline) or start `pnpm worker`.                                                                |
| Upload ends `FAILED` / `PROCESSING_ERROR`       | ffmpeg/ffprobe not found: set `FFMPEG_PATH` / `FFPROBE_PATH`.                                                                     |
| `401 TOKEN_EXPIRED` after a while               | Normal: access tokens last 15 minutes; refresh via `/v1/auth/refresh` (the client does it for you).                               |
| `410 FEED_EXPIRED`                              | The ranked-feed snapshot expired (30 min); refetch the feed without a cursor.                                                     |
| `429 RATE_LIMITED` while developing             | Set `RATE_LIMIT_ENABLED=false` in `.env`.                                                                                         |
| Migration `was modified after being applied`    | You edited an applied migration. Revert it and add a new one (in dev: `pnpm db:reset`).                                           |
| Seed says users already exist                   | `pnpm db:reset` first.                                                                                                            |
| Port 3000 busy                                  | `PORT=3100 pnpm dev` and adjust `PUBLIC_BASE_URL` (it is used to mint media URLs).                                                |
