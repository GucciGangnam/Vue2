-- Phase 5: rooms and synchronised playback.
--
-- Two channels solve two different problems (see docs/ARCHITECTURE.md):
--
--   Authority -- the `rooms` row is the truth. It stores playback as an anchor
--   rather than a position: `position_ms` *at* `anchor_server_time`. A client
--   that joins an hour late computes where everyone is from those two numbers
--   and lands in step, which a bare "current position" column could never do.
--
--   Speed -- a Realtime broadcast carries the same event immediately so a tap
--   feels instant. `seq` is what lets the fast path and the slow path disagree
--   safely: it is assigned here, monotonically, and a client ignores anything
--   older than what it has already applied.
--
-- Playback columns are writable *only* through `set_playback_state`. That is
-- enforced by a trigger, not by convention: if any client could write
-- `anchor_server_time` directly it could also write a time that never happened,
-- and every other viewer would obediently seek to it.
--
-- GRANTs ship beside the policies (D14); policy helpers are caller-scoped (D18).

-- ============================================================================
-- rooms
-- ============================================================================

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  media_id uuid not null references public.media (id) on delete cascade,
  status text not null default 'lobby'
    check (status in ('lobby', 'live', 'ended')),
  control_mode text not null default 'open'
    check (control_mode in ('open', 'owner_only')),

  -- The playback anchor. Never written except by set_playback_state().
  is_playing boolean not null default false,
  position_ms integer not null default 0 check (position_ms >= 0),
  anchor_server_time timestamptz not null default now(),
  seq bigint not null default 0,
  last_actor_id uuid references public.profiles (id) on delete set null,

  created_at timestamptz not null default now(),
  ended_at timestamptz
);

comment on table public.rooms is
  'A watch-together session. Playback is stored as an anchor (position at a server instant), so a late joiner can compute the current position exactly.';
comment on column public.rooms.seq is
  'Monotonic, assigned only by set_playback_state(). Resolves conflicts between the broadcast fast path and the database slow path.';
comment on column public.rooms.anchor_server_time is
  'Server clock, never client clock. A client-supplied time here would let one viewer make everyone else seek anywhere.';

create index if not exists rooms_owner_idx on public.rooms (owner_id, created_at desc);
create index if not exists rooms_media_idx on public.rooms (media_id);

alter table public.rooms enable row level security;

-- ============================================================================
-- room_members
-- ============================================================================

create table if not exists public.room_members (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null default 'viewer' check (role in ('owner', 'viewer')),
  state text not null default 'invited'
    check (state in ('invited', 'joined', 'left', 'kicked')),
  can_control boolean not null default false,
  invited_at timestamptz not null default now(),
  joined_at timestamptz,
  primary key (room_id, user_id)
);

comment on table public.room_members is
  'Who is in a room and what they may do. `can_control` only matters when the room is in owner_only mode.';

create index if not exists room_members_user_idx on public.room_members (user_id);

alter table public.room_members enable row level security;

-- A kick has to reach the kicked client, and a DELETE event only carries enough
-- of the old row for RLS to be evaluated under REPLICA IDENTITY FULL.
alter table public.room_members replica identity full;

-- ============================================================================
-- helpers
-- ============================================================================

-- Caller-scoped (D18), and SECURITY DEFINER so the two tables' policies do not
-- recurse into each other: `rooms` asks about membership and `room_members`
-- asks about ownership.

create or replace function public.owns_room(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.rooms
    where id = p_room_id and owner_id = (select auth.uid())
  );
$$;

comment on function public.owns_room(uuid) is
  'True when the calling user owns p_room_id. Caller-scoped on purpose.';

revoke execute on function public.owns_room(uuid) from public;
grant execute on function public.owns_room(uuid) to authenticated;

-- Being invited is enough to see the room; you have to accept to watch it.
create or replace function public.in_room(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.room_members
    where room_id = p_room_id
      and user_id = (select auth.uid())
      and state in ('invited', 'joined')
  );
$$;

comment on function public.in_room(uuid) is
  'True when the caller is invited to or joined in p_room_id. Excludes left and kicked.';

revoke execute on function public.in_room(uuid) from public;
grant execute on function public.in_room(uuid) to authenticated;

