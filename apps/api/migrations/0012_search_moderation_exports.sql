-- 0012: search indexes, moderation (reports + append-only audit trail) and data exports.

-- ---------------------------------------------------------------------------------- search
-- Trigram indexes make "contains"/typo-tolerant matching fast. Post text search uses the
-- existing posts.search_tsv GIN index; topic prefix lookups use topics_slug_prefix_idx.
create index profiles_username_trgm_idx on profiles using gin ((username::text) gin_trgm_ops);
create index profiles_display_name_trgm_idx on profiles using gin (lower(display_name) gin_trgm_ops);
create index topics_slug_trgm_idx on topics using gin ((slug::text) gin_trgm_ops);

-- ------------------------------------------------------------------------------- moderation
create type report_target_type as enum ('POST', 'COMMENT', 'USER');
create type report_reason as enum (
  'SPAM', 'HARASSMENT', 'HATE_SPEECH', 'VIOLENCE', 'SEXUAL_CONTENT', 'SELF_HARM', 'MINOR_SAFETY',
  'IMPERSONATION', 'MISINFORMATION', 'UNDISCLOSED_SPONSORSHIP', 'COPYRIGHT', 'PRIVACY_VIOLATION', 'OTHER'
);
create type report_status as enum ('OPEN', 'IN_REVIEW', 'ACTIONED', 'DISMISSED');
create type report_source as enum ('USER', 'AUTOMATED');
create type moderation_action_type as enum (
  'HIDE_CONTENT', 'REMOVE_CONTENT', 'RESTORE_CONTENT', 'SUSPEND_USER', 'UNSUSPEND_USER',
  'WARN_USER', 'DISMISS_REPORT', 'SET_CREATOR_VERIFICATION'
);

create table reports (
  id                 uuid primary key default uuid_generate_v7(),
  -- NULL for AUTOMATED reports and after the reporter's account is deleted (the report stays).
  reporter_id        uuid references users(id) on delete set null,
  source             report_source not null default 'USER',
  target_type        report_target_type not null,
  target_post_id     uuid references posts(id) on delete cascade,
  target_comment_id  uuid references comments(id) on delete cascade,
  target_user_id     uuid references users(id) on delete cascade,
  reason             report_reason not null,
  details            text,
  -- The reported text as it was at report time (captions and comments can be edited or deleted).
  snapshot           jsonb not null default '{}'::jsonb,
  status             report_status not null default 'OPEN',
  -- Moderator ids are plain uuids (no FK): the record must outlive staff accounts.
  resolved_by        uuid,
  resolved_at        timestamptz,
  resolution_note    text,
  created_at         timestamptz not null default now(),
  constraint reports_details_len check (details is null or char_length(details) <= 1000),
  constraint reports_note_len check (resolution_note is null or char_length(resolution_note) <= 1000),
  constraint reports_one_target check (
    (target_type = 'POST'    and target_post_id is not null and target_comment_id is null and target_user_id is null) or
    (target_type = 'COMMENT' and target_comment_id is not null and target_post_id is null and target_user_id is null) or
    (target_type = 'USER'    and target_user_id is not null and target_post_id is null and target_comment_id is null)
  ),
  constraint reports_resolved_consistent check (
    (status in ('ACTIONED', 'DISMISSED')) = (resolved_at is not null)
  )
);
-- A person can report a given thing once.
create unique index reports_user_once_post_key on reports (reporter_id, target_post_id)
  where reporter_id is not null and target_post_id is not null;
create unique index reports_user_once_comment_key on reports (reporter_id, target_comment_id)
  where reporter_id is not null and target_comment_id is not null;
create unique index reports_user_once_user_key on reports (reporter_id, target_user_id)
  where reporter_id is not null and target_user_id is not null;
-- At most one unresolved automated report per target (re-flagging an edit does not pile up).
create unique index reports_auto_open_key on reports (coalesce(target_post_id, target_comment_id, target_user_id))
  where source = 'AUTOMATED' and status in ('OPEN', 'IN_REVIEW');
-- The moderation queue.
create index reports_queue_idx on reports (status, id);
create index reports_target_post_idx on reports (target_post_id) where target_post_id is not null;
create index reports_target_comment_idx on reports (target_comment_id) where target_comment_id is not null;
create index reports_target_user_idx on reports (target_user_id) where target_user_id is not null;
create index reports_reporter_idx on reports (reporter_id, id desc) where reporter_id is not null;

-- The audit trail. Append-only (enforced below) and deliberately WITHOUT foreign keys: it must
-- survive the deletion of the content, the moderated account and the moderator.
create table moderation_actions (
  id                 uuid primary key default uuid_generate_v7(),
  actor_id           uuid not null,
  action             moderation_action_type not null,
  report_id          uuid,
  target_type        report_target_type not null,
  target_post_id     uuid,
  target_comment_id  uuid,
  target_user_id     uuid,
  note               text,
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  constraint moderation_actions_note_len check (note is null or char_length(note) <= 1000)
);
create index moderation_actions_target_post_idx on moderation_actions (target_post_id, id desc) where target_post_id is not null;
create index moderation_actions_target_comment_idx on moderation_actions (target_comment_id, id desc) where target_comment_id is not null;
create index moderation_actions_target_user_idx on moderation_actions (target_user_id, id desc) where target_user_id is not null;
create index moderation_actions_actor_idx on moderation_actions (actor_id, id desc);

create function moderation_actions_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'moderation_actions is append-only' using errcode = 'P0001', constraint = 'moderation_actions_append_only';
end $$;
create trigger moderation_actions_no_change before update or delete on moderation_actions
  for each row execute function moderation_actions_immutable();
create trigger moderation_actions_no_truncate before truncate on moderation_actions
  for each statement execute function moderation_actions_immutable();

-- ------------------------------------------------------------------------------ data export
create type data_export_status as enum ('PENDING', 'PROCESSING', 'READY', 'FAILED', 'EXPIRED');

create table data_exports (
  id            uuid primary key default uuid_generate_v7(),
  user_id       uuid not null references users(id) on delete cascade,
  status        data_export_status not null default 'PENDING',
  storage_key   text,
  size_bytes    bigint check (size_bytes is null or size_bytes >= 0),
  error         text,
  requested_at  timestamptz not null default now(),
  completed_at  timestamptz,
  expires_at    timestamptz,
  constraint data_exports_ready_has_file check (status <> 'READY' or (storage_key is not null and expires_at is not null))
);
create index data_exports_user_idx on data_exports (user_id, requested_at desc);
create unique index data_exports_active_key on data_exports (user_id) where status in ('PENDING', 'PROCESSING');
create index data_exports_expiry_idx on data_exports (expires_at) where status = 'READY';
