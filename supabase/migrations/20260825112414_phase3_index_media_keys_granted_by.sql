-- Cover the last unindexed foreign key on media_keys.
--
-- `granted_by` is never queried directly by the app, but it is a foreign key to
-- profiles, and Postgres has to scan the child table to enforce the cascade
-- whenever a profile is deleted. Without an index that is a sequential scan of
-- every key grant in the database per deleted account.
--
-- media_id is already covered by the leading column of the (media_id,
-- recipient_id) unique index, and recipient_id has its own.

create index if not exists media_keys_granted_by_idx on public.media_keys (granted_by);
