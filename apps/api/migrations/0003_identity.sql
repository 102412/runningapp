-- 0003: identity — users, profiles, settings, devices, sessions, refresh tokens, auth tokens.

create type user_status as enum ('ACTIVE', 'SUSPENDED', 'PENDING_DELETION');
create type user_role as enum ('USER', 'MODERATOR', 'ADMIN');
create type account_visibility as enum ('PUBLIC', 'PRIVATE');
create type content_visibility as enum ('PUBLIC', 'FOLLOWERS', 'PRIVATE');
create type comment_permission as enum ('EVERYONE', 'FOLLOWERS', 'NOBODY');
create type unit_system as enum ('METRIC', 'IMPERIAL');
create type route_privacy as enum ('FULL', 'TRIMMED', 'APPROXIMATE', 'HIDDEN');
create type device_platform as enum ('IOS', 'ANDROID', 'WEB');
create type push_provider as enum ('APNS', 'FCM', 'EXPO');
create type auth_token_purpose as enum ('EMAIL_VERIFICATION', 'PASSWORD_RESET');
create type oauth_provider as enum ('GOOGLE', 'APPLE');

-- Account deletion is a HARD delete after the grace period (ON DELETE CASCADE everywhere user
-- data hangs off users.id), so there is deliberately no 'DELETED' status.
create table users (
  id                      uuid primary key default uuid_generate_v7(),
  email                   citext not null,
  email_verified_at       timestamptz,
  -- NULL for accounts that only ever sign in through an OAuth provider.
  password_hash           text,
  status                  user_status not null default 'ACTIVE',
  role                    user_role not null default 'USER',
  birth_date              date not null,
  last_login_at           timestamptz,
  password_changed_at     timestamptz,
  suspended_at            timestamptz,
  deletion_requested_at   timestamptz,
  deletion_scheduled_for  timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint users_email_key unique (email),
  constraint users_email_format check (char_length(email) <= 254 and email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  constraint users_deletion_consistent check (
    (status = 'PENDING_DELETION') = (deletion_requested_at is not null and deletion_scheduled_for is not null)
  )
);
create index users_deletion_due_idx on users (deletion_scheduled_for) where status = 'PENDING_DELETION';
create trigger users_set_updated_at before update on users for each row execute function set_updated_at();

create table profiles (
  user_id               uuid primary key references users(id) on delete cascade,
  username              citext not null,
  display_name          text not null,
  bio                   text not null default '',
  -- Coarse, user-typed place name ("Eugene, OR"). Never derived from GPS.
  location_label        text,
  -- FK to media_assets is added by the media migration.
  avatar_media_id       uuid,
  account_visibility    account_visibility not null default 'PUBLIC',
  -- When false the account is excluded from search and suggestions (still reachable by username).
  discoverable          boolean not null default true,
  username_changed_at   timestamptz,
  follower_count        integer not null default 0,
  following_count       integer not null default 0,
  post_count            integer not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint profiles_username_key unique (username),
  constraint profiles_username_format check (
    username ~ '^[A-Za-z][A-Za-z0-9_.]{2,29}$' and username !~ '\.\.' and username !~ '\.$'
  ),
  constraint profiles_display_name_len check (char_length(display_name) between 1 and 50),
  constraint profiles_bio_len check (char_length(bio) <= 300),
  constraint profiles_location_len check (location_label is null or char_length(location_label) <= 80),
  constraint profiles_counts_nonneg check (follower_count >= 0 and following_count >= 0 and post_count >= 0)
);
create trigger profiles_set_updated_at before update on profiles for each row execute function set_updated_at();

-- Private per-user preferences and defaults for newly created content.
create table user_settings (
  user_id                       uuid primary key references users(id) on delete cascade,
  unit_system                   unit_system not null default 'METRIC',
  default_activity_visibility   content_visibility not null default 'FOLLOWERS',
  default_post_visibility       content_visibility not null default 'PUBLIC',
  default_comment_permission    comment_permission not null default 'EVERYONE',
  default_route_privacy         route_privacy not null default 'TRIMMED',
  -- Metres trimmed from both ends of a route shown to others when route privacy is TRIMMED/APPROXIMATE.
  route_trim_meters             integer not null default 200,
  -- Auto-create a feed-visible activity post when an activity is logged.
  auto_create_activity_post     boolean not null default true,
  -- Opt-out of using this user's behaviour to personalise their feed.
  personalization_enabled       boolean not null default true,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  constraint user_settings_trim_range check (route_trim_meters between 0 and 2000)
);
create trigger user_settings_set_updated_at before update on user_settings for each row execute function set_updated_at();

create table devices (
  id                      uuid primary key default uuid_generate_v7(),
  user_id                 uuid not null references users(id) on delete cascade,
  -- Client-generated stable id for this app install; lets re-logins reuse the same device row.
  install_id              text not null,
  platform                device_platform not null,
  name                    text,
  app_version             text,
  push_provider           push_provider,
  push_token              text,
  push_token_updated_at   timestamptz,
  last_seen_at            timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint devices_user_install_key unique (user_id, install_id),
  constraint devices_install_id_len check (char_length(install_id) between 8 and 128),
  constraint devices_push_pair check ((push_provider is null) = (push_token is null))
);
-- A push token identifies exactly one device row.
create unique index devices_push_token_key on devices (push_provider, push_token) where push_token is not null;
create trigger devices_set_updated_at before update on devices for each row execute function set_updated_at();

create table sessions (
  id              uuid primary key default uuid_generate_v7(),
  user_id         uuid not null references users(id) on delete cascade,
  device_id       uuid references devices(id) on delete set null,
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  -- Absolute lifetime cap: refresh tokens cannot extend a session beyond this.
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  revoked_reason  text check (revoked_reason in ('LOGOUT', 'LOGOUT_ALL', 'PASSWORD_CHANGED', 'PASSWORD_RESET', 'REFRESH_REUSE', 'USER_REVOKED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_DELETION')),
  -- Coarse network hint for the "your devices" screen (IPv4 /24 or IPv6 /48). Never the full IP.
  ip_prefix       text,
  user_agent      text,
  constraint sessions_revoked_pair check ((revoked_at is null) = (revoked_reason is null))
);
create index sessions_user_active_idx on sessions (user_id, last_seen_at desc) where revoked_at is null;

-- One row per issued refresh token. Rotation marks the old row used; presenting a used token
-- again proves theft/replay, so the whole session is revoked (reuse detection).
create table refresh_tokens (
  id          uuid primary key default uuid_generate_v7(),
  session_id  uuid not null references sessions(id) on delete cascade,
  token_hash  text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  replaced_by uuid references refresh_tokens(id) on delete set null,
  constraint refresh_tokens_hash_key unique (token_hash)
);
create index refresh_tokens_session_idx on refresh_tokens (session_id);
create index refresh_tokens_expires_idx on refresh_tokens (expires_at);

-- Single-use emailed tokens (email verification, password reset). Only SHA-256 hashes are stored.
create table auth_tokens (
  id           uuid primary key default uuid_generate_v7(),
  user_id      uuid not null references users(id) on delete cascade,
  purpose      auth_token_purpose not null,
  token_hash   text not null,
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now(),
  constraint auth_tokens_hash_key unique (token_hash)
);
create index auth_tokens_user_purpose_idx on auth_tokens (user_id, purpose) where consumed_at is null;
create index auth_tokens_expires_idx on auth_tokens (expires_at);

-- Progressive per-account login throttling (complements the per-IP rate limiter). Keyed by the
-- submitted email regardless of whether the account exists, so it reveals nothing.
create table login_throttles (
  email           citext primary key,
  failure_count   integer not null default 0,
  locked_until    timestamptz,
  updated_at      timestamptz not null default now()
);
create index login_throttles_updated_idx on login_throttles (updated_at);

-- Architecture for future "Sign in with Apple/Google"; no endpoints yet (see docs/SECURITY.md).
create table oauth_identities (
  id          uuid primary key default uuid_generate_v7(),
  user_id     uuid not null references users(id) on delete cascade,
  provider    oauth_provider not null,
  subject     text not null,
  email       citext,
  created_at  timestamptz not null default now(),
  constraint oauth_identities_provider_subject_key unique (provider, subject)
);
create index oauth_identities_user_idx on oauth_identities (user_id);
