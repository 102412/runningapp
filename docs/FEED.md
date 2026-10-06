# Feed, ranking and learning (v1)

The feed has to show a _mixed_ stream — activity posts, videos, photos, creator and sponsored content —
to people who mostly follow people they know, while staying explainable, cheap to run and safe. Version 1
is therefore a **transparent heuristic** wrapped in infrastructure (snapshots, a serving log, behavioural
events, rollups) that a learned model can later reuse unchanged. No external vendor is involved.

## Three surfaces

| Surface       | Endpoint                 | Algorithm    | Paging                            | Content                                                                                                                              |
| ------------- | ------------------------ | ------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Following** | `GET /v1/feed/following` | `chrono-v1`  | live keyset cursor (newest first) | Your own posts + everyone you follow. No ranking, no discovery, no sponsored injection — only sponsored posts _by people you follow_ |
| **Home**      | `GET /v1/feed/home`      | `ranked-v1`  | snapshot (≈100 items, 30 min)     | Followed + own posts ranked together, with **one discovery item every 4th slot**                                                     |
| **Explore**   | `GET /v1/feed/explore`   | `explore-v1` | snapshot                          | Public posts from authors you do **not** follow (never your own)                                                                     |

Every response is a `FeedPage`:

```json
{ "requestId": "…", "algorithmVersion": "ranked-v1",
  "items": [ { "post": { …Post… }, "reason": "FOLLOWED_AUTHOR", "position": 0 } ],
  "nextCursor": "…" }
```

- `reason` ∈ `OWN_POST | FOLLOWED_AUTHOR | SPORT_INTEREST | CREATOR_AFFINITY | TRENDING | DISCOVERY` — an
  honest, UI-friendly hint ("Because you follow…", "Popular right now"). Clients may ignore it.
