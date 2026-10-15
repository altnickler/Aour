import { useSyncExternalStore } from 'react'
import { DEFAULT_FILTERS, type DiscoveryFilters, type DiscoverySort } from '@/core/discovery'

/** Search/Map share one filter state for the session (so switching views keeps context). */
interface FilterState {
  filters: DiscoveryFilters
  sort: DiscoverySort
}

let state: FilterState = { filters: { ...DEFAULT_FILTERS }, sort: 'recommended' }
const listeners = new Set<() => void>()

export function setFilterState(next: Partial<FilterState>) {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}

export function useFilterState(): [FilterState, typeof setFilterState] {
  const s = useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state,
  )
  return [s, setFilterState]
}
