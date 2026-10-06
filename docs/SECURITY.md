# Security and privacy

This is what the backend defends against, how, which tests prove it, and — just as important — what it
does **not** yet cover. Nothing here has had an independent penetration test or a legal review; both are
listed in [`HANDOFF.md`](../HANDOFF.md) as needed before real users.

> Reporting a vulnerability: there is no public disclosure channel yet. Set one up (a `security@` mailbox
> and a `SECURITY.txt`) before launch — see HANDOFF → _Questions for you_.

## What we protect, and from whom

| Asset                                                                       | Worst case                                                 | Main adversaries                                                      |
| --------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| Accounts (credentials, sessions)                                            | Takeover, impersonation                                    | Credential stuffing, phishing, stolen device/token, malicious insider |
| **Location & routine** (GPS routes, home/work, when someone is away)        | Stalking, burglary, physical harm                          | Stalkers, ex-partners, scrapers aggregating public routes             |
| **Minors' data**                                                            | Contact/grooming, exposure                                 | Predators, scrapers                                                   |
| Private content (private accounts, followers-only posts, drafts, bookmarks) | Disclosure                                                 | Anyone not entitled, blocked users, enumeration                       |
| Media files                                                                 | Hosting malware / illegal content, hotlinking              | Malicious uploaders, abusers                                          |
| The platform itself                                                         | Spam, harassment, fake sponsored content, abuse of ranking | Spammers, brands hiding ads, bots                                     |
| Operational secrets                                                         | Total compromise                                           | Leaks via repo, logs, config                                          |

## Authentication and sessions

| Control                     | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password hashing            | **argon2id** (`@node-rs/argon2`: 19 MiB, 2 passes, 1 lane — OWASP minimum profile). Hashes below the current parameters are transparently re-hashed at next login. Passwords are 10–128 chars, NIST-style: no composition rules (length beats complexity), but a blocklist of well-known passwords and values containing the account's own email/username is refused (`PASSWORD_TOO_WEAK`); they are never logged (log redaction) or returned |
| Login                       | Same `INVALID_CREDENTIALS` for unknown email, wrong password and OAuth-only account; a dummy argon2 verification equalises timing so response time does not reveal whether an email exists                                                                                                                                                                                                                                                    |
| Brute force                 | Per-IP limit (10/min) **and** a per-account progressive throttle (5 free failures, then growing delays up to 15 minutes → `429` + `Retry-After`), so rotating IPs does not help an attacker. A successful login resets it                                                                                                                                                                                                                     |
| Access tokens               | JWT HS256 (`jose`), 15 minutes, carry only user/session ids. **Every request re-checks the session and user rows**, so logout, "log out everywhere", password change/reset, suspension and deletion are immediate. `JWT_SECRET_PREVIOUS` allows secret rotation without logging everyone out                                                                                                                                                  |
| Refresh tokens              | 256-bit random, stored only as SHA-256, 30 days, **single use**. Rotation marks the old token used; presenting a used token revokes the whole session (`REFRESH_TOKEN_REUSED`) — a stolen-token replay burns the thief and the victim must sign in again. Sessions have an absolute 90-day cap                                                                                                                                                |
| Account recovery            | Email verification and password-reset tokens are random, hashed at rest, single-use, short-lived (24 h / 60 min), and reset signs out every session. `POST /auth/password/forgot` answers identically whether or not the email exists                                                                                                                                                                                                         |
| Sealed secrets in the queue | Verification/reset tokens needed by the email job are **encrypted** (AES-256-GCM, key derived from `JWT_SECRET`) inside the job payload — a database dump of `jobs` does not contain usable tokens                                                                                                                                                                                                                                            |
| Re-authentication           | Account deletion and data export need the current password                                                                                                                                                                                                                                                                                                                                                                                    |
| Devices                     | Sessions list with coarse location hint (IPv4 /24, IPv6 /48 — never the full IP), per-session revoke; push tokens are unique per device and removed on logout                                                                                                                                                                                                                                                                                 |
| Staff                       | Roles are `USER`/`MODERATOR`/`ADMIN`. **No API grants roles**: `pnpm admin:grant` runs against the database with explicit operator access. Staff cannot act on equal/higher roles; creator verification is ADMIN-only                                                                                                                                                                                                                         |

Signup tells the caller when an email is already registered (`409 EMAIL_TAKEN`). That is a deliberate,
**accepted** enumeration tradeoff for usability (the alternative is a confusing "check your email" for
every signup); it is rate-limited per IP. Revisit if enumeration becomes a concern.

## Authorization and privacy rules

Authentication answers _who_; authorization answers _may they_. They are separate layers:

- **Route guards** (`requireAuth`, `optionalAuth`, `requireVerified`, `requireRole`) say who may call an
  endpoint at all. `route-security.test.ts` enumerates **every registered route** and asserts: public
  routes are exactly an allow-list; every other route rejects missing, malformed, expired and revoked
  tokens; staff routes reject normal users; every request body schema is `.strict()`.
