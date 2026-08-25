import { cn } from '@/lib/cn'

/**
 * Identity without a photo upload. `avatar_hue` is derived from the user id at
 * signup, so everyone gets a stable colour nobody had to choose, and the same
 * hue is what Phase 7 will draw their ink strokes in.
 *
 * The colour has to be an inline style: Tailwind generates classes ahead of
 * time and cannot produce one per hue.
 */
export function Avatar({
  name,
  hue,
  size = 'md',
}: {
  name: string
  hue: number
  size?: 'md' | 'lg'
}) {
  const initial = [...name.trim()][0]?.toUpperCase() ?? '?'

  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium',
        size === 'lg' ? 'size-12 text-lg' : 'size-10 text-base',
      )}
      style={{
        backgroundColor: `oklch(0.42 0.09 ${hue})`,
        color: `oklch(0.94 0.03 ${hue})`,
      }}
    >
      {initial}
    </span>
  )
}
