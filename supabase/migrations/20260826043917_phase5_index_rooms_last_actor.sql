-- Cover the last unindexed foreign key on rooms.
--
-- `last_actor_id` is only ever read as part of the room row, never queried on
-- its own, but it is a foreign key to profiles: deleting an account makes
-- Postgres scan every room to enforce the ON DELETE SET NULL. Same reasoning as
-- media_keys_granted_by_idx in Phase 3.

create index if not exists rooms_last_actor_idx on public.rooms (last_actor_id);