-- ============================================================================
-- the playback guard
-- ============================================================================

-- set_playback_state() raises this flag for the duration of its transaction.
-- Anything else writing a playback column is rejected outright rather than
-- silently ignored: a client that thinks it moved playback and did not would be
-- far harder to debug than one that got an error.
create or replace function public.rooms_guard_playback()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.id := old.id;
  new.owner_id := old.owner_id;
  new.media_id := old.media_id;
  new.created_at := old.created_at;

  if coalesce(current_setting('vue2.playback_write', true), '') <> 'on' then
    if new.is_playing is distinct from old.is_playing
      or new.position_ms is distinct from old.position_ms
      or new.anchor_server_time is distinct from old.anchor_server_time
      or new.seq is distinct from old.seq
      or new.last_actor_id is distinct from old.last_actor_id
    then
      raise exception 'Playback state is only writable through set_playback_state()'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.rooms_guard_playback() from public;

drop trigger if exists rooms_guard_playback on public.rooms;
create trigger rooms_guard_playback
  before update on public.rooms
  for each row execute function public.rooms_guard_playback();

-- The owner is a member of their own room from the moment it exists, so the
-- roster and the permission checks have no special case for them.
create or replace function public.rooms_add_owner_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.room_members (room_id, user_id, role, state, can_control, joined_at)
  values (new.id, new.owner_id, 'owner', 'joined', true, now())
  on conflict (room_id, user_id) do nothing;
  return null;
end;
$$;

revoke execute on function public.rooms_add_owner_member() from public;

drop trigger if exists rooms_add_owner_member on public.rooms;
create trigger rooms_add_owner_member
  after insert on public.rooms
  for each row execute function public.rooms_add_owner_member();

-- ============================================================================
-- clock
-- ============================================================================

-- The NTP-style handshake calls this five times and keeps the lowest-RTT
-- sample. clock_timestamp() rather than now(), which would return the
-- transaction start and quietly fold queue time into the offset.
create or replace function public.server_now()
returns timestamptz
language sql
volatile
security definer
set search_path = ''
as $$
  select clock_timestamp();
$$;

comment on function public.server_now() is
  'Current server instant for clock-offset sampling. VOLATILE on purpose: a STABLE wrapper around clock_timestamp() may be folded to the statement start, which is exactly the error being measured.';

revoke execute on function public.server_now() from public;
grant execute on function public.server_now() to authenticated;

-- ============================================================================
-- set_playback_state
-- ============================================================================

-- The only way playback moves. Checks membership and control mode, stamps the
-- server clock, bumps seq, and hands back the new state together with the
-- server's current time so the caller can reconcile without a second round trip.
create or replace function public.set_playback_state(
  p_room_id uuid,
  p_action text,
  p_position_ms integer
)
returns table (
  seq bigint,
  is_playing boolean,
  position_ms integer,
  anchor_server_time timestamptz,
  last_actor_id uuid,
  server_time timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_room public.rooms;
  v_member public.room_members;
begin
  if v_caller is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_action not in ('play', 'pause', 'seek') then
    raise exception 'unknown action %', p_action using errcode = '22023';
  end if;
  if p_position_ms is null or p_position_ms < 0 then
    raise exception 'position must be a non-negative number of milliseconds'
      using errcode = '22023';
  end if;

  select * into v_room from public.rooms where id = p_room_id;
  if not found then
    raise exception 'no such room' using errcode = '42704';
  end if;
  if v_room.status = 'ended' then
    raise exception 'this room has ended' using errcode = '42501';
  end if;

  select * into v_member
  from public.room_members
  where room_id = p_room_id and user_id = v_caller;

  if not found or v_member.state <> 'joined' then
    raise exception 'you are not in this room' using errcode = '42501';
  end if;

  -- D2: anyone joined may control, unless the owner has locked the room.
  if v_room.control_mode = 'owner_only'
     and v_member.role <> 'owner'
     and not v_member.can_control then
    raise exception 'only the owner can control this room' using errcode = '42501';
  end if;

  perform set_config('vue2.playback_write', 'on', true);

  update public.rooms r
     set is_playing = (p_action = 'play'),
         position_ms = p_position_ms,
         -- clock_timestamp(), not now(): the anchor must be the instant the row
         -- actually changed, not when the transaction opened.
         anchor_server_time = clock_timestamp(),
         seq = r.seq + 1,
         last_actor_id = v_caller,
         status = case when r.status = 'lobby' then 'live' else r.status end
   where r.id = p_room_id
   returning r.seq, r.is_playing, r.position_ms, r.anchor_server_time, r.last_actor_id
   into seq, is_playing, position_ms, anchor_server_time, last_actor_id;

  server_time := clock_timestamp();
  return next;
end;
$$;

comment on function public.set_playback_state(uuid, text, integer) is
  'The only writer of room playback state. Assigns seq and the server anchor; returns both plus the server clock so a caller can reconcile in one round trip.';

revoke execute on function public.set_playback_state(uuid, text, integer) from public;
grant execute on function public.set_playback_state(uuid, text, integer) to authenticated;

-- ============================================================================
-- policies
-- ============================================================================

create policy "rooms_select_involved"
  on public.rooms for select to authenticated
  using (
    owner_id = (select auth.uid())
    or public.in_room(id)
  );

-- You cannot host a screening of something you cannot decrypt. Checking the key
-- grant here means a room can never exist that its own owner cannot watch.
create policy "rooms_insert_own"
  on public.rooms for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and public.has_media_key(media_id)
  );

