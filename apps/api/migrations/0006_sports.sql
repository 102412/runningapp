-- 0006: sports reference data. Sports are rows, not an enum, so adding one needs no deploy.
-- Capability flags drive validation ("is a power metric meaningful for this sport?") and tell
-- clients which fields to render. They never *require* a metric: every metric stays optional.

create type sport_category as enum ('ENDURANCE', 'STRENGTH', 'GENERAL');
create type speed_display as enum ('PACE_PER_DISTANCE', 'SPEED', 'PACE_PER_100M', 'PACE_PER_500M', 'NONE');
create type sport_relation as enum ('PARTICIPANT', 'FOLLOWER');

create table sports (
  key                  text primary key check (key ~ '^[a-z][a-z_]{1,30}$'),
  label                text not null,
  category             sport_category not null,
  speed_display        speed_display not null,
  supports_distance    boolean not null,
  supports_route       boolean not null,
  supports_elevation   boolean not null,
  supports_heart_rate  boolean not null,
  supports_cadence     boolean not null,
  supports_power       boolean not null,
  supports_splits      boolean not null,
  sort_order           integer not null,
  created_at           timestamptz not null default now()
);

insert into sports
  (key, label, category, speed_display, supports_distance, supports_route, supports_elevation, supports_heart_rate, supports_cadence, supports_power, supports_splits, sort_order)
values
  ('running',           'Running',           'ENDURANCE', 'PACE_PER_DISTANCE', true,  true,  true,  true,  true,  true,  true,  10),
  ('cross_country',     'Cross Country',     'ENDURANCE', 'PACE_PER_DISTANCE', true,  true,  true,  true,  true,  false, true,  20),
  ('track',             'Track',             'ENDURANCE', 'PACE_PER_DISTANCE', true,  false, false, true,  true,  false, true,  30),
  ('cycling',           'Cycling',           'ENDURANCE', 'SPEED',             true,  true,  true,  true,  true,  true,  true,  40),
  ('swimming',          'Swimming',          'ENDURANCE', 'PACE_PER_100M',     true,  true,  false, true,  true,  false, true,  50),
  ('walking',           'Walking',           'ENDURANCE', 'PACE_PER_DISTANCE', true,  true,  true,  true,  true,  false, true,  60),
  ('hiking',            'Hiking',            'ENDURANCE', 'PACE_PER_DISTANCE', true,  true,  true,  true,  false, false, true,  70),
  ('rowing',            'Rowing',            'ENDURANCE', 'PACE_PER_500M',     true,  true,  false, true,  true,  true,  true,  80),
  ('triathlon',         'Triathlon',         'ENDURANCE', 'SPEED',             true,  true,  true,  true,  true,  true,  true,  90),
  ('strength_training', 'Strength Training', 'STRENGTH',  'NONE',              false, false, false, true,  false, false, false, 100),
  ('workout',           'Workout',           'GENERAL',   'NONE',              false, false, false, true,  false, false, false, 110),
  ('other',             'Other',             'GENERAL',   'SPEED',             true,  true,  true,  true,  false, false, false, 999);

alter table profiles
  add column primary_sport_key text references sports(key) on update cascade on delete set null;

-- Explicit sport interests (onboarding / settings). Inferred affinities live in user_affinities.
create table sport_preferences (
  user_id     uuid not null references users(id) on delete cascade,
  sport_key   text not null references sports(key) on update cascade on delete cascade,
  relation    sport_relation not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, sport_key)
);
create index sport_preferences_sport_idx on sport_preferences (sport_key);
