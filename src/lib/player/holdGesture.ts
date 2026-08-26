/**
 * The hold gesture, as arithmetic.
 *
 * A locked player ignores taps entirely: the transport only responds after a
 * deliberate three-second hold. Everything that decides whether a particular
 * press counts as deliberate lives here, framework-free, so it can be tested as
 * numbers rather than as a race between a finger and a render.
 *
 * The two rules that matter are both about *not* firing. A hold that moves is
 * someone scrolling, or -- from Phase 7 onwards -- someone drawing, and a hold
 * that ends early is someone who changed their mind. Both must leave playback
 * exactly where it was, because the whole point is that the room does not lurch
 * when one person shifts their grip.
 */

/** How long a hold must last. Three seconds, from docs/PHASES.md Phase 6. */
export const HOLD_DURATION_MS = 3000

/**
 * How far a finger may wander before the hold is abandoned. Twenty pixels is
 * roughly the slop a resting thumb produces on a phone; anything more is a
 * gesture that means something else.
 */
export const CANCEL_DISTANCE_PX = 20

export interface Point {
  x: number
  y: number
}

/** A hold in progress. Created on press, discarded on release or cancel. */
export interface Hold {
  /** Which pointer owns this hold; events from any other are not ours. */
  pointerId: number
  origin: Point
  startedAtMs: number
}

export function beginHold(pointerId: number, origin: Point, nowMs: number): Hold {
  return { pointerId, origin, startedAtMs: nowMs }
}

/** 0 at the moment of press, 1 once the hold is complete. Never outside that. */
export function holdProgress(hold: Hold, nowMs: number): number {
  const elapsed = nowMs - hold.startedAtMs
  if (elapsed <= 0) return 0
  if (elapsed >= HOLD_DURATION_MS) return 1
  return elapsed / HOLD_DURATION_MS
}

export function isHoldComplete(hold: Hold, nowMs: number): boolean {
  return nowMs - hold.startedAtMs >= HOLD_DURATION_MS
}

export function distanceBetween(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/**
 * Strictly greater than the threshold: a finger exactly at the limit is still
 * within the slop we promised to tolerate.
 */
export function hasMovedTooFar(hold: Hold, point: Point): boolean {
  return distanceBetween(hold.origin, point) > CANCEL_DISTANCE_PX
}

/** Events from a second finger are ignored rather than treated as a cancel. */
export function ownsPointer(hold: Hold, pointerId: number): boolean {
  return hold.pointerId === pointerId
}
