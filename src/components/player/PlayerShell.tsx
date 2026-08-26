import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Loader2, type LucideIcon } from 'lucide-react'
import { Drawer } from '@/components/player/Drawer'
import { Transport } from '@/components/player/Transport'
import { useReveal } from '@/hooks/useReveal'
import type { StreamStatus } from '@/hooks/useMediaStream'
import { cn } from '@/lib/cn'
import { formatPercent } from '@/lib/format'
import { decideTap } from '@/lib/player/reveal'

/**
 * The screen a video is watched on. One layout, two shapes.
 *
 * **Phone.** The picture fills everything the platform will give us and the
 * chrome floats on top of it, appearing when touched and fading when left
 * alone. The owner's controls are icons down the right-hand edge — thumb side —
 * and each one raises a sheet.
 *
 * **Desktop.** The same panels stop being a sheet and become a column beside
 * the picture, in the space YouTube fills with recommendations. There is room
 * for them there, so hiding them behind a tap would be hiding them for nothing.
 *
 * **Full screen is CSS, never `webkitEnterFullscreen()` (D40.)** Handing the
 * element to Apple's player takes the overlay with it — the transport, the
 * roster, the sync state — and leaves the viewer looking at a UI we do not
 * control while the room carries on without them. So the button is offered
 * only where the real Fullscreen API exists, and the phone gets a layout that
 * fills the viewport with `playsinline` instead.
 */

export interface PlayerPanel {
  id: string
  label: string
  icon: LucideIcon
  badge?: number
  content: ReactNode
}

