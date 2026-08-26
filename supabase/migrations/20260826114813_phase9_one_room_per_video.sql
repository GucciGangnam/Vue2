-- ============================================================================
-- Phase 9 -- the video is the room
-- ============================================================================
--
-- Until now a room was a thing you created *alongside* a video, and nothing
-- stopped you creating several against the same one. That is why the library
-- showed `Episode 1` five times: five rooms, one video, and a user who never
-- asked to create any of them.
--
-- A room becomes derived from the media instead: exactly one per video, got or
-- created on demand. The anchor, `seq`, the guard trigger and the RLS are all
-- unchanged -- they were right, and none of them cared how many rooms a video
-- had. What changes is who decides that a room exists.
--
-- Three things happen here, in this order, because the constraint cannot be
-- added while the duplicates are still there:
--
--   1. collapse the existing duplicates, deliberately and by name
--   2. one room per media, enforced by a unique index
--   3. get_or_create_room(), so opening a video is idempotent under the
--      10-per-hour room-creation limit (D35)
--
-- ...and one removal: `require_hold` goes with the three-second hold (D39).

-- ============================================================================
-- 1. collapse the duplicates
-- ============================================================================
--
-- Five rooms exist, all owned by Grace, all on `Episode 1`
-- (a26b9606-75ed-4c98-b32d-029afc83e714). They are test data from Phases 5, 6
-- and 8. Which one survives is a decision, not something to leave to an
-- arbitrary ordering, so it is written out here:
--
--   358cfa1f-216c-490c-987b-0a479c304e4c  KEPT   live, seq 14, 18:52 in
--   cd855e59-0ef1-4ea5-9110-d620ae8df04e  gone   lobby, seq 0, never played
--   3bbc810c-bc00-4f4a-bd07-9dcdc691c102  gone   lobby, seq 0, never played
--   5b0b00f8-6f04-45b8-aa64-12263f702abd  gone   already ended
--   fae1913c-3546-45a8-ba6c-667ab19d77ef  gone   live, seq 2, Ada is a member
--
-- 358cfa1f is kept because it is the oldest, because it is the only one
-- carrying real playback history, and because the end-to-end suite deep-links
-- it. But fae1913c is the only room anybody was ever invited to, so its
-- membership is moved across first rather than deleted with it: Ada keeps her
-- seat, at the position `Episode 1` was actually watched to.
--
-- (Her *content key* is a separate matter and cannot be repaired from here --
-- wrapping it needs the owner's identity private key, which only ever exists
-- in the owner's browser. Re-inviting her grants it.)
--
-- On a database rebuilt from an empty project none of these ids exist, every
-- statement here matches zero rows, and that is the correct outcome.

insert into public.room_members (
  room_id, user_id, role, state, can_control, invited_at, joined_at
)
select
  '358cfa1f-216c-490c-987b-0a479c304e4c'::uuid,
  m.user_id,
  -- Never 'owner': the survivor already has one, and a second would make the
  -- roster lie about who the room belongs to.
  'viewer',
  m.state,
  m.can_control,
  m.invited_at,
  m.joined_at
from public.room_members m
where m.room_id in (
  'cd855e59-0ef1-4ea5-9110-d620ae8df04e'::uuid,
  '3bbc810c-bc00-4f4a-bd07-9dcdc691c102'::uuid,
  '5b0b00f8-6f04-45b8-aa64-12263f702abd'::uuid,
  'fae1913c-3546-45a8-ba6c-667ab19d77ef'::uuid
)
on conflict (room_id, user_id) do nothing;

-- room_members cascades from rooms, so the losing rosters go with them.
delete from public.rooms
where id in (
  'cd855e59-0ef1-4ea5-9110-d620ae8df04e'::uuid,
  '3bbc810c-bc00-4f4a-bd07-9dcdc691c102'::uuid,
  '5b0b00f8-6f04-45b8-aa64-12263f702abd'::uuid,
  'fae1913c-3546-45a8-ba6c-667ab19d77ef'::uuid
);

-- ============================================================================
-- 2. one room per video
-- ============================================================================
--
-- The constraint is what makes "click a video, land in its room" mean one
-- thing. A unique index rather than a table constraint so it can be created
-- idempotently, and because ON CONFLICT infers against it just as happily.
--
-- It also subsumes the non-unique rooms_media_idx from Phase 5.

create unique index if not exists rooms_media_unique on public.rooms (media_id);

comment on index public.rooms_media_unique is
  'One room per video. A video *is* a room, so a second room on the same media is not a thing a user can mean.';

drop index if exists public.rooms_media_idx;

-- ============================================================================
-- 3. get_or_create_room
-- ============================================================================
--
-- Opening a video must be idempotent. Room creation is limited to 10 per hour
-- per user (D35), so a screen that created lazily on every open would lock the
-- owner out of their own library by lunchtime -- and with the unique index above
-- it would simply fail instead.
--
-- SECURITY DEFINER because it reads `media` to find out who owns the video,
-- which is a row the caller may not be able to see. That makes it an RPC, so it
-- is caller-scoped in the sense D18 asks for: every branch resolves against
-- auth.uid(), and a caller with no business here learns nothing except that
-- they were refused. In particular it never reveals whether a room exists to
-- somebody who is not in it.
--
-- Who may call it:
--
--   * the owner of the video -- creates the room if there is none, revives it
--     if they had ended it, and otherwise just gets the id back
--   * a member of an existing room -- gets the id back, and nothing else
--   * anybody else -- refused
--
-- Note what is deliberately *not* here: a viewer cannot bring a room into
-- existence. rooms_insert_own would make the creator its owner, and a room on
-- somebody else's video owned by a viewer is a room the video's owner cannot
-- control. Starting the screening is the owner's act.

create or replace function public.get_or_create_room(p_media_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_media_owner uuid;
  v_room public.rooms;
  v_new_id uuid;
begin
  if v_caller is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select owner_id into v_media_owner from public.media where id = p_media_id;
  if not found then
    raise exception 'no such video' using errcode = '42704';
  end if;

  select * into v_room from public.rooms where media_id = p_media_id;

  if found then
    if v_room.owner_id = v_caller then
      -- Ending a screening is not deleting it: the room comes back where it
      -- was left. The anchor is untouched, so this needs no exemption from the
      -- playback guard -- status and ended_at are not playback columns.
      if v_room.status = 'ended' then
        update public.rooms
           set status = 'lobby', ended_at = null
         where id = v_room.id;
      end if;
      return v_room.id;
    end if;

    if exists (
      select 1 from public.room_members
      where room_id = v_room.id
        and user_id = v_caller
        and state in ('invited', 'joined')
    ) then
      return v_room.id;
    end if;

    raise exception 'you are not watching this with anyone' using errcode = '42501';
  end if;

  if v_media_owner <> v_caller then
    raise exception 'only the owner of a video can start watching it together'
      using errcode = '42501';
  end if;

  -- The same check rooms_insert_own makes, restated because SECURITY DEFINER
  -- means that policy is not consulted: you cannot host a screening of
  -- something you cannot decrypt.
  if not exists (
    select 1 from public.media_keys
    where media_id = p_media_id and recipient_id = v_caller
  ) then
    raise exception 'you have no key for this video' using errcode = '42501';
  end if;

  -- Racing callers: the loser's insert is skipped and it re-reads the winner's
  -- row. The rate-limit trigger fires before the conflict is detected, so a
  -- lost race still spends one of the ten, which is the right way round for a
  -- limiter to be wrong.
  insert into public.rooms (media_id, owner_id)
  values (p_media_id, v_caller)
  on conflict (media_id) do nothing
  returning id into v_new_id;

  if v_new_id is null then
    select id into v_new_id from public.rooms where media_id = p_media_id;
  end if;

  return v_new_id;
end;
$$;

comment on function public.get_or_create_room(uuid) is
  'The room for a video, created on first use by its owner. Idempotent, because room creation is rate limited and a video has exactly one room.';

revoke execute on function public.get_or_create_room(uuid) from public;
grant execute on function public.get_or_create_room(uuid) to authenticated;

-- ============================================================================
-- 4. the three-second hold is retired (D39)
-- ============================================================================
--
-- Phase 6 existed because a stray thumb pausing a film is a cost paid by
-- everyone watching. That protection survives; only the mechanism goes. The
-- replacement is an invariant in the player rather than a column here:
--
--     a tap on the video reveals the controls, and never toggles playback.
--
-- Play/pause is a button you have to hit, so an accidental tap now costs a
-- control strip appearing and nothing else. A column that says "require a
-- hold" while no interface offers one is worse than no column, so it goes
-- rather than being defaulted to false.

alter table public.rooms drop column if exists require_hold;
