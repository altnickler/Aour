import { useEffect, useId, useState } from 'react'
import { Search as SearchIcon } from 'lucide-react'
import { useGeocode } from '@/data/hooks'
import type { GeoResult } from '@/data/api'
import { Input } from './ui'

/**
 * City / address search — the fallback when location is off, and the way to look beyond the
 * launch market. Queries go out only while the user types (debounced, ≥ 3 characters).
 */
export function PlaceSearch({ onPick, autoFocus }: { onPick: (r: GeoResult) => void; autoFocus?: boolean }) {
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const id = useId()
  useEffect(() => {
    const t = setTimeout(() => setQuery(text), 350)
    return () => clearTimeout(t)
  }, [text])
  const geo = useGeocode(query)
  const results = geo.data?.results ?? []

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-bold text-muted uppercase">
        Search a city or address
      </label>
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <Input
          id={id}
          type="search"
          inputMode="search"
          autoComplete="off"
          autoFocus={autoFocus}
          placeholder="e.g. Jensen Beach, FL"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="pl-10"
          aria-describedby={`${id}-status`}
        />
      </div>
      <p id={`${id}-status`} className="mt-1.5 text-xs text-muted" role="status">
        {query.trim().length >= 3 && geo.isFetching
          ? 'Searching…'
          : geo.isError
            ? (geo.error as Error).message
            : query.trim().length >= 3 && geo.data && !results.length
              ? 'No matches. Try a city name.'
              : ''}
      </p>
      {results.length > 0 && (
        <ul className="mt-1 overflow-hidden rounded-tile bg-white ring-1 ring-line" aria-label="Search results">
          {results.map((r) => (
            <li key={`${r.lat},${r.lng},${r.label}`}>
              <button type="button" onClick={() => onPick(r)} className="press w-full border-b border-line px-4 py-3 text-left last:border-0 hover:bg-cream">
                <span className="block truncate font-semibold text-choc">{r.label}</span>
                <span className="text-xs text-muted capitalize">{r.kind}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {geo.data?.attribution && results.length > 0 && <p className="mt-1 text-[11px] text-muted">{geo.data.attribution}</p>}
    </div>
  )
}
