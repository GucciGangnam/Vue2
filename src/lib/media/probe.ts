/**
 * Reading a video before it is encrypted.
 *
 * Duration, dimensions and the poster frame all have to be extracted here, on
 * the device, while we still hold the plaintext. Once the file is uploaded the
 * server has ciphertext and could not generate a thumbnail even if we asked it
 * to -- which is the point, but it does mean this is the only chance.
 */

const POSTER_MAX_WIDTH = 640
const POSTER_QUALITY = 0.72

/** How long to wait for the browser to decode enough of the file to answer. */
const METADATA_TIMEOUT_MS = 20_000
const SEEK_TIMEOUT_MS = 15_000

export interface VideoProbe {
  durationMs: number
  width: number
  height: number
  /** JPEG bytes, or null if a frame could not be captured. */
  posterJpeg: Uint8Array | null
  /**
   * False when the browser could read the file but could not seek in it --
   * usually a progressive MP4 whose moov atom is at the end. It will still
   * upload and play, but seeking will be poor until it is remuxed.
   */
  seekable: boolean
}

export class UnreadableVideoError extends Error {
  constructor(message = 'This file could not be read as a video') {
    super(message)
    this.name = 'UnreadableVideoError'
  }
}

export async function probeVideo(file: File): Promise<VideoProbe> {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.preload = 'metadata'
  video.muted = true
  // Required on iOS or the element refuses to decode without a user gesture.
  video.playsInline = true
  video.src = url

  try {
    await once(video, 'loadedmetadata', METADATA_TIMEOUT_MS)

    const durationMs = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0
    const width = video.videoWidth
    const height = video.videoHeight
    if (width === 0 || height === 0) throw new UnreadableVideoError()

    const poster = await capturePoster(video)
    return {
      durationMs,
      width,
      height,
      posterJpeg: poster,
      seekable: poster !== null && video.seekable.length > 0,
    }
  } catch (cause) {
    if (cause instanceof UnreadableVideoError) throw cause
    throw new UnreadableVideoError()
  } finally {
    video.src = ''
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

/**
 * Grab a frame a little way in. The first frame of a video is very often black
 * or a fade-in, which makes for a useless poster.
 *
 * A failure here is not fatal: the thumbnail columns are nullable and a library
 * card without a picture is much better than an upload that refuses to start.
 */
async function capturePoster(video: HTMLVideoElement): Promise<Uint8Array | null> {
  try {
    const target = Math.min(video.duration * 0.1, 3)
    video.currentTime = Number.isFinite(target) ? target : 0
    await once(video, 'seeked', SEEK_TIMEOUT_MS)

    const scale = Math.min(1, POSTER_MAX_WIDTH / video.videoWidth)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale))

    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(video, 0, 0, canvas.width, canvas.height)

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', POSTER_QUALITY),
    )
    if (!blob) return null
    return new Uint8Array(await blob.arrayBuffer())
  } catch {
    return null
  }
}

/**
 * Resolve on the next `event`, reject on `error` or after `timeoutMs`.
 *
 * The timeout matters: a media element that cannot decode a file sometimes
 * fires nothing at all rather than an error, and without this the upload would
 * simply hang with no explanation.
 */
function once(video: HTMLVideoElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener(event, onEvent)
      video.removeEventListener('error', onError)
      clearTimeout(timer)
    }
    const onEvent = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new UnreadableVideoError())
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new UnreadableVideoError('Timed out reading this video'))
    }, timeoutMs)

    video.addEventListener(event, onEvent, { once: true })
    video.addEventListener('error', onError, { once: true })
  })
}
