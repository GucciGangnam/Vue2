import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/** Centred, width-capped column. Every full-page screen sits in one of these. */
export function Screen({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <main
      className={cn(
        'safe-top safe-bottom mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-6 py-10',
        className,
      )}
    >
      {children}
    </main>
  )
}

export function ScreenHeader({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <header className="flex flex-col gap-2">
      <h1 className="text-3xl font-semibold tracking-tight text-ink-100">{title}</h1>
      {subtitle && <p className="text-base leading-relaxed text-ink-500">{subtitle}</p>}
    </header>
  )
}
