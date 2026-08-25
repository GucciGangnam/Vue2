import { describe, expect, it } from 'vitest'
import { formatBytes, formatDuration, formatPercent } from './format'

describe('formatBytes', () => {
  it('keeps small sizes whole', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1024)).toBe('1 KB')
  })

  it('shows one decimal from megabytes up, until the number is large', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(350 * 1024 * 1024)).toBe('350 MB')
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB')
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB')
  })

  it('does not invent a unit past gigabytes', () => {
    expect(formatBytes(5 * 1024 ** 4)).toBe('5120 GB')
  })

  it('refuses nonsense rather than printing NaN', () => {
    expect(formatBytes(-1)).toBe('—')
    expect(formatBytes(Number.NaN)).toBe('—')
  })
})

describe('formatDuration', () => {
  it('reads as m:ss below an hour', () => {
    expect(formatDuration(1000)).toBe('0:01')
    expect(formatDuration(61_000)).toBe('1:01')
    expect(formatDuration(59 * 60_000 + 59_000)).toBe('59:59')
  })

  it('adds hours once there are any', () => {
    expect(formatDuration(3_600_000)).toBe('1:00:00')
    expect(formatDuration(5_400_000)).toBe('1:30:00')
  })

  it('has something to show for an unknown duration', () => {
    expect(formatDuration(0)).toBe('—')
    expect(formatDuration(Number.NaN)).toBe('—')
  })
})

describe('formatPercent', () => {
  it('floors, so nothing reads 100% before it is done', () => {
    expect(formatPercent(0, 100)).toBe('0%')
    expect(formatPercent(999, 1000)).toBe('99%')
    expect(formatPercent(1000, 1000)).toBe('100%')
  })

  it('never exceeds 100, even if a source over-reports', () => {
    expect(formatPercent(120, 100)).toBe('100%')
  })

  it('copes with a total of zero', () => {
    expect(formatPercent(0, 0)).toBe('0%')
  })
})