- **Resource rules** live in SQL predicates, not scattered `if`s: `social/visibility.ts`,
  `posts/visibility.ts`, `search/predicates.ts`. Listings AND them into the query; single lookups reuse
  them and answer **404 (never 403)** when the viewer may not know the thing exists, so existence cannot
  be probed. Feed snapshots **re-check visibility at serve time**, so a post that became private,
  hidden or blocked after the snapshot was built disappears before it is shown.
- **Blocks** are enforced three times: server-side filtering of every listing/notification, database
  triggers that sever and forbid relationships across a block, and mutual invisibility.
- **Ownership** of foreign references is enforced by composite foreign keys (a post can only attach its
  author's activity and media; a report target must exist) — not just by checks that could be skipped.
- IDs are UUIDv7: not guessable _and_ not relied upon for secrecy — every access is authorised.

### Location privacy

Routes are the most sensitive data in the product, so privacy is applied **at read time to the raw
track**, with the strictest sensible default:

- `routePrivacy` per activity: `FULL`, `TRIMMED` (default: the first and last stretch are cut off, so
  the start/finish — usually home — is not revealed), `APPROXIMATE` (trimmed + coordinates coarsened),
  `HIDDEN`. Only the **owner** ever receives the exact track.
- **Privacy zones** (circles around home/school/work, 50 m–5 km): points inside a zone are removed from
  what others see. Segments are returned **separately** and clients must never join them (the gap is
  the privacy). The check tests whole _segments_ against circles, not just points, so a long straight
  line cannot "jump over" a zone. Zones themselves are visible to the owner only.
- Activities carry no derived place names; `locationLabel` is whatever the user typed.
- GPX import strips nothing else from the user's own data, but parsing refuses XML entities / external
  references (XXE, billion-laughs) and caps size (10 MB) and point count (50 000).

### Minors

Policy in code today (all thresholds are configuration — **each launch market's law must be reviewed**:
COPPA/GDPR-K/UK AADC and similar are not satisfied merely by this list):

- Signup requires `MIN_SIGNUP_AGE` (13) → `UNDER_MINIMUM_AGE`.
- Users under `MINOR_PUBLIC_MIN_AGE` (16) cannot be public; under `ADULT_AGE` (18) accounts are private
  by default and are **excluded from search and suggestions**, and never get sponsored content in
  discovery.
- Reports have a `MINOR_SAFETY` reason; moderation of such reports is a human process (see below).
- _Not implemented:_ parental consent flows, age verification beyond the self-declared birth date,
  restrictions on messaging (there is no messaging), or special data-retention rules.

### Personal data

- **Export** (`POST /me/exports`, password required, 1/day): all of the user's data as streamed JSON
  in object storage with a short-lived signed link, expiring after 7 days. Media _bytes_ are not
  included (links are).
- **Deletion**: request → 30-day grace (restricted login, can cancel) → permanent purge of the
  account, content, relationships, notifications and stored files (queued **in the same transaction**
  as the delete so no file is orphaned). Deleted comments/posts have their text erased immediately and
  rows purged after 30 days.
- **Logging**: pino with redaction of authorization headers, cookies, passwords, tokens and secrets;
  request logs drop query strings (they contain media signatures); no request bodies are logged.
- Third parties today: none beyond what you configure (SMTP provider, object storage, later push).

## Input, content and media safety

- **Validation everywhere**: Zod on params, query, body and _response_. Bodies are strict (unknown
  fields rejected), 1 MB limit, malformed JSON gets the standard error envelope.
- **SQL**: parameterised Kysely only; no string-built SQL with user input (search text is escaped for
  `LIKE`, and full-text input is reduced to alphanumeric tokens before it becomes a `tsquery`, so no
  operator can be injected).
- **Output**: JSON only; no HTML is ever rendered by the server. Clients must treat captions/comments
  as untrusted text (no HTML injection into web views).
- **Uploads**: pre-signed single-object URLs with fixed key, content type and size; the server
  verifies the stored object's size and type, then **probes it with ffprobe and fully re-encodes it**
  (the original is never served): format allow-list, duration/size/pixel limits, all metadata
  (including GPS EXIF) stripped from every output. Details: [`MEDIA_PIPELINE.md`](MEDIA_PIPELINE.md).
- **Signed media URLs**: short-lived (`MEDIA_URL_TTL_SECONDS`), never persisted by the API. With S3 they
  are native presigned `GET`s; with the dev-only local driver they are HMAC-signed, verified in constant
  time and bound to the object path (Range supported, private cache headers).
- **Automated moderation hook**: captions and comments pass through a `ContentModerator` port. The only
  adapter is a word-list (`MODERATION_FLAG_TERMS` → file an automated report; `MODERATION_BLOCK_TERMS`
  → reject). Image/video classification is a **stub** — real CSAM/abuse detection (hash matching, a
  vendor) is a launch blocker for a platform with minors and user video (see HANDOFF).
- **Reports**: users can report posts, comments and users (one report per person per target,
  rate-limited); staff act through an audited queue with CAS state changes; every action writes an
  append-only audit row **in the same transaction** as its effect.

## HTTP and infrastructure hardening

- `helmet` security headers, no `X-Powered-By`, `Cache-Control: no-store` on API responses.
- CORS closed unless `CORS_ORIGINS` lists origins (wildcard refused in production).
- Hostile `X-Request-Id` values are replaced, not echoed (log/header injection).
- `TRUST_PROXY_HOPS` trusts exactly N proxy hops for the client IP (never blindly `X-Forwarded-For`).
- `/metrics` requires `METRICS_TOKEN` (and does not exist in production without one); `/healthz` and
  `/readyz` reveal nothing. Error responses for unexpected failures are generic (`INTERNAL`) with a
  request id; details go to logs only.
- Container: multi-stage image, runs as a non-root user, production dependencies only, no secrets baked
  in (`.dockerignore`).

### Configuration guards

`NODE_ENV=production` **refuses to start** (listing every problem at once) when:
`JWT_SECRET` or `MEDIA_SIGNING_SECRET` is the dev default, a `.env.example` placeholder, or shorter than
32 characters · `DEV_AUTO_VERIFY_EMAIL` or `DEV_ENDPOINTS_ENABLED` is on · rate limiting is off ·
`MAIL_DRIVER` is `console` (or `smtp` without `SMTP_URL`) · `STORAGE_DRIVER` is `local` · `CORS_ORIGINS`
contains `*`. `STORAGE_DRIVER=s3` additionally requires bucket and credentials. `.env` files are not
loaded in production at all. Secrets are only ever read from the environment; `.env.example` contains
placeholders, never working values.

## What enforces this (tests)

| Guarantee                                                                                                                                                             | Test                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Every route's authentication; public allow-list; strict bodies                                                                                                        | `route-security.test.ts`                                                                  |
| Production config guards, `.env.example` completeness, log redaction, headers, hostile request ids, body limits, per-IP and per-account throttling, `/metrics` closed | `hardening.test.ts`                                                                       |
| Module boundaries (who may import what; which libraries are allowed where)                                                                                            | `architecture.test.ts`                                                                    |
| Visibility matrix: public/private/followers/blocked × every content type                                                                                              | `visibility.test.ts`, `social.test.ts`, `posts.test.ts`, `feed.test.ts`, `search.test.ts` |
| Auth lifecycle: rotation, reuse detection, logout-all, reset, throttle, enumeration                                                                                   | `auth.test.ts`                                                                            |
| Route privacy transforms, zones, GPX XXE                                                                                                                              | `activities.test.ts`, `geo.test.ts`                                                       |
| Media state machine, signed URLs, metadata stripping, size/format limits                                                                                              | `media.test.ts`, `media-cleanup.test.ts`, `storage-s3.test.ts`                            |
| Moderation permissions, rank rules, append-only audit                                                                                                                 | `moderation.test.ts`, `migrations.test.ts`                                                |
| Account purge, export, deletion grace                                                                                                                                 | `account-lifecycle.test.ts`                                                               |
| No N+1 / bounded queries per page                                                                                                                                     | `query-budget.test.ts`                                                                    |
| Dependencies: `pnpm audit --prod` in CI (no known vulnerabilities at the time of writing)                                                                             | `.github/workflows/ci.yml`                                                                |

## Known gaps

Be honest about these before launch:

1. **No external security review** (pentest, threat-model review) and no formal privacy/legal review.
2. **Image/video content moderation is a stub**; there is no CSAM hash matching, malware scanning of
   uploads (everything is re-encoded, which neutralises most payloads, but is not a scan), or
   appeals / report-threshold auto-hide / staff UI / suspension emails.
3. **Rate limiting is per process** unless `REDIS_URL` is set; Redis outages _fail open_ (availability
   over strictness). Behind several replicas without Redis the effective limits multiply.
4. **No MFA / passkeys / OAuth login yet** (the `oauth_identities` table exists; no flow). Password
   reset by email is the only recovery path. A compromised mailbox is a compromised account.
5. **Signup reveals registered emails** (accepted, rate-limited — see above).
6. **Append-only audit relies on triggers**: a database superuser can disable them. Use separate roles
   (app role without `ALTER`/`TRIGGER`), WAL archiving, and ship `moderation_actions` to write-once
   storage if regulation demands.
7. **Secrets management** is whatever your platform provides (env vars). No KMS, no automatic rotation;
   `JWT_SECRET_PREVIOUS` supports manual rotation of access-token signing, and queued sealed payloads
   are unsealed with the current _or_ previous secret, so a single rotation does not strand them (two
   rotations in a row would; users can then simply request a new link).
8. **Data at rest** encryption is the database/storage provider's job; the app itself encrypts only the
   tokens inside queued email jobs (the `integration_connections` columns are reserved for sealed
   provider tokens, but no provider is wired up yet).
9. **No tracing/anomaly detection/alerting rules** are defined (metrics and structured logs exist).
10. **`GET /v1/openapi.json` is public** (no secrets, but it documents the surface). Gate it at the
    proxy if undesired.
11. **Minor-safety policy is a first draft** (see above) — thresholds and behaviours need legal review.
12. **Backups, disaster recovery and data-retention periods for the audit trail** are not defined.
