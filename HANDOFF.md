# HANDOFF

State of the backend at the end of the initial build, written for the next person (or agent) who takes
over — in particular whoever builds the UI. Everything here was checked against the code; where
something could **not** be verified in the authoring environment, it says so.

**Product loop:** DO → LOG → SHOW. An athlete does a workout, logs it (manual, GPX import; sync
providers later), and is encouraged to attach a short vertical video or photo. Activity and post are
related but independent.

**Verification at hand-off** (run in the authoring environment: Linux, Node 22, PostgreSQL 16, ffmpeg):
`pnpm format:check`, `pnpm lint`, `pnpm deadcode` (knip), `pnpm typecheck`, `pnpm test` (**431 API tests and
25 client tests, all passing**), `pnpm build`, `pnpm openapi` (no diff), `pnpm audit --prod` (no known
vulnerabilities at the time), the seed end to end, and the production bundle started from a simulated
container layout. **Not verified locally:** the Docker image build (no Docker daemon here — the CI `docker` job builds and smoke-tests it), anything
against a real S3/R2, SMTP server, push provider or third-party OAuth/sync provider, and any
load/performance testing.

## What exists

Legend: ✅ implemented and tested · 🟡 partial / stub (details under [Known limitations](#known-limitations)) · ⛔ not built

| Area                                         | Status  | Summary                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo / tooling                               | ✅      | pnpm monorepo: `apps/api`, `packages/contracts`, `packages/api-client`; TypeScript strict, ESLint, Prettier, knip, Vitest; CI workflow; Dockerfile (one image: API / worker / migrate); docker-compose for Postgres, Redis, MinIO, Mailpit                                                                                                                                      |
| Auth & sessions                              | ✅      | Signup/login (argon2id), 15-min JWT checked against DB sessions, single-use rotating refresh tokens with reuse detection, logout / logout-all, device list + revoke, email verification, password reset/change, account deletion (30-day grace) and cancel, per-account login throttle                                                                                          |
| Authorization                                | ✅      | Route guards (user / verified / role) separate from resource visibility predicates in SQL; 404-not-403 rule; staff roles via script only                                                                                                                                                                                                                                        |
| Profiles & settings                          | ✅      | Profile, avatar, privacy/units/defaults/personalisation settings, sport preferences, privacy zones                                                                                                                                                                                                                                                                              |
| Social graph                                 | ✅      | Follow, private-account requests (accept/reject), remove follower, block (severs relations in both directions; DB-enforced), follower/following lists, race-free counters                                                                                                                                                                                                       |
| Sports & activities                          | ✅      | 12 sports with capability flags; manual logging and **GPX import** (idempotent), metrics, splits, personal records, sport-specific data (swim/strength), routes with **privacy modes** (`FULL/TRIMMED/APPROXIMATE/HIDDEN`) and privacy zones                                                                                                                                    |
| Media pipeline                               | ✅      | Presigned direct upload → verify → ffprobe → ffmpeg variants (720p/360p MP4, posters, thumbs; images to JPEG), metadata stripped, state machine enforced by DB trigger, signed delivery, cleanup jobs; local-disk and S3-compatible drivers                                                                                                                                     |
| Posts                                        | ✅      | Video / photo / text / activity posts, caption, topics (hashtags), mentions, activity attachment (own only), draft → `PENDING_MEDIA` → `PUBLISHED`, server-derived `format`, idempotent create                                                                                                                                                                                  |
| Creators & sponsorship                       | ✅      | Creator profile + categories, staff-granted verification, brand partnerships, **sponsorship disclosure as data** (`sponsorship.label`), cannot be removed once published                                                                                                                                                                                                        |
| Engagement                                   | ✅      | 4 reaction types, two-level comments (+ reactions, mentions), bookmarks, shares, counters by triggers                                                                                                                                                                                                                                                                           |
| Feed                                         | ✅      | Following (chronological), Home (ranked + discovery), Explore; ranking v1 heuristic, snapshots, diversity, sponsored density limits, seen penalty                                                                                                                                                                                                                               |
| Events & learning                            | ✅      | Idempotent client event ingestion, server-side events, serving log, rollups, decayed affinities, personalisation opt-out                                                                                                                                                                                                                                                        |
| Notifications                                | ✅ / 🟡 | In-app notifications, preferences, unread count, push _abstraction_ (provider = logging stub)                                                                                                                                                                                                                                                                                   |
| Search & discovery                           | ✅      | `SearchProvider` port with Postgres FTS/trigram implementation (users, posts, topics), who-to-follow, trending topics, topic pages; minors/non-discoverable excluded                                                                                                                                                                                                            |
| Moderation                                   | ✅ / 🟡 | Reports, automated flags, staff queue + actions (hide/remove/restore/warn/suspend/verify), append-only audit trail, role-rank rules, soft delete; word-list moderator only                                                                                                                                                                                                      |
| Data rights                                  | ✅      | Personal data export (streamed JSON, 7-day link), deletion with grace period, account purge incl. stored files                                                                                                                                                                                                                                                                  |
| Integrations                                 | 🟡      | Schema + availability endpoint only: **no Strava/Garmin/Apple Health/Health Connect clients**                                                                                                                                                                                                                                                                                   |
| OAuth login                                  | ⛔      | Table exists (`oauth_identities`); no flow                                                                                                                                                                                                                                                                                                                                      |
| Push delivery                                | ⛔      | Interface + logging adapter; no APNs/FCM/Expo adapter                                                                                                                                                                                                                                                                                                                           |
| Real-time (WebSocket/SSE)                    | ⛔      | Not built; clients poll                                                                                                                                                                                                                                                                                                                                                         |
| Direct messages, clubs, challenges, segments | ⛔      | Not in scope of this build                                                                                                                                                                                                                                                                                                                                                      |
| API contract                                 | ✅      | OpenAPI 3.1 for **116 operations** (`docs/openapi.json`), generated endpoint table, generated TypeScript client types, consistent error shape, CI drift checks                                                                                                                                                                                                                  |
| Seeds                                        | ✅      | Deterministic 8-week demo world with 17 personas, GPS routes, real ffmpeg-generated media, moderation story                                                                                                                                                                                                                                                                     |
| Docs                                         | ✅      | This file + [`README`](README.md), [`ARCHITECTURE`](docs/ARCHITECTURE.md), [`API`](docs/API.md), [`DATABASE`](docs/DATABASE.md), [`SECURITY`](docs/SECURITY.md), [`MEDIA_PIPELINE`](docs/MEDIA_PIPELINE.md), [`FEED`](docs/FEED.md), [`FRONTEND_INTEGRATION`](docs/FRONTEND_INTEGRATION.md), [`LOCAL_DEVELOPMENT`](docs/LOCAL_DEVELOPMENT.md), [`DECISIONS`](docs/DECISIONS.md) |

Size: 12 migrations, 54 tables (+ `schema_migrations`), 116 endpoints, 16 background job types (10 of them recurring).

## How to run it

```bash
# prerequisites: Node 22, pnpm 10 (corepack enable), PostgreSQL 16, ffmpeg (for media + full seed)
pnpm install
docker compose up -d                 # Postgres on :5432 — or use your own (docs/LOCAL_DEVELOPMENT.md)
cp .env.example apps/api/.env        # optional: defaults already work for local dev
pnpm db:migrate
pnpm db:seed                         # demo world, ~4 min with media (-- --no-media for ~1 min)
pnpm dev                             # API + inline worker on http://localhost:3000
```

- Health: `GET /healthz`, `GET /readyz`. Contract: `GET /v1/openapi.json`.
- Sign in as `maya_runs@seed.example` / `Seed-Pass-Running-2026` ([accounts](#seed-accounts)).
- Verification/reset emails in dev: `GET /v1/dev/outbox?to=<email>` (dev only, contains raw tokens).
- Separate worker: `WORKER_INLINE=false pnpm dev` + `pnpm worker`.
- Bootstrap a staff account: `pnpm admin:grant -- --email you@example.com --role ADMIN`.
- **Production-style** (what a deployment does): build the image (`docker build -f apps/api/Dockerfile -t runningapp-api .`),
  run `node dist/migrate.js` once per release, then `node dist/server.js` (≥ 1 replica) and `node dist/worker.js`
  (≥ 1 replica, sized for ffmpeg). Required configuration and the guards that refuse unsafe values:
  [`SECURITY.md`](docs/SECURITY.md#configuration-guards); every variable is documented in [`.env.example`](.env.example).
  **Do not expose a development configuration to the internet** (dev outbox, local storage and auto-verify are dev-only and
  refused under `NODE_ENV=production`).

More detail and troubleshooting: [`docs/LOCAL_DEVELOPMENT.md`](docs/LOCAL_DEVELOPMENT.md).

## How to test it

```bash
pnpm test              # everything: needs Postgres with CREATEDB rights (+ ffmpeg for media tests) — ~80 s for the API suite
pnpm check             # the full CI gate: format, lint, dead code, typecheck, tests, build
pnpm openapi && git diff --exit-code   # contract + generated client up to date
```

- Tests run against a **real PostgreSQL** (each test file gets its own database cloned from a migrated template).
- Beyond feature tests there are system audits that fail when something is forgotten: every route's auth
  (`route-security`), module dependency rules (`architecture`), no N+1 (`query-budget`), production config guards
  and headers (`hardening`), contract ⇄ DB enum parity (`enum-parity`).
- `client.e2e.test.ts` boots the real server and drives it through `@runningapp/api-client`.
- CI (`.github/workflows/ci.yml`): verify (format, lint, dead code, typecheck, migrate, codegen diff, OpenAPI diff,
  tests, build, seed smoke) · docker image build (+ ffmpeg present, migrations apply, `/readyz` ok) · dependency audit.
  It runs on every push to this branch (GitHub Actions). The `docker` and `audit` jobs pass; the `verify` job passed
  through typecheck/dead-code/migrations/codegen/OpenAPI drift on the documentation commit — see the Actions tab for the
  latest run, and fix forward if a GitHub-runner difference shows up.

## Important architectural decisions

Full records with revisit triggers: [`docs/DECISIONS.md`](docs/DECISIONS.md). The ones that shape everything:

1. **Modular monolith**, one image in two roles (API, worker); module boundaries enforced by a test.
2. **PostgreSQL does everything** (data, queue, search, analytics) until measurements say otherwise; externals sit behind ports.
3. **Contracts first**: Zod → OpenAPI → generated client; drift fails CI.
4. **Auth = short JWT + DB-checked session + rotating refresh**: logout/suspension take effect immediately.
5. **Authorization in SQL predicates**; invisible content is `404`, never `403`; feeds re-check visibility at serve time.
6. **Activity ≠ post**; the server derives a post's `format`; auto-post only for non-private activities and verified emails.
7. **Route privacy at read time** on the raw track (default `TRIMMED`), segments never joined; privacy zones.
8. **Media**: direct signed uploads, our own ffmpeg, everything re-encoded and de-identified, progressive MP4.
9. **Feed**: transparent heuristic v1 + a complete event/serving-log/affinity pipeline ready for a learned model; finite snapshots.
10. **Sponsorship is data** (`sponsorship.label`), non-removable after publish; **minors** get protective defaults.
11. **Moderation audit is append-only**; staff roles are granted out of band only.
12. **No pretend integrations**: push, image moderation, OAuth and sync providers are documented gaps, not stubs presented as done.

## API contract location

| What                                                                   | Where                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Machine-readable contract (OpenAPI 3.1)**                            | [`docs/openapi.json`](docs/openapi.json) (committed) · live at `GET /v1/openapi.json`            |
| Human conventions (auth, errors, pagination, idempotency, rate limits) | [`docs/API.md`](docs/API.md)                                                                     |
| Endpoint table (generated)                                             | [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md)                                                 |
| Source of truth (Zod schemas, enums, error catalogue)                  | [`packages/contracts/src`](packages/contracts/src)                                               |
| Generated client types                                                 | [`packages/api-client/src/generated/schema.d.ts`](packages/api-client/src/generated/schema.d.ts) |
| Typed client with auth refresh, pagination, event buffer, uploads      | [`packages/api-client`](packages/api-client) → `@runningapp/api-client`                          |
| UI developer guide                                                     | [`docs/FRONTEND_INTEGRATION.md`](docs/FRONTEND_INTEGRATION.md)                                   |

Change protocol: edit `packages/contracts` → implement → `pnpm openapi` → commit the regenerated files with the change.
All routes are under `/v1`; `API_VERSION` is `0.1.0` (breaking change while `0.x` ⇒ bump minor, update implementation, tests,
OpenAPI, client types, docs and seeds **together**).

## Seed accounts

`pnpm db:seed` creates 17 accounts. Email is `<username>@seed.example`; the password for all is
**`Seed-Pass-Running-2026`** (override with `SEED_PASSWORD`). The seed refuses to run in production.

| Username          | Role in the story                                                             | Use it to test                                                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maya_runs`       | **Main demo account.** Public marathon runner, privacy zone, blocked one user | Rich Home/Following/Explore feeds, notifications, suggestions, activities with routes. She follows only leo, dani, stride and priya, so Explore and "who to follow" have content         |
| `leo_gravel`      | Verified cycling creator                                                      | Creator profile, **sponsored posts** (`sponsorship` label), video-heavy profile                                                                                                          |
| `coach_dani`      | Verified coach                                                                | Standalone teaching videos, affiliate post, creator badge                                                                                                                                |
| `stride_running`  | Verified brand                                                                | Brand side of sponsorship/partnerships                                                                                                                                                   |
| `sora_swims`      | Swimmer                                                                       | Swim metrics, activities **without** routes/elevation                                                                                                                                    |
| `ben_lifts`       | Strength athlete                                                              | Strength data, photo posts, no routes                                                                                                                                                    |
| `tri_tom`         | Triathlete                                                                    | Multi-sport activities                                                                                                                                                                   |
| `hiker_hana`      | Hiker                                                                         | `FULL` route privacy, photo-heavy                                                                                                                                                        |
| `private_priya`   | **Private account**                                                           | Follow-request flow (pending requests from `leo_gravel` and `sora_swims`), followers-only visibility, `ACCOUNT_PRIVATE`                                                                  |
| `quiet_quentin`   | Not discoverable                                                              | Absent from search, suggestions and Explore                                                                                                                                              |
| `teen_tess`       | **Minor** (born 2011-05-14; under 16)                                         | Forced private, never in search/suggestions/sponsored discovery. _Her birth date is fixed: she turns 16 on 2027-05-14, so update `scripts/seed/world.ts` if you still need a minor then_ |
| `new_nina`        | Brand-new user                                                                | Onboarding / cold-start (follows nobody, no posts)                                                                                                                                       |
| `blocked_bob`     | Spammer                                                                       | Blocked by Maya (mutual invisibility); one post hidden by a moderator, one in the open report queue plus an automated flag                                                               |
| `mod_morgan`      | **MODERATOR**                                                                 | `/v1/admin/reports`, hide/remove/warn/suspend                                                                                                                                            |
| `admin_alex`      | **ADMIN**                                                                     | Moderator rights + creator verification                                                                                                                                                  |
| `pending_pat`     | Deletion scheduled                                                            | Restricted mode: can log in only to cancel deletion                                                                                                                                      |
| `unverified_ulla` | Email not verified                                                            | `EMAIL_NOT_VERIFIED` on posting/commenting; can still log activities                                                                                                                     |

Same `--seed` ⇒ same people, activities, captions and engagement. Details: [`docs/LOCAL_DEVELOPMENT.md`](docs/LOCAL_DEVELOPMENT.md#3-the-seeded-demo-world).

## Known limitations

Honest list; none of these is hidden in the code.

**Integrations and delivery**

- **No real push delivery.** The `PushProvider` port exists; the only adapter logs. Device tokens are stored; nothing is sent to APNs/FCM/Expo.
- **No Strava / Garmin / Apple Health / Health Connect.** Only the schema (`integration_connections`, `source` enum) and an availability endpoint. GPX file import works.
- **No OAuth / social login / MFA / passkeys.** `oauth_identities` is an unused table.
- **Email delivery** works through SMTP (nodemailer) but has never been run against a real provider; no bounce/complaint handling, templates are plain text.
- **S3 driver** is tested against an in-test fake only; signature validity against a real S3/R2/MinIO has not been exercised ([`MEDIA_PIPELINE.md`](docs/MEDIA_PIPELINE.md#s3-setup)).

**Safety and moderation**

- **Image/video moderation is a stub** (always allows); text moderation is word lists from env. No CSAM hash matching, malware scan, report-threshold auto-hide, appeals, staff UI, or suspension/warning emails (in-app `MODERATION_ACTION` notification exists).
- **Minor-safety and age thresholds (13 / 16 / 18) are engineering defaults that need legal review** per market (COPPA, GDPR-K, UK AADC…). No parental consent, no age verification beyond a self-declared birth date.
- Signup reveals registered emails (accepted trade-off, rate-limited).
- No external penetration test. See [`SECURITY.md`](docs/SECURITY.md#known-gaps).

**Product/feeds/search**

- Home/Explore are **finite ≈100-item snapshots**; candidate generation is SQL-bound (trending sorts a 7-day window); no ML, no real-time signals, hand-set weights untested on real data.
- Search is Postgres FTS with the `simple` configuration (no stemming, no typo tolerance beyond trigram on names/topics), offset capped at 500.
- Analytics rollups lag by minutes (watermark + 60 s settle window) and rely on UUIDv7 ordering.
- English-only messages; no localisation, no per-region rules.
- Data export excludes media bytes (links only).
- `GET /v1/openapi.json` is public.

**Media**

- Progressive MP4 only (no HLS/ABR), no resumable/multipart upload, no CDN setup, originals kept (private) with their original metadata; HEIC not accepted (client must convert). Encoding throughput not benchmarked.

**Operations**

- Rate limiting is in-memory unless `REDIS_URL` is set (and fails open). No WebSocket/SSE.
- No tracing/OpenTelemetry, alert rules, dashboards, load tests, or backup/PITR/disaster-recovery plan.
- The Docker image is built and smoke-tested (ffmpeg present, migrations apply, API ready) by CI only; it was never built in the authoring environment (no Docker daemon). It has not been deployed anywhere.
- Zero-downtime migration discipline is documented but the runner wraps every migration in a transaction (no `CONCURRENTLY` yet).
- Some `0006_sports.sql` wording ("no deploy") is misleading — adding a sport also needs a `SPORT_KEYS` entry ([`DATABASE.md`](docs/DATABASE.md#sports-are-data-but-typed)); applied migrations cannot be edited.

## External services still requiring human setup

Nothing below was purchased, registered or contacted; each needs a person (and often money, a legal entity or an approval).
**Costs are possible for every item marked 💲.**

| Need                                                                                                                                                                            | Why                                                                  | What to do                                                                                                                            | Env / code                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 💲 **Hosting** for API + worker + PostgreSQL                                                                                                                                    | Run anything beyond a laptop                                         | Choose a platform (see Q1); managed Postgres 16 with `citext`/`pg_trgm`/`pgcrypto` and backups/PITR                                   | `DATABASE_URL`, `DATABASE_SSL`, `DATABASE_POOL_MAX`                |
| 💲 **Object storage** (S3 / R2 / B2 / Spaces)                                                                                                                                   | Required in production (`local` driver is refused)                   | Private bucket, restricted key, CORS — steps in [`MEDIA_PIPELINE.md`](docs/MEDIA_PIPELINE.md#s3-setup); then **one real upload test** | `STORAGE_DRIVER=s3`, `S3_*`, `MEDIA_SIGNING_SECRET`                |
| 💲 **CDN** (optional, recommended for video)                                                                                                                                    | Bandwidth/latency for media                                          | Put in front of the bucket; cache on path                                                                                             | –                                                                  |
| 💲 **Email provider** (+ domain DNS: SPF, DKIM, DMARC)                                                                                                                          | Verification & reset mails                                           | Pick provider, verify sending domain                                                                                                  | `MAIL_DRIVER=smtp`, `SMTP_URL`, `MAIL_FROM`, `EMAIL_LINK_BASE_URL` |
| **Domain, TLS, universal/app links**                                                                                                                                            | Email deep links, CORS, cookies-free web                             | Register domain; configure `apple-app-site-association` / `assetlinks.json` in the app project                                        | `PUBLIC_BASE_URL`, `EMAIL_LINK_BASE_URL`, `CORS_ORIGINS`           |
| 💲 **Push**: Apple Developer Program (APNs key), Firebase (FCM), or Expo                                                                                                        | Notifications                                                        | Create credentials, **then write the adapter** (`PushProvider`)                                                                       | new adapter in `platform/ports/push.ts` consumers                  |
| **Strava API application** and/or 💲 **Garmin Connect Developer Program** (both have approval/review processes and terms that change — check the current requirements and fees) | Activity sync                                                        | Register apps, obtain client id/secret, set redirect URIs                                                                             | new module code + `integration_connections`                        |
| Apple Health / Health Connect                                                                                                                                                   | On-device workout import                                             | No server credentials — needs an **ingestion endpoint** designed with the app team                                                    | –                                                                  |
| **Sign in with Apple / Google**                                                                                                                                                 | Social login (Apple requires it if other social logins exist on iOS) | Create OAuth clients                                                                                                                  | uses `oauth_identities`                                            |
| 💲 **Content-safety vendor / hash lists** (e.g. CSAM hash matching programmes, image classifier)                                                                                | Mandatory for user-generated video with minors                       | Choose and contract a vendor; legal obligations (reporting duties) vary by country                                                    | implement `ContentModerator.moderateImage`                         |
| **Redis** (optional)                                                                                                                                                            | Shared rate limits across replicas                                   | Provision                                                                                                                             | `REDIS_URL`                                                        |
| 💲 **Monitoring/alerting** (Prometheus/Grafana, Sentry, log aggregation)                                                                                                        | Operate it                                                           | Scrape `/metrics` with `METRICS_TOKEN`; ship JSON logs                                                                                | `METRICS_TOKEN`, `LOG_LEVEL`                                       |
| **Secrets management**                                                                                                                                                          | Production secrets                                                   | Generate `JWT_SECRET`, `MEDIA_SIGNING_SECRET` (≥ 32 random chars each) in the platform's secret store; never commit                   | see `.env.example`                                                 |
| **GitHub**: Actions secrets/registry, branch protection                                                                                                                         | CI/CD                                                                | Enable Actions; decide image registry and deploy path                                                                                 | `.github/workflows/ci.yml` (build/test only; no deploy job)        |
| **Legal**: Terms, Privacy Policy, age policy, DMCA/abuse contact, data-retention periods, security disclosure address                                                           | Launch                                                               | Counsel review                                                                                                                        | see Questions                                                      |
| **App store accounts** (Apple, Google)                                                                                                                                          | Ship the mobile app                                                  | Out of backend scope                                                                                                                  | –                                                                  |

## Next recommended backend milestones

Ordered by "what unblocks a real launch":

1. **M11 — Staging deployment and reality check.** Deploy to a real host with managed Postgres, real S3/R2, a real SMTP
   provider; confirm CI is green on GitHub; run the real-upload smoke test; set up backups/PITR, alerts on `/metrics`,
   and a first load test (feed, upload, auth). Fix whatever the first contact with reality finds.
2. **M12 — Push notifications.** One `PushProvider` adapter (Expo is the fastest start; native APNs/FCM later), token
   invalidation handling, quiet hours/digest rules.
3. **M13 — Sync providers.** Strava first (OAuth, webhook, backfill, deduplication against manual/GPX imports — the
   idempotent `(user, source, external_id)` key is ready), then an on-device ingestion endpoint for Apple Health / Health
   Connect.
4. **M14 — Trust & safety.** Real image/video moderation + hash matching, report thresholds and auto-hide, appeals,
   staff-facing endpoints for a review UI (queue assignment, notes, user history), warning/suspension emails, spam/velocity
   heuristics, link/URL safety on captions.
5. **M15 — Login options.** Sign in with Apple/Google, optional TOTP/passkeys, suspicious-login notices.
6. **M16 — Feed v2.** Job-built candidate pools, infinite ranked scroll, "topics you follow", offline evaluation from the
   serving log, shadow-run a learned ranker ([`FEED.md`](docs/FEED.md#path-to-a-learned-ranker)).
7. **M17 — Athlete features beyond posts.** Weekly/monthly stats and goals, personal-record history, clubs/teams,
   challenges, segments/leaderboards (all reuse activities + privacy rules), plus direct messages if product wants them.
8. **M18 — Scale & ops.** HLS ladder or managed transcoder, CDN-aware signed delivery, search service
   (Meilisearch/Typesense) behind `SearchProvider`, table partitioning for events, read replicas, SSE/WebSocket for live
   notifications, OpenTelemetry tracing.
9. **Compliance pass** (any time before public launch): legal review of age policy and retention, privacy policy
   alignment with real behaviour, external penetration test.

## Questions for you

Simple questions; each has a default that I would pick if you have no preference. Answers decide the work above.

**Where and how it runs**

1. **Where should the backend be hosted?** (Fly.io / Render / Railway / AWS / your own server / not decided.) _Default: a container platform with managed Postgres (Render or Fly.io) — least effort._
2. **Which object storage should hold videos and photos?** (Cloudflare R2 / AWS S3 / Backblaze B2 / other.) _Default: Cloudflare R2 (no egress fees)._
3. **Which email service should send verification and password-reset mail?** (Postmark / Resend / SES / SendGrid / other.) _Default: Postmark or Resend._
4. **Will there be a web app too, or mobile only at first?** If web: what is its address (for CORS and email links)? _Default: mobile first; web later._
5. **Which domain name will the API use?** _(Needed for links and TLS.)_

**Product** 6. **Which workout-sync provider first: Strava, Garmin, or Apple Health/Health Connect?** _Default: Strava._ 7. **How should push notifications be sent: Expo (fastest) or directly via Apple/Google?** Will the app be built with React Native/Expo? _Default: Expo if the app is React Native._ 8. **Is a 3-minute / 300 MB limit per video OK?** (Everything is re-encoded to 720p anyway.) _Default: keep 180 s / 300 MB._ 9. **Do you want ads or paid placements from the platform itself later?** (Today only creator-disclosed sponsorships exist.) _Default: no, creator disclosures only._ 10. **Should the home feed be endless, or is "refresh for new posts" (about 100 posts per refresh) fine for now?** _Default: finite is fine._

**Safety, privacy and legal** 11. **Which countries will you launch in first?** (Decides age rules and legal duties.) _Default: US only, with the current 13+ signup and under-16 private rule — pending legal review._ 12. **Who will review reports and moderate content, and do you need a staff web tool?** (Today staff use the API only.) _Default: build a small internal tool in the next milestones._ 13. **How long may we keep the moderation audit trail and deleted-account records?** _Default: keep the audit trail indefinitely (it holds moderator notes and ids, while report snapshots hold the reported text), purge everything else on deletion._ 14. **Is 30 days the right "undo" window after someone requests account deletion?** _Default: 30 days._ 15. **Are you comfortable that signup tells people when an email is already registered?** (Easier for users; slightly easier for attackers to check emails.) _Default: yes, keep it._ 16. **Which address should receive security reports?** (e.g. security@yourdomain.) _Needed for `SECURITY.txt`._

**Process** 17. **Should I open a pull request for this branch?** (I did not, as instructed.) And who should review it?
