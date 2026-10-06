-- 0004: social graph — follows, follow requests, blocks, with invariants enforced in the DB.

create table follows (
  follower_id  uuid not null references users(id) on delete cascade,
  followee_id  uuid not null references users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (follower_id, followee_id),
  constraint follows_no_self check (follower_id <> followee_id)
);
create index follows_followee_idx on follows (followee_id, created_at desc, follower_id);
create index follows_follower_idx on follows (follower_id, created_at desc, followee_id);

create table follow_requests (
  id            uuid primary key default uuid_generate_v7(),
  requester_id  uuid not null references users(id) on delete cascade,
  target_id     uuid not null references users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  constraint follow_requests_no_self check (requester_id <> target_id),
  constraint follow_requests_pair_key unique (requester_id, target_id)
);
create index follow_requests_target_idx on follow_requests (target_id, created_at desc, id);

create table blocks (
  blocker_id  uuid not null references users(id) on delete cascade,
  blocked_id  uuid not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_no_self check (blocker_id <> blocked_id)
);
create index blocks_blocked_idx on blocks (blocked_id, blocker_id);
create index blocks_blocker_idx on blocks (blocker_id, created_at desc, blocked_id);

-- ---- block invariants ---------------------------------------------------------------------
-- 1. Creating a block severs every relationship between the pair, in both directions.
create function blocks_sever_relationships() returns trigger language plpgsql as $$
begin
  delete from follows
   where (follower_id = new.blocker_id and followee_id = new.blocked_id)
      or (follower_id = new.blocked_id and followee_id = new.blocker_id);
  delete from follow_requests
   where (requester_id = new.blocker_id and target_id = new.blocked_id)
      or (requester_id = new.blocked_id and target_id = new.blocker_id);
  return new;
end $$;
create trigger blocks_after_insert after insert on blocks
  for each row execute function blocks_sever_relationships();

-- 2. Safety net: no follow or follow request may be created across an existing block.
create function reject_relationship_across_block() returns trigger language plpgsql as $$
declare a uuid; b uuid;
begin
  if tg_table_name = 'follows' then a := new.follower_id; b := new.followee_id;
  else a := new.requester_id; b := new.target_id; end if;
  if exists (
    select 1 from blocks
     where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a)
  ) then
    raise exception 'relationship blocked' using errcode = 'P0001', constraint = 'blocked_pair';
  end if;
  return new;
end $$;
create trigger follows_reject_blocked before insert on follows
  for each row execute function reject_relationship_across_block();
create trigger follow_requests_reject_blocked before insert on follow_requests
  for each row execute function reject_relationship_across_block();

-- ---- counters -----------------------------------------------------------------------------
-- Relative SQL increments inside the same transaction as the row change: atomic under
-- concurrency (no read-modify-write in application code) and impossible to forget.
create function follows_maintain_counts() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    update profiles set following_count = following_count + 1 where user_id = new.follower_id;
    update profiles set follower_count = follower_count + 1 where user_id = new.followee_id;
  else
    update profiles set following_count = following_count - 1 where user_id = old.follower_id;
    update profiles set follower_count = follower_count - 1 where user_id = old.followee_id;
  end if;
  return null;
end $$;
create trigger follows_counts_ins after insert on follows for each row execute function follows_maintain_counts();
create trigger follows_counts_del after delete on follows for each row execute function follows_maintain_counts();
