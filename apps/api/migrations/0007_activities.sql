-- 0007: activities — what an athlete DID. Independent of posts (what they SHARE).
-- Units are SI throughout: metres, seconds, metres/second, degrees Celsius, watts.

create type activity_source as enum ('MANUAL', 'FILE_IMPORT', 'STRAVA', 'GARMIN', 'APPLE_HEALTH', 'HEALTH_CONNECT');
create type split_type as enum ('KM', 'MILE', 'LAP', 'INTERVAL');
create type record_type as enum (
  'LONGEST_DISTANCE', 'LONGEST_DURATION', 'FASTEST_5K', 'FASTEST_10K',
  'FASTEST_HALF_MARATHON', 'FASTEST_MARATHON', 'BIGGEST_CLIMB'
);
create type integration_provider as enum ('STRAVA', 'GARMIN', 'APPLE_HEALTH', 'HEALTH_CONNECT');
create type integration_status as enum ('CONNECTED', 'NEEDS_REAUTH', 'REVOKED');

-- Connections to third-party activity sources. Architecture only: no provider is wired up yet
-- (each needs developer credentials). Tokens must be stored sealed (AES-GCM), never plaintext.
create table integration_connections (
  id                   uuid primary key default uuid_generate_v7(),
  user_id              uuid not null references users(id) on delete cascade,
  provider             integration_provider not null,
  status               integration_status not null default 'CONNECTED',
  external_account_id  text,
  scopes               text[] not null default '{}',
  access_token_sealed  text,
  refresh_token_sealed text,
  token_expires_at     timestamptz,
  last_synced_at       timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint integration_connections_user_provider_key unique (user_id, provider)
);
create trigger integration_connections_set_updated_at before update on integration_connections
  for each row execute function set_updated_at();

create table activities (
  id                          uuid primary key default uuid_generate_v7(),
  user_id                     uuid not null references users(id) on delete cascade,
  sport_key                   text not null references sports(key) on update cascade,
  -- Free-form but constrained slug: 'trail', 'indoor', 'open_water', 'long_run', ...
  subtype                     text,
  is_race                     boolean not null default false,
  title                       text not null,
  description                 text not null default '',
  started_at                  timestamptz not null,
  -- IANA zone the activity happened in, so "Morning run" can be derived and shown correctly.
  timezone                    text not null default 'UTC',
  elapsed_time_s              integer not null,
  moving_time_s               integer,
  distance_m                  double precision,
  elevation_gain_m            double precision,
  elevation_loss_m            double precision,
  calories_kcal               integer,
  visibility                  content_visibility not null,
  route_privacy               route_privacy not null,
  source                      activity_source not null default 'MANUAL',
  integration_connection_id   uuid references integration_connections(id) on delete set null,
  external_id                 text,
  -- Coarse, user-supplied place name. Never derived from GPS.
  location_label              text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  -- Target of composite foreign keys so a post can only attach its own author's activity.
  constraint activities_id_user_key unique (id, user_id),
  constraint activities_title_len check (char_length(title) between 1 and 100),
  constraint activities_description_len check (char_length(description) <= 2000),
  constraint activities_subtype_format check (subtype is null or subtype ~ '^[a-z][a-z0-9_]{0,39}$'),
  constraint activities_elapsed_range check (elapsed_time_s between 0 and 604800),
  constraint activities_moving_range check (moving_time_s is null or (moving_time_s >= 0 and moving_time_s <= elapsed_time_s)),
  constraint activities_distance_range check (distance_m is null or (distance_m >= 0 and distance_m <= 2000000)),
  constraint activities_elev_gain_range check (elevation_gain_m is null or (elevation_gain_m >= 0 and elevation_gain_m <= 20000)),
  constraint activities_elev_loss_range check (elevation_loss_m is null or (elevation_loss_m >= 0 and elevation_loss_m <= 20000)),
  constraint activities_calories_range check (calories_kcal is null or calories_kcal between 0 and 100000),
  constraint activities_location_len check (location_label is null or char_length(location_label) <= 80),
  constraint activities_external_pair check ((external_id is null) = (source = 'MANUAL'))
);
-- Imports are idempotent: the same external activity can never be stored twice per user.
create unique index activities_external_key on activities (user_id, source, external_id) where external_id is not null;
create index activities_user_started_idx on activities (user_id, started_at desc, id desc);
create index activities_sport_started_idx on activities (sport_key, started_at desc);
create trigger activities_set_updated_at before update on activities for each row execute function set_updated_at();

