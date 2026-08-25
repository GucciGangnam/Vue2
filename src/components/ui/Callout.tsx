import type { ReactNode } from 'react'
import { AlertTriangle, Info } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * Used for the consequences the user genuinely has to read -- chiefly that a
 * lost recovery phrase means lost media. Deliberately not dismissible.
 */
export function Callout({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warning'
  children: ReactNode
}) {
  const Icon = tone === 'warning' ? AlertTriangle : Info
  return (
    <div
      className={cn(
        'flex gap-3 rounded-xl border p-4 text-sm leading-relaxed',
        tone === 'warning'
          ? 'border-lamp-600/40 bg-lamp-600/10 text-lamp-400'
          : 'border-ink-800 bg-ink-900 text-ink-300',
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  )
}
