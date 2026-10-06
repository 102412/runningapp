-- 0011: feed serving, behavioural events and ranking data.
-- Two complementary logs make future ML possible without any vendor:
--   * feed_requests + recommendation_events: what the ranker SHOWED (decision log: score, reason,
--     signal breakdown, algorithm version), so a model can learn from what was and wasn't shown.
--   * feed_events: what the USER DID (impressions, watch time, likes...), idempotent by event id.

create type feed_surface as enum ('HOME', 'FOLLOWING', 'EXPLORE', 'PROFILE', 'SEARCH', 'POST_DETAIL', 'TOPIC', 'OTHER');
create type feed_event_type as enum (
  'IMPRESSION', 'VIDEO_START', 'VIDEO_COMPLETE', 'WATCH_TIME', 'SKIP', 'PROFILE_OPEN', 'ACTIVITY_OPEN',
  'MEDIA_EXPAND', 'TOPIC_INTERACTION', 'NOT_INTERESTED',
  'LIKE', 'UNLIKE', 'COMMENT', 'SHARE', 'BOOKMARK', 'UNBOOKMARK', 'FOLLOW', 'UNFOLLOW'
);
create type affinity_subject as enum ('SPORT', 'CREATOR', 'FORMAT', 'TOPIC');

-- One row per feed page served.
create table feed_requests (
  id                 uuid primary key default uuid_generate_v7(),
  user_id            uuid not null references users(id) on delete cascade,
  surface            feed_surface not null,
  algorithm_version  text not null,
  snapshot_id        uuid,
  page_offset        integer not null default 0,
  item_count         smallint not null,
  created_at         timestamptz not null default now()
);
create index feed_requests_user_idx on feed_requests (user_id, created_at desc);
create index feed_requests_created_idx on feed_requests using brin (created_at);

-- One row per item served (the "recommendation event"). Sampled by RANKING_LOG_SAMPLE_RATE.
create table recommendation_events (
  feed_request_id  uuid not null references feed_requests(id) on delete cascade,
  position         smallint not null,
  post_id          uuid not null references posts(id) on delete cascade,
  score            real,
  reason           text not null,
  signals          jsonb not null default '{}'::jsonb,
  primary key (feed_request_id, position)
);
create index recommendation_events_post_idx on recommendation_events (post_id);

create table feed_events (
  id                uuid primary key default uuid_generate_v7(),
  -- Client-generated for client events (so retries/batches are idempotent); generated for server events.
  event_id          uuid not null,
  user_id           uuid not null references users(id) on delete cascade,
  event_type        feed_event_type not null,
  origin            text not null check (origin in ('CLIENT', 'SERVER')),
  post_id           uuid references posts(id) on delete cascade,
  activity_id       uuid references activities(id) on delete set null,
  subject_user_id   uuid references users(id) on delete cascade,
  topic             text check (topic is null or char_length(topic) <= 50),
  surface           feed_surface,
  feed_request_id   uuid references feed_requests(id) on delete set null,
  position          smallint check (position is null or position >= 0),
  value_ms          integer check (value_ms is null or value_ms between 0 and 86400000),
  client_ts         timestamptz,
  created_at        timestamptz not null default now(),
  constraint feed_events_user_event_key unique (user_id, event_id)
);
create index feed_events_user_idx on feed_events (user_id, created_at desc);
create index feed_events_post_type_idx on feed_events (post_id, event_type) where post_id is not null;
create index feed_events_created_idx on feed_events using brin (created_at);
create index feed_events_not_interested_idx on feed_events (user_id, post_id) where event_type = 'NOT_INTERESTED';

-- Ranked page lists. A snapshot freezes ORDER so pagination is exactly-once even though live
-- scores keep changing; visibility is re-checked when each page is served. Short-lived.
create table feed_snapshots (
  id                 uuid primary key default uuid_generate_v7(),
  user_id            uuid not null references users(id) on delete cascade,
  surface            feed_surface not null,
  algorithm_version  text not null,
  -- [{ "p": postId, "s": score, "r": reason, "f": { signal: value } }, ...] in rank order
  items              jsonb not null,
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null
);
create index feed_snapshots_user_idx on feed_snapshots (user_id, created_at desc);
create index feed_snapshots_expires_idx on feed_snapshots (expires_at);

-- Rolled-up engagement per post, refreshed incrementally from feed_events.
create table post_stats (
  post_id           uuid primary key references posts(id) on delete cascade,
  impressions       integer not null default 0 check (impressions >= 0),
  video_starts      integer not null default 0 check (video_starts >= 0),
  video_completes   integer not null default 0 check (video_completes >= 0),
  skips             integer not null default 0 check (skips >= 0),
  not_interested    integer not null default 0 check (not_interested >= 0),
  watch_time_ms     bigint not null default 0 check (watch_time_ms >= 0),
  updated_at        timestamptz not null default now()
);

create table analytics_watermarks (
  name           text primary key,
  last_event_id  uuid,
  updated_at     timestamptz not null default now()
);

-- Learned per-user taste, derived from feed_events with time decay (see feed/affinities.ts).
create table user_affinities (
  user_id       uuid not null references users(id) on delete cascade,
  subject_type  affinity_subject not null,
  subject_key   text not null,
  score         real not null,
  updated_at    timestamptz not null default now(),
  primary key (user_id, subject_type, subject_key)
);
create index user_affinities_user_idx on user_affinities (user_id, subject_type, score desc);
