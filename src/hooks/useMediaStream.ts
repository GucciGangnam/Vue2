/**
 * Opening a video for playback, in one place.
 *
 * Both the solo screen and the shared one need exactly this, and before this
 * phase they each had their own copy -- which is how the shared one ended up
 * without `listenForStreamRenewals`. The worker cannot mint signed URLs
 * because it has no session, so when one expires it asks the page; a screen
 * that is not listening simply stops being able to fetch chunks, some minutes
 * in, for no visible reason. One hook, one behaviour.
 */

import { useEffect, useState } from 'react'
import { listenForStreamRenewals, openStream, type OpenStream } from '@/lib/media/playback'
import { useSession } from '@/stores/sessionStore'

export type StreamStatus =
  | { kind: 'opening' }
  /** WebKit decrypts the whole file before playing (D26, D31). It takes a while; say so. */
  | { kind: 'staging'; done: number; total: number }
  | { kind: 'ready'; mode: OpenStream['mode'] }
  | { kind: 'error'; message: string }

export interface MediaStream {
  src: string | null
  status: StreamStatus
}

export function useMediaStream(mediaId: string): MediaStream {
  const session = useSession((s) => s.session)
  const identityKey = useSession((s) => s.identityKey)
  const userId = session?.user.id ?? ''

  const [src, setSrc] = useState<string | null>(null)
  const [status, setStatus] = useState<StreamStatus>({ kind: 'opening' })

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

  return { src, status }
}
