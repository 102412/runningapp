-- 0010: engagement — reactions, comments, bookmarks, shares, with trigger-maintained counters.
-- Counters change via relative SQL increments inside the same transaction as the row change, so
-- they are atomic under concurrency (no read-modify-write in app code) and impossible to forget.

create type reaction_type as enum ('LIKE', 'CLAP', 'FIRE', 'STRONG');
create type share_channel as enum ('COPY_LINK', 'SYSTEM_SHARE', 'EXTERNAL_APP');

create table post_reactions (
  post_id     uuid not null references posts(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  reaction    reaction_type not null default 'LIKE',
  created_at  timestamptz not null default now(),
  -- One reaction per user per post: a duplicate request cannot double-count.
  primary key (post_id, user_id)
);
create index post_reactions_post_idx on post_reactions (post_id, created_at desc, user_id);
create index post_reactions_user_idx on post_reactions (user_id, created_at desc);

create table comments (
  id                 uuid primary key default uuid_generate_v7(),
  post_id            uuid not null references posts(id) on delete cascade,
  author_id          uuid not null references users(id) on delete cascade,
  -- Two-level threads: replies always point at a TOP-LEVEL comment (enforced by trigger).
  parent_id          uuid,
  reply_to_user_id   uuid references users(id) on delete set null,
  body               text not null,
  moderation_status  moderation_status not null default 'CLEAN',
  deleted_at         timestamptz,
  reply_count        integer not null default 0 check (reply_count >= 0),
  reaction_count     integer not null default 0 check (reaction_count >= 0),
  created_at         timestamptz not null default now(),
  constraint comments_body_len check (char_length(body) between 1 and 1000),
  constraint comments_id_post_key unique (id, post_id),
  constraint comments_parent_fk foreign key (parent_id, post_id) references comments (id, post_id) on delete cascade
);
create index comments_post_top_idx on comments (post_id, id) where parent_id is null;
create index comments_parent_idx on comments (parent_id, id) where parent_id is not null;
create index comments_author_idx on comments (author_id, created_at desc);

create function comments_enforce_two_levels() returns trigger language plpgsql as $$
begin
  if new.parent_id is not null and exists (select 1 from comments where id = new.parent_id and parent_id is not null) then
    raise exception 'replies must target a top-level comment' using errcode = 'P0001', constraint = 'comments_two_levels';
  end if;
  return new;
end $$;
create trigger comments_two_levels before insert on comments for each row execute function comments_enforce_two_levels();

create table comment_reactions (
  comment_id  uuid not null references comments(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (comment_id, user_id)
);
create index comment_reactions_user_idx on comment_reactions (user_id, created_at desc);

create table comment_mentions (
  comment_id  uuid not null references comments(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  primary key (comment_id, user_id)
);

create table bookmarks (
  user_id     uuid not null references users(id) on delete cascade,
  post_id     uuid not null references posts(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, post_id)
);
create index bookmarks_user_idx on bookmarks (user_id, created_at desc, post_id);

-- Share events ("reference events"): each share is a fact worth recording; repeats are allowed.
create table shares (
  id          uuid primary key default uuid_generate_v7(),
  post_id     uuid not null references posts(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  channel     share_channel not null,
  created_at  timestamptz not null default now()
);
create index shares_post_idx on shares (post_id, created_at desc);
create index shares_user_idx on shares (user_id, created_at desc);

-- ---- counters ----------------------------------------------------------------------------------
create function counted_post(p_status post_status, p_deleted timestamptz, p_mod moderation_status) returns boolean
language sql immutable as $$ select p_status = 'PUBLISHED' and p_deleted is null and p_mod = 'CLEAN' $$;

-- profiles.post_count = published, not deleted, not moderated away.
create function posts_maintain_profile_count() returns trigger language plpgsql as $$
declare was boolean := false; is_now boolean := false;
begin
  if tg_op in ('UPDATE', 'DELETE') then was := counted_post(old.status, old.deleted_at, old.moderation_status); end if;
  if tg_op in ('INSERT', 'UPDATE') then is_now := counted_post(new.status, new.deleted_at, new.moderation_status); end if;
  if is_now and not was then
    update profiles set post_count = post_count + 1 where user_id = coalesce(new.author_id, old.author_id);
  elsif was and not is_now then
    update profiles set post_count = post_count - 1 where user_id = coalesce(old.author_id, new.author_id);
  end if;
  return null;
end $$;
create trigger posts_profile_count after insert or update of status, deleted_at, moderation_status or delete on posts
  for each row execute function posts_maintain_profile_count();

create function reactions_maintain_counts() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then update posts set reaction_count = reaction_count + 1 where id = new.post_id;
  else update posts set reaction_count = reaction_count - 1 where id = old.post_id; end if;
  return null;
end $$;
create trigger post_reactions_counts after insert or delete on post_reactions
  for each row execute function reactions_maintain_counts();

create function comment_reactions_maintain_counts() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then update comments set reaction_count = reaction_count + 1 where id = new.comment_id;
  else update comments set reaction_count = reaction_count - 1 where id = old.comment_id; end if;
  return null;
end $$;
create trigger comment_reactions_counts after insert or delete on comment_reactions
  for each row execute function comment_reactions_maintain_counts();

create function bookmarks_maintain_counts() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then update posts set bookmark_count = bookmark_count + 1 where id = new.post_id;
  else update posts set bookmark_count = bookmark_count - 1 where id = old.post_id; end if;
  return null;
end $$;
create trigger bookmarks_counts after insert or delete on bookmarks
  for each row execute function bookmarks_maintain_counts();

create function shares_maintain_counts() returns trigger language plpgsql as $$
begin
  update posts set share_count = share_count + 1 where id = new.post_id;
  return null;
end $$;
create trigger shares_counts after insert on shares for each row execute function shares_maintain_counts();

-- posts.comment_count counts every visible comment (top-level and replies); comments.reply_count
-- counts visible replies. "Visible" = not soft-deleted and not moderated away.
create function counted_comment(p_deleted timestamptz, p_mod moderation_status) returns boolean
language sql immutable as $$ select p_deleted is null and p_mod = 'CLEAN' $$;

create function comments_maintain_counts() returns trigger language plpgsql as $$
declare was boolean := false; is_now boolean := false; delta integer := 0;
begin
  if tg_op in ('UPDATE', 'DELETE') then was := counted_comment(old.deleted_at, old.moderation_status); end if;
  if tg_op in ('INSERT', 'UPDATE') then is_now := counted_comment(new.deleted_at, new.moderation_status); end if;
  if is_now and not was then delta := 1; elsif was and not is_now then delta := -1; end if;
  if delta <> 0 then
    update posts set comment_count = comment_count + delta where id = coalesce(new.post_id, old.post_id);
    if coalesce(new.parent_id, old.parent_id) is not null then
      update comments set reply_count = reply_count + delta where id = coalesce(new.parent_id, old.parent_id);
    end if;
  end if;
  return null;
end $$;
create trigger comments_counts after insert or update of deleted_at, moderation_status or delete on comments
  for each row execute function comments_maintain_counts();

-- ---- late foreign keys for notifications --------------------------------------------------------
alter table notifications
  add constraint notifications_post_fk foreign key (post_id) references posts(id) on delete cascade,
  add constraint notifications_comment_fk foreign key (comment_id) references comments(id) on delete cascade;