-- Playback columns are excluded by the guard trigger, not by this policy: an
-- owner may edit control_mode and status through here, and nothing else.
create policy "rooms_update_owner"
  on public.rooms for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy "rooms_delete_owner"
  on public.rooms for delete to authenticated
  using (owner_id = (select auth.uid()));

create policy "room_members_select_involved"
  on public.room_members for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.owns_room(room_id)
    or public.in_room(room_id)
  );

-- Only the owner invites. A viewer cannot add themselves, or anyone else.
create policy "room_members_insert_by_owner"
  on public.room_members for insert to authenticated
  with check (public.owns_room(room_id));

-- Two writers with different reach: the owner manages anybody's membership,
-- and a member may move their own state (accept an invitation, leave).
create policy "room_members_update_owner_or_self"
  on public.room_members for update to authenticated
  using (
    public.owns_room(room_id)
    or user_id = (select auth.uid())
  )
  with check (
    public.owns_room(room_id)
    or user_id = (select auth.uid())
  );

create policy "room_members_delete_by_owner"
  on public.room_members for delete to authenticated
  using (public.owns_room(room_id));

-- ============================================================================
-- membership guard
-- ============================================================================

-- The self-update policy above cannot express "but not your own role" in a
-- WITH CHECK, because it has no access to the old row. Without this a viewer
-- could promote themselves to owner, or un-kick themselves.
create or replace function public.room_members_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
begin
  new.room_id := old.room_id;
  new.user_id := old.user_id;
  new.invited_at := old.invited_at;

  if not public.owns_room(new.room_id) then
    -- A member may only move their own state, and only between the states that
    -- are theirs to choose. Being kicked is not one of them.
    new.role := old.role;
    new.can_control := old.can_control;

    if old.state = 'kicked' then
      raise exception 'you have been removed from this room' using errcode = '42501';
    end if;
    if new.state not in ('invited', 'joined', 'left') then
      raise exception 'you cannot set your membership to %', new.state
        using errcode = '42501';
    end if;
  end if;

  if new.state = 'joined' and old.state <> 'joined' then
    new.joined_at := now();
  end if;

  return new;
end;
$$;

revoke execute on function public.room_members_guard() from public;

drop trigger if exists room_members_guard on public.room_members;
create trigger room_members_guard
  before update on public.room_members
  for each row execute function public.room_members_guard();

-- ============================================================================
-- grants
-- ============================================================================

grant select, insert, update, delete on public.rooms to authenticated;
grant select, insert, update, delete on public.room_members to authenticated;

-- `anon` gets nothing.

-- ============================================================================
-- realtime
-- ============================================================================

-- Postgres changes carry the authoritative state; the broadcast channel
-- `room:{id}` carries the same events faster and is ephemeral.
alter publication supabase_realtime add table public.rooms;
alter publication supabase_realtime add table public.room_members;
