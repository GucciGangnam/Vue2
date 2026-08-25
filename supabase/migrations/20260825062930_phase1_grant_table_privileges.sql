-- Grant the DML privileges the RLS policies are written against.
--
-- RLS narrows access; it never widens it. Postgres checks table GRANTs *first*,
-- so a table with perfect policies and no grant is simply unreadable -- which is
-- what these three tables were. This project's default privileges do not extend
-- select/insert/update to anon or authenticated, so each table needs it stated.
--
-- Grants here are the widest a policy could ever allow; the policies then narrow
-- them to the caller's own rows. Anything not granted is not reachable at all:
--   profiles           -- no insert (signup trigger only), no delete (cascades)
--   user_public_keys   -- no update/delete: rotating a key orphans every grant
--   user_private_keys  -- no delete: losing this row loses the account's media

grant select, update on public.profiles to authenticated;
grant select, insert on public.user_public_keys to authenticated;
grant select, insert, update on public.user_private_keys to authenticated;

-- `anon` gets nothing: every one of these tables is per-user private, and the
-- only pre-auth entry point is Supabase Auth itself.
