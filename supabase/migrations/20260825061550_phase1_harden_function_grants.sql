-- Trigger functions must not be reachable over PostgREST.
--
-- Postgres grants EXECUTE to PUBLIC on new functions by default. `handle_new_user`
-- is SECURITY DEFINER and inserts into public.profiles, so leaving that default in
-- place exposes /rest/v1/rpc/handle_new_user to anon. Revoking EXECUTE does not
-- affect trigger firing: privilege is checked when the trigger is created, not
-- each time it fires, and the function still runs as its owner.

revoke execute on function public.handle_new_user() from public;
revoke execute on function public.profiles_protect_immutable() from public;
revoke execute on function public.touch_updated_at() from public;

-- find_profile_by_code stays callable by `authenticated` on purpose: it is the
-- only supported way to resolve a friend code, and it exists precisely so that
-- public.profiles can stay non-enumerable. The security advisor flags it; that
-- is expected and accepted. See docs/DECISIONS.md D12.
comment on function public.find_profile_by_code(text) is
  'Intentionally SECURITY DEFINER and executable by authenticated users. Resolves a friend code without making public.profiles enumerable. Returns at most one row and never the caller.';
