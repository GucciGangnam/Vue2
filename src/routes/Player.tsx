import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Loader2, Pause, Play } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { formatDuration, formatPercent } from '@/lib/format'
import { listenForStreamRenewals, openStream, type OpenStream } from '@/lib/media/playback'
import { useSession } from '@/stores/sessionStore'

type Status =
  | { kind: 'opening' }
  | { kind: 'staging'; done: number; total: number }
  | { kind: 'ready'; mode: OpenStream['mode'] }
  | { kind: 'error'; message: string }

export function Player() {
  const { mediaId = '' } = useParams()
  const navigate = useNavigate()
  const session = useSession((s) => s.session)
  const identityKey = useSession((s) => s.identityKey)
  const userId = session?.user.id ?? ''

  const video = useRef<HTMLVideoElement>(null)
  const [status, setStatus] = useState<Status>({ kind: 'opening' })
  const [src, setSrc] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffering, setBuffering] = useState(false)

  // The worker cannot mint signed URLs; it asks the page. Listen for as long as
  // this screen is mounted.
  useEffect(listenForStreamRenewals, [])

  useEffect(() => {
    if (!mediaId || !userId || !identityKey) return

    let stream: OpenStream | null = null
    let cancelled = false
    const abort = new AbortController()

    void (async () => {
      try {
        const opened = await openStream({
          mediaId,
          userId,
          identityPrivateKey: identityKey,
          signal: abort.signal,
          onProgress: (done, total) => {
            if (!cancelled) setStatus({ kind: 'staging', done, total })
          },
        })
        if (cancelled) {
          void opened.release()
          return
        }
        stream = opened
        setSrc(opened.src)
        setStatus({ kind: 'ready', mode: opened.mode })
      } catch (cause) {
        if (!cancelled) {
          setStatus({
            kind: 'error',
            message: cause instanceof Error ? cause.message : 'Could not open that video.',
          })
        }
      }
    })()

    return () => {
      cancelled = true
      abort.abort()
      void stream?.release()
    }
  }, [mediaId, userId, identityKey])

  const toggle = useCallback(() => {
    const element = video.current
    if (!element) return
    if (element.paused) void element.play().catch(() => setPlaying(false))
    else element.pause()
  }, [])

  function onSeek(event: React.ChangeEvent<HTMLInputElement>) {
    const element = video.current
    if (!element) return
    const next = Number(event.target.value)
    element.currentTime = next
    setPosition(next)
  }

  return (
    <main className="safe-top safe-bottom mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <Link
        to="/library"
        className="-ml-1 inline-flex items-center gap-1.5 self-start rounded-lg py-1 pr-2 pl-1 text-sm text-ink-500 hover:text-ink-300"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Library
      </Link>

      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black">
        {src && (
          <video
            ref={video}
            src={src}
            className="size-full"
            playsInline
            controls={false}
            preload="metadata"
            onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
            onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onWaiting={() => setBuffering(true)}
            onPlaying={() => setBuffering(false)}
            onCanPlay={() => setBuffering(false)}
            onError={() =>
              setStatus({ kind: 'error', message: 'This video could not be decoded.' })
            }
            onClick={toggle}
          />
        )}

        {(status.kind === 'opening' || status.kind === 'staging' || buffering) &&
          status.kind !== 'error' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60">
              <Loader2 className="size-6 animate-spin text-lamp-500" aria-label="Loading" />
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
            <Button variant="ghost" onClick={() => navigate('/library')} className="w-auto px-4">
              Back to library
            </Button>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={toggle}
          disabled={status.kind !== 'ready'}
          aria-label={playing ? 'Pause' : 'Play'}
          className="inline-flex size-12 shrink-0 items-center justify-center rounded-xl bg-lamp-500 text-ink-950 hover:bg-lamp-400 disabled:opacity-45"
        >
          {playing ? (
            <Pause className="size-5" aria-hidden />
          ) : (
            <Play className="size-5" aria-hidden />
          )}
        </button>

        <input
          type="range"
          min={0}
          max={duration || 0}
          step="any"
          value={position}
          onChange={onSeek}
          disabled={status.kind !== 'ready' || duration === 0}
          aria-label="Seek"
          className="h-11 flex-1 accent-lamp-500 disabled:opacity-45"
        />

        <p className="shrink-0 font-mono text-xs text-ink-500 tabular-nums">
          {formatDuration(position * 1000)} / {formatDuration(duration * 1000)}
        </p>
      </div>

      {status.kind === 'ready' && (
        <p className="text-center text-xs text-ink-700">
          {status.mode === 'service-worker'
            ? 'Decrypting on demand — only the parts you watch are ever decrypted.'
            : 'Decrypted in full on this device, because this browser does not route video through a service worker.'}
        </p>
      )}
    </main>
  )
}
