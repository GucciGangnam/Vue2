import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger'
  loading?: boolean
  children: ReactNode
}

export function Button({
  variant = 'primary',
  loading = false,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      // 48px min height: comfortable thumb target on a phone.
      className={cn(
        'inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl px-5',
        'text-base font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-45',
        variant === 'primary' && 'bg-lamp-500 text-ink-950 hover:bg-lamp-400 active:bg-lamp-600',
        variant === 'ghost' && 'bg-ink-850 text-ink-100 hover:bg-ink-800 active:bg-ink-700',
        variant === 'danger' && 'bg-ink-850 text-danger-500 hover:bg-ink-800',
        className,
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  )
}
