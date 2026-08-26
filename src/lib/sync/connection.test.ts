import { describe, expect, it } from 'vitest'
import {
  connectionMessage,
  nextConnectionState,
  shouldRemeasureClock,
  shouldResync,
  type ConnectionState,
} from './connection'

describe('nextConnectionState', () => {
  it('is live once subscribed', () => {
    expect(nextConnectionState('SUBSCRIBED', true, 'connecting')).toBe('live')
    expect(nextConnectionState('SUBSCRIBED', true, 'reconnecting')).toBe('live')
  })

  it('reports offline whatever the channel thinks, because the device knows first', () => {
    // A phone leaving wifi tells the page before the socket notices.
    expect(nextConnectionState('SUBSCRIBED', false, 'live')).toBe('offline')
    expect(nextConnectionState('CHANNEL_ERROR', false, 'live')).toBe('offline')
  })

  it('calls a drop after being live a reconnection', () => {
    expect(nextConnectionState('CHANNEL_ERROR', true, 'live')).toBe('reconnecting')
    expect(nextConnectionState('TIMED_OUT', true, 'live')).toBe('reconnecting')
    expect(nextConnectionState('CLOSED', true, 'live')).toBe('reconnecting')
  })

  it('does not call a first failure a reconnection', () => {
    // Nothing has been missed yet, and "reconnecting" would read as a fault.
    expect(nextConnectionState('CHANNEL_ERROR', true, 'connecting')).toBe('connecting')
    expect(nextConnectionState('TIMED_OUT', true, 'connecting')).toBe('connecting')
  })

  it('keeps reporting a reconnection until it actually succeeds', () => {
    expect(nextConnectionState('CHANNEL_ERROR', true, 'reconnecting')).toBe('reconnecting')
    expect(nextConnectionState('CHANNEL_ERROR', true, 'offline')).toBe('reconnecting')
  })
})

describe('shouldResync', () => {
  it('re-reads on every arrival at live, including the first', () => {
    // The first is not redundant: it closes the window between the initial
    // load and the subscription being ready.
    expect(shouldResync('connecting', 'live')).toBe(true)
    expect(shouldResync('reconnecting', 'live')).toBe(true)
    expect(shouldResync('offline', 'live')).toBe(true)
  })

  it('does not re-read while already live', () => {
    expect(shouldResync('live', 'live')).toBe(false)
  })

  it('does not re-read on the way down', () => {
    expect(shouldResync('live', 'reconnecting')).toBe(false)
    expect(shouldResync('live', 'offline')).toBe(false)
    expect(shouldResync('connecting', 'connecting')).toBe(false)
  })
})

describe('shouldRemeasureClock', () => {
  it('re-measures after a real interruption, because the route may have changed', () => {
    expect(shouldRemeasureClock('reconnecting', 'live')).toBe(true)
    expect(shouldRemeasureClock('offline', 'live')).toBe(true)
  })

  it('does not re-measure on the first connection, which just measured', () => {
    expect(shouldRemeasureClock('connecting', 'live')).toBe(false)
  })

  it('does not re-measure while steady or while dropping', () => {
    expect(shouldRemeasureClock('live', 'live')).toBe(false)
    expect(shouldRemeasureClock('live', 'reconnecting')).toBe(false)
  })
})

describe('connectionMessage', () => {
  it('says nothing when there is nothing wrong', () => {
    expect(connectionMessage('live')).toBeNull()
    expect(connectionMessage('connecting')).toBeNull()
  })

  it('warns that the room may have moved on', () => {
    // The honest risk is being out of step, not merely being disconnected.
    expect(connectionMessage('offline')).toContain('out of step')
    expect(connectionMessage('reconnecting')).toBe('Reconnecting…')
  })

  it('covers every state', () => {
    const states: ConnectionState[] = ['connecting', 'live', 'reconnecting', 'offline']
    for (const state of states) {
      expect(() => connectionMessage(state)).not.toThrow()
    }
  })
})
