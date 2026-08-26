-- Phase 6: the locked player.
--
-- A room is watched on a phone held in someone's hand, and an accidental brush
-- of the screen must not pause the film for everybody else. So a locked room
-- answers taps with nothing at all, and the transport controls appear only
-- after a deliberate three-second hold.
--
-- This column is the owner's switch for that behaviour, per room. It defaults
-- to on: the failure it prevents is silent, shared and instant, while the cost
-- of having it on is one deliberate gesture by the person who meant it.
--
-- No new table, so no new GRANTs (D14) -- `rooms` already grants update to
-- `authenticated`, and `rooms_update_owner` already narrows that to the owner.
-- The playback guard trigger pins the anchor columns and is unaffected: this is
-- a policy about the interface, not part of the playback state.

alter table public.rooms
  add column if not exists require_hold boolean not null default true;

comment on column public.rooms.require_hold is
  'When true, a viewer must hold the video for three seconds before the transport controls respond. Set by the room owner; it protects everyone in the room from an accidental tap on one person''s phone.';
