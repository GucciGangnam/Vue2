/**
 * NTP-style clock offset against the database.
 *
 * Every synchronisation decision in this app is expressed in *server* time.
 * Local clocks disagree by seconds routinely and by minutes occasionally, and a
 * viewer whose clock is 30s fast would otherwise spend the whole film seeking.
 * So we measure the offset once, keep it, and convert.
 *
 * The measurement is the standard trick: note when the request left, ask the
 * server for its clock, note when the reply arrived. If the network were
 * symmetric, the server's instant corresponds to the midpoint of those two.
 * It is not symmetric, so the error is bounded by half the round trip -- which
 * is why the lowest-RTT sample of a handful is the one worth keeping, rather
 * than the average of all of them. Averaging mixes good samples with bad.
 */

export interface ClockSample {
  /** Round trip, in milliseconds. Lower means a tighter bound on the error. */
  rttMs: number
  /** Add to a local timestamp to get server time. */
  offsetMs: number
}

/**
 * Derive one sample from a completed round trip.
 *
 * Pure so the arithmetic can be tested without a network: pass the two local
 * timestamps and whatever the server said.
 */
export function sampleOffset(
  sentAtMs: number,
  serverTimeMs: number,
  receivedAtMs: number,
): ClockSample {
  const rttMs = Math.max(0, receivedAtMs - sentAtMs)
  const localMidpointMs = sentAtMs + rttMs / 2
  return { rttMs, offsetMs: serverTimeMs - localMidpointMs }
}

/**
 * The most trustworthy sample of a set: the one that spent least time in
 * transit, because its true offset can be wrong by at most rtt/2.
 */
export function bestSample(samples: readonly ClockSample[]): ClockSample | null {
  let best: ClockSample | null = null
  for (const sample of samples) {
    if (!best || sample.rttMs < best.rttMs) best = sample
  }
  return best
}

/** A measured offset, and the confidence bound that comes with it. */
export class ClockOffset {
  readonly offsetMs: number
  readonly rttMs: number

  constructor(sample: ClockSample) {
    this.offsetMs = sample.offsetMs
    this.rttMs = sample.rttMs
  }

  /** Current server time, in epoch milliseconds. */
  now(localNowMs: number = Date.now()): number {
    return localNowMs + this.offsetMs
  }

  /** Half the round trip: the most this offset can be wrong by. */
  get uncertaintyMs(): number {
    return this.rttMs / 2
  }

  /** An offset of zero, for a client that has not measured yet. */
  static unmeasured(): ClockOffset {
    return new ClockOffset({ rttMs: 0, offsetMs: 0 })
  }
}