export function PlayerShell({
  title,
  subtitle,
  src,
  status,
  shared,
  canControl,
  attachVideo,
  onToggle,
  onSeek,
  panels = [],
  notice,
  toast,
  error,
  footnote,
}: {
  title: string
  subtitle?: string | null
  src: string | null
  status: StreamStatus
  /** Whether anybody else is watching. Decides what a tap on the picture means. */
  shared: boolean
  canControl: boolean
  attachVideo?: (element: HTMLVideoElement | null) => void
  onToggle: (shouldPlay: boolean) => void
  onSeek: (seconds: number) => void
  panels?: PlayerPanel[]
  notice?: string | null
  toast?: string | null
  error?: string | null
  footnote?: ReactNode
}) {
  const video = useRef<HTMLVideoElement | null>(null)
  const frame = useRef<HTMLDivElement | null>(null)

  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffering, setBuffering] = useState(false)
  const [scrubbing, setScrubbing] = useState(false)
  const [openPanel, setOpenPanel] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)

  // Anything that would be rude to fade out from under the user.
  const held = scrubbing || openPanel !== null
  const reveal = useReveal({ playing, held })
  const { poke } = reveal

  const setVideo = useCallback(
    (element: HTMLVideoElement | null) => {
      video.current = element
      attachVideo?.(element)
    },
    [attachVideo],
  )

  // D40 again: only offer the button where a real Fullscreen API exists. iOS
  // has none for an element that is not the video, and the video-element one is
  // precisely what we are refusing to call, so the phone gets no button — it
  // does not need one, because this layout already fills the viewport.
  const fullscreenState = document.fullscreenEnabled ? fullscreen : null

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void frame.current?.requestFullscreen().catch(() => {})
  }

  /**
   * The invariant carried forward from Phase 6, via D39: a tap reveals the
   * controls and, when anyone else is watching, never touches playback.
   */
  function onPictureTap() {
    const outcome = decideTap({ controlsVisible: reveal.visible, shared })
    if (outcome.reveal) poke()
    if (outcome.togglePlayback && canControl) onToggle(!playing)
  }

  // Deliberately not "Play"/"Pause": the transport already has a button by
  // that name, and two of them would be indistinguishable to a screen reader.
  const tapLabel =
    !reveal.visible || shared ? 'Show the controls' : playing ? 'Pause the video' : 'Play the video'
  const loading = status.kind === 'opening' || status.kind === 'staging' || buffering
  const chrome = reveal.visible || status.kind !== 'ready'

  return (
    <div
      className="flex h-dvh w-full flex-col overflow-hidden bg-black lg:flex-row"
      onPointerMove={(event) => {
        // Touch already reveals through the tap handler; this is the mouse.
        if (event.pointerType !== 'touch') poke()
      }}
    >
      <div ref={frame} className="relative min-h-0 flex-1 bg-black">
        {src && (
          <video
            ref={setVideo}
            src={src}
            className="absolute inset-0 size-full object-contain"
            playsInline
            controls={false}
            preload="auto"
            onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
            onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onWaiting={() => setBuffering(true)}
            onPlaying={() => setBuffering(false)}
            onCanPlay={() => setBuffering(false)}
          />
        )}

        {/* The picture is a control in its own right, so it is a button:
            a keyboard or switch user reveals the chrome the same way. */}
        <button
          type="button"
          onClick={onPictureTap}
          aria-label={tapLabel}
          className="absolute inset-0 size-full cursor-default"
        />

        {loading && status.kind !== 'error' && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3">
            <Loader2 className="size-7 animate-spin text-lamp-500" aria-label="Loading" />
            {status.kind === 'staging' && (
              <p className="text-sm text-ink-300">
                Decrypting {formatPercent(status.done, status.total)}
              </p>
            )}
          </div>
        )}

        {status.kind === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-sm text-danger-500">{status.message}</p>
            <Link to="/library" className="text-sm text-lamp-500 hover:underline">
              Back to your videos
            </Link>
          </div>
        )}

        {toast && (
          <div className="pointer-events-none absolute inset-x-0 top-16 flex justify-center px-4">
            <span className="rounded-full bg-ink-950/85 px-3 py-1.5 text-xs text-ink-100">
              {toast}
            </span>
          </div>
        )}

        {/* ---- the chrome: everything that fades together ----

            `inert` is not decoration. Fading to `opacity-0` leaves the buttons
            exactly where they were and still hit-testable, so an invisible
            play/pause would sit under the viewer's thumb at the bottom of the
            screen — which is the accidental-pause failure D39's invariant is
            supposed to have made impossible, reintroduced by a CSS property.
            It also keeps invisible controls out of the tab order. */}
        <div
          inert={!chrome}
          className={cn(
            'pointer-events-none absolute inset-0 transition-opacity duration-300',
            chrome ? 'opacity-100' : 'opacity-0',
          )}
        >
          <header className="safe-top pointer-events-auto absolute inset-x-0 top-0 flex items-start gap-3 bg-gradient-to-b from-black/80 to-transparent px-3 pt-3 pb-10">
            <Link
              to="/library"
              aria-label="Back to your videos"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-ink-100 hover:bg-white/10"
            >
              <ArrowLeft className="size-5" aria-hidden />
            </Link>
            <div className="min-w-0 flex-1 pt-2.5">
              <p className="truncate text-sm font-medium text-ink-100">{title}</p>
              {subtitle && <p className="truncate text-xs text-ink-300">{subtitle}</p>}
            </div>
          </header>

          {panels.length > 0 && (
            <nav
              aria-label="Session controls"
              className="pointer-events-auto absolute top-1/2 right-2 flex -translate-y-1/2 flex-col gap-2 lg:hidden"
            >
              {panels.map((panel) => (
                <button
                  key={panel.id}
                  type="button"
                  onClick={() => setOpenPanel(panel.id)}
                  aria-label={panel.label}
                  className="relative inline-flex size-11 items-center justify-center rounded-full bg-ink-950/70 text-ink-100 backdrop-blur hover:bg-ink-950/90"
                >
                  <panel.icon className="size-5" aria-hidden />
                  {panel.badge !== undefined && panel.badge > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-lamp-500 px-1 font-mono text-[10px] leading-4 text-ink-950">
                      {panel.badge}
                    </span>
                  )}
                </button>
              ))}
            </nav>
          )}

          <div className="safe-bottom pointer-events-auto absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-gradient-to-t from-black/85 to-transparent px-3 pt-10 pb-3">
            {notice && (
              <p className="rounded-lg bg-ink-950/70 px-3 py-2 text-xs text-lamp-400">{notice}</p>
            )}
            {error && (
              <p
                role="alert"
                className="rounded-lg bg-ink-950/70 px-3 py-2 text-xs text-danger-500"
              >
                {error}
              </p>
            )}
            <Transport
              playing={playing}
              position={position}
              duration={duration}
              disabled={!canControl || status.kind === 'error'}
              fullscreen={fullscreenState}
              onToggle={() => onToggle(!playing)}
              onSeek={onSeek}
              onScrubStart={() => setScrubbing(true)}
              onScrubEnd={() => setScrubbing(false)}
              onFullscreen={toggleFullscreen}
            />
            {footnote && <div className="text-[11px] text-ink-500">{footnote}</div>}
          </div>
        </div>
      </div>

      {panels.length > 0 && (
        <aside className="hidden w-[22rem] shrink-0 flex-col overflow-y-auto border-l border-ink-850 bg-ink-950 lg:flex">
          {panels.map((panel) => (
            <section key={panel.id} className="flex flex-col gap-3 border-b border-ink-900 p-5">
              <h2 className="flex items-center gap-2 text-sm font-medium text-ink-500">
                <panel.icon className="size-4" aria-hidden />
                {panel.label}
                {panel.badge !== undefined && panel.badge > 0 && (
                  <span className="font-mono text-xs text-ink-700">{panel.badge}</span>
                )}
              </h2>
              {panel.content}
            </section>
          ))}
        </aside>
      )}

      {panels.map((panel) => (
        <Drawer
          key={panel.id}
          open={openPanel === panel.id}
          title={panel.label}
          onClose={() => setOpenPanel(null)}
        >
          {panel.content}
        </Drawer>
      ))}
    </div>
  )
}
