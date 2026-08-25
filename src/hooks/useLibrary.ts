/**
 * Library state: the decrypted list, and the upload in flight.
 *
 * The list is a TanStack query keyed on the user. Upload is deliberately *not*
 * a mutation -- it reports progress continuously for minutes at a time, and a
 * mutation's pending flag cannot express "43% through encrypting". It lives in
 * local state with an AbortController beside it instead.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  deleteMedia,
  listLibrary,
  listShares,
  revokeShare,
  shareMedia,
  type LibraryItem,
} from '@/lib/media/library'
import { resumeUpload, uploadMedia, UploadCancelled, type UploadProgress } from '@/lib/media/upload'
import { useSession } from '@/stores/sessionStore'

const libraryKey = (userId: string) => ['library', userId] as const

export function useLibrary() {
  const session = useSession((s) => s.session)
  const identityKey = useSession((s) => s.identityKey)
  const userId = session?.user.id ?? ''
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: libraryKey(userId),
    // Only enabled once the vault is open: without the identity key there is
    // nothing to decrypt the titles with.
    enabled: Boolean(userId && identityKey),
    queryFn: () => listLibrary(userId, identityKey as CryptoKey),
  })

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: libraryKey(userId) })
  }, [queryClient, userId])

  const remove = useMutation({
    mutationFn: (item: LibraryItem) => deleteMedia(item),
    onSuccess: invalidate,
  })

  const share = useMutation({
    mutationFn: (input: { mediaId: string; recipientId: string }) =>
      shareMedia({
        mediaId: input.mediaId,
        ownerId: userId,
        recipientId: input.recipientId,
        identityPrivateKey: identityKey as CryptoKey,
      }),
  })

  const revoke = useMutation({
    mutationFn: (input: { mediaId: string; recipientId: string }) =>
      revokeShare(input.mediaId, input.recipientId),
  })

  return {
    items: query.data ?? [],
    isLoading: query.isPending && Boolean(identityKey),
    error: query.error,
    refresh: invalidate,
    remove,
    share,
    revoke,
  }
}

export function useShares(mediaId: string | null) {
  const session = useSession((s) => s.session)
  const userId = session?.user.id ?? ''

  return useQuery({
    queryKey: ['shares', mediaId],
    enabled: Boolean(mediaId && userId),
    queryFn: () => listShares(mediaId as string, userId),
  })
}

export interface ActiveUpload {
  fileName: string
  progress: UploadProgress
}

export function useUpload(onFinished: () => void) {
  const session = useSession((s) => s.session)
  const identityKey = useSession((s) => s.identityKey)
  const publicKey = useSession((s) => s.publicKey)
  const userId = session?.user.id ?? ''

  const [active, setActive] = useState<ActiveUpload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)

  // An upload that is still running when the screen goes away would keep
  // writing to a cache nobody is reading. Abort it with the component.
  useEffect(() => () => controller.current?.abort(), [])

  const run = useCallback(
    async (fileName: string, work: (signal: AbortSignal) => Promise<unknown>) => {
      setError(null)
      const abort = new AbortController()
      controller.current = abort
      setActive({ fileName, progress: { phase: 'reading', bytesDone: 0, bytesTotal: 1 } })

      try {
        await work(abort.signal)
        onFinished()
      } catch (cause) {
        if (!(cause instanceof UploadCancelled)) {
          setError(cause instanceof Error ? cause.message : 'That upload failed.')
          onFinished()
        }
      } finally {
        controller.current = null
        setActive(null)
      }
    },
    [onFinished],
  )

  const start = useCallback(
    (file: File, title: string) => {
      if (!publicKey) {
        setError('Your keys are still loading. Try again in a moment.')
        return
      }
      void run(file.name, (signal) =>
        uploadMedia({
          file,
          title,
          ownerId: userId,
          identityPublicKey: publicKey,
          signal,
          onProgress: (progress) => setActive({ fileName: file.name, progress }),
        }),
      )
    },
    [publicKey, run, userId],
  )

  const resume = useCallback(
    (mediaId: string, file: File) => {
      void run(file.name, (signal) =>
        resumeUpload({
          mediaId,
          file,
          ownerId: userId,
          identityPrivateKey: identityKey as CryptoKey,
          signal,
          onProgress: (progress) => setActive({ fileName: file.name, progress }),
        }),
      )
    },
    [identityKey, run, userId],
  )

  return {
    active,
    error,
    dismissError: useCallback(() => setError(null), []),
    start,
    resume,
    cancel: useCallback(() => controller.current?.abort(), []),
  }
}
