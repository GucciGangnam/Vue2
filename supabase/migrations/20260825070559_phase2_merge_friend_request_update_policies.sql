-- Collapse the two friend_requests UPDATE policies into one.
--
-- Permissive policies for the same role and action are OR-ed together on both
-- halves, so `respond` OR `cancel` is exactly the single policy below:
--
--   USING       (addressee = me and pending) or (requester = me and pending)
--            == pending and (addressee = me or requester = me)
--   WITH CHECK  unchanged, still the disjunction
--
-- Same semantics, one policy evaluated per row instead of two, and the
-- performance advisor stops flagging the table. The state machine is unchanged:
-- only a pending request moves, and each party can still only write the outcome
-- that belongs to their side -- an addressee cannot cancel, and a requester
-- cannot accept, because neither satisfies the other's disjunct.

drop policy if exists "friend_requests_respond" on public.friend_requests;
drop policy if exists "friend_requests_cancel" on public.friend_requests;

create policy "friend_requests_respond_or_cancel"
  on public.friend_requests for update to authenticated
  using (
    status = 'pending'
    and (
      addressee_id = (select auth.uid())
      or requester_id = (select auth.uid())
    )
  )
  with check (
    (addressee_id = (select auth.uid()) and status in ('accepted', 'declined'))
    or (requester_id = (select auth.uid()) and status = 'cancelled')
  );
