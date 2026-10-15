import { useId } from 'react'
import { Minus, Plus } from 'lucide-react'
import { cn } from '@/lib/cn'
import { haptic } from '@/lib/share'

/**
 * Touch-optimised 1.0–10.0 score control (0.5 steps) with an explicit N/A option.
 * value: number = scored, null = N/A, undefined = untouched (also treated as not rated).
 */
export function ScoreSlider({
  label,
  description,
  value,
  onChange,
  allowNA = true,
  compact,
}: {
  label: string
  description?: string
  value: number | null | undefined
  onChange: (v: number | null | undefined) => void
  allowNA?: boolean
  compact?: boolean
}) {
  const id = useId()
  const scored = typeof value === 'number'
  const shown = scored ? value : 7
  const fill = `${((shown - 1) / 9) * 100}%`
  const set = (v: number) => {
    const clamped = Math.min(10, Math.max(1, Math.round(v * 2) / 2))
    if (clamped !== value) haptic(5)
    onChange(clamped)
  }

  return (
    <div className={cn('rounded-card bg-white px-4 shadow-card', compact ? 'py-3' : 'py-4')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <label htmlFor={id} className="block text-[16px] font-extrabold text-choc">
            {label}
          </label>
          {description && !compact && <p className="text-[13px] leading-snug text-muted">{description}</p>}
        </div>
        <output
          htmlFor={id}
          className={cn(
            'tabular flex h-10 min-w-14 items-center justify-center rounded-full px-3 text-lg font-extrabold',
            scored ? 'bg-butter text-choc' : value === null ? 'bg-beige text-muted' : 'bg-cream-deep text-muted-soft',
          )}
          aria-live="polite"
        >
          {scored ? value.toFixed(1) : value === null ? 'N/A' : '–'}
        </output>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button type="button" aria-label={`Lower ${label}`} onClick={() => set((scored ? value : 7) - 0.5)} className="press flex size-10 shrink-0 items-center justify-center rounded-full bg-cream-deep text-choc">
          <Minus className="size-4" />
        </button>
        <input
          id={id}
          type="range"
          min={1}
          max={10}
          step={0.5}
          value={shown}
          aria-valuetext={scored ? `${value.toFixed(1)} out of 10` : value === null ? 'Not applicable' : 'Not rated'}
          onChange={(e) => set(Number(e.target.value))}
          onPointerDown={() => !scored && onChange(shown)}
          className="score-range"
          data-untouched={!scored || undefined}
          style={{ ['--fill' as string]: scored ? fill : '0%' }}
        />
        <button type="button" aria-label={`Raise ${label}`} onClick={() => set((scored ? value : 7) + 0.5)} className="press flex size-10 shrink-0 items-center justify-center rounded-full bg-cream-deep text-choc">
          <Plus className="size-4" />
        </button>
      </div>
      {allowNA && (
        <div className="mt-1 flex justify-end">
          <button
            type="button"
            aria-pressed={value === null}
            onClick={() => onChange(value === null ? undefined : null)}
            className={cn('press rounded-full px-3 py-1 text-xs font-bold', value === null ? 'bg-choc text-cream' : 'text-muted hover:bg-cream-deep')}
          >
            {value === null ? 'Marked N/A' : "Didn't have it · N/A"}
          </button>
        </div>
      )}
    </div>
  )
}
