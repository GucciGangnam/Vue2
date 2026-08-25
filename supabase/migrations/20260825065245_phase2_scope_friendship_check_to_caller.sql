-- Scope the friendship test in the `profiles` policy to the caller.
--
-- A function used inside an RLS policy has its EXECUTE privilege checked against
-- the role running the query, so putting `are_friends(a, b)` in the policy meant
-- granting it to `authenticated` -- which also exposes /rest/v1/rpc/are_friends
-- and turns it into a social-graph oracle: anyone holding two user ids could ask
-- whether those two are friends. Friend ids are easy to come by (your friends'
-- profiles are visible to you), so that leaks exactly the edge the app never
-- shows you: whether two of your friends know each other.
--
-- `is_friend_of_caller` answers only the question the policy actually asks. It
-- is SECURITY DEFINER, so the nested call to `are_friends` is privilege-checked
-- as the function owner and `are_friends` no longer needs a grant of its own.
-- (Postgres does not inline SECURITY DEFINER SQL functions, so this stays a
-- genuine privilege boundary rather than being flattened into the policy.)
--
-- `are_friends` itself survives unchanged as the shared internal helper the
-- schema calls for, reachable from other SECURITY DEFINER code -- it is simply
-- no longer part of the public API.

create or replace function public.is_friend_of_caller(p_other uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.are_friends((select auth.uid()), p_other);
$$;

comment on function public.is_friend_of_caller(uuid) is
  'True when p_other is a friend of the calling user. The caller-scoped form of are_friends, and the only one exposed over the API.';

revoke execute on function public.is_friend_of_caller(uuid) from public;
grant execute on function public.is_friend_of_caller(uuid) to authenticated;

drop policy if exists "profiles_select_visible" on public.profiles;

create policy "profiles_select_visible"
  on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or public.is_friend_of_caller(id)
    or public.has_pending_request_with(id)
  );

-- No longer reachable over PostgREST. Trigger functions and the wrapper above
-- are SECURITY DEFINER and call it as the owner, so nothing breaks.
revoke execute on function public.are_friends(uuid, uuid) from authenticated;
