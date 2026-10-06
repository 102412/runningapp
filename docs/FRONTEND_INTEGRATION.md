# Front-end integration guide

For whoever builds the UI (a mobile app, a web app, or both). The backend has **no opinion about visual
design**; it gives you a typed contract, privacy-correct data and server-derived hints (post `format`,
feed `reason`, ready-to-show sponsorship `label`, `viewer` state) so screens stay thin.

> Read first: [`API.md`](API.md) (conventions) · try everything against the **seeded demo world**
> ([accounts](../HANDOFF.md#seed-accounts)) · endpoint table: [`API_REFERENCE.md`](API_REFERENCE.md).

## 1. Get the contract into your app

| Option                              | How                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TypeScript client (recommended)** | `@runningapp/api-client` lives in this monorepo (`packages/api-client`); not published to a registry (publishing is a human decision). Consume it as a workspace dependency, or `pnpm --filter @runningapp/api-client build && pnpm pack` and install the tarball. It gives you typed `GET/POST/PUT/PATCH/DELETE` calls, token refresh, pagination helpers, an event buffer and the upload helper |
| **Types only**                      | `docs/openapi.json` → `npx openapi-typescript docs/openapi.json -o schema.d.ts`. Or fetch the live document: `GET /v1/openapi.json`                                                                                                                                                                                                                                                               |
| **Other languages**                 | Generate a client from `docs/openapi.json` (OpenAPI 3.1) with your generator of choice                                                                                                                                                                                                                                                                                                            |
| **Shared enums/limits**             | `@runningapp/contracts` exports Zod schemas and constants (`SPORT_KEYS`, allowed MIME types, `MAX_EVENTS_PER_BATCH`, …) — optional for UI code                                                                                                                                                                                                                                                    |

When the backend changes, `pnpm openapi` regenerates `docs/openapi.json` and the client types; a CI check
fails if they drift, so **pull and re-generate** rather than hand-editing types.

```ts
import {
  createApiClient,
  MemoryTokenStore,
  unwrap,
  isApiError,
  paginate,
  collect,
} from '@runningapp/api-client';

const tokens = new MemoryTokenStore(); // implement TokenStore with Keychain/Keystore on mobile
const api = createApiClient({
  baseUrl: 'http://localhost:3000', // origin only; paths already include /v1
  tokens,
  onSessionLost: (reason) => goToSignIn(reason), // refresh refused / revoked / suspended
  // web: withRefreshLock: (fn) => navigator.locks.request('runningapp-refresh', fn),
});

const login = unwrap(await api.POST('/v1/auth/login', { body: { email, password, device } }));
await api.setTokens(login.tokens);
const me = unwrap(await api.GET('/v1/me'));
```

`unwrap(result)` returns `data` or throws `ApiError` (`.code`, `.status`, `.requestId`, `.fieldErrors`).

## 2. Authentication recipe

1. **Device id.** Generate a random `installId` (≥ 8 chars) once per app install and keep it in secure
   storage; send it as `device: { installId, platform: 'IOS'|'ANDROID'|'WEB', name?, appVersion? }` on signup
   and login. It lets the backend show "your devices" and attach push tokens.
2. **Signup** `POST /v1/auth/signup` `{ email, password, username, displayName?, birthDate, device }` →
   `{ user, tokens, sessionId }` (you are signed in). Errors to design for: `EMAIL_TAKEN`, `USERNAME_TAKEN`,
   `PASSWORD_TOO_WEAK`, `UNDER_MINIMUM_AGE`, `VALIDATION_FAILED` (with `fieldErrors`). Use
   `GET /v1/auth/username-available?username=` for live feedback.
3. **Verify email.** A mail is sent; the link is `EMAIL_LINK_BASE_URL + "verify-email?token=…"`
   (default `runningapp://verify-email?token=…`; set it to your universal link / `https://app…/` for web).
   Handle the deep link by `POST /v1/auth/verify-email { token }`. Until verified, `me.emailVerified` is false
   and **creating posts, comments and reports** fails with `EMAIL_NOT_VERIFIED` (offer _Resend_ →
   `POST /v1/auth/verify-email/resend`, max once a minute). Activities can still be logged; their auto-post
   is only created once the email is verified.
4. **Password reset**: `POST /v1/auth/password/forgot { email }` (always succeeds, no hint whether the email
   exists) → link `…reset-password?token=…` → `POST /v1/auth/password/reset { token, newPassword }`; all sessions
   are signed out, so go to sign-in. Expired/used link: `410 TOKEN_CONSUMED_OR_EXPIRED`.
5. **Tokens.** Access token 15 min, refresh token single-use (30 days). Let the client library refresh; if you
   write your own: refresh on `TOKEN_EXPIRED` **once**, **serialise** concurrent refreshes (a second use of the
   same refresh token revokes the session), store the _new_ refresh token **before** retrying, and treat
   `REFRESH_TOKEN_INVALID | REFRESH_TOKEN_REUSED | SESSION_REVOKED | TOKEN_INVALID | ACCOUNT_SUSPENDED` as "signed out".
   Store tokens in Keychain/Keystore (mobile) — not `localStorage` if you can avoid it on web.
6. **Logout** `POST /v1/auth/logout` (this device) / `…/logout-all` (all devices). **Sessions screen**:
   `GET /v1/auth/sessions` (`isCurrent`, device, last seen, coarse network) + `DELETE /v1/auth/sessions/{id}`.
7. **Account states.** `me.status`: `ACTIVE`; `PENDING_DELETION` (login works in _restricted mode_, show "deletion
   scheduled for {me.deletion.scheduledFor} — cancel?" → `DELETE /v1/me/account/deletion`); `SUSPENDED` (every
   call but `/me`, logout and deletion-cancel gives `ACCOUNT_SUSPENDED`; show a blocking screen).
8. **Minors** (`me.isMinor`): force/hide controls accordingly — accounts are private; making the account public
   returns `PUBLIC_ACCOUNT_NOT_ALLOWED`.

## 3. Screen → endpoint map

| Screen / feature                 | Calls                                                                                                                                                                      | Notes                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Onboarding: pick sports**      | `GET /v1/sports` (public, cacheable) · `PUT /v1/me/sports` `{items:[{sport, relation: PARTICIPANT\|FOLLOWER}]}` (replaces the set) · `PATCH /v1/me/profile {primarySport}` | `GET /sports` also says which metrics each sport supports → show only those inputs                                            |
| **Onboarding: who to follow**    | `GET /v1/discover/athletes` · `POST /v1/users/{id}/follow`                                                                                                                 | Reasons per suggestion are included                                                                                           |
| **Home feed**                    | `GET /v1/feed/home`                                                                                                                                                        | Snapshot paging, `FEED_EXPIRED`; echo `requestId`/`position` in events ([§6](#6-events-and-engagement-attribution))           |
| **Following feed**               | `GET /v1/feed/following`                                                                                                                                                   | Chronological                                                                                                                 |
| **Explore / discover**           | `GET /v1/feed/explore` · `GET /v1/discover/topics`                                                                                                                         |                                                                                                                               |
| **Post card**                    | data from the `Post` object                                                                                                                                                | `format` picks the layout; `sponsorship` → label; `viewer` → button state; `activity` summary for the stats strip             |
| **Post detail**                  | `GET /v1/posts/{id}` · `GET /v1/posts/{id}/comments` · `GET /v1/comments/{id}/replies`                                                                                     | 404 = deleted _or_ not allowed (same screen: "unavailable")                                                                   |
| **React / save / share**         | `PUT\|DELETE /v1/posts/{id}/reaction {type}` · `PUT\|DELETE /v1/posts/{id}/bookmark` · `POST /v1/posts/{id}/shares {channel}`                                              | Reaction types `LIKE, CLAP, FIRE, STRONG`; one reaction per user, sending another type changes it. All idempotent             |
| **Comment**                      | `POST /v1/posts/{id}/comments {body, parentId?, context?}` · `DELETE /v1/comments/{id}` · `PUT\|DELETE /v1/comments/{id}/reaction`                                         | Two levels only (reply to a reply attaches to the thread root); `post.viewer.canComment` and `COMMENTS_RESTRICTED`            |
| **Reactions list**               | `GET /v1/posts/{id}/reactions`                                                                                                                                             |                                                                                                                               |
| **Saved posts**                  | `GET /v1/me/bookmarks`                                                                                                                                                     | Posts that became invisible are omitted                                                                                       |
| **Log an activity (DO→LOG)**     | `POST /v1/activities` (manual) or `POST /v1/activities/import/gpx` (raw GPX body)                                                                                          | Response is a `LoggedActivity` with `postId` of the auto-created post (or null). Send an `Idempotency-Key`                    |
| **Prompt to SHOW**               | after logging: _"Add a video or photo?"_ → upload media → `POST /v1/posts/{postId}/media {mediaIds}`                                                                       | Auto post exists already; attaching media upgrades its `format`                                                               |
| **Create post (no activity)**    | upload media → `POST /v1/posts {caption, mediaIds, visibility?, topics?, sponsorship?, activityId?, publish?}`                                                             | `EMPTY_POST` if nothing. `publish:false` = private draft; `POST /v1/posts/{id}/publish` later                                 |
| **My posts / drafts / failed**   | `GET /v1/me/posts?status=`                                                                                                                                                 | Shows `PENDING_MEDIA`, `PUBLISH_FAILED`, moderated states                                                                     |
| **Activity detail**              | `GET /v1/activities/{id}` (splits, metrics, records) · `GET /v1/activities/{id}/route`                                                                                     | Route `segments[]`: draw each separately ([§8](#8-routes-and-maps))                                                           |
| **Edit/delete activity or post** | `PATCH\|DELETE /v1/activities/{id}` · `PATCH\|DELETE /v1/posts/{id}`                                                                                                       | Deleting an activity deletes its _auto_ post only                                                                             |
| **Profile**                      | `GET /v1/users/{id}` or `/by-username/{name}` · `GET /v1/users/{id}/posts?format=` · `GET /v1/users/{id}/activities?sport=`                                                | `profile.viewer` drives Follow/Requested/Following buttons; private profiles return limited data + `ACCOUNT_PRIVATE` on lists |
| **Follow graph**                 | `POST\|DELETE /v1/users/{id}/follow` · `GET /v1/users/{id}/followers\|following` · `DELETE /v1/me/followers/{id}`                                                          | Following a private account yields `relationship: "REQUESTED"`                                                                |
| **Follow requests inbox**        | `GET /v1/me/follow-requests` · `POST …/{requestId}/accept\|reject`                                                                                                         |                                                                                                                               |
| **Block / blocked list**         | `PUT\|DELETE /v1/users/{id}/block` · `GET /v1/me/blocks`                                                                                                                   | After blocking, expect the other person's content to vanish everywhere                                                        |
| **Notifications**                | `GET /v1/notifications?unreadOnly=` · `GET …/unread-count` · `POST …/read {ids}\|{all:true}`                                                                               | [Deep links](#7-notifications-and-deep-links)                                                                                 |
| **Notification settings**        | `GET\|PUT /v1/me/notification-preferences` · `PUT\|DELETE /v1/me/device/push-token`                                                                                        | Push _delivery_ needs provider setup — see HANDOFF                                                                            |
| **Search**                       | `GET /v1/search?q=` (overview) · `/search/users\|posts\|topics?q=&cursor=`                                                                                                 | Debounce ≥ 250 ms; 2–100 characters (a leading `#`/`@` is ignored); 60/min                                                    |
| **Topic page**                   | `GET /v1/topics/{slug}` · `GET /v1/topics/{slug}/posts`                                                                                                                    |                                                                                                                               |
| **Settings**                     | `GET\|PATCH /v1/me/settings` · `PATCH /v1/me/profile` · `PUT\|DELETE /v1/me/avatar`                                                                                        | Units (`METRIC`/`IMPERIAL`) are display-only: convert yourself                                                                |
| **Privacy zones**                | `GET\|POST /v1/me/privacy-zones` · `DELETE …/{id}`                                                                                                                         | Max 10; radius 50–5000 m                                                                                                      |
| **Creator mode**                 | `GET\|PUT\|DELETE /v1/me/creator` · `POST …/verification-request` · `GET\|POST\|DELETE …/partnerships`                                                                     | Verification is granted by staff only                                                                                         |
| **Report**                       | `POST /v1/reports {targetType, targetId, reason, details?}` · `GET /v1/me/reports`                                                                                         | `ALREADY_REPORTED` is fine to show as "Thanks, we already have your report"                                                   |
| **Account**                      | `POST\|DELETE /v1/me/account/deletion` · `POST /v1/me/exports` → poll `GET /v1/me/exports/{id}`                                                                            | Both need the password; export link is a short-lived signed URL                                                               |
| **Integrations**                 | `GET /v1/me/integrations`                                                                                                                                                  | Lists providers and whether each is available (none are yet — show "coming soon")                                             |
| **Staff tools (internal)**       | `/v1/admin/*`                                                                                                                                                              | Roles `MODERATOR`/`ADMIN` only (`me.role`)                                                                                    |

## 4. Rendering a post

```jsonc
{
  "id": "…", "format": "VIDEO",            // VIDEO | PHOTO | ACTIVITY | TEXT — derived server-side
  "origin": "AUTHORED",                     // or ACTIVITY_AUTO (generated from a logged activity)
  "status": "PUBLISHED",                    // authors can also see DRAFT | PENDING_MEDIA | PUBLISH_FAILED
  "author": { "id", "username", "displayName", "avatar", "isPrivate", "creator": { "category", "verified" } },
  "caption": "…", "topics": ["parkrun"], "mentions": [{ "id", "username" }],
  "media": [ /* Media objects: urls.playback / playbackLow / poster / thumbnail / large / medium */ ],
  "activity": { /* Activity summary + routePreview (privacy-filtered) */ } , // null if none
  "sponsorship": null,                      // or { type, brandName, label, partnershipId }
  "counts": { "reactions", "comments", "shares", "bookmarks" /* author only */ },
  "viewer": { "reaction", "bookmarked", "isAuthor", "canComment" },   // null if anonymous
  "visibility": "FOLLOWERS", "commentPermission": "EVERYONE",
  "moderationStatus": null,                 // author only: CLEAN | HIDDEN | REMOVED
  "publishedAt": "…", "createdAt": "…"
}
```

- **Layout from `format`**, not from guessing media: `VIDEO` → vertical player using `media[0].urls.playback`
  (`playbackLow` on cellular/data-saver; `poster` while loading; reserve space with `media[0].aspectRatio`);
  `PHOTO` → carousel of `urls.medium` (tap → `urls.large`); `ACTIVITY` → stats card + `activity.routePreview`;
  `TEXT` → text.
- A post can combine media **and** an activity: show the media with the activity strip (distance, time, pace,
  sport) beneath, route/splits on tap.
- **Sponsored**: if `sponsorship !== null`, show `sponsorship.label` prominently wherever the post appears. This is
  a requirement, not a styling choice ([`API.md`](API.md#sponsored-content-hard-rule-for-uis)).
- **Creator badge**: `author.creator.verified` is staff-verified; unverified creators still get a category label,
  never a verified checkmark.
- **Counts** are exact at fetch time; update optimistically after your own actions.
- **Media URLs expire** (`media[].urlsExpireAt`, ~6 h). On a 403 from the CDN/storage for a still-valid
  post, refetch the post and swap URLs; do not persist URLs across sessions.
- Never assume `activity` or `media` is present; both are optional.

## 5. Uploading media

Use the helper where possible:

```ts
import { uploadMedia } from '@runningapp/api-client';
const media = await uploadMedia(api, { kind: 'VIDEO', mimeType: 'video/mp4', data: blob, onStatus: m => … });
// resolves with the READY media; throws ApiError(MEDIA_REJECTED | MEDIA_NOT_READY) on failure
```

The same flow by hand (needed for background uploads on mobile):

1. `GET /v1/media/limits` (once) → validate locally: size, duration, types. HEIC is not accepted — convert to JPEG.
2. `POST /v1/media/uploads { kind, mimeType, sizeBytes, purpose?: 'POST'|'AVATAR' }` → `{ media, upload: { url, headers, expiresAt } }`.
3. `PUT upload.url` with **exactly** `upload.headers` and the raw bytes — **no** `Authorization`, no multipart.
4. `POST /v1/media/{id}/complete` → `UPLOADED`/`PROCESSING`.
5. Either poll `GET /v1/media/{id}` (1–4 s backoff) until `READY | FAILED | REJECTED`, **or** create/attach the post right
   away: it stays `PENDING_MEDIA` (visible to you only) and **publishes itself** when processing ends — then show
   "Processing…" on that post (refresh `GET /v1/me/posts?status=PENDING_MEDIA`, or wait for the
   `POST_PUBLISHED` / `POST_PUBLISH_FAILED` notification).
6. Failure UX by `media.failureCode`: permanent (`INVALID_MEDIA`, `UNSUPPORTED_FORMAT`, `TOO_LONG`,
   `TOO_LARGE_DIMENSIONS`, `TOO_SMALL`, `MODERATION_REJECTED`) → explain and let the user pick another file;
   `PROCESSING_ERROR` → _Retry_ (`POST /v1/media/{id}/retry`).
7. Expired upload URL (15 min) → request a new slot. At most 20 unattached slots per user (`RATE_LIMITED`).

Compress/trim on the device first (the server accepts up to 300 MB / 180 s but re-encodes to 720p anyway):
users on mobile data will thank you. Details: [`MEDIA_PIPELINE.md`](MEDIA_PIPELINE.md).

## 6. Events and engagement attribution

- Create **one** `EventBuffer` after sign-in (`new EventBuffer(api).start()`), `track(...)` as the user scrolls and
  watches, `flush()` when the app backgrounds, `stop()` on sign-out. Event definitions and _when_ to send each:
  [`FEED.md`](FEED.md#events-the-client-sends).
- Echo the page's `requestId` as `feedRequestId`, plus `surface` and `position`, in events — and in the optional
  `context` of reaction/comment/share/bookmark calls — so the backend knows what surfaced a post.
- If the user turns off `personalizationEnabled`, keep sending (the server discards them) or stop; either is fine.
- "Show less like this" → `NOT_INTERESTED` event **and** remove the card locally.

## 7. Notifications and deep links

`GET /v1/notifications` items carry `type`, `actor`, optional `post` preview (with thumbnail), `comment` excerpt,
`followRequestId`, `data`, `readAt`. Suggested navigation:

| `type`                                              | Text                                                                                  | Go to                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `NEW_FOLLOWER`, `FOLLOW_ACCEPTED`                   | "{actor} followed you" / "accepted your request"                                      | actor profile                                                                                                    |
| `FOLLOW_REQUEST`                                    | "{actor} wants to follow you"                                                         | requests inbox (or accept/reject inline with `followRequestId`)                                                  |
| `POST_REACTION`                                     | "{actor} reacted" (`data.reaction`)                                                   | post                                                                                                             |
| `POST_COMMENT`, `COMMENT_REPLY`, `COMMENT_REACTION` | …                                                                                     | post → scroll to `comment.id`                                                                                    |
| `MENTION_POST`, `MENTION_COMMENT`                   | "{actor} mentioned you"                                                               | post / comment                                                                                                   |
| `POST_PUBLISHED`, `POST_PUBLISH_FAILED`             | "Your video is live" / "couldn't be processed" (`data.mediaId` names the failed item) | the post (failed → retry/fix)                                                                                    |
| `MODERATION_ACTION`                                 | "A moderator took action on your content"                                             | explanatory screen; `data` = `{ action, targetType, message? }` (`message` is the moderator's note on a warning) |

Notifications about content you can no longer see are not returned. Badge: `GET /unread-count` (`100` means "99+").
Push tokens: `PUT /v1/me/device/push-token { provider: 'APNS'|'FCM'|'EXPO', token, installId }` (the server stores it; actual
push delivery needs a provider adapter — see HANDOFF).

## 8. Routes and maps

- Activities expose `routePreview` (≤ 120 points, for cards) and `GET /v1/activities/{id}/route` (detail, ≤ 2 000
  points). Both return `segments: string[]` (**encoded polylines, precision 5**, `[lat, lon]`) + `bbox` + `isPrivacyFiltered`.
- **Draw every segment as its own line. Never concatenate segments.** Gaps are privacy (trimmed start/end,
  privacy zones). If `isPrivacyFiltered`, you may show a small "Route partially hidden for privacy" hint.
- The owner can preview what others see: `GET /activities/{id}/route?view=PUBLIC`.
- Pick a map SDK that supports the polyline format (Google/Mapbox/MapLibre decode precision-5 polylines).
  There is no map-tile or geocoding service in the backend; `locationLabel` is a free-text place name the user typed.
- Units: distances m, durations s, speeds m/s. Derived pace/speed (`speed.paceSecPerKm`, `…PerMile`, `avgSpeedKph`…)
  are provided; use the sport's `speedDisplay` from `GET /v1/sports` to choose pace vs speed.

## 9. Error handling table

| Situation                    | Code(s)                                                                      | UI                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Field problems               | `VALIDATION_FAILED` (+ `details[]`)                                          | Inline field errors (`ApiError.fieldErrors`)                                    |
| Session ended                | `SESSION_REVOKED`, `REFRESH_TOKEN_*`, `TOKEN_INVALID`                        | Sign-in screen                                                                  |
| Email unverified             | `EMAIL_NOT_VERIFIED`                                                         | Banner + resend                                                                 |
| Suspended / deletion pending | `ACCOUNT_SUSPENDED`, `ACCOUNT_PENDING_DELETION`                              | Blocking screen / cancel offer                                                  |
| Gone or hidden content       | `*_NOT_FOUND`                                                                | "This isn't available" (don't distinguish)                                      |
| Private account lists        | `ACCOUNT_PRIVATE`                                                            | Lock state with Follow button                                                   |
| Can't comment                | `COMMENTS_RESTRICTED`                                                        | Disabled composer with reason                                                   |
| Duplicate/replayed           | `ALREADY_REPORTED`, `USERNAME_TAKEN`, `EMAIL_TAKEN`                          | Friendly message                                                                |
| Idempotency conflicts        | `IDEMPOTENCY_KEY_REUSED` (bug), `IDEMPOTENCY_IN_PROGRESS`                    | Retry after `Retry-After`                                                       |
| Throttled                    | `RATE_LIMITED` (+ `Retry-After`)                                             | Back off; show a countdown for login                                            |
| Feed stale                   | `FEED_EXPIRED`                                                               | Silently refetch from the top                                                   |
| Expired link                 | `TOKEN_CONSUMED_OR_EXPIRED`                                                  | "Request a new link"                                                            |
| Upload problems              | `UPLOAD_INCOMPLETE`, `MEDIA_NOT_READY`, `MEDIA_REJECTED`, `UNSUPPORTED_FILE` | Retry / pick another file                                                       |
| Offline / 5xx / 503          | `INTERNAL`, `SERVICE_UNAVAILABLE`, network error                             | Retry with backoff; keep drafts locally; show `requestId` in "report a problem" |

## 10. Offline, retries and drafts

- GETs are safe to retry. Creating POSTs: generate an `Idempotency-Key` per user action and **reuse it for retries**.
- Keep an outbox on device for actions taken offline (logging an activity from a watch recording is the main one);
  replay with the same keys when back online. Activity import by file is idempotent by content.
- Backend drafts exist for posts (`publish: false`); activities have no draft state (log when ready).
- Don't cache signed media URLs beyond their expiry; cache post JSON for rendering, but revalidate on open.

## 11. Local development against this backend

```bash
pnpm install && docker compose up -d && pnpm db:migrate && pnpm db:seed && pnpm dev   # http://localhost:3000
```

- Sign in as **`maya_runs@seed.example` / `Seed-Pass-Running-2026`** (rich Home feed, follows, notifications).
  Other personas for edge cases (private account, minor, creator, brand, blocked user, unverified email,
  pending deletion, moderator, admin): [`HANDOFF.md`](../HANDOFF.md#seed-accounts).
- Emails (verification, reset) land in the dev outbox: `GET /v1/dev/outbox?to=<email>` includes the raw token
  (dev only). New accounts are auto-verified in development (`DEV_AUTO_VERIFY_EMAIL`).
- Media is processed by the inline worker (needs `ffmpeg`); uploads go to the local signed storage route.
- CORS for a web dev server: add its origin to `CORS_ORIGINS` (e.g. `http://localhost:5173`). Native apps need none.
- Phones on the same network: set `HOST=0.0.0.0` (default) and `PUBLIC_BASE_URL=http://<your-LAN-IP>:3000` — it is baked into
  signed media URLs. Never expose the dev server to the public internet.
- Rate limits are on by default; set `RATE_LIMIT_ENABLED=false` while hammering endpoints in dev.
