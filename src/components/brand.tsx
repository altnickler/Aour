import { cn } from '@/lib/cn'

/**
 * Aour wordmark + mark.
 *
 * PLACEHOLDER: no logo files were found in the repository, so this renders a simple
 * typographic mark in the brand palette. Drop the official assets into public/brand/
 * (logo.svg, mark.svg) and swap them in here — see README → "Brand assets".
 */
export function Logo({ className, size = 28 }: { className?: string; size?: number }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)} aria-label="Aour">
      <Mark size={size} />
      <span className="font-extrabold tracking-tight text-choc" style={{ fontSize: size * 0.86 }} aria-hidden>
        aour
      </span>
    </span>
  )
}

export function Mark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden className={className}>
      <rect width="64" height="64" rx="18" fill="#3B251B" />
      <circle cx="32" cy="35" r="17" fill="#FFDE75" />
      <path d="M15 35h34" stroke="#3B251B" strokeWidth="4" strokeLinecap="round" />
      <circle cx="44" cy="20" r="5" fill="#F4B942" />
    </svg>
  )
}
