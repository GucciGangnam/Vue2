/**
 * When is a room's live connection trustworthy, and when must it re-read?
 *
 * Realtime reconnects on its own, and that is the part that makes this subtle:
 * the socket comes back, the channel rejoins, everything looks healthy -- and
 * the client is silently wrong. `postgres_changes` has no replay, so every
 * event that happened during the gap is simply gone. A viewer whose phone
 * switched from wifi to mobile data can miss the pause and go on playing
 * forever, with the room insisting it is paused and nothing to heal it: the
 * drift loop re-asserts `anchor.current`, and `anchor.current` is the stale one.
 *
 * The cure is the same trick late joining already uses. The anchor is an
 * absolute fact -- a position at a server time -- so re-reading the row is
 * enough to land back in step exactly, with no negotiation and no replay. That
 * makes "reconnected" and "just arrived" the same code path.
 *
 * Kept pure and separate from the hook so the transitions can be tested as
 * values rather than as a race against a websocket.
 */

/** The subset of Supabase channel statuses worth reacting to. */
export type ChannelStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED'

export type ConnectionState =
  /** Opening for the first time; no events missed yet. */
  | 'connecting'
  /** Subscribed and current. */
  | 'live'
  /** Was live, is not now. Events are being missed. */
  | 'reconnecting'
  /** The device itself reports no network. */
  | 'offline'

/**
 * Fold a channel status and the browser's own connectivity into one state.
 *
 * `navigator.onLine` is only ever trusted for the negative case. It reports a
 * working link, not a working route, so "online" is not evidence the server is
 * reachable -- but "offline" is good evidence it is not, and it is the signal
 * that arrives first when a phone leaves wifi.
 */
export function nextConnectionState(
  status: ChannelStatus,
  isOnline: boolean,
  previous: ConnectionState,
): ConnectionState {
  if (!isOnline) return 'offline'
  if (status === 'SUBSCRIBED') return 'live'
  // A drop before we were ever live is still just "connecting": showing
  // "reconnecting" to someone who has not yet connected reads as a fault.
  return previous === 'connecting' ? 'connecting' : 'reconnecting'
}

/**
 * Should the room re-read its authoritative state?
 *
 * On every entry into `live`, including the first. The first one is not
 * redundant: the initial load and the subscription are separate async steps,
 * and anything that happens between them lands in the gap between a row already
 * read and a subscription not yet listening. One extra read on opening a room
 * closes that window and means there is a single resync path rather than two.
 */
export function shouldResync(previous: ConnectionState, next: ConnectionState): boolean {
  return next === 'live' && previous !== 'live'
}

/**
 * Should the clock offset be measured again rather than reused?
 *
 * After a genuine interruption, yes. The offset is a property of the *route*,
 * not of the server: a phone that has moved from wifi to mobile data is talking
 * to Tokyo over an entirely different path, and reusing an offset measured on
 * the old one puts this client confidently out of step with everybody else --
 * which is indistinguishable from a sync bug (D30).
 *
 * Not on the first connection, where the offset was just measured.
 */
export function shouldRemeasureClock(previous: ConnectionState, next: ConnectionState): boolean {
  return next === 'live' && (previous === 'reconnecting' || previous === 'offline')
}

/** What to tell the viewer. `null` when there is nothing worth saying. */
export function connectionMessage(state: ConnectionState): string | null {
  switch (state) {
    case 'offline':
      return 'No connection — you may be out of step with everyone else.'
    case 'reconnecting':
      return 'Reconnecting…'
    case 'connecting':
    case 'live':
      return null
  }
}
