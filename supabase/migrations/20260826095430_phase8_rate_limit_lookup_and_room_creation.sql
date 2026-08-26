-- ============================================================================
-- Phase 8 -- rate limiting on friend-code lookup and room creation
-- ============================================================================
--
-- Two surfaces are cheap to call and expensive to leave open:
--
--   * find_profile_by_code is the only way to resolve a friend code, and it
--     exists so public.profiles can stay non-enumerable (D12). An unlimited
--     lookup turns it back into an enumeration oracle -- 8 Crockford base32
--     characters is a large space, but "large" is not a rate limit.
--   * Room creation writes a row and fires a trigger that writes another. A
--     loop costs the caller nothing and fills the table.
--
-- Counting lives in a table no client can touch. Note the deliberate absence
-- of GRANTs: D14 says every table a client uses needs them, and the corollary
-- is that a table clients must NOT use gets none. RLS is enabled with zero
-- policies as a second lock, so even a future accidental grant still denies.
-- Everything that reads or writes this table is SECURITY DEFINER and owned by
-- the migration role, which bypasses both.

create table if not exists public.rate_limits (
  user_id uuid not null references auth.users (id) on delete cascade,
  action text not null,
  -- Floored to the window size, so a given call maps to exactly one row and
  -- the counter needs no scan.
  window_start timestamptz not null,
  attempts integer not null default 0,
  primary key (user_id, action, window_start)
);

alter table public.rate_limits enable row level security;

comment on table public.rate_limits is
  'Fixed-window call counters. No GRANTs and no policies on purpose: only '
  'SECURITY DEFINER functions read or write it.';

-- ============================================================================
-- the limiter
-- ============================================================================
--
-- Fixed windows rather than sliding: one row per user per action, no history
-- to scan, and the imprecision at a window boundary does not matter for a
-- limit whose job is to stop a loop rather than to meter billing.
--
-- Not granted to anyone. It is called from other SECURITY DEFINER functions
-- and from a trigger, never over REST -- which is also why it does not need
-- the caller-scoping argument treatment from D18: it is not reachable as an
-- RPC at all.

create or replace function public.consume_rate_limit(
  p_action text,
  p_limit integer,
  p_window interval
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_window_seconds double precision := extract(epoch from p_window);
  v_window_start timestamptz;
  v_attempts integer;
begin
  if v_caller is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  v_window_start := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / v_window_seconds) * v_window_seconds
  );

  -- Keeps the table at one row per user per action rather than accumulating
  -- one per window forever. Deterministic and bounded, so it needs no cron.
  delete from public.rate_limits
  where user_id = v_caller
    and action = p_action
    and window_start < v_window_start;

  insert into public.rate_limits (user_id, action, window_start, attempts)
  values (v_caller, p_action, v_window_start, 1)
  on conflict (user_id, action, window_start)
    do update set attempts = public.rate_limits.attempts + 1
  returning attempts into v_attempts;

  -- Raising rolls the increment back with the rest of the statement, which is
  -- the behaviour we want: a blocked caller stays pinned at the limit for the
  -- remainder of the window instead of climbing away from it.
  if v_attempts > p_limit then
    raise exception 'Too many attempts. Wait a moment and try again.'
      using errcode = 'P0001';
  end if;
end;
$$;

revoke execute on function public.consume_rate_limit(text, integer, interval) from public;

-- ============================================================================
-- friend-code lookup
-- ============================================================================
--
-- Replaced rather than edited in place -- the Phase 1 migration is pushed and
-- stays as it was. Two changes: the limiter call, and VOLATILE.
--
-- VOLATILE is not cosmetic. The function was STABLE, and a non-volatile
-- function may not write, so the limiter's INSERT would fail at runtime with
-- every lookup. Nothing depends on it being STABLE: it is called as an RPC,
-- not from inside a query plan or an RLS policy.
--
-- 30 lookups per 10 minutes: far more than anyone adding friends by hand will
-- use, and far too few to walk the code space with.

create or replace function public.find_profile_by_code(p_code text)
returns table (
  id uuid,
  display_name text,
  avatar_hue smallint,
  friend_code text,
  public_key bytea
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_code text;
  v_caller uuid := (select auth.uid());
begin
  if v_caller is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  perform public.consume_rate_limit('friend_code_lookup', 30, interval '10 minutes');

  v_code := upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g'));
  -- Crockford: these are transcription errors, not distinct symbols.
  v_code := translate(v_code, 'ILO', '110');

  if v_code !~ '^[0-9A-HJKMNP-TV-Z]{8}$' then
    return;
  end if;

  return query
    select p.id, p.display_name, p.avatar_hue, p.friend_code, k.public_key
    from public.profiles p
    left join public.user_public_keys k on k.user_id = p.id
    where p.friend_code = v_code
      and p.id <> v_caller;
end;
$$;

revoke execute on function public.find_profile_by_code(text) from public;
grant execute on function public.find_profile_by_code(text) to authenticated;

comment on function public.find_profile_by_code(text) is
  'Resolves a friend code without making public.profiles enumerable. Rate '
  'limited to 30 lookups per 10 minutes per caller.';

-- ============================================================================
-- room creation
-- ============================================================================
--
-- A BEFORE INSERT trigger rather than a check inside a creation RPC, because
-- rooms are created by a plain insert through RLS and there is no RPC to put
-- it in. The trigger fires before rooms_add_owner_member, so a refused
-- creation writes neither row.
--
-- 10 rooms per hour. A person hosting a film night creates one.

create or replace function public.rooms_rate_limit()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.consume_rate_limit('room_create', 10, interval '1 hour');
  return new;
end;
$$;

revoke execute on function public.rooms_rate_limit() from public;

drop trigger if exists rooms_rate_limit on public.rooms;
create trigger rooms_rate_limit
  before insert on public.rooms
  for each row execute function public.rooms_rate_limit();
