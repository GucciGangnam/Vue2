import { Maximize, Minimize, Pause, Play } from 'lucide-react'
import { formatClock } from '@/lib/format'
import { cn } from '@/lib/cn'

/**
 * Play/pause, scrub, position. The only way playback moves.
 *
 * That last part is the point rather than an implementation note: since D39
 * retired the three-second hold, this button *is* the protection against a
 * stray thumb pausing a film for everybody. Tapping the picture reveals these
 * controls and does nothing else — see `lib/player/reveal`.
 *
 * Rendered without handlers it comes out inert, which is what a viewer sees
 * when the owner has taken control for themselves. One component either way,
 * because two would drift apart.
 */
export function Transport({
  playing,
  position,
  duration,
  disabled = false,
  fullscreen,
  onToggle,
  onSeek,
  onScrubStart,
  onScrubEnd,
  onFullscreen,
}: {
  playing: boolean
  position: number
  duration: number
  disabled?: boolean
  /** `null` where the platform has no full screen we are willing to use (D40). */
  fullscreen: boolean | null
  onToggle?: () => void
  onSeek?: (seconds: number) => void
  onScrubStart?: () => void
  onScrubEnd?: () => void
  onFullscreen?: () => void
}) {
  const inert = disabled || !onToggle

  return (
    <div className="flex flex-col gap-1">
      <input
        type="range"
        min={0}
        max={duration || 0}
        step="any"
        value={Math.min(position, duration || 0)}
        onChange={(event) => onSeek?.(Number(event.target.value))}
        onPointerDown={onScrubStart}
        onPointerUp={onScrubEnd}
        onPointerCancel={onScrubEnd}
        onFocus={onScrubStart}
        onBlur={onScrubEnd}
        disabled={inert || duration === 0}
        aria-label="Seek"
        className="h-8 w-full cursor-pointer accent-lamp-500 disabled:cursor-not-allowed disabled:opacity-45"
      />

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onToggle}
          disabled={inert}
          aria-label={playing ? 'Pause' : 'Play'}
          className={cn(
            'inline-flex size-12 shrink-0 items-center justify-center rounded-full',
            'bg-lamp-500 text-ink-950 transition-colors hover:bg-lamp-400 active:bg-lamp-600',
            'disabled:cursor-not-allowed disabled:opacity-45',
          )}
        >
          {playing ? (
            <Pause className="size-5" aria-hidden />
          ) : (
            <Play className="size-5 translate-x-px" aria-hidden />
          )}
        </button>

        <p className="font-mono text-xs text-ink-300 tabular-nums">
          {formatClock(position)}
          <span className="text-ink-500"> / {formatClock(duration)}</span>
        </p>

        {fullscreen !== null && (
          <button
            type="button"
            onClick={onFullscreen}
            aria-label={fullscreen ? 'Leave full screen' : 'Full screen'}
            className="ml-auto inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-ink-300 transition-colors hover:bg-white/10 hover:text-ink-100"
          >
            {fullscreen ? (
              <Minimize className="size-5" aria-hidden />
            ) : (
              <Maximize className="size-5" aria-hidden />
            )}
          </button>
        )}
      </div>
    </div>
  )
}
