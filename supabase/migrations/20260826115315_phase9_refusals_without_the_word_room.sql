-- ============================================================================
-- Phase 9 -- refusals that do not say "room"
-- ============================================================================
--
-- The interface no longer has rooms in it: a video *is* the thing you watch
-- together, and the word never appears on screen. These four messages were the
-- exception, because set_playback_state's refusals are shown to the user
-- verbatim -- a viewer who has been removed and presses play reads the raise
-- text, not something the client wrote.
--
-- Nothing else changes. The function is replaced rather than edited because the
-- Phase 5 migration is pushed and stays as it was (D11); the body below is that
-- one, character for character, with four strings reworded:
--
--   'no such room'                        -> 'no such video'
--   'this room has ended'                 -> 'nobody is watching this together any more'
--   'you are not in this room'            -> 'you are not watching this with anyone'
--   'only the owner can control this room'-> 'only the owner can control this video'
--
-- The last two match the wording get_or_create_room already uses, so a viewer
-- who is refused gets the same sentence whichever call refuses them.

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
    raise exception 'no such video' using errcode = '42704';
  end if;
  if v_room.status = 'ended' then
    raise exception 'nobody is watching this together any more' using errcode = '42501';
  end if;

  select * into v_member
  from public.room_members
  where room_id = p_room_id and user_id = v_caller;

  if not found or v_member.state <> 'joined' then
    raise exception 'you are not watching this with anyone' using errcode = '42501';
  end if;

  -- D2: anyone joined may control, unless the owner has locked the room.
  if v_room.control_mode = 'owner_only'
     and v_member.role <> 'owner'
     and not v_member.can_control then
    raise exception 'only the owner can control this video' using errcode = '42501';
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
