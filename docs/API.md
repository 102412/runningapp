# API conventions

This page describes the rules that apply to **every** endpoint. The endpoint-by-endpoint table is
[`API_REFERENCE.md`](API_REFERENCE.md) (generated); the machine-readable contract is
[`openapi.json`](openapi.json), also served live at `GET /v1/openapi.json`. Types for front-ends are
generated from it and shipped in [`@runningapp/api-client`](../packages/api-client) — prefer that
client over hand-written `fetch` calls (it implements token refresh, pagination and event batching).
Screen-by-screen guidance: [`FRONTEND_INTEGRATION.md`](FRONTEND_INTEGRATION.md).

## Basics

|                      |                                                                                                                                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base URL             | `PUBLIC_BASE_URL` (dev: `http://localhost:3000`)                                                                                                                                                                                  |
| Prefix               | Every resource lives under **`/v1`**. `/healthz`, `/readyz`, `/metrics` are operational and unversioned                                                                                                                           |
| Format               | JSON in, JSON out (`Content-Type: application/json`). The only exceptions are GPX import (`application/gpx+xml`) and the dev-only local storage upload                                                                            |
| Versioning           | `API_VERSION` in `packages/contracts/src/version.ts` (currently `0.1.0`). While `0.x`, a breaking change bumps the minor version. A future incompatible API becomes `/v2` next to `/v1`                                           |
| Ids                  | UUIDv7 strings. Time-ordered, so they sort roughly by creation time; treat them as opaque                                                                                                                                         |
| Timestamps           | ISO-8601 UTC with `Z` (`2026-03-14T07:30:00.000Z`)                                                                                                                                                                                |
| Dates                | `YYYY-MM-DD` (birth date, partnership dates, activity local date)                                                                                                                                                                 |
| Units                | **SI, always**: metres, seconds, metres/second, kilograms. Unit-system preference (`METRIC`/`IMPERIAL`) is a _display_ setting the client applies                                                                                 |
| Unknown fields       | Request bodies are **strict**: an unknown property is `422 VALIDATION_FAILED`, not silently ignored. Responses may gain fields in minor versions — clients must ignore fields they do not know                                    |
| Enums                | Defined once in `packages/contracts/src/enums.ts` and exported by the client. A new value may appear in a future minor version: render unknown values gracefully                                                                  |
| Request id           | Every response carries `X-Request-Id`. A client may send its own (8–64 chars of `[A-Za-z0-9._-]`); otherwise the server generates one. It is also in every error body and every log line — quote it in bug reports                |
| Caching              | `Cache-Control: no-store` on all API responses (they are per-viewer and often private). Exceptions: `GET /v1/sports` (`public, max-age=60`) and signed media files (`private, max-age=<remaining signature lifetime>, immutable`) |
| Compression / limits | JSON bodies are limited to 1 MB (`413 PAYLOAD_TOO_LARGE`); GPX import to 10 MB                                                                                                                                                    |
| CORS                 | Off unless `CORS_ORIGINS` lists the allowed web origins. Native apps do not need it                                                                                                                                               |

## Authentication

- **Bearer access token** (JWT, HS256, 15 min) in `Authorization: Bearer <token>`.
- **Opaque refresh token** (30 days, single use) — exchanged at `POST /v1/auth/refresh` for a new pair.
  Every refresh _rotates_ the refresh token; presenting an old one a second time is treated as theft:
  the whole session is revoked and the call fails with `REFRESH_TOKEN_REUSED`. (This is why a client
  must **serialize** refreshes — `api-client` does, including across browser tabs via a lock.)
- A session lives at most `SESSION_MAX_AGE_DAYS` (90) regardless of refreshing.
- The server checks the session against the database on **every** request, so logout, "log out
  everywhere", password change, suspension and deletion take effect immediately — not when the access
  token expires.