- `requestId` + `position` are what the client echoes in events and engagement `context` so the system
  knows what surfaced a post ([events](#events-the-client-sends)).
- The format of each post (`VIDEO`, `PHOTO`, `ACTIVITY`, `TEXT`) is server-derived, so a client can pick a
  card layout without inspecting media.

### Why snapshots

Ranked feeds that re-rank on every page produce duplicates, gaps and jumping items. So the **first** request
builds an ordered list of ≤ `FEED_SNAPSHOT_SIZE` (100) post ids with scores and reasons, stores it in
`feed_snapshots` (TTL `FEED_SNAPSHOT_TTL_MINUTES` = 30) and returns page 1. Later pages are slices of that list
(the cursor carries snapshot id + offset). Consequences clients must know:

- Pages are **stable**: no duplicates, no reordering while paging.
- The feed is **finite** (≈100 posts per refresh). At the end, `nextCursor` is `null`; pull-to-refresh builds a new
  snapshot. (For an infinite-scroll feel, refetch without a cursor.)
- **Visibility is re-checked when each page is served**: a post that was deleted, made private, hidden by a
  moderator or whose author got blocked _after_ the snapshot disappears; the page may therefore be shorter than
  `limit`. Keep paging until `nextCursor` is `null`.
- An expired/foreign snapshot is `410 FEED_EXPIRED` → drop the cursor and refetch from the top.

## How v1 ranks

`apps/api/src/modules/feed/ranking.ts` is **pure** (no I/O, clock or randomness): same inputs ⇒ same output, which
makes it testable and replaceable.

```
score = max(0, recency + relationship + affinities + quality + popularity + media − sponsoredPenalty) × seenFactor
```

| Term                    | Value (default weights)                                                                                                                                                                                                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| recency                 | `0.35 × 0.5^(ageHours / 36)` — half-life 36 h                                                                                                                                                                                                                                                              |
| relationship            | followed author `0.30`, own post `0.08`, else 0                                                                                                                                                                                                                                                            |
| creator affinity        | `0.20 × learned score for this author ∈ [-1,1]` (personalised users only)                                                                                                                                                                                                                                  |
| sport affinity          | `0.15 × score for the post's activity sport` — **explicit** sport interests count even with personalisation off (`PRIMARY` 0.8, `PARTICIPANT` 0.6, `FOLLOWER` 0.4)                                                                                                                                         |
| format / topic affinity | `0.05 × format score`, `0.10 × best topic score` (personalised only)                                                                                                                                                                                                                                       |
| quality                 | `0.20 × quality ∈ [0,1]`: Bayesian-smoothed engagement per impression (prior 30 impressions / 1 engagement; "great" = 15 %), blended 60/40 with video completion for videos, minus a penalty for "not interested"/skips (cap 0.5). Weighted engagement = reactions + 2·comments + 3·shares + 1.5·bookmarks |
| popularity              | `0.10 × log(1+engagement)/log(201)` (200 weighted engagements saturate)                                                                                                                                                                                                                                    |
| media                   | video `+0.05`, photo `+0.02`                                                                                                                                                                                                                                                                               |
| sponsored penalty       | `−0.10` for sponsored posts from authors the viewer does **not** follow (and is not themselves)                                                                                                                                                                                                            |
| seen factor             | personalised viewers: ×1 first time, ×0.5, ×0.25, then ×0.1 for posts already shown (7-day lookback)                                                                                                                                                                                                       |

Hard rules around the score:

- **Exclusion**: for non-followed authors, an author the viewer clearly rejects (creator affinity ≤ −0.6) is never
  recommended; a post the viewer marked **NOT_INTERESTED** is filtered in SQL — even if personalisation is off.
- **Diversity** (greedy re-rank that respects the score order as far as possible): Home — ≤ 5 posts per author,
  ≥ 2 other items between same-author posts, ≤ 1 sponsored item per 5; Explore — ≤ 2 per author, gap 3, same
  sponsored density. Soft rules relax when nothing else fits; the per-author cap never does.
- **Reasons** for discovery items are picked from the strongest positive term (creator > sport > trending), else
  `DISCOVERY`.

### Candidate generation

Built per snapshot with plain SQL (all through the same visibility predicate used everywhere, plus
`NOT_INTERESTED` exclusion):

| Pool                 | What                                                                       | Window / size |
| -------------------- | -------------------------------------------------------------------------- | ------------- |
| Followed (Home only) | own + followed authors, newest first                                       | 14 days, 150  |
| Trending             | other authors' public posts ordered by `reactions + 2·comments + 3·shares` | 7 days, 150   |
| Fresh                | newest public posts                                                        | 7 days, 100   |
| Sport                | newest public posts whose activity sport is one the viewer declared        | 14 days, 100  |

Discovery pools only include authors with `profile.discoverable = true`, exclude people the viewer follows, and for
under-18 viewers exclude **sponsored** posts entirely. Minors' own accounts are private/non-discoverable, so they
are not recommended to strangers.

The trending query scans a bounded recent window; that is fine for early scale and the obvious first thing to
precompute into a table when it stops being cheap ([`DATABASE.md`](DATABASE.md#scale-notes-honest)).

## Events the client sends

`POST /v1/events` takes ≤ 100 events per batch, rate-limited to 60 requests/min, **idempotent per `(user, eventId)`**.
Use `EventBuffer` from `@runningapp/api-client` (batching, flush on interval/size/background, retry, dedupe) rather
than sending one request per event.

| Client event                                    | Send when                                                           | Needs                                            |
| ----------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------ |
| `IMPRESSION`                                    | A post was ≥ 50 % visible for ≥ 1 s (one per post per feed request) | `postId`, `feedRequestId`, `surface`, `position` |
| `VIDEO_START` / `VIDEO_COMPLETE`                | Playback began / reached the end (loop ≠ complete)                  | `postId`                                         |
| `WATCH_TIME`                                    | When leaving a video: total ms watched                              | `postId`, `valueMs`                              |
| `SKIP`                                          | Scrolled past a video within ~1 s                                   | `postId`                                         |
| `PROFILE_OPEN`, `ACTIVITY_OPEN`, `MEDIA_EXPAND` | The user opened it                                                  | `subjectUserId` / `postId`                       |
| `TOPIC_INTERACTION`                             | The user tapped a hashtag/topic                                     | `topic`                                          |
| `NOT_INTERESTED`                                | The user said "show less like this"                                 | `postId`                                         |

Likes, comments, shares, bookmarks and follows are **not** sent here: the server records them itself (`ServerEventType`)
when those endpoints are called — pass the optional `context` (`feedRequestId`, `surface`, `position`) in those
requests so attribution is preserved.

Privacy: with `personalizationEnabled = false` in settings, behavioural events are **discarded on ingestion** (the
response still acknowledges them); only `NOT_INTERESTED` is kept (it is an explicit instruction, and used to hide
the post). Events from blocked/invisible posts are ignored. Retention: `ANALYTICS_RETENTION_DAYS` (180).

## Learning loop (jobs)

```
client events ─► feed_events ─► feed.rollup_post_stats (5 min) ─► post_stats ─► quality / popularity terms
                           └──► feed.refresh_affinities (5 min) ─► user_affinities ─► creator/sport/format/topic terms
served pages ─► feed_requests + recommendation_events (what was shown, at which position, with all score signals)
```

- **Rollups** fold new events into `post_stats` (impressions, starts, completes, skips, not-interested) **exactly once**
  using a per-job **watermark** on the time-ordered event id and a 60 s **settle window** (so an event inserted by a
  slow transaction is not skipped). Re-running a job is harmless.
- **Affinities**: event weights (watch 0…0.8, complete 1, like 1, comment 1.5, share 2, follow 2.5; skip −0.4,
  unlike −1, not-interested −2.5, unfollow −2.5), exponentially decayed with a **14-day half-life** over a 60-day
  lookback, squashed with `tanh(sum/5)` into (−1, 1), kept per subject (sport / creator / format / topic; top 100
  per type, |score| ≥ 0.03). Users whose personalisation is off are skipped and their stored affinities ignored.
- **Serving log**: every ranked page is recorded (`feed_requests`, plus one `recommendation_events` row per item with
  its `signals`), sampled by `RANKING_LOG_SAMPLE_RATE` (default 1 = everything). It is the **training/evaluation
  dataset** for a future model and the answer to "why did I see this?".
- Retention for all of the above: `feed.purge_analytics` (6 h).

## Safety properties (tested in `feed.test.ts`, `ranking.test.ts`, `events.test.ts`)

- No post the viewer could not open via `GET /posts/{id}` ever appears — across blocks, private accounts,
  followers-only posts, drafts/pending media, hidden/removed posts, soft-deleted posts.
- Sponsored posts always carry `sponsorship` (data-level), are density-limited, penalised in discovery, and never
  shown in discovery to minors.
- Constant number of queries per page (`query-budget`), snapshot paging has no duplicates, expired snapshots are
  `410`, `NOT_INTERESTED` posts never come back, tampered cursors are `400`.
- Ranking is deterministic for fixed inputs; ties break by recency then id.

## Tuning cheat-sheet

| I want…                             | Change                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| Fresher / more "timeline-like" Home | Lower `recencyHalfLifeHours` or raise `recency` in `DEFAULT_WEIGHTS`                     |
| More discovery in Home              | `HOME_DISCOVERY_EVERY` (3 = every 3rd item)                                              |
| Longer / shorter feed per refresh   | `FEED_SNAPSHOT_SIZE` (10–500), `FEED_SNAPSHOT_TTL_MINUTES`                               |
| Fewer sponsored items               | `sponsoredWindow` in `HOME_DIVERSITY` / `EXPLORE_DIVERSITY`, `sponsoredDiscoveryPenalty` |
| Less logging volume                 | `RANKING_LOG_SAMPLE_RATE` (e.g. 0.1)                                                     |
| Faster-learning taste               | Lower `AFFINITY_HALF_LIFE_DAYS`, `SQUASH_SCALE`                                          |

Weights are constants in code on purpose (reviewed, versioned, tested). When you change behaviour materially, bump the
`algorithmVersion` string so logs and analysis can tell eras apart.

## Path to a learned ranker

1. Use the serving log + events to build `(viewer, post, signals) → engaged?` training rows (the `signals` JSON is
   exactly the heuristic's features; add more as needed).
2. Train offline (start with logistic regression / gradient boosted trees on the same features); evaluate against
   the heuristic with held-out `recommendation_events`.
3. Implement a `Ranker` with the signature of `rank()` (candidates + taste → ordered list) in the service, run it
   in **shadow** (log its order, serve the heuristic), then A/B by `userId` hash with the new `algorithmVersion`.
4. If candidate generation becomes the bottleneck, move pools to a job-built table or a retrieval service; the
   ranking seam does not change.

## Known limits of v1

- Finite 100-item Home/Explore snapshots (no endless scroll without a refresh).
- Candidate pools are SQL-bound; the trending pool sorts engagement within a 7-day window.
- No real-time signals, no embeddings/content understanding, no cold-start beyond declared sports + popularity,
  no per-region/language handling, no explicit "topics you follow" feed, no creator-diversity guarantees beyond the
  per-author rules.
- Quality terms use ids/watermarks and a 60 s settle window; stats lag live events by a few minutes by design.
- Weights are hand-set, not tuned on real data (there is none yet).
