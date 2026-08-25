-- Phase 2: friend requests and friendships.
--
-- Two tables, because they answer two different questions. `friend_requests` is
-- the mutable conversation ("A asked B, B has not replied"); `friendships` is the
-- settled fact, stored as a canonical ordered pair so "are these two friends" is
-- one primary-key lookup rather than a two-directional scan. The second is
-- written only by a trigger on the first -- there is no client path to it.
--
-- GRANTs ship beside the policies. RLS narrows access, it never widens it:
-- Postgres checks table privileges first, so a table with perfect policies and
-- no grant is simply unreadable. See docs/DECISIONS.md D14.

-- ============================================================================
-- friend_requests
-- ============================================================================

create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles (id) on delete cascade,
  addressee_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  constraint friend_requests_not_self check (requester_id <> addressee_id)
);

comment on table public.friend_requests is
  'One row per invitation. Declined and cancelled rows are kept: they are the audit trail, and only pending rows constrain anything.';

-- Only one live invitation per direction. Declined/cancelled rows fall out of
-- the index, so a second attempt after a refusal is allowed (rate limiting is
-- Phase 8's problem, not the schema's).
create unique index if not exists friend_requests_unique_pending
  on public.friend_requests (requester_id, addressee_id)
  where status = 'pending';

create index if not exists friend_requests_addressee_idx
  on public.friend_requests (addressee_id, status);
create index if not exists friend_requests_requester_idx
  on public.friend_requests (requester_id, status);

alter table public.friend_requests enable row level security;

-- ============================================================================
-- friendships
-- ============================================================================

create table if not exists public.friendships (
  user_a uuid not null references public.profiles (id) on delete cascade,
  user_b uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_a, user_b),
  constraint friendships_ordered_pair check (user_a < user_b)
);

comment on table public.friendships is
  'Canonical ordered pair (user_a < user_b), so friendship is symmetric by construction and needs exactly one row. Written only by the accept trigger.';

-- The PK covers user_a; user_b needs its own index for the reverse direction.
create index if not exists friendships_user_b_idx on public.friendships (user_b);

alter table public.friendships enable row level security;

-- Unfriending has to reach the other party's client, and a DELETE event only
-- carries enough of the old row for RLS to be evaluated under REPLICA IDENTITY FULL.
alter table public.friendships replica identity full;

-- ============================================================================
-- helpers
-- ============================================================================

-- SECURITY DEFINER because this is called from inside the `profiles` select
-- policy: it must see the friendship row regardless of whose query is running.
create or replace function public.are_friends(p_one uuid, p_two uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.friendships
    where user_a = least(p_one, p_two)
      and user_b = greatest(p_one, p_two)
  );
$$;

comment on function public.are_friends(uuid, uuid) is
  'Symmetric friendship test against the canonical ordered pair. SECURITY DEFINER so it can be used inside RLS policies.';

revoke execute on function public.are_friends(uuid, uuid) from public;
grant execute on function public.are_friends(uuid, uuid) to authenticated;

-- Deliberately takes one argument, not two: the other side is always the caller.
-- A two-argument version would let anyone holding two user ids probe whether a
-- request exists between strangers, which is exactly the thing this table should
-- not leak. The `profiles` policy only ever needs the caller's own pairs.
create or replace function public.has_pending_request_with(p_other uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.friend_requests r
    where r.status = 'pending'
      and (
        (r.requester_id = (select auth.uid()) and r.addressee_id = p_other)
        or (r.addressee_id = (select auth.uid()) and r.requester_id = p_other)
      )
  );
$$;

comment on function public.has_pending_request_with(uuid) is
  'True when a pending request links the caller and p_other, in either direction. Scoped to the caller on purpose so it cannot be used to probe other people''s invitations.';

revoke execute on function public.has_pending_request_with(uuid) from public;
grant execute on function public.has_pending_request_with(uuid) to authenticated;

-- ============================================================================
-- triggers
-- ============================================================================

-- A request is always born pending, whatever the client sends. Rejecting the
-- impossible cases here gives the UI a sentence it can show verbatim; the
-- same-direction duplicate is caught by friend_requests_unique_pending instead.
create or replace function public.friend_requests_validate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.status := 'pending';
  new.responded_at := null;
  new.created_at := now();

  if public.are_friends(new.requester_id, new.addressee_id) then
    raise exception 'You are already friends with this person.';
  end if;

  if exists (
    select 1
    from public.friend_requests r
    where r.status = 'pending'
      and r.requester_id = new.addressee_id
      and r.addressee_id = new.requester_id
  ) then
    raise exception 'This person has already sent you a request. Check your invitations.';
  end if;

  return new;
end;
$$;

