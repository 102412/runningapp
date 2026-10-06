-- 0005: notification records (write side lives in modules/notifier, read API in modules/notifications).
-- post_id / comment_id foreign keys are added by the migrations that create those tables.

create type notification_type as enum (
  'NEW_FOLLOWER', 'FOLLOW_REQUEST', 'FOLLOW_ACCEPTED', 'POST_REACTION', 'POST_COMMENT',
  'COMMENT_REPLY', 'COMMENT_REACTION', 'MENTION_POST', 'MENTION_COMMENT', 'POST_PUBLISHED',
  'POST_PUBLISH_FAILED', 'MODERATION_ACTION'
);

create table notifications (
  id            uuid primary key default uuid_generate_v7(),
  recipient_id  uuid not null references users(id) on delete cascade,
  type          notification_type not null,
  -- NULL for system-originated notifications (e.g. moderation outcomes).
  actor_id      uuid references users(id) on delete cascade,
  post_id       uuid,
  comment_id    uuid,
  -- Small display snapshot (comment excerpt, moderation reason code). Never anything sensitive.
  data          jsonb not null default '{}'::jsonb,
  -- Natural key so a re-like or retried request cannot create a duplicate notification.
  dedupe_key    text,
  read_at       timestamptz,
  created_at    timestamptz not null default now(),
  constraint notifications_dedupe_key unique (recipient_id, dedupe_key),
  constraint notifications_no_self check (actor_id is null or actor_id <> recipient_id)
);
create index notifications_recipient_idx on notifications (recipient_id, created_at desc, id);
create index notifications_unread_idx on notifications (recipient_id) where read_at is null;
create index notifications_actor_idx on notifications (actor_id);

-- Per-user, per-type delivery preferences. Missing row = defaults (in-app on, push on).
create table notification_preferences (
  user_id    uuid not null references users(id) on delete cascade,
  type       notification_type not null,
  in_app     boolean not null default true,
  push       boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, type)
);
