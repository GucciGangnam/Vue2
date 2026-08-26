/**
 * The sync engine: keeps one `<video>` element in step with a room.
 *
 * The element is driven *only* by this hook. Native controls are off and the
 * UI buttons call `act()` rather than touching the element, so there is no
 * feedback loop where a programmatic pause fires an event that looks like a
 * user pause and gets broadcast back out. That loop is easy to create and
 * miserable to debug, and the cheapest fix is not to have two sources of truth.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ClockOffset } from '@/lib/sync/clock'
import {
  nextConnectionState,
  shouldRemeasureClock,
  shouldResync,
  type ChannelStatus,
  type ConnectionState,
} from '@/lib/sync/connection'
import {
  decideCorrection,
  expectedPositionMs,
  hasRunOut,
  NUDGE_THRESHOLD_MS,
  SEEK_THRESHOLD_MS,
  shouldApply,
  type PlaybackAnchor,
} from '@/lib/sync/timeline'
import {
  canControlPlayback,
  listRoomMembers,
  loadRoom,
  measureClock,
  sendPlaybackAction,
  setMemberState,
  subscribeToRoom,
  type PlaybackAction,
  type Room,
  type RoomMember,
} from '@/lib/sync/room'
import { useSession } from '@/stores/sessionStore'

/** ARCHITECTURE.md: drift is checked twice a second. */
const DRIFT_INTERVAL_MS = 500

/**
 * The element's duration in milliseconds, or `null` before it knows.
 *
 * `HTMLMediaElement.duration` is `NaN` until metadata loads and `Infinity` for
 * a live stream, and both of those must mean "do not clamp" rather than
 * "clamp to nothing".
 */
function durationMs(element: HTMLVideoElement | null): number | null {
  if (!element || !Number.isFinite(element.duration) || element.duration <= 0) return null
  return element.duration * 1000
}
/** Re-measure the clock occasionally; laptops sleep and clocks slew. */
const CLOCK_REFRESH_MS = 5 * 60_000

export interface RoomSync {
  /**
   * Attach to the `<video>`: `<video ref={sync.attachVideo} />`.
   *
   * A callback ref rather than a `RefObject`, for a non-obvious reason worth
   * keeping: returning a ref object as a field makes the React compiler treat
   * every property of this result as a ref access during render, and the whole
   * hook lights up with warnings. A function does not have that problem, and
   * a callback ref is the more idiomatic way to hand an element to a hook.
   */
  attachVideo: (element: HTMLVideoElement | null) => void
  room: Room | null
  members: RoomMember[]
  self: RoomMember | null
  error: string | null
  /**
   * Whether this client is still hearing the room. Worth showing: a silent
   * reconnection is indistinguishable from a room where nobody has touched
   * anything, and only one of those is safe to keep watching through.
   */
  connection: ConnectionState
  /** Round-trip uncertainty on the clock, for the diagnostics line. */
  clockUncertaintyMs: number
  /** "Ada paused" — resolved against the roster during render. */
  lastAction: { actorName: string; isPlaying: boolean; at: number } | null
  play: () => void
  pause: () => void
  seek: (positionMs: number) => void
  forceSync: () => void
  join: () => Promise<void>
  leave: () => Promise<void>
}

