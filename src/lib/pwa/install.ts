/**
 * Installing the app to a home screen.
 *
 * Two browsers, two entirely different mechanisms, and the difference is not
 * cosmetic:
 *
 *   * Chromium fires `beforeinstallprompt`, which must be captured and its
 *     default suppressed, then replayed later from a user gesture. Miss the
 *     event and there is no second chance in that page load.
 *   * **iOS Safari has no such event and no programmatic install at all.** The
 *     only route is Share -> Add to Home Screen, done by hand. Since iOS is the
 *     platform this app most wants to be installed on -- a locked player and a
 *     hold gesture are phone features -- "no prompt available" must mean
 *     "explain how", not "hide the option".
 *
 * Framework-free so the rules stay testable without a DOM event loop.
 */

/** The Chromium-only event. Not in TypeScript's DOM library. */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export type InstallMethod =
  /** Chromium: a real prompt is waiting to be replayed. */
  | 'prompt'
  /** iOS Safari: tell the user where the button is. */
  | 'manual-ios'
  /** Already installed, or nothing useful to offer. */
  | 'none'

const DISMISSED_KEY = 'vue2:install-dismissed'

/** Running from a home-screen icon rather than a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true
  // The non-standard iOS flag, which is the only signal Safari gives.
  return (window.navigator as { standalone?: boolean }).standalone === true
}

/**
 * iOS Safari, including iPadOS pretending to be a Mac.
 *
 * The iPad check is the awkward one: iPadOS reports a desktop Mac user agent,
 * so it is separated from a real Mac by the presence of touch points.
 */
export function isIosSafari(userAgent: string, maxTouchPoints: number): boolean {
  const isIosDevice =
    /iPad|iPhone|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)
  if (!isIosDevice) return false
  // Chrome and Firefox on iOS are WebKit underneath but have no Add to Home
  // Screen of their own, so offering the Safari instructions there would be
  // telling the user to do something they cannot do.
  return !/CriOS|FxiOS|EdgiOS|OPiOS/.test(userAgent)
}

/**
 * What, if anything, to offer this visitor.
 *
 * A captured prompt wins wherever it exists. Being installed already, or
 * having said no, means offering nothing at all.
 */
export function installMethod(options: {
  hasPrompt: boolean
  standalone: boolean
  iosSafari: boolean
  dismissed: boolean
}): InstallMethod {
  if (options.standalone || options.dismissed) return 'none'
  if (options.hasPrompt) return 'prompt'
  if (options.iosSafari) return 'manual-ios'
  return 'none'
}

export function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === 'true'
  } catch {
    // Private browsing, or storage disabled. Not being able to remember the
    // dismissal is not a reason to fail.
    return false
  }
}

export function rememberDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, 'true')
  } catch {
    /* as above */
  }
}
