-- Close the broadcast channel to non-members.
--
-- Realtime broadcast channels are public by default: they are pub/sub over a
-- topic string, with no relation to the row policies that protect `rooms`. This
-- was verified rather than assumed -- a signed-in user who could `select` zero
-- rows for a room id still subscribed to `room:{id}` and received playback
-- intents, complete with the acting user's id. Room ids are unguessable UUIDs,
-- so this is not a hole anyone can walk into, but "who is watching what, and
-- when" is exactly the metadata this project exists to not leak, and Phase 7
-- will put ink strokes on the sibling `room:{id}:ink` topic.
--
-- Supabase gates private channels on RLS over `realtime.messages`. The table
-- already has RLS enabled and, until now, no policies at all -- which denies
-- everything, and is why the client must also opt in with
-- `{ config: { private: true } }`. Both halves are required: policies without
-- the client flag protect nothing, and the flag without policies blocks
-- everyone.

create or replace function public.can_use_room_channel(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_room uuid;
begin
  -- Topics are `room:{uuid}` and `room:{uuid}:ink`; anything else is not ours.
  if p_topic is null or left(p_topic, 5) <> 'room:' then
    return false;
  end if;

  begin
    v_room := split_part(p_topic, ':', 2)::uuid;
  exception when others then
    return false;
  end;

  -- Same membership test the table policies use, so the fast path can never be
  -- more permissive than the authoritative one.
  return public.in_room(v_room) or public.owns_room(v_room);
end;
$$;

comment on function public.can_use_room_channel(text) is
  'Membership test for realtime topics belonging to a room. Caller-scoped; used by the realtime.messages policies that make room channels private.';

revoke execute on function public.can_use_room_channel(text) from public;
grant execute on function public.can_use_room_channel(text) to authenticated;

drop policy if exists "room_channel_receive" on realtime.messages;
drop policy if exists "room_channel_send" on realtime.messages;

create policy "room_channel_receive"
  on realtime.messages for select to authenticated
  using (public.can_use_room_channel(realtime.topic()));

create policy "room_channel_send"
  on realtime.messages for insert to authenticated
  with check (public.can_use_room_channel(realtime.topic()));
