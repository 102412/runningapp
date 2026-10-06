# Decisions

Short architecture decision records: what was decided, why, what it costs, and **what would make us
revisit it**. Decisions were made autonomously during the initial build (the brief asked for high
autonomy); items that genuinely need a human are collected as questions in
[`HANDOFF.md`](../HANDOFF.md#questions-for-you). To change a decision, add a new record that supersedes
the old one rather than rewriting history.

| #                                                                                   | Decision                                                         |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [001](#adr-001-modular-monolith-one-image-two-processes)                            | Modular monolith, one image, two processes                       |
| [002](#adr-002-postgresql-for-everything-until-it-hurts)                            | PostgreSQL for everything until it hurts                         |
| [003](#adr-003-typescript-fastify-zod-kysely)                                       | TypeScript, Fastify, Zod, Kysely                                 |
| [004](#adr-004-contracts-first-zod--openapi--client)                                | Contracts first: Zod → OpenAPI → client                          |
| [005](#adr-005-short-jwts-checked-against-the-database-rotating-refresh-tokens)     | Short JWTs checked against the database; rotating refresh tokens |
| [006](#adr-006-authorization-as-sql-predicates-404-not-403)                         | Authorization as SQL predicates; 404 not 403                     |
| [007](#adr-007-counters-by-triggers-uuidv7-keys-soft-delete)                        | Counters by triggers, UUIDv7 keys, soft delete                   |
| [008](#adr-008-keyset-pagination-snapshots-for-ranked-feeds)                        | Keyset pagination; snapshots for ranked feeds                    |
| [009](#adr-009-heuristic-ranking-v1-with-a-learning-ready-event-pipeline)           | Heuristic ranking v1 with a learning-ready event pipeline        |
| [010](#adr-010-activities-and-posts-are-independent)                                | Activities and posts are independent                             |
| [011](#adr-011-route-privacy-is-applied-at-read-time-to-the-raw-track)              | Route privacy applied at read time to the raw track              |
| [012](#adr-012-media-signed-direct-uploads-own-ffmpeg-progressive-mp4)              | Media: signed direct uploads, own ffmpeg, progressive MP4        |
| [013](#adr-013-sponsorship-is-data-not-styling)                                     | Sponsorship is data, not styling                                 |
| [014](#adr-014-moderation-audit-is-append-only-staff-roles-are-granted-out-of-band) | Append-only moderation audit; roles granted out of band          |
| [015](#adr-015-externals-behind-ports-no-pretend-integrations)                      | Externals behind ports; no pretend integrations                  |
| [016](#adr-016-a-table-backed-job-queue)                                            | A table-backed job queue                                         |
| [017](#adr-017-privacy-and-minors-defaults)                                         | Privacy and minors defaults                                      |
| [018](#adr-018-accepted-trade-off-signup-reveals-registered-emails)                 | Accepted trade-off: signup reveals registered emails             |
| [019](#adr-019-forward-only-checksummed-migrations)                                 | Forward-only, checksummed migrations                             |
| [020](#adr-020-tests-run-against-real-postgres-and-enforce-the-architecture)        | Tests run on real Postgres and enforce the architecture          |
| [021](#adr-021-sports-are-rows-with-typed-keys)                                     | Sports are rows with typed keys                                  |
| [022](#adr-022-rate-limiting-in-process-by-default-redis-optional)                  | Rate limiting in-process by default, Redis optional              |

---

## ADR-001 Modular monolith, one image, two processes

**Context.** Small team, one product, a UI built separately; the main risk is shipping _correct, private_
behaviour, not scale. **Decision.** One codebase with enforced module boundaries (`architecture.test.ts` pins
who may depend on whom), deployed as the same image in two roles: `server` (HTTP) and `worker` (jobs).
**Consequences.** Simple deploys, transactions across modules where needed, no network hops or distributed
failure modes; the boundary tests keep extraction possible. **Revisit when** a module needs an independent
scaling/ownership profile (media processing is the first candidate — it already runs as its own deployment
role) or a team boundary appears.

## ADR-002 PostgreSQL for everything until it hurts

**Context.** Early products die of operational sprawl. **Decision.** PostgreSQL is the system of record,
**job queue** (`SKIP LOCKED`), **search index** (FTS + trigram), **analytics store** (events, rollups) and
**feed snapshot store**. Redis is optional (shared rate limits only). **Consequences.** One thing to back
up, secure and reason about; transactional enqueue (no lost jobs); less specialised performance.
**Revisit when** — jobs: sustained queue throughput or fan-out saturates the primary (→ SQS/Redis streams
behind the `JobQueue` seam); search: relevance/typo tolerance/scale demand it (→ Meilisearch/Typesense/
OpenSearch behind `SearchProvider`, already a port); events: > tens of millions of rows/day (→ partition,
then a columnar store).

## ADR-003 TypeScript, Fastify, Zod, Kysely

**Decision.** TypeScript (strict) on Node 22; **Fastify 5** (fast, schema-first, mature plugin ecosystem);
**Zod 4** (one schema language for validation, types and OpenAPI); **Kysely** (typed SQL builder: the
database remains visible and tunable, unlike an ORM; types are generated from the live schema);
**Vitest**, ESLint, Prettier, pnpm workspaces. **Consequences.** The same types run from the database column
to the generated client. Hand-written SQL for the hot paths is normal here. **Revisit when** the team prefers
another runtime — the contract (OpenAPI) and the SQL schema survive a rewrite; the code does not need to.

## ADR-004 Contracts first: Zod → OpenAPI → client

**Decision.** `packages/contracts` (Zod) is the single source of truth: routes validate with it, OpenAPI 3.1 is
generated from the registered routes (`docs/openapi.json`, committed), the endpoint table and the client's
types are generated from that, and CI fails on drift. Conventions: request bodies are anonymous and
`.strict()`; only response/entity schemas and shared enums carry `.meta({ id })` (named components).
**Consequences.** A UI developer can trust the generated types; backend changes that break clients are visible in
review as a diff of generated files. **Revisit when** non-TypeScript consumers need richer generation (the
OpenAPI file is already the neutral interface).

## ADR-005 Short JWTs checked against the database; rotating refresh tokens

**Context.** Pure stateless JWTs cannot be revoked; pure opaque sessions need a lookup everywhere.
**Decision.** HS256 access JWTs (15 min) that only _name_ a session, **validated against `sessions ⋈ users` on every
request**; opaque 256-bit refresh tokens stored hashed, **single use with reuse detection** (replay revokes the
session). **Consequences.** Logout, revoke-all, suspension, password change are immediate; one indexed lookup per
request (cheap relative to the work done). **Revisit when** other services must verify tokens without the database
(→ asymmetric keys/JWKS) or the per-request lookup shows up in profiles (→ short-TTL cache with explicit
invalidation).

## ADR-006 Authorization as SQL predicates; 404 not 403

**Decision.** "Can viewer V see X" is a reusable SQL predicate (`social/visibility.ts`, `posts/visibility.ts`,
`search/predicates.ts`) ANDed into every query that returns other people's data; single resources reuse it and
answer **404** (existence is not revealed). Route guards say _who may call_; predicates say _what they may see_.
Feeds re-check visibility at serve time. **Consequences.** Leaks need a _missing predicate_ rather than a
forgotten `if`, and tests enumerate the matrix. Predicates add join cost — acceptable and indexed.
**Revisit when** rules become per-object ACLs (sharing with named people) — then model permissions in a table
and join it in the same predicate seam.

## ADR-007 Counters by triggers, UUIDv7 keys, soft delete

**Decision.** Denormalised counts are maintained by database triggers with relative updates (exact under
concurrency, impossible to forget). Keys are UUIDv7 (index-friendly, time-ordered, non-guessable enough that
authorisation — not obscurity — is what protects). Posts/comments are soft-deleted (instant disappearance,
text erased) and purged after 30 days. **Consequences.** Write amplification on hot rows (a viral post's counter
row is contended). **Revisit when** a single post's counter becomes a hot-row bottleneck (→ sharded counters or
buffered increments flushed by a job).

## ADR-008 Keyset pagination; snapshots for ranked feeds

**Decision.** Lists use keyset cursors (stable under writes, O(1) deep paging). Ranked feeds (Home/Explore) are
built once into a ≈100-item **snapshot** (30 min) and paged by offset into it, so pages never duplicate or
reorder. Search uses a capped offset (relevance sorting can't be keyset). **Consequences.** Ranked feeds are
finite per refresh. **Revisit when** product wants infinite ranked scroll (→ build snapshots incrementally or move
retrieval to a service that returns the next ranked slice with an exclusion list of seen ids).

## ADR-009 Heuristic ranking v1 with a learning-ready event pipeline

**Context.** No data yet; vendors cost money and lock in; a black box can't be debugged or made safe on day one.
**Decision.** A pure, additive heuristic (recency, relationship, learned affinities, smoothed quality, popularity,
diversity, sponsored density), with the _infrastructure_ of a real recommender: serving log with per-term signals,
idempotent behavioural events, watermarked rollups, decayed affinities, personalisation opt-out. **Consequences.**
Explainable, cheap, tunable, safe. Not "smart". **Revisit when** there are enough users/events to beat the heuristic
offline — then run a model in shadow (see [`FEED.md`](FEED.md#path-to-a-learned-ranker)).

## ADR-010 Activities and posts are independent

**Decision.** An activity (the DO→LOG record: metrics, splits, route) and a post (the SHOW: caption, media,
audience) are separate rows with an optional link. Logging can auto-create a post (setting + request flag),
never for `PRIVATE` activities or unverified emails; deleting an activity deletes only its _auto_ post;
authored posts survive and detach. A composite FK guarantees a post can only attach its author's activity.
`format` is server-derived. **Consequences.** Users can log privately, post without logging, add media later.
Slightly more joins. **Revisit when** product wants multi-activity posts (a day summary): the link would become
a join table.

## ADR-011 Route privacy is applied at read time to the raw track

**Decision.** The exact track is stored once; every non-owner response is the output of a transform (trim, privacy
zones, coarsening, hide) computed per request, defaulting to `TRIMMED`. Segments, not a single line, are
returned so gaps stay gaps. **Consequences.** Changing a privacy setting or zone applies retroactively and
instantly; no second copy of sensitive data to leak. Cost: CPU per read (previews are simplified to ≤ 120 points,
detail to ≤ 2 000). **Revisit when** route reads dominate CPU (→ cache transformed segments keyed by
`(activity, viewer-class, settings-version)`).

## ADR-012 Media: signed direct uploads, own ffmpeg, progressive MP4

**Decision.** Bytes go client → object storage via presigned PUT (the API never proxies video); a worker
validates with ffprobe and **re-encodes everything** (720p H.264 + 360p + poster/thumb; images to JPEG
variants), stripping all metadata; originals are kept private; delivery is progressive MP4 over signed URLs;
post publishing waits on media readiness via jobs. **Consequences.** Cheap, no vendor, privacy-safe outputs;
CPU-heavy worker; no adaptive bitrate. **Revisit when** videos get longer, audiences global or encoding cost
dominates (→ managed transcoder/HLS behind the same state machine). See [`MEDIA_PIPELINE.md`](MEDIA_PIPELINE.md).

## ADR-013 Sponsorship is data, not styling

**Decision.** A row in `sponsorship_disclosures` is what makes a post sponsored; the API serialises it as a
`sponsorship` object with a ready-to-render `label`; a disclosure can't be removed after publishing; ranking
treats sponsored content separately (density cap, discovery penalty, never to minors in discovery); creator
_verification_ is a separate, staff-only fact. **Consequences.** Disclosure can't be forgotten or styled away
without the UI ignoring the data. Legal wording per jurisdiction is a product/legal task. **Revisit when** ad
products (paid placement by the platform) arrive — they need their own model, not this one.

## ADR-014 Moderation audit is append-only; staff roles are granted out of band

**Decision.** Every staff action writes an audit row **in the same transaction** as its effect;
`moderation_actions` is append-only by trigger and has no foreign keys (survives deletions). Staff cannot act
against equal/higher roles; verification is ADMIN-only; there is **no API to grant roles** (`pnpm admin:grant`).
**Consequences.** A compromised moderator account cannot mint admins or rewrite history through the API.
**Revisit when** staff headcount grows (→ role-management UI with its own audit + two-person rules) or
regulators require tamper-evident logs (→ ship audit rows to write-once storage).

## ADR-015 Externals behind ports; no pretend integrations

**Decision.** Object storage, mail, push, content moderation, search and event recording are interfaces with a
development adapter and, where we could write one without credentials, a production adapter (S3, SMTP).
**Push delivery, image moderation, OAuth, Strava/Garmin are not implemented and are documented as such** — the
schema/hooks exist, the integrations don't pretend to. **Consequences.** Everything runs locally and in CI with
no accounts; going live needs explicit human setup ([`HANDOFF.md`](../HANDOFF.md#external-services-still-requiring-human-setup)).
**Revisit** per integration when credentials exist.

## ADR-016 A table-backed job queue

**Decision.** `jobs` table with `SKIP LOCKED` claiming, exponential backoff, stale-lock reclaim, dedupe/unique
keys (cron buckets so N schedulers enqueue once), and **transactional enqueue** next to the state change.
Handlers are idempotent. **Consequences.** No lost "after commit" work, trivial local setup. **Revisit when**
throughput or latency needs exceed polling (see ADR-002).

## ADR-017 Privacy and minors defaults

**Decision.** Privacy-protective defaults: `TRIMMED` routes, activity auto-post respects visibility, minors are
private by default / non-discoverable / excluded from search and suggestions / no sponsored discovery; behavioural
personalisation can be switched off and then discards events; data export and deletion with a grace period are
built in. Age thresholds (13/16/18) are configuration. **Consequences.** Safe starting point. **Revisit** with
**legal review per launch market** — these are engineering defaults, not legal advice.

## ADR-018 Accepted trade-off: signup reveals registered emails

**Decision.** `POST /auth/signup` answers `EMAIL_TAKEN`. Login and password-reset do **not** reveal existence
(identical responses, timing equalised). **Why.** Usability: the alternative ("check your email" for every
signup) confuses legitimate users; the endpoint is rate-limited (5/min/IP). **Revisit when** enumeration becomes
a real abuse vector (→ always answer 202 and send "you already have an account" email).

## ADR-019 Forward-only, checksummed migrations

**Decision.** Plain SQL files applied in order, each in a transaction, with SHA-256 checksums and an advisory lock;
never edit an applied file; no down-migrations (restore from backup / fix forward). **Consequences.** Simple and
auditable; rollback = deploy previous code (migrations are written additive-first). **Revisit when** zero-downtime
changes on large tables need non-transactional steps (add a `-- no-transaction` marker to the runner).

## ADR-020 Tests run against real Postgres and enforce the architecture

**Decision.** No mocked data layer: each test file clones a migrated template database. Whole-system audits fail
when someone forgets something: `route-security` (auth on every route), `architecture` (allowed imports),
`query-budget` (no N+1), `hardening` (production guards), `enum-parity` (contract ⇄ database). Time is injected.
**Consequences.** Tests catch SQL and trigger bugs for real; the suite takes ~80 s and needs Postgres (+ ffmpeg).
**Revisit when** the suite gets slow enough to hurt (→ shard files across CI jobs).

## ADR-021 Sports are rows with typed keys

**Decision.** Sports are table rows with capability flags (what metrics are meaningful, how speed is shown) so the
UI can adapt without code, plus a typed key list in the contract for client type safety. Adding a sport = migration

- `SPORT_KEYS` entry (a parity test enforces both). **Consequences.** Slightly more ceremony than pure data, far
  better client types. **Revisit when** sports need to be user- or admin-defined at runtime (then drop the typed list
  and ship keys as plain strings).

## ADR-022 Rate limiting in-process by default, Redis optional

**Decision.** Per-IP and per-user limits are in memory unless `REDIS_URL` is set, in which case they are shared
across replicas and **fail open** if Redis is down (availability over strictness). Login additionally has a
**per-account** progressive throttle in the database. **Consequences.** Single replica works with zero
infrastructure; multi-replica deployments should set Redis (or enforce limits at the edge/WAF). **Revisit when**
abuse needs more than counters (→ edge WAF, bot detection, per-device reputation).