revoke execute on function public.friend_requests_validate() from public;

drop trigger if exists friend_requests_validate on public.friend_requests;
create trigger friend_requests_validate
  before insert on public.friend_requests
  for each row execute function public.friend_requests_validate();

-- WITH CHECK constrains the new row's status but cannot stop an addressee from
-- rewriting requester_id on the way past, which would forge a friendship with
-- someone who never asked. Pinning the identity columns here closes that.
create or replace function public.friend_requests_protect()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.id := old.id;
  new.requester_id := old.requester_id;
  new.addressee_id := old.addressee_id;
  new.created_at := old.created_at;

  if new.status is distinct from old.status then
    new.responded_at := now();
  else
    new.responded_at := old.responded_at;
  end if;

  return new;
end;
$$;

revoke execute on function public.friend_requests_protect() from public;

drop trigger if exists friend_requests_protect on public.friend_requests;
create trigger friend_requests_protect
  before update on public.friend_requests
  for each row execute function public.friend_requests_protect();

-- The only writer of public.friendships.
create or replace function public.friend_requests_on_accept()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.friendships (user_a, user_b)
  values (
    least(new.requester_id, new.addressee_id),
    greatest(new.requester_id, new.addressee_id)
  )
  on conflict (user_a, user_b) do nothing;
  return null;
end;
$$;

revoke execute on function public.friend_requests_on_accept() from public;

drop trigger if exists friend_requests_create_friendship on public.friend_requests;
create trigger friend_requests_create_friendship
  after update of status on public.friend_requests
  for each row
  when (new.status = 'accepted' and old.status is distinct from 'accepted')
  execute function public.friend_requests_on_accept();

-- ============================================================================
-- policies
-- ============================================================================

create policy "friend_requests_select_involved"
  on public.friend_requests for select to authenticated
  using (
    requester_id = (select auth.uid())
    or addressee_id = (select auth.uid())
  );

create policy "friend_requests_insert_own"
  on public.friend_requests for insert to authenticated
  with check (
    requester_id = (select auth.uid())
    and addressee_id <> (select auth.uid())
  );

-- USING sees the old row, WITH CHECK the new one, so these two policies encode
-- the whole state machine: only a pending request moves, and only to the
-- outcome its own side is entitled to. Multiple permissive policies OR together
-- on both halves, and neither disjunct lets a party pick the other's verb.
create policy "friend_requests_respond"
  on public.friend_requests for update to authenticated
  using (addressee_id = (select auth.uid()) and status = 'pending')
  with check (
    addressee_id = (select auth.uid())
    and status in ('accepted', 'declined')
  );

create policy "friend_requests_cancel"
  on public.friend_requests for update to authenticated
  using (requester_id = (select auth.uid()) and status = 'pending')
  with check (
    requester_id = (select auth.uid())
    and status = 'cancelled'
  );

-- No delete policy: a request's history is not the client's to erase.

create policy "friendships_select_own"
  on public.friendships for select to authenticated
  using (
    user_a = (select auth.uid())
    or user_b = (select auth.uid())
  );

-- Unfriending is symmetric: either side may remove the single shared row.
create policy "friendships_delete_own"
  on public.friendships for delete to authenticated
  using (
    user_a = (select auth.uid())
    or user_b = (select auth.uid())
  );

-- No insert or update policy: the accept trigger is the only writer.

-- ============================================================================
-- profiles: widen select
-- ============================================================================

-- Phase 1 shipped this self-only, which was right when nobody could see anyone.
-- Phase 2 needs a friend to have a name and a colour, and needs the person you
-- just invited to be visible while they decide. Anyone else stays invisible, and
-- the table stays non-enumerable -- friend codes still resolve only through
-- find_profile_by_code.
drop policy if exists "profiles_select_own" on public.profiles;

create policy "profiles_select_visible"
  on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or public.are_friends(id, (select auth.uid()))
    or public.has_pending_request_with(id)
  );

comment on table public.profiles is
  'Public-facing user identity. Visible to yourself, to your friends, and to the counterparty of a pending friend request -- nobody else.';

-- ============================================================================
-- grants
-- ============================================================================

-- Widest a policy could ever allow; the policies above narrow it.
--   friend_requests -- no delete: declined/cancelled rows are the audit trail
--   friendships     -- no insert/update: written only by the accept trigger
grant select, insert, update on public.friend_requests to authenticated;
grant select, delete on public.friendships to authenticated;

-- `anon` gets nothing on either table.

-- ============================================================================
-- realtime
-- ============================================================================

-- So an incoming request lands on the other person's screen without a refresh.
alter publication supabase_realtime add table public.friend_requests;
alter publication supabase_realtime add table public.friendships;
