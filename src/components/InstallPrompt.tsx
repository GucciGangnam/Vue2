import { useEffect, useState } from 'react'
import { Download, Share, X } from 'lucide-react'
import {
  installMethod,
  isIosSafari,
  isStandalone,
  readDismissed,
  rememberDismissed,
  type BeforeInstallPromptEvent,
  type InstallMethod,
} from '@/lib/pwa/install'

/**
 * Offers to put the app on the home screen, and on iOS explains how, since
 * Safari has no programmatic install.
 *
 * Installed matters here beyond tidiness: the locked player and the hold
 * gesture are phone interactions, and a standalone window loses the browser
 * chrome that a full-screen video otherwise fights with.
 */
export function InstallPrompt() {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [dismissed, setDismissed] = useState(() => readDismissed())

  useEffect(() => {
    const onBeforeInstall = (event: Event) => {
      // Must be suppressed and kept: Chromium gives no second chance to
      // replay it later in this page load.
      event.preventDefault()
      setPrompt(event as BeforeInstallPromptEvent)
    }
    const onInstalled = () => setPrompt(null)

    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const method: InstallMethod = installMethod({
    hasPrompt: prompt !== null,
    standalone: isStandalone(),
    iosSafari: isIosSafari(navigator.userAgent, navigator.maxTouchPoints),
    dismissed,
  })

  if (method === 'none') return null

  function dismiss() {
    rememberDismissed()
    setDismissed(true)
  }

  async function install() {
    if (!prompt) return
    await prompt.prompt()
    const { outcome } = await prompt.userChoice
    setPrompt(null)
    // "Not now" is an answer. Asking again on the next visit is nagging.
    if (outcome === 'dismissed') dismiss()
  }

  return (
    <aside className="flex items-start gap-3 rounded-xl border border-ink-800 bg-ink-900 p-3">
      <Download className="mt-0.5 size-5 shrink-0 text-lamp-500" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink-100">Add Vue2 to your home screen</p>
        {method === 'manual-ios' ? (
          <p className="mt-1 flex flex-wrap items-center gap-x-1 text-xs text-ink-500">
            Tap <Share className="inline size-3.5 align-text-bottom" aria-label="Share" /> Share,
            then “Add to Home Screen”.
          </p>
        ) : (
          <button
            onClick={() => void install()}
            className="mt-2 min-h-11 rounded-xl bg-lamp-500 px-4 text-sm font-medium text-ink-950 hover:bg-lamp-400"
          >
            Install
          </button>
        )}
      </div>
      <button
        onClick={dismiss}
        aria-label="Not now"
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-ink-500 hover:bg-ink-850 hover:text-ink-300"
      >
        <X className="size-4" aria-hidden />
      </button>
    </aside>
  )
}
