-- 0001: extensions and shared database functions.

create extension if not exists citext;
create extension if not exists pg_trgm;
create extension if not exists pgcrypto;

-- Time-ordered UUIDv7 (48-bit unix ms + random). Keeps btree inserts append-mostly and makes
-- `order by id` approximate `order by created_at`. Application code generates the same shape.
create or replace function uuid_generate_v7() returns uuid
language sql volatile parallel safe as $$
  select encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          placing substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3)
          from 1 for 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid;
$$;

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
