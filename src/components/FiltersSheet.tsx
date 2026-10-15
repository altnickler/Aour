import { useState, type ReactNode } from 'react'
import { DEFAULT_FILTERS, type DiscoveryFilters, type DiscoverySort } from '@/core/discovery'
import { DAY_SHORT } from '@/core/schedule'
import { ESTABLISHMENT_KINDS } from '@/core/listing'
import { TAGS } from '@/core/categories'
import { useLocationState } from '@/app/location'
import { Button, Chip, Sheet, Toggle } from './ui'

const TIMES = [
  { label: 'Any time', value: null },
  { label: '3pm', value: 15 * 60 },
  { label: '4pm', value: 16 * 60 },
  { label: '5pm', value: 17 * 60 },
  { label: '6pm', value: 18 * 60 },
  { label: '9pm+', value: 21 * 60 },
]

const SORTS: { key: DiscoverySort; label: string }[] = [
  { key: 'recommended', label: 'Recommended' },
  { key: 'rating', label: 'Top rated' },
  { key: 'distance', label: 'Closest' },
  { key: 'ending_soon', label: 'Ending soon' },
  { key: 'name', label: 'A–Z' },
]

export function FiltersSheet({
  open,
  onClose,
  filters,
  sort,
  onApply,
}: {
  open: boolean
  onClose: () => void
  filters: DiscoveryFilters
  sort: DiscoverySort
  onApply: (f: DiscoveryFilters, s: DiscoverySort) => void
}) {
  const { market, origin } = useLocationState()
  const [f, setF] = useState(filters)
  const [s, setS] = useState(sort)
  const [syncedOpen, setSyncedOpen] = useState(open)
  if (open !== syncedOpen) {
    // Reset the draft each time the sheet opens.
    setSyncedOpen(open)
    if (open) {
      setF(filters)
      setS(sort)
    }
  }
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Filters"
      footer={
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => { setF({ ...DEFAULT_FILTERS, query: f.query }); setS('recommended') }}>
            Reset
          </Button>
          <Button block onClick={() => { onApply(f, s); onClose() }}>
            Show results
          </Button>
        </div>
      }
    >
      <div className="space-y-6 py-2">
        <Group title="Sort by">
          {SORTS.map((o) => (
            <Chip key={o.key} selected={s === o.key} onClick={() => setS(o.key)} disabled={o.key === 'distance' && !origin && !market}>
              {o.label}
            </Chip>
          ))}
        </Group>

        <Group title="When">
          {(
            [
              ['any', 'Any day'],
              ['now', 'Happening now'],
              ['today', 'Later today'],
              ['day', 'Pick a day'],
            ] as const
          ).map(([k, label]) => (
            <Chip key={k} selected={f.when === k} onClick={() => setF({ ...f, when: k })}>
              {label}
            </Chip>
          ))}
        </Group>
        {f.when === 'day' && (
          <>
            <Group title="Day">
              {DAY_SHORT.map((d, i) => (
                <Chip key={d} selected={f.day === i} onClick={() => setF({ ...f, day: i })}>
                  {d}
                </Chip>
              ))}
            </Group>
            <Group title="Time">
              {TIMES.map((t) => (
                <Chip key={t.label} selected={f.time === t.value} onClick={() => setF({ ...f, time: t.value })}>
                  {t.label}
                </Chip>
              ))}
            </Group>
          </>
        )}

        <Group title="Distance">
          {[null, 1, 3, 5, 10].map((m) => (
            <Chip key={String(m)} selected={f.maxMiles === m} onClick={() => setF({ ...f, maxMiles: m })}>
              {m === null ? 'Any' : `${m} mi`}
            </Chip>
          ))}
          {!origin && <p className="w-full text-xs text-muted">Measured from the {market?.name ?? 'area'} center unless you share your location.</p>}
        </Group>

        <Group title="Community rating">
          {[null, 7, 8, 8.5].map((r) => (
            <Chip key={String(r)} selected={f.minRating === r} onClick={() => setF({ ...f, minRating: r })}>
              {r === null ? 'Any' : `${r}+`}
            </Chip>
          ))}
        </Group>

        <Group title="Type of place">
          {ESTABLISHMENT_KINDS.filter((k) => k.key !== 'other').map((k) => (
            <Chip key={k.key} selected={f.kinds.includes(k.key)} onClick={() => setF({ ...f, kinds: toggle(f.kinds, k.key) })}>
              {k.label}
            </Chip>
          ))}
        </Group>

        <Group title="Vibe">
          {TAGS.map((t) => (
            <Chip key={t.key} selected={f.tags.includes(t.key)} onClick={() => setF({ ...f, tags: toggle(f.tags, t.key) })}>
              <span aria-hidden>{t.emoji}</span> {t.label}
            </Chip>
          ))}
        </Group>

        {market && (
          <Group title="Area">
            <Chip selected={!f.area} onClick={() => setF({ ...f, area: null })}>
              Everywhere
            </Chip>
            {market.areas.map((a) => (
              <Chip key={a} selected={f.area === a} onClick={() => setF({ ...f, area: a })}>
                {a}
              </Chip>
            ))}
          </Group>
        )}

        <div className="rounded-card bg-white px-4 shadow-card">
          <Toggle checked={f.verifiedOnly} onChange={(v) => setF({ ...f, verifiedOnly: v })} label="Recently verified only" description="Happy-hour details confirmed in the last 90 days" />
        </div>
      </div>
    </Sheet>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-bold tracking-wide text-muted uppercase">{title}</legend>
      <div className="flex flex-wrap gap-2">{children}</div>
    </fieldset>
  )
}
