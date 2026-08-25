/** Display helpers shared by the library and player screens. */

const UNITS = ['B', 'KB', 'MB', 'GB'] as const

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  // Bytes and kilobytes are noise below the decimal point; megabytes upward
  // read better with one.
  const decimals = unit >= 2 && value < 100 ? 1 : 0
  return `${value.toFixed(decimals)} ${UNITS[unit]}`
}

/** `h:mm:ss` past an hour, `m:ss` below it. */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '—'
  const total = Math.round(milliseconds / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60

  const pad = (n: number) => n.toString().padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

export function formatPercent(done: number, total: number): string {
  if (total <= 0) return '0%'
  return `${Math.min(100, Math.floor((done / total) * 100))}%`
}
