import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * The sheet that slides up over the player on a phone.
 *
 * Mobile only: on a wide screen the same panels live permanently in the
 * sidebar, where YouTube would put recommendations, and a drawer over the top
 * of that would be hiding one thing behind another for no reason.
 *
 * It stays mounted while closed so the slide runs in both directions — a
 * component that unmounts on close animates in and vanishes out, which reads
 * as a bug. Closed, it is inert: no pointer events, and out of the
 * accessibility tree.
 */
export function Drawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}) {
  const close = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    close.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <div
      className={cn('fixed inset-0 z-50 lg:hidden', !open && 'pointer-events-none')}
      aria-hidden={!open}
      {...(open ? { role: 'dialog', 'aria-modal': true, 'aria-label': title } : {})}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        onClick={onClose}
        className={cn(
          'absolute inset-0 bg-ink-950/70 transition-opacity duration-300',
          open ? 'opacity-100' : 'opacity-0',
        )}
      />

      <div
        className={cn(
          'safe-bottom absolute inset-x-0 bottom-0 flex max-h-[80dvh] flex-col',
          'rounded-t-2xl border-t border-ink-800 bg-ink-900 shadow-2xl',
          'transition-transform duration-300 ease-out',
          open ? 'translate-y-0' : 'translate-y-full',
        )}
      >
        {/* The grab handle is decoration — the sheet is dismissed by the
            close button, the backdrop or Escape, all of which work for
            somebody who cannot drag. */}
        <div className="flex justify-center pt-2" aria-hidden>
          <span className="h-1 w-10 rounded-full bg-ink-700" />
        </div>

        <div className="flex items-center justify-between gap-4 px-5 pt-2 pb-1">
          <h2 className="text-lg font-medium text-ink-100">{title}</h2>
          <button
            ref={close}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-ink-500 hover:text-ink-100"
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>

        <div className="overflow-y-auto px-5 pt-2 pb-5">{children}</div>
      </div>
    </div>
  )
}
