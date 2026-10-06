-- 0002: platform tables — background jobs, request idempotency, dev mail outbox.

create type job_status as enum ('PENDING', 'RUNNING', 'SUCCEEDED', 'DEAD');

-- Postgres-backed job queue. Enqueue happens inside the caller's transaction (transactional
-- outbox semantics: no job without its state change, no state change without its job).
create table jobs (
  id            uuid primary key default uuid_generate_v7(),
  name          text not null check (char_length(name) between 1 and 100),
  payload       jsonb not null default '{}'::jsonb,
  status        job_status not null default 'PENDING',
  run_at        timestamptz not null default now(),
  attempts      integer not null default 0 check (attempts >= 0),
  max_attempts  integer not null default 5 check (max_attempts >= 1),
  locked_at     timestamptz,
  locked_by     text,
  last_error    text,
  -- dedupe_key: at most one PENDING/RUNNING job with this key.
  dedupe_key    text,
  -- unique_key: at most one job EVER with this key (used by the cron scheduler).
  unique_key    text,
  finished_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint jobs_running_has_lock check (status <> 'RUNNING' or locked_at is not null)
);

create index jobs_claim_idx on jobs (run_at, id) where status = 'PENDING';
create index jobs_running_idx on jobs (locked_at) where status = 'RUNNING';
create unique index jobs_dedupe_active_idx on jobs (dedupe_key)
  where dedupe_key is not null and status in ('PENDING', 'RUNNING');
create unique index jobs_unique_key_idx on jobs (unique_key) where unique_key is not null;
create index jobs_finished_idx on jobs (finished_at) where status in ('SUCCEEDED', 'DEAD');

create trigger jobs_set_updated_at before update on jobs
  for each row execute function set_updated_at();

-- Idempotency-Key support for non-idempotent POSTs. Scoped per user; entries expire.
create table idempotency_keys (
  user_id          uuid not null,
  key              text not null check (char_length(key) between 8 and 128),
  request_hash     text not null,
  state            text not null check (state in ('IN_PROGRESS', 'COMPLETED')),
  response_status  integer,
  response_body    jsonb,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  primary key (user_id, key)
);
create index idempotency_keys_expires_idx on idempotency_keys (expires_at);

-- Development/test mail sink. Populated ONLY by the console mailer, which production config
-- refuses; production never persists email bodies (they contain single-use links).
create table dev_mail_outbox (
  id          uuid primary key default uuid_generate_v7(),
  to_email    citext not null,
  subject     text not null,
  text_body   text not null,
  template    text not null,
  -- Parsed single-use token (verification / reset), exposed so UI devs can finish flows.
  token       text,
  created_at  timestamptz not null default now()
);
create index dev_mail_outbox_to_idx on dev_mail_outbox (to_email, created_at desc);