export function useRoom(roomId: string): RoomSync {
  const session = useSession((s) => s.session)
  const selfId = session?.user.id ?? ''

  const [room, setRoom] = useState<Room | null>(null)
  const [members, setMembers] = useState<RoomMember[]>([])
  const [error, setError] = useState<string | null>(null)
  // Stores ids, not names: resolving the name here would mean reading the
  // roster from a ref during render, and the roster is already state.
  const [lastEvent, setLastEvent] = useState<{
    actorId: string
    isPlaying: boolean
    at: number
  } | null>(null)
  const [clockUncertaintyMs, setClockUncertaintyMs] = useState(0)
  const [connection, setConnection] = useState<ConnectionState>('connecting')

  // Owned here rather than taken as an argument: this hook is the only thing
  // that drives the element, and mutating a ref handed in from outside is both
  // harder to reason about and something the React compiler rightly objects to.
  const video = useRef<HTMLVideoElement | null>(null)
  const clock = useRef<ClockOffset>(ClockOffset.unmeasured())
  const anchor = useRef<PlaybackAnchor | null>(null)
  const appliedSeq = useRef(0)
  const broadcastRef = useRef<((intent: never) => void) | null>(null)
  // Mirrors `connection` so the callbacks below can read it without being
  // rebuilt on every transition, which would tear down the subscription.
  const connectionRef = useRef<ConnectionState>('connecting')
  const lastStatus = useRef<ChannelStatus>('CLOSED')
  // Read by the drift interval, which must not be torn down and rebuilt every
  // time the roster changes just to know this.
  const mayControl = useRef(false)

  /**
   * Put the element where the anchor says it should be, right now.
   *
   * `authoritative` matters more than it looks. An anchor from the database
   * describes a position at the instant the *server* stamped it, which is one
   * one-way latency after the actor actually clicked -- the position travelled
   * with the request, the timestamp was applied on arrival. Everyone who snaps
   * to that anchor therefore sits slightly behind the person who pressed play.
   *
   * The actor is the exception, because its own error is only one one-way
   * latency, which falls under the nudge threshold and is never corrected. The
   * result is the actor drifting permanently ahead of the room by the latency
   * to Tokyo -- measured at a rock-steady 205ms before this was fixed, and it
   * would be far worse from Europe.
   *
   * So an authoritative anchor is applied exactly, by everyone including the
   * actor. The absolute position ends up a fraction of a second behind the
   * click, which nobody can perceive; what matters is that every client agrees.
   * The looser drift policy still governs the gaps between anchors.
   */
  const applyAnchor = useCallback((next: PlaybackAnchor, authoritative = false) => {
    anchor.current = next
    const element = video.current
    if (!element) return

    const expected = expectedPositionMs(next, clock.current.now(), durationMs(element))
    const tolerance = authoritative ? NUDGE_THRESHOLD_MS : SEEK_THRESHOLD_MS
    if (Math.abs(element.currentTime * 1000 - expected) > tolerance) {
      element.currentTime = expected / 1000
      element.playbackRate = 1
    }
    // `element.ended` is excluded deliberately: play() on a finished element
    // restarts it from the beginning, so a session still marked playing would
    // replay the film from zero, be seeked back to the end by the next anchor,
    // and do it again. The drift loop stops the session instead.
    if (next.isPlaying && element.paused && !element.ended) {
      void element.play().catch(() => {
        // Autoplay refused until the user interacts. The drift loop will keep
        // trying, and the play button is right there.
      })
    }
    if (!next.isPlaying && !element.paused) element.pause()
  }, [])

  /* ---- staying in step across interruptions ------------------------------- */

  /**
   * Re-read the authoritative state and land on it.
   *
   * This is deliberately the same thing a late joiner does, because it is the
   * same problem: the anchor is an absolute fact, so re-reading the row is
   * enough to be exactly in step again without any replay of what was missed.
   */
  const resync = useCallback(
    async (remeasureClock: boolean) => {
      try {
        if (remeasureClock) {
          const measured = await measureClock()
          clock.current = measured
          setClockUncertaintyMs(Math.round(measured.uncertaintyMs))
        }
        const [fresh, roster] = await Promise.all([loadRoom(roomId), listRoomMembers(roomId)])
        setRoom(fresh)
        setMembers(roster)
        appliedSeq.current = fresh.anchor.seq
        applyAnchor(fresh.anchor, true)
      } catch {
        // Still unreachable, or the room has ended. Whichever it is, the next
        // status change tries again; failing loudly here would only replace a
        // recoverable gap with an error screen.
      }
    },
    [applyAnchor, roomId],
  )

  const updateConnection = useCallback(
    (status: ChannelStatus, isOnline: boolean) => {
      lastStatus.current = status
      const previous = connectionRef.current
      const next = nextConnectionState(status, isOnline, previous)
      if (next === previous) return

      const remeasure = shouldRemeasureClock(previous, next)
      const resyncNeeded = shouldResync(previous, next)
      connectionRef.current = next
      setConnection(next)
      if (resyncNeeded) void resync(remeasure)
    },
    [resync],
  )

  /**
   * The device's own view of connectivity, and coming back from the background.
   *
   * Foregrounding is handled separately from the state machine and always
   * resyncs, even from `live`. A phone that has been asleep may hold a channel
   * that still reports `SUBSCRIBED` over a socket that quietly died, so waiting
   * for a status change would mean waiting forever. The clock is re-measured
   * too: a sleeping device's clock slews, and a wrong offset is exactly what
   * makes a client confidently out of step (D30).
   */
  useEffect(() => {
    const onConnectivity = () => updateConnection(lastStatus.current, navigator.onLine)
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      onConnectivity()
      void resync(true)
    }
    window.addEventListener('online', onConnectivity)
    window.addEventListener('offline', onConnectivity)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('online', onConnectivity)
      window.removeEventListener('offline', onConnectivity)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [resync, updateConnection])

  /* ---- load, subscribe ---------------------------------------------------- */

  useEffect(() => {
    if (!roomId || !selfId) return
    let live = true

    void (async () => {
      try {
        clock.current = await measureClock()
        setClockUncertaintyMs(Math.round(clock.current.uncertaintyMs))
        const [loaded, roster] = await Promise.all([loadRoom(roomId), listRoomMembers(roomId)])
        if (!live) return

        setRoom(loaded)
        setMembers(roster)
        appliedSeq.current = loaded.anchor.seq
        // Late join lands here: the anchor plus the clock is enough to compute
        // exactly where everyone else is, with no negotiation.
        applyAnchor(loaded.anchor, true)
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : 'Could not open that room.')
      }
    })()

    const subscription = subscribeToRoom(roomId, selfId, {
      onRoomChanged: (next) => {
        setRoom(next)
        // The database is authoritative, so this is where appliedSeq moves.
        if (!shouldApply(next.anchor.seq, appliedSeq.current)) return
        appliedSeq.current = next.anchor.seq
        applyAnchor(next.anchor, true)

        if (next.lastActorId && next.lastActorId !== selfId) {
          setLastEvent({
            actorId: next.lastActorId,
            isPlaying: next.anchor.isPlaying,
            at: Date.now(),
          })
        }
      },
      onIntent: (intent) => {
        // Optimistic: fast, and deliberately does NOT advance appliedSeq, so the
        // authoritative row still applies when it lands a moment later.
        applyAnchor({
          seq: appliedSeq.current,
          isPlaying: intent.action === 'play',
          positionMs: intent.positionMs,
          anchorServerTimeMs: intent.atServerMs,
        })
      },
      onMembersChanged: () => {
        void listRoomMembers(roomId)
          .then((roster) => live && setMembers(roster))
          .catch(() => {})
      },
      onStatusChange: (status) => {
        if (!live) return
        updateConnection(status, navigator.onLine)
      },
    })
    broadcastRef.current = subscription.broadcast as unknown as (intent: never) => void

    return () => {
      live = false
      subscription.unsubscribe()
      broadcastRef.current = null
      connectionRef.current = 'connecting'
      lastStatus.current = 'CLOSED'
    }
  }, [roomId, selfId, applyAnchor, updateConnection])

  /* ---- who we are, and what the clock is doing ----------------------------- */

  const self = members.find((member) => member.userId === selfId) ?? null

  useEffect(() => {
    mayControl.current = canControlPlayback(room, self, selfId)
  }, [room, self, selfId])

  useEffect(() => {
    const timer = setInterval(() => {
      void measureClock()
        .then((measured) => {
          clock.current = measured
          setClockUncertaintyMs(Math.round(measured.uncertaintyMs))
        })
        .catch(() => {})
    }, CLOCK_REFRESH_MS)
    return () => clearInterval(timer)
  }, [])

  /* ---- acting ------------------------------------------------------------- */

  const act = useCallback(
    (action: PlaybackAction, positionMs: number) => {
      setError(null)
      // Fast path first: everyone else moves before the round trip completes.
      broadcastRef.current?.({
        action,
        positionMs,
        atServerMs: clock.current.now(),
        actorId: selfId,
      } as never)

      // ...and locally, so our own UI does not wait either.
      applyAnchor({
        seq: appliedSeq.current,
        isPlaying: action === 'play',
        positionMs,
        anchorServerTimeMs: clock.current.now(),
      })

      void sendPlaybackAction(roomId, action, positionMs)
        .then((result) => {
          if (!shouldApply(result.anchor.seq, appliedSeq.current)) return
          appliedSeq.current = result.anchor.seq
          // Including ourselves: see the note on applyAnchor.
          applyAnchor(result.anchor, true)
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : 'The room refused that.')
          // Snap back to whatever the room actually says, so a refused action
          // does not leave this client quietly out of step with everyone else.
          void loadRoom(roomId)
            .then((fresh) => {
              appliedSeq.current = fresh.anchor.seq
              applyAnchor(fresh.anchor, true)
            })
            .catch(() => {})
        })
    },
    [applyAnchor, roomId, selfId],
  )

  /* ---- drift correction ---------------------------------------------------

     Below `act` rather than above it, because the loop is now allowed to act:
     a film that has run out has to be stopped by somebody, and the client
     noticing it is the only one in a position to. */

  useEffect(() => {
    const timer = setInterval(() => {
      const element = video.current
      const current = anchor.current
      if (!element || !current || element.seeking || element.readyState < 2) return

      const total = durationMs(element)

      // The film has run out. Nothing else notices: `is_playing` stays true,
      // the computed position climbs for as long as the row says so, and every
      // client arriving afterwards is dragged to the last frame. So somebody
      // present has to say the session is over.
      //
      // Checked before the re-assert below, because an ended element is also a
      // paused one and re-asserting play on it restarts the film from zero.
      //
      // Several clients can reach this in the same instant, and that is fine
      // rather than coordinated: the guard is `isPlaying`, and `act` broadcasts
      // optimistically on the fast path -- well under 100ms against a 500ms
      // tick -- so the first one to notice flips everybody else's local anchor
      // and they fall silent. A duplicate would only set the same state again.
      if (current.isPlaying && total !== null && mayControl.current) {
        if (element.ended || hasRunOut(current, clock.current.now(), total)) {
          act('pause', total)
          return
        }
      }

      // Re-assert play/pause, not just position. An element can stop on its own
      // -- a stall, a decode hiccup, a refused autoplay -- and without this the
      // room would sit "playing" while this client stared at a frozen frame,
      // because nothing else re-checks until the next anchor arrives.
      if (current.isPlaying && element.paused && !element.ended) {
        void element.play().catch(() => {})
      } else if (!current.isPlaying && !element.paused) {
        element.pause()
      }

      const correction = decideCorrection(
        current,
        element.currentTime * 1000,
        clock.current.now(),
        total,
      )
      switch (correction.kind) {
        case 'seek':
          element.currentTime = correction.toMs / 1000
          element.playbackRate = 1
          break
        case 'rate':
          element.playbackRate = correction.playbackRate
          break
        case 'none':
          if (element.playbackRate !== 1) element.playbackRate = 1
          break
      }
    }, DRIFT_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [act])

  const attachVideo = useCallback((element: HTMLVideoElement | null) => {
    video.current = element
  }, [])

  const positionNow = useCallback(() => {
    const element = video.current
    return element ? element.currentTime * 1000 : (anchor.current?.positionMs ?? 0)
  }, [])

  const lastAction = lastEvent
    ? {
        actorName:
          members.find((member) => member.userId === lastEvent.actorId)?.displayName ?? 'Someone',
        isPlaying: lastEvent.isPlaying,
        at: lastEvent.at,
      }
    : null

  return {
    attachVideo,
    room,
    members,
    self,
    error,
    connection,
    clockUncertaintyMs,
    lastAction,
    // A finished film restarts rather than sitting on the last frame doing
    // nothing, which is what pressing play plainly promises. The element would
    // do this by itself -- play() on an ended element seeks to zero -- but the
    // anchor has to agree, or the drift loop pulls it straight back.
    play: () => act('play', video.current?.ended ? 0 : positionNow()),
    pause: () => act('pause', positionNow()),
    seek: (positionMs: number) => act('seek', positionMs),
    // Re-issuing the current state bumps seq, which makes every client
    // re-apply from the authoritative anchor.
    forceSync: () => {
      const current = anchor.current
      if (!current) return
      act(current.isPlaying ? 'play' : 'pause', expectedPositionMs(current, clock.current.now()))
    },
    join: async () => {
      await setMemberState(roomId, selfId, 'joined')
      setMembers(await listRoomMembers(roomId))
    },
    leave: async () => {
      await setMemberState(roomId, selfId, 'left')
    },
  }
}