| Endpoint class                                                                                                                                            | Behaviour without a valid token                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public` (11 routes: signup, login, refresh, verify-email, password forgot/reset, username-available, `GET /sports`, plus dev-only storage/outbox routes) | works                                                                                                                                                                                       |
| `optional` (public content: user profiles, posts, activities, comments, topics…)                                                                          | works anonymously and shows only what a stranger may see. **A token that is presented must still be valid** — an expired token is `401 TOKEN_EXPIRED`, not silently downgraded to anonymous |
| `bearer`                                                                                                                                                  | `401 UNAUTHENTICATED` / `TOKEN_EXPIRED` / `TOKEN_INVALID` / `SESSION_REVOKED`                                                                                                               |
| `staff` (`/v1/admin/*`)                                                                                                                                   | as `bearer`, plus `403 INSUFFICIENT_ROLE` for `USER` accounts                                                                                                                               |

Authentication outcomes a client must handle:

| Code                                                                                | HTTP | What to do                                                                                                             |
| ----------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------- |
| `TOKEN_EXPIRED`                                                                     | 401  | Refresh once, retry the request once                                                                                   |
| `TOKEN_INVALID`, `SESSION_REVOKED`, `REFRESH_TOKEN_INVALID`, `REFRESH_TOKEN_REUSED` | 401  | Drop tokens, show sign-in                                                                                              |
| `INVALID_CREDENTIALS`                                                               | 401  | Login failed. Same answer for "no such email" and "wrong password"                                                     |
| `ACCOUNT_SUSPENDED`                                                                 | 403  | Show "your account is suspended"; only `/me`, logout and deletion-cancel routes still work                             |
| `ACCOUNT_PENDING_DELETION`                                                          | 403  | Login still works (**restricted mode**) so the user can `DELETE /v1/me/account/deletion` to cancel; offer exactly that |
| `EMAIL_NOT_VERIFIED`                                                                | 403  | Creating posts/comments/reports (and publishing) needs a verified email. Offer `POST /v1/auth/verify-email/resend`     |

Passwords are 10–128 characters with no composition rules; very common passwords and ones containing
the email/username are refused with `422 PASSWORD_TOO_WEAK` (see [`SECURITY.md`](SECURITY.md)). Usernames match `^[A-Za-z][A-Za-z0-9_.]{2,29}$`, no `..`, no trailing `.`,
unique case-insensitively, and can be changed (with a cooldown → `USERNAME_CHANGE_COOLDOWN`).

## Errors

Every non-2xx response has exactly this shape:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request failed validation.",
    "requestId": "0194f2c0-…",
    "details": [
      {
        "path": "metrics.avgHeartRateBpm",
        "message": "Too big: expected number to be <=250",
        "code": "too_big"
      }
    ]
  }
}
```

- **Branch on `code`, never on `message`.** Messages are human text and may change or be localized.
- `details` appears for validation failures: one entry per offending field, `path` is dotted
  (`caption`, `items.2.type`). `api-client` exposes them as `ApiError.fieldErrors`.
- The full catalogue with HTTP statuses is at the bottom of [`API_REFERENCE.md`](API_REFERENCE.md#error-codes)
  and in `packages/contracts/src/errors.ts`; a test guarantees the code is a member of it. Statuses:
  400 malformed · 401 not authenticated · 403 authenticated but not allowed · 404 not found / not visible ·
  409 conflict with current state · 410 gone (expired link/feed) · 413/415 body too large / wrong type ·
  422 validation / business rule · 429 rate limited · 5xx ours.
- `5xx` bodies never contain stack traces or internals — only `INTERNAL`/`SERVICE_UNAVAILABLE` and a
  `requestId`.

### 404 instead of 403 (the privacy rule)

When something exists but the viewer is **not allowed to know it exists** — a private account's post,
a followers-only activity, a hidden/removed post, content of someone who blocked you or whom you
blocked, a deleted comment — the API answers **`404 <THING>_NOT_FOUND`**, byte-for-byte the same as for
something that never existed. `403` is only used when the _existence is already public_ and an action
is refused (`ACCOUNT_PRIVATE` when listing a private account's followers, `COMMENTS_RESTRICTED`,
`INSUFFICIENT_ROLE`, …). So a client never has to distinguish "gone" from "forbidden" for content, and
cannot be used to probe whether a hidden thing exists.

## Pagination

Three shapes exist; the response tells you which by its fields.

| Type          | Used by                                                                                       | Request                                | Response                                                                                 | Notes                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Keyset**    | Almost every list: posts, comments, followers, notifications, activities, bookmarks, reports… | `?limit=1..50` (default 20) `&cursor=` | `{ "items": […], "nextCursor": string \| null }`                                         | Stable under inserts/deletes. A page can be shorter than `limit` only on the last page                                                                                                                                                                                                                                                                                                 |
| **Feed page** | `GET /v1/feed/{following,home,explore}`                                                       | same query                             | `{ "requestId", "algorithmVersion", "items": [{post, reason, position}], "nextCursor" }` | `following` is keyset (chronological). `home`/`explore` page through a **snapshot** of ~100 ranked items that is built on the first request and lives 30 minutes (`410 FEED_EXPIRED` afterwards: refetch from the top). A page may be shorter than `limit` if posts became invisible since the snapshot was built — keep paging until `nextCursor` is `null`. See [`FEED.md`](FEED.md) |
| **Search**    | `GET /v1/search/{users,posts,topics}`                                                         | same query + `q`                       | `{ "items", "nextCursor" }`                                                              | Internally an offset capped at 500 results. Ranked by relevance, so deep paging is intentionally limited                                                                                                                                                                                                                                                                               |

Rules for all cursors: they are **opaque** (do not parse or build them), valid only for the endpoint
and query that produced them, and a tampered or foreign one is `400 INVALID_CURSOR`. They are not
secret — visibility is re-checked on every page, so a forged cursor can never reveal anything.

## Idempotency

- **`PUT`/`DELETE` actions are naturally idempotent** (react, bookmark, block, unfollow, like a
  comment…): repeating them is a no-op that returns the current state.
- **Creating `POST`s** — `POST /v1/posts`, `POST /v1/activities`, `POST /v1/posts/{id}/comments` — accept
  an **`Idempotency-Key`** header (8–128 chars of `[A-Za-z0-9_-]`). Generate a UUID per _user intent_
  (one tap on "Post"), reuse it on retries after a timeout or lost response, and you get the
  **original response replayed** (same status and body) instead of a duplicate.
  - Keys are per user and bound to method + path + body: the same key with a different body is
    `409 IDEMPOTENCY_KEY_REUSED`; a retry while the first request is still running is
    `409 IDEMPOTENCY_IN_PROGRESS` (with `Retry-After: 2`).
  - Keys are remembered for 24 hours. Without the header the endpoint behaves normally.
- `POST /v1/activities/import/gpx` is idempotent by file content (the same file twice returns the
  existing activity with `200` instead of `201`).
- `POST /v1/events` is idempotent per `(user, eventId)`: a batch can be resent safely.

## Rate limiting

A global per-IP limit (600/min, `RATE_LIMIT_GLOBAL_PER_MINUTE`) protects the process; routes add a
profile for their abuse surface. Exceeding any returns `429 RATE_LIMITED` with a **`Retry-After`**
header (seconds) — honour it.

| Profile      | Limit     | Key                      | Applied to                                                                                                          |
| ------------ | --------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `authStrict` | 10 / min  | IP                       | login, refresh, verify-email (+resend), password forgot/reset/change, account-deletion request, data-export request |
| `authSignup` | 5 / min   | IP                       | signup                                                                                                              |
| `write`      | 60 / min  | user                     | creating/editing posts, activities, comments, profile, settings, follows, blocks…                                   |
| `engagement` | 120 / min | user                     | reactions, bookmarks, shares, comment likes                                                                         |
| `upload`     | 30 / min  | user                     | media init/complete/retry                                                                                           |
| `report`     | 10 / min  | user                     | `POST /v1/reports`                                                                                                  |
| `search`     | 60 / min  | user (IP when anonymous) | all search endpoints and `GET /auth/username-available`                                                             |
| `events`     | 60 / min  | user                     | `POST /v1/events`                                                                                                   |

On top of the per-IP limit, **repeated failed logins for one email are throttled per account** (5 free
failures, then growing delays up to 15 minutes) so distributed credential stuffing is slowed even when
every request comes from a different IP. Counters live in process memory unless `REDIS_URL` is set
(shared across replicas); behind a proxy set `TRUST_PROXY_HOPS` so the client IP is the real one.

## Visibility, blocks and what a viewer sees

- **Account visibility** `PUBLIC | PRIVATE`; **content visibility** `PUBLIC | FOLLOWERS | PRIVATE`. The
  effective audience of a post/activity is the _stricter_ of the two. Following a private account is a
  **request** the owner approves (`relationship: "REQUESTED"` until then).
- **Blocks** are mutual in effect: neither side sees the other's profile, posts, comments, reactions,
  mentions, search results, suggestions or notifications; existing follows in both directions are
  removed; the blocker can still list/unblock. The blocked user gets the same `404`s as for a
  non-existent account.
- Every list/aggregate respects this _in SQL_; counters shown to a viewer (e.g. reaction lists) exclude
  people they cannot see.
- **Minors** (under 18): private by default, can never be discovered by search/suggestions, get no
  sponsored discovery items; thresholds are configuration (`MIN_SIGNUP_AGE` 13, `MINOR_PUBLIC_MIN_AGE`
  16, `ADULT_AGE` 18) and **need legal review** for each launch market (see [`SECURITY.md`](SECURITY.md)).

## Sponsored content (hard rule for UIs)

Sponsorship is **data, not styling**. A post is sponsored if and only if `post.sponsorship` is
non-null:

```json
"sponsorship": { "type": "PAID_PARTNERSHIP", "brandName": "Stride", "label": "Paid partnership with Stride", "partnershipId": "…" }
```

- `label` is ready-to-display text — show it prominently on every surface where the post appears
  (feed, detail, profile grid, search, topic page). Do not hide, truncate to nothing or restyle it so
  that it is less visible than a "like" count.
- Once a post is **published**, its disclosure cannot be removed (`PATCH` with `sponsorship: null` →
  `409 INVALID_STATE`); the type/brand can still be corrected. Missing disclosures can be reported
  (`UNDISCLOSED_SPONSORSHIP` is a report reason). The creator's `verified` badge is set only by staff
  and is unrelated to sponsorship.
- Ranking treats sponsored posts separately (density limits in feeds; never shown as "discovery" to
  under-18 viewers).

## Content model cheat-sheet

- **Post** = a _format_ (`VIDEO` > `PHOTO` > `ACTIVITY` > `TEXT`, derived by the server from content so
  clients never guess a layout) + optional caption + optional attached `activity` summary + media +
  `topics` (hashtags found in the caption) + `mentions` + `sponsorship` + `counts` + `viewer` state
  (`reaction`, `bookmarked`, `isAuthor`, `canComment`; `null` for anonymous viewers). Counters are
  maintained by database triggers in the same transaction as the change, so they are exact after
  every write (`counts.bookmarks` is visible to the author only).
- **Post status**: `DRAFT` → `PENDING_MEDIA` (author-only until all media is `READY`) → `PUBLISHED`, or
  `PUBLISH_FAILED` (a media item failed; fix and `POST /posts/{id}/publish`). Only `PUBLISHED`,
  non-moderated posts appear to others. Authors see everything of theirs via `GET /v1/me/posts`.
- **Activity** and **post** are independent. Logging an activity (public/followers) auto-creates a
  `ACTIVITY_AUTO` post unless the user disabled it (`autoCreateActivityPost`) or the activity is
  `PRIVATE`. Attach media later with `POST /v1/posts/{id}/media`.
- **Routes** are returned as encoded-polyline _segments_ — never join segments client-side; the gaps
  are intentional (privacy zones, trimmed start/end). What a viewer receives depends on
  `routePrivacy` (`FULL`, `TRIMMED`, `APPROXIMATE`, `HIDDEN`); the owner always sees `FULL`.
- **Media** is a separate resource with its own lifecycle (see [`MEDIA_PIPELINE.md`](MEDIA_PIPELINE.md)).
  URLs in responses are **signed and expire** (`MEDIA_URL_TTL_SECONDS`, default 6 h): never persist
  them, refetch the owning resource instead.

## Operational endpoints

| Path                   | Purpose                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`         | Liveness: the process is up (no dependencies checked)                                                                            |
| `GET /readyz`          | Readiness: database reachable **and** all migrations applied; `503` otherwise                                                    |
| `GET /metrics`         | Prometheus text. Requires `Authorization: Bearer $METRICS_TOKEN`; in production without a token the route does not exist (`404`) |
| `GET /v1/openapi.json` | The live OpenAPI 3.1 document (public — it contains no secrets)                                                                  |
