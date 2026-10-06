-- 0009: posts — what an athlete SHARES. Related to, but independent of, activities (what they DID).
-- A post may carry any mix of: caption, one attached activity, photos/videos, sponsorship
-- disclosure, topics and mentions. An activity needs no post; a post needs no activity.

create type post_status as enum ('DRAFT', 'PENDING_MEDIA', 'PUBLISHED', 'PUBLISH_FAILED');
create type post_origin as enum ('AUTHORED', 'ACTIVITY_AUTO');
create type post_format as enum ('ACTIVITY', 'VIDEO', 'PHOTO', 'TEXT');
create type moderation_status as enum ('CLEAN', 'HIDDEN', 'REMOVED');
create type sponsorship_type as enum ('PAID_PARTNERSHIP', 'GIFTED_PRODUCT', 'AFFILIATE', 'AMBASSADOR');
create type creator_category as enum ('PROFESSIONAL_ATHLETE', 'COACH', 'CONTENT_CREATOR', 'BRAND', 'CLUB_OR_TEAM');
create type verification_status as enum ('NONE', 'PENDING', 'VERIFIED');

create table posts (
  id                  uuid primary key default uuid_generate_v7(),
  author_id           uuid not null references users(id) on delete cascade,
  origin              post_origin not null default 'AUTHORED',
  status              post_status not null default 'DRAFT',
  -- Server-derived from the activity and READY media (see PostService.deriveFormat).
  format              post_format not null,
  caption             text not null default '',
  visibility          content_visibility not null,
  comment_permission  comment_permission not null default 'EVERYONE',
  activity_id         uuid,
  media_count         smallint not null default 0 check (media_count >= 0),
  moderation_status   moderation_status not null default 'CLEAN',
  published_at        timestamptz,
  -- Soft delete: invisible everywhere immediately; purged for good after a retention window.
  deleted_at          timestamptz,
  reaction_count      integer not null default 0 check (reaction_count >= 0),
  comment_count       integer not null default 0 check (comment_count >= 0),
  bookmark_count      integer not null default 0 check (bookmark_count >= 0),
  share_count         integer not null default 0 check (share_count >= 0),
  search_tsv          tsvector generated always as (to_tsvector('simple', caption)) stored,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint posts_id_author_key unique (id, author_id),
  constraint posts_caption_len check (char_length(caption) <= 2200),
  constraint posts_published_has_time check ((status = 'PUBLISHED') = (published_at is not null)),
  -- A post can only attach ITS AUTHOR's activity: enforced by the database, not by hope.
  -- Deleting the activity detaches the post (it keeps its caption/media).
  constraint posts_activity_owner_fk foreign key (activity_id, author_id)
    references activities (id, user_id) on delete set null (activity_id)
);
-- At most one auto-generated "activity post" per activity.
create unique index posts_auto_activity_key on posts (activity_id) where origin = 'ACTIVITY_AUTO';
create index posts_activity_idx on posts (activity_id) where activity_id is not null;
-- Profile grids and the chronological following feed.
create index posts_author_published_idx on posts (author_id, published_at desc, id desc)
  where status = 'PUBLISHED' and deleted_at is null and moderation_status = 'CLEAN';
-- Discovery over everything public.
create index posts_published_idx on posts (published_at desc, id desc)
  where status = 'PUBLISHED' and deleted_at is null and moderation_status = 'CLEAN' and visibility = 'PUBLIC';
create index posts_author_created_idx on posts (author_id, created_at desc, id desc) where deleted_at is null;
create index posts_pending_idx on posts (updated_at) where status = 'PENDING_MEDIA';
create index posts_deleted_idx on posts (deleted_at) where deleted_at is not null;
create index posts_search_idx on posts using gin (search_tsv);
create trigger posts_set_updated_at before update on posts for each row execute function set_updated_at();

create table post_media (
  post_id     uuid not null,
  media_id    uuid not null,
  -- Denormalised owner so composite FKs can prove post and media share the same owner.
  owner_id    uuid not null,
  position    smallint not null check (position >= 0),
  created_at  timestamptz not null default now(),
  primary key (post_id, media_id),
  constraint post_media_post_fk foreign key (post_id, owner_id) references posts (id, author_id) on delete cascade,
  -- NO ACTION (checked at statement end): deleting attached media fails, yet cascading a user's
  -- deletion (which removes posts and media together) still succeeds.
  constraint post_media_media_fk foreign key (media_id, owner_id) references media_assets (id, owner_id) on delete no action,
  constraint post_media_one_post_per_media unique (media_id),
  constraint post_media_position_key unique (post_id, position)
);

create table topics (
  id            uuid primary key default uuid_generate_v7(),
  slug          citext not null,
  created_at    timestamptz not null default now(),
  constraint topics_slug_key unique (slug),
  constraint topics_slug_len check (char_length(slug) between 1 and 50)
);
create index topics_slug_prefix_idx on topics (lower(slug::text) text_pattern_ops);

create table post_topics (
  post_id   uuid not null references posts(id) on delete cascade,
  topic_id  uuid not null references topics(id) on delete cascade,
  -- EXPLICIT: chosen by the author. CAPTION: derived from a #hashtag, so it follows caption edits.
  source    text not null check (source in ('EXPLICIT', 'CAPTION')),
  primary key (post_id, topic_id)
);
create index post_topics_topic_idx on post_topics (topic_id, post_id);

create table post_mentions (
  post_id  uuid not null references posts(id) on delete cascade,
  user_id  uuid not null references users(id) on delete cascade,
  primary key (post_id, user_id)
);
create index post_mentions_user_idx on post_mentions (user_id, post_id);

-- ---- creators & sponsorship --------------------------------------------------------------------
create table creator_profiles (
  user_id              uuid primary key references users(id) on delete cascade,
  category             creator_category not null,
  verification_status  verification_status not null default 'NONE',
  verified_at          timestamptz,
  verified_by          uuid references users(id) on delete set null,
  tagline              text check (tagline is null or char_length(tagline) <= 120),
  contact_email        citext check (contact_email is null or char_length(contact_email) <= 254),
  website_url          text check (website_url is null or (char_length(website_url) <= 300 and website_url ~* '^https://')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint creator_verified_pair check ((verification_status = 'VERIFIED') = (verified_at is not null))
);
create trigger creator_profiles_set_updated_at before update on creator_profiles for each row execute function set_updated_at();

create table brand_partnerships (
  id               uuid primary key default uuid_generate_v7(),
  creator_user_id  uuid not null references users(id) on delete cascade,
  brand_name       text not null check (char_length(brand_name) between 1 and 80),
  brand_url        text check (brand_url is null or (char_length(brand_url) <= 300 and brand_url ~* '^https://')),
  type             sponsorship_type not null,
  started_on       date,
  ended_on         date,
  created_at       timestamptz not null default now(),
  constraint brand_partnerships_dates check (started_on is null or ended_on is null or ended_on >= started_on),
  constraint brand_partnerships_id_creator_key unique (id, creator_user_id)
);
create index brand_partnerships_creator_idx on brand_partnerships (creator_user_id, created_at desc, id desc);

-- A row here is what makes a post "sponsored" at the data level. There is no way to publish
-- branded content without it, and the API always surfaces it (never hidden in free-text).
create table sponsorship_disclosures (
  post_id         uuid primary key references posts(id) on delete cascade,
  type            sponsorship_type not null,
  brand_name      text not null check (char_length(brand_name) between 1 and 80),
  partnership_id  uuid references brand_partnerships(id) on delete set null,
  created_at      timestamptz not null default now()
);
