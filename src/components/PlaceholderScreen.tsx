import { Lock } from 'lucide-react'

/**
 * Temporary scaffold screen so routes are navigable before their phase lands.
 * Delete once every route has a real implementation.
 */
export function PlaceholderScreen({ title, phase }: { title: string; phase: string }) {
  return (
    <main className="safe-top safe-bottom flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
      <Lock className="size-7 text-lamp-500" aria-hidden />
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-ink-500">Arrives in {phase}</p>
    </main>
  )
}