-- Optional, sport-dependent measurements. One row per activity; every column may be NULL.
create table activity_metrics (
  activity_id          uuid primary key references activities(id) on delete cascade,
  avg_speed_mps        double precision check (avg_speed_mps is null or avg_speed_mps between 0 and 120),
  max_speed_mps        double precision check (max_speed_mps is null or max_speed_mps between 0 and 120),
  avg_heart_rate_bpm   integer check (avg_heart_rate_bpm is null or avg_heart_rate_bpm between 20 and 260),
  max_heart_rate_bpm   integer check (max_heart_rate_bpm is null or max_heart_rate_bpm between 20 and 260),
  avg_cadence          integer check (avg_cadence is null or avg_cadence between 0 and 300),
  max_cadence          integer check (max_cadence is null or max_cadence between 0 and 300),
  avg_power_w          integer check (avg_power_w is null or avg_power_w between 0 and 3000),
  max_power_w          integer check (max_power_w is null or max_power_w between 0 and 5000),
  normalized_power_w   integer check (normalized_power_w is null or normalized_power_w between 0 and 3000),
  avg_temperature_c    real check (avg_temperature_c is null or avg_temperature_c between -60 and 70),
  -- Genuinely sport-specific structures (swim pool length, strength sets/reps). Validated by the
  -- API against a schema; capped in size so it cannot become a dumping ground.
  extra                jsonb not null default '{}'::jsonb check (pg_column_size(extra) <= 32768)
);

create table activity_splits (
  activity_id         uuid not null references activities(id) on delete cascade,
  split_type          split_type not null,
  split_index         smallint not null check (split_index >= 0),
  distance_m          double precision check (distance_m is null or distance_m >= 0),
  elapsed_time_s      integer not null check (elapsed_time_s >= 0),
  elevation_diff_m    double precision,
  avg_heart_rate_bpm  integer check (avg_heart_rate_bpm is null or avg_heart_rate_bpm between 20 and 260),
  avg_speed_mps       double precision check (avg_speed_mps is null or avg_speed_mps between 0 and 120),
  primary key (activity_id, split_type, split_index)
);

-- The raw GPS track. Stored at full precision for the owner; every other viewer only ever
-- receives the output of the route-privacy transform (trim, privacy zones, coarsening).
create table activity_routes (
  activity_id  uuid primary key references activities(id) on delete cascade,
  -- Google encoded polyline, precision 5 (~1.1 m).
  polyline     text not null,
  point_count  integer not null check (point_count between 2 and 50000),
  created_at   timestamptz not null default now()
);

-- Circles around sensitive places (home, school, workplace). Points inside a zone are never
-- served to other viewers. Zones themselves are visible to their owner only.
create table privacy_zones (
  id          uuid primary key default uuid_generate_v7(),
  user_id     uuid not null references users(id) on delete cascade,
  label       text not null check (char_length(label) between 1 and 40),
  center_lat  double precision not null check (center_lat between -90 and 90),
  center_lon  double precision not null check (center_lon between -180 and 180),
  radius_m    integer not null check (radius_m between 50 and 5000),
  created_at  timestamptz not null default now()
);
create index privacy_zones_user_idx on privacy_zones (user_id);

-- Personal records, recorded at the time an activity sets them.
create table activity_records (
  id              uuid primary key default uuid_generate_v7(),
  user_id         uuid not null references users(id) on delete cascade,
  activity_id     uuid not null references activities(id) on delete cascade,
  record_type     record_type not null,
  value           double precision not null,
  previous_value  double precision,
  achieved_at     timestamptz not null,
  created_at      timestamptz not null default now(),
  constraint activity_records_activity_type_key unique (activity_id, record_type)
);
create index activity_records_user_type_idx on activity_records (user_id, record_type, value);
