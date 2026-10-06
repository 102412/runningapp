-- 0008: media — uploaded videos/images, their lifecycle, extracted metadata and derived variants.
-- Originals live in object storage under a private key and are never served; only variants are.

create type media_kind as enum ('VIDEO', 'IMAGE');
create type media_purpose as enum ('POST', 'AVATAR');
create type media_status as enum ('PENDING_UPLOAD', 'UPLOADED', 'PROCESSING', 'READY', 'FAILED', 'REJECTED');
create type media_moderation_status as enum ('PENDING', 'APPROVED', 'REJECTED');
create type media_variant_kind as enum (
  'VIDEO_MP4_HIGH', 'VIDEO_MP4_LOW', 'POSTER', 'POSTER_THUMB', 'IMAGE_LARGE', 'IMAGE_MEDIUM', 'IMAGE_THUMB'
);

create table media_assets (
  id                      uuid primary key default uuid_generate_v7(),
  owner_id                uuid not null references users(id) on delete cascade,
  kind                    media_kind not null,
  purpose                 media_purpose not null,
  status                  media_status not null default 'PENDING_UPLOAD',
  moderation_status       media_moderation_status not null default 'PENDING',
  -- Private object key of the original upload. Server-generated; never client-supplied.
  storage_key             text not null,
  declared_mime           text not null,
  declared_size_bytes     bigint not null check (declared_size_bytes > 0),
  actual_size_bytes       bigint check (actual_size_bytes is null or actual_size_bytes > 0),
  upload_expires_at       timestamptz not null,
  uploaded_at             timestamptz,
  processing_started_at   timestamptz,
  ready_at                timestamptz,
  -- Machine-readable reason (exposed to the owner) and free-text diagnostics (internal only).
  failure_code            text check (failure_code in (
    'INVALID_MEDIA', 'UNSUPPORTED_FORMAT', 'TOO_LONG', 'TOO_LARGE_DIMENSIONS', 'TOO_SMALL',
    'MODERATION_REJECTED', 'PROCESSING_ERROR', 'TAKEN_DOWN'
  )),
  failure_detail          text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  -- Composite-FK target so join tables can prove "this media belongs to this owner".
  constraint media_assets_id_owner_key unique (id, owner_id),
  constraint media_assets_storage_key_key unique (storage_key),
  constraint media_failure_pairing check ((status in ('FAILED', 'REJECTED')) = (failure_code is not null)),
  constraint media_ready_requirements check (
    status <> 'READY' or (ready_at is not null and actual_size_bytes is not null and moderation_status = 'APPROVED')
  ),
  constraint media_avatar_is_image check (purpose <> 'AVATAR' or kind = 'IMAGE')
);
create index media_assets_owner_idx on media_assets (owner_id, created_at desc);
create index media_assets_pending_expiry_idx on media_assets (upload_expires_at) where status = 'PENDING_UPLOAD';
create index media_assets_status_idx on media_assets (status) where status in ('UPLOADED', 'PROCESSING');
create trigger media_assets_set_updated_at before update on media_assets for each row execute function set_updated_at();

create table video_assets (
  media_id       uuid primary key references media_assets(id) on delete cascade,
  duration_ms    integer not null check (duration_ms > 0),
  width          integer not null check (width > 0),
  height         integer not null check (height > 0),
  aspect_ratio   real generated always as (width::real / height::real) stored,
  fps            real check (fps is null or fps > 0),
  video_codec    text,
  audio_codec    text,
  has_audio      boolean not null default false,
  bitrate_kbps   integer check (bitrate_kbps is null or bitrate_kbps > 0)
);

create table image_assets (
  media_id       uuid primary key references media_assets(id) on delete cascade,
  width          integer not null check (width > 0),
  height         integer not null check (height > 0),
  aspect_ratio   real generated always as (width::real / height::real) stored
);

-- Every derived file: playable renditions, posters and thumbnails.
create table media_variants (
  id            uuid primary key default uuid_generate_v7(),
  media_id      uuid not null references media_assets(id) on delete cascade,
  kind          media_variant_kind not null,
  storage_key   text not null,
  mime_type     text not null,
  size_bytes    bigint not null check (size_bytes > 0),
  width         integer check (width is null or width > 0),
  height        integer check (height is null or height > 0),
  bitrate_kbps  integer check (bitrate_kbps is null or bitrate_kbps > 0),
  created_at    timestamptz not null default now(),
  constraint media_variants_media_kind_key unique (media_id, kind),
  constraint media_variants_storage_key_key unique (storage_key)
);

alter table profiles
  add constraint profiles_avatar_media_fk foreign key (avatar_media_id) references media_assets(id) on delete set null;

-- ---- lifecycle guards ------------------------------------------------------------------------
-- 1. Only legal state transitions are possible, whatever code path tries to make them.
-- 2. A row can only become READY once its metadata and required variants exist: a file that was
--    never validated/processed cannot be served, no matter how it got there.
create function media_assets_guard_status() returns trigger language plpgsql as $$
declare ok boolean;
begin
  ok := case old.status
    when 'PENDING_UPLOAD' then new.status = 'UPLOADED'
    when 'UPLOADED'       then new.status in ('PROCESSING', 'FAILED', 'REJECTED')
    when 'PROCESSING'     then new.status in ('READY', 'FAILED', 'REJECTED')
    when 'FAILED'         then new.status in ('PROCESSING', 'REJECTED')
    when 'READY'          then new.status = 'REJECTED'
    else false
  end;
  if not ok then
    raise exception 'illegal media status transition % -> %', old.status, new.status
      using errcode = 'P0001', constraint = 'media_illegal_transition';
  end if;

  if new.status = 'READY' then
    if new.kind = 'VIDEO' then
      if not exists (select 1 from video_assets where media_id = new.id)
         or (select count(*) from media_variants
              where media_id = new.id and kind in ('VIDEO_MP4_HIGH', 'POSTER', 'POSTER_THUMB')) < 3 then
        raise exception 'video % cannot be READY without metadata and variants', new.id
          using errcode = 'P0001', constraint = 'media_not_ready';
      end if;
    else
      if not exists (select 1 from image_assets where media_id = new.id)
         or (select count(*) from media_variants
              where media_id = new.id and kind in ('IMAGE_MEDIUM', 'IMAGE_THUMB')) < 2 then
        raise exception 'image % cannot be READY without metadata and variants', new.id
          using errcode = 'P0001', constraint = 'media_not_ready';
      end if;
    end if;
  end if;
  return new;
end $$;
create trigger media_assets_status_guard before update of status on media_assets
  for each row when (old.status is distinct from new.status)
  execute function media_assets_guard_status();
