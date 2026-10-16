import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BadgeCheck, Plus, Trash2, X } from 'lucide-react'
import { api, type EstablishmentInput } from '@/data'
import { useLocationState } from '@/app/location'
import { AMENITIES } from '@/core/categories'
import { DAY_SHORT, validateWindow } from '@/core/schedule'
import { ESTABLISHMENT_KINDS, slugify } from '@/core/listing'
import type { Establishment, ListingSource } from '@/core/types'
import { compressImage, ACCEPTED_IMAGE_TYPES } from '@/lib/image'
import { cn } from '@/lib/cn'
import { Button, Chip, Field, Input, Spinner, Textarea } from '@/components/ui'
import { errorMessage, useToast } from '@/components/toast'
import { adminKeys, FreshTag } from './Admin'
import { JobList } from './Pipeline'

const SOURCE_KINDS: { key: ListingSource['kind']; label: string }[] = [
  { key: 'phone', label: 'Called the venue' },
  { key: 'in_person', label: 'Visited in person' },
  { key: 'website', label: "Venue's website" },
  { key: 'menu_photo', label: 'Photo of menu' },
  { key: 'owner', label: 'Owner / manager' },
  { key: 'social', label: "Venue's social media" },
  { key: 'user_submission', label: 'User submission (confirmed)' },
]
/** Recorded by approving automated findings; not offered as manual choices. */
const AUTO_SOURCE_LABEL: Record<string, string> = { official_website: "Venue's website (automated finding)", open_data: 'Open data (automated finding)' }

function emptyInput(marketId: string, prefill?: Record<string, string>): EstablishmentInput {
  return {
    slug: prefill?.name ? slugify(prefill.name) : '',
    name: prefill?.name ?? '',
    kind: 'restaurant',
    marketId,
    neighborhood: prefill?.area ?? null,
    city: prefill?.area ?? '',
    state: 'FL',
    address: prefill?.address ?? '',
    postalCode: null,
    lat: 27.1975,
    lng: -80.2528,
    timezone: 'America/New_York',
    phone: null,
    website: prefill?.website ?? null,
    description: null,
    priceLevel: null,
    amenities: [],
    hhStatus: 'unverified',
    hhSourceNote: null,
    status: 'draft',
    windows: [],
    exceptions: [],
    specials: [],
  }
}

function toInput(e: Establishment): EstablishmentInput {
  return {
    id: e.id,
    slug: e.slug,
    name: e.name,
    kind: e.kind,
    marketId: e.marketId,
    neighborhood: e.neighborhood,
    city: e.city,
    state: e.state,
    address: e.address,
    postalCode: e.postalCode,
    lat: e.lat,
    lng: e.lng,
    timezone: e.timezone,
    phone: e.phone,
    website: e.website,
    description: e.description,
    priceLevel: e.priceLevel,
    amenities: e.amenities,
    hhStatus: e.hhStatus,
    hhSourceNote: e.hhSourceNote,
    status: e.status,
    windows: e.windows.map(({ days, start, end, label, notes }) => ({ days, start, end, label: label ?? null, notes: notes ?? null })),
    exceptions: e.exceptions.map(({ date, closed, start, end, note }) => ({ date, closed, start: start ?? null, end: end ?? null, note: note ?? null })),
    specials: e.specials.map(({ kind, title, price, description }) => ({ kind, title, price, description })),
  }
}

export default function ListingEditor() {
  const { id } = useParams()
  const listings = useQuery({ queryKey: adminKeys.listings, queryFn: () => api.admin.listEstablishments() })
  const existing = id ? listings.data?.find((e) => e.id === id) : undefined
  const { market: here, markets } = useLocationState()
  const market = here ?? markets[0]
  if (listings.isLoading || !market) return <div className="flex justify-center py-16"><Spinner /></div>
  if (id && !existing) return <p className="p-6 text-center text-muted">Listing not found.</p>
  const prefill = (() => {
    try {
      return JSON.parse(sessionStorage.getItem('aour-admin-prefill') ?? 'null') as Record<string, string> | null
    } catch {
      return null
    }
  })()
  return <Editor key={id ?? 'new'} initial={existing ? toInput(existing) : emptyInput(market.id, prefill ?? undefined)} existing={existing} />
}

function Editor({ initial, existing }: { initial: EstablishmentInput; existing?: Establishment }) {
  const [f, setF] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [slugTouched, setSlugTouched] = useState(!!initial.id)
  const { markets } = useLocationState()
  const market = markets.find((m) => m.id === f.marketId)
  const toast = useToast()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const set = <K extends keyof EstablishmentInput>(k: K, v: EstablishmentInput[K]) => setF((s) => ({ ...s, [k]: v }))

  useEffect(() => () => sessionStorage.removeItem('aour-admin-prefill'), [])

  const windowErrors = f.windows.map((w) => validateWindow(w))
  const problems = [
    !f.name.trim() && 'Name is required',
    !/^[a-z0-9-]{2,80}$/.test(f.slug) && 'URL slug must be lowercase letters, numbers and dashes',
    !f.city.trim() && 'City is required',
    !f.address.trim() && 'Address is required',
    (Number.isNaN(f.lat) || Math.abs(f.lat) > 90 || Number.isNaN(f.lng) || Math.abs(f.lng) > 180) && 'Coordinates look wrong',
    f.website && !/^https?:\/\//.test(f.website) && 'Website must start with https://',
    windowErrors.some(Boolean) && 'Fix the happy-hour times below',
    f.specials.some((s) => !s.title.trim()) && 'Every special needs a title',
    f.exceptions.some((x) => !x.date || (!x.closed && (!x.start || !x.end))) && 'Every exception needs a date (and times if not closed)',
  ].filter(Boolean) as string[]

  const save = async () => {
    setBusy(true)
    try {
      const newId = await api.admin.saveEstablishment(f)
      await qc.invalidateQueries({ queryKey: ['admin'] })
      await qc.invalidateQueries({ queryKey: ['listings'] })
      await qc.invalidateQueries({ queryKey: ['place'] })
      toast('Listing saved')
      if (!f.id) navigate(`/admin/listings/${newId}`, { replace: true })
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4 p-4">
      {existing && (
        <div className="flex flex-wrap items-center gap-2">
          <FreshTag e={existing} />
          {existing.status === 'published' && (
            <a href={`/place/${existing.slug}`} target="_blank" rel="noreferrer" className="text-sm font-bold text-choc underline">
              View live page
            </a>
          )}
        </div>
      )}

      <Panel title="Basics">
        <Field label="Name">{(id) => <Input id={id} value={f.name} maxLength={100} onChange={(e) => { set('name', e.target.value); if (!slugTouched) set('slug', slugify(e.target.value)) }} />}</Field>
        <Field label="URL slug" hint={`aour.app/place/${f.slug || '…'}`}>{(id) => <Input id={id} value={f.slug} onChange={(e) => { setSlugTouched(true); set('slug', e.target.value.toLowerCase()) }} />}</Field>
        <Field label="Type">
          {(id) => (
            <select id={id} value={f.kind} onChange={(e) => set('kind', e.target.value as EstablishmentInput['kind'])} className="h-12 rounded-tile bg-white px-3 ring-1 ring-line">
              {ESTABLISHMENT_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
            </select>
          )}
        </Field>
        <Field label="Description">{(id) => <Textarea id={id} value={f.description ?? ''} maxLength={1000} onChange={(e) => set('description', e.target.value || null)} />}</Field>
        <div>
          <p className="text-sm font-semibold text-choc">Price</p>
          <div className="mt-1.5 flex gap-2">
            {[null, 1, 2, 3, 4].map((p) => (
              <Chip key={String(p)} selected={f.priceLevel === p} onClick={() => set('priceLevel', p as EstablishmentInput['priceLevel'])}>{p ? '$'.repeat(p) : 'Unknown'}</Chip>
            ))}
          </div>
        </div>
      </Panel>

      <Panel title="Location & contact">
        <Field label="Neighborhood / town">
          {(id) => (
            <select id={id} value={f.neighborhood ?? ''} onChange={(e) => set('neighborhood', e.target.value || null)} className="h-12 rounded-tile bg-white px-3 ring-1 ring-line">
              <option value="">—</option>
              {market?.areas.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          )}
        </Field>
        <Field label="Street address">{(id) => <Input id={id} value={f.address} onChange={(e) => set('address', e.target.value)} />}</Field>
        <div className="grid grid-cols-[1fr_5rem_6rem] gap-2">
          <Field label="City">{(id) => <Input id={id} value={f.city} onChange={(e) => set('city', e.target.value)} />}</Field>
          <Field label="State">{(id) => <Input id={id} value={f.state} maxLength={2} onChange={(e) => set('state', e.target.value.toUpperCase())} />}</Field>
          <Field label="ZIP">{(id) => <Input id={id} value={f.postalCode ?? ''} onChange={(e) => set('postalCode', e.target.value || null)} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Latitude">{(id) => <Input id={id} type="number" step="0.000001" value={f.lat} onChange={(e) => set('lat', parseFloat(e.target.value))} />}</Field>
          <Field label="Longitude">{(id) => <Input id={id} type="number" step="0.000001" value={f.lng} onChange={(e) => set('lng', parseFloat(e.target.value))} />}</Field>
        </div>
        <p className="text-xs text-muted">
          Tip: in Apple or Google Maps, long-press the entrance and copy the coordinates.{' '}
          <a className="underline" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${f.lat}&mlon=${f.lng}#map=18/${f.lat}/${f.lng}`}>Check on map</a>
        </p>
        <Field label="Phone">{(id) => <Input id={id} type="tel" value={f.phone ?? ''} onChange={(e) => set('phone', e.target.value || null)} />}</Field>
        <Field label="Website">{(id) => <Input id={id} type="url" value={f.website ?? ''} placeholder="https://" onChange={(e) => set('website', e.target.value || null)} />}</Field>
      </Panel>

      <Panel title="Verified amenities" subtitle="Objective facts only — shown separately from user tags.">
        <div className="flex flex-wrap gap-2">
          {AMENITIES.map((a) => (
            <Chip key={a.key} selected={f.amenities.includes(a.key)} onClick={() => set('amenities', f.amenities.includes(a.key) ? f.amenities.filter((x) => x !== a.key) : [...f.amenities, a.key])}>
              {a.label}
            </Chip>
          ))}
        </div>
      </Panel>

      <Panel title="Happy-hour schedule" subtitle="Only enter times you have confirmed with a source.">
        <div className="flex gap-2">
          <Chip selected={f.hhStatus !== 'none'} onClick={() => f.hhStatus === 'none' && set('hhStatus', 'unverified')}>Has a happy hour</Chip>
          <Chip selected={f.hhStatus === 'none'} onClick={() => set('hhStatus', 'none')}>No happy hour</Chip>
        </div>
        {f.hhStatus !== 'none' && (
          <>
            {f.windows.map((w, i) => (
              <div key={i} className="rounded-tile bg-cream p-3">
                <div className="flex flex-wrap gap-1.5">
                  {DAY_SHORT.map((d, di) => (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={w.days.includes(di)}
                      onClick={() => set('windows', f.windows.map((x, xi) => (xi === i ? { ...x, days: x.days.includes(di) ? x.days.filter((y) => y !== di) : [...x.days, di].sort() } : x)))}
                      className={cn('h-9 w-11 rounded-full text-sm font-bold', w.days.includes(di) ? 'bg-choc text-cream' : 'bg-white text-choc ring-1 ring-line')}
                    >
                      {d}
                    </button>
                  ))}
                </div>
                <div className="mt-2 grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                  <Field label="Starts">{(id) => <Input id={id} type="time" value={w.start} onChange={(e) => set('windows', f.windows.map((x, xi) => (xi === i ? { ...x, start: e.target.value } : x)))} />}</Field>
                  <Field label="Ends">{(id) => <Input id={id} type="time" value={w.end} onChange={(e) => set('windows', f.windows.map((x, xi) => (xi === i ? { ...x, end: e.target.value } : x)))} />}</Field>
                  <Button variant="ghost" aria-label="Remove window" onClick={() => set('windows', f.windows.filter((_, xi) => xi !== i))}><Trash2 className="size-4" /></Button>
                </div>
                <Input className="mt-2" placeholder="Label (optional), e.g. Late night" value={w.label ?? ''} onChange={(e) => set('windows', f.windows.map((x, xi) => (xi === i ? { ...x, label: e.target.value || null } : x)))} aria-label="Window label" />
                {windowErrors[i] && <p className="mt-1 text-sm text-danger">{windowErrors[i]}</p>}
                <p className="mt-1 text-xs text-muted">An end time earlier than the start (e.g. 10pm–1am) runs past midnight.</p>
              </div>
            ))}
            <Button variant="secondary" size="sm" onClick={() => set('windows', [...f.windows, { days: [1, 2, 3, 4, 5], start: '16:00', end: '19:00', label: null, notes: null }])}>
              <Plus className="size-4" /> Add time window
            </Button>

            <h3 className="pt-2 font-bold text-choc">Specials</h3>
            {f.specials.map((s, i) => (
              <div key={i} className="grid grid-cols-[5.5rem_1fr_5rem_auto] items-center gap-2">
                <select aria-label="Special type" value={s.kind} onChange={(e) => set('specials', f.specials.map((x, xi) => (xi === i ? { ...x, kind: e.target.value as 'drink' } : x)))} className="h-12 rounded-tile bg-white px-2 ring-1 ring-line">
                  <option value="drink">Drink</option>
                  <option value="food">Food</option>
                  <option value="other">Other</option>
                </select>
                <Input aria-label="Special" placeholder="House wine" value={s.title} maxLength={80} onChange={(e) => set('specials', f.specials.map((x, xi) => (xi === i ? { ...x, title: e.target.value } : x)))} />
                <Input aria-label="Price" placeholder="$5" value={s.price ?? ''} maxLength={30} onChange={(e) => set('specials', f.specials.map((x, xi) => (xi === i ? { ...x, price: e.target.value || null } : x)))} />
                <Button variant="ghost" aria-label="Remove special" onClick={() => set('specials', f.specials.filter((_, xi) => xi !== i))}><X className="size-4" /></Button>
              </div>
            ))}
            <Button variant="secondary" size="sm" onClick={() => set('specials', [...f.specials, { kind: 'drink', title: '', price: null, description: null }])}>
              <Plus className="size-4" /> Add special
            </Button>

            <h3 className="pt-2 font-bold text-choc">Exceptions (holidays, events)</h3>
            {f.exceptions.map((x, i) => (
              <div key={i} className="rounded-tile bg-cream p-3">
                <div className="grid grid-cols-[1fr_auto] items-end gap-2">
                  <Field label="Date">{(id) => <Input id={id} type="date" value={x.date} onChange={(e) => set('exceptions', f.exceptions.map((y, yi) => (yi === i ? { ...y, date: e.target.value } : y)))} />}</Field>
                  <Button variant="ghost" aria-label="Remove exception" onClick={() => set('exceptions', f.exceptions.filter((_, yi) => yi !== i))}><Trash2 className="size-4" /></Button>
                </div>
                <div className="mt-2 flex gap-2">
                  <Chip selected={x.closed} onClick={() => set('exceptions', f.exceptions.map((y, yi) => (yi === i ? { ...y, closed: true } : y)))}>No happy hour</Chip>
                  <Chip selected={!x.closed} onClick={() => set('exceptions', f.exceptions.map((y, yi) => (yi === i ? { ...y, closed: false, start: y.start ?? '16:00', end: y.end ?? '19:00' } : y)))}>Special hours</Chip>
                </div>
                {!x.closed && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <Input type="time" aria-label="Exception start" value={x.start ?? ''} onChange={(e) => set('exceptions', f.exceptions.map((y, yi) => (yi === i ? { ...y, start: e.target.value } : y)))} />
                    <Input type="time" aria-label="Exception end" value={x.end ?? ''} onChange={(e) => set('exceptions', f.exceptions.map((y, yi) => (yi === i ? { ...y, end: e.target.value } : y)))} />
                  </div>
                )}
                <Input className="mt-2" placeholder="Note, e.g. Closed for Thanksgiving" value={x.note ?? ''} onChange={(e) => set('exceptions', f.exceptions.map((y, yi) => (yi === i ? { ...y, note: e.target.value || null } : y)))} aria-label="Exception note" />
              </div>
            ))}
            <Button variant="secondary" size="sm" onClick={() => set('exceptions', [...f.exceptions, { date: '', closed: true, start: null, end: null, note: null }])}>
              <Plus className="size-4" /> Add exception
            </Button>

            <Field label="Public source note" hint='Shown to users, e.g. "Confirmed by phone with the bar manager".'>
              {(id) => <Input id={id} value={f.hhSourceNote ?? ''} maxLength={280} onChange={(e) => set('hhSourceNote', e.target.value || null)} />}
            </Field>
            {f.id && (
              <div className="flex gap-2">
                <Chip selected={f.hhStatus === 'outdated'} onClick={() => set('hhStatus', f.hhStatus === 'outdated' ? 'unverified' : 'outdated')}>Flag as outdated</Chip>
              </div>
            )}
          </>
        )}
      </Panel>

      <Panel title="Visibility">
        <div className="flex gap-2">
          {(['draft', 'published', 'archived'] as const).map((s) => (
            <Chip key={s} selected={f.status === s} onClick={() => set('status', s)} className="capitalize">{s}</Chip>
          ))}
        </div>
        <p className="text-xs text-muted">Drafts are only visible to admins. New schedules start “unverified” until you record a source below.</p>
      </Panel>

      {problems.length > 0 && (
        <ul className="rounded-tile bg-danger/10 p-3 text-sm text-danger">
          {problems.map((p) => <li key={p}>• {p}</li>)}
        </ul>
      )}
      <div className="sticky bottom-0 -mx-4 bg-cream/95 px-4 py-3 backdrop-blur">
        <Button size="lg" block loading={busy} disabled={problems.length > 0} onClick={save}>
          {f.id ? 'Save changes' : 'Create listing'}
        </Button>
      </div>

      {existing && <VerifyPanel establishment={existing} />}
      {existing && <PhotosPanel establishment={existing} />}
      {existing && api.mode === 'supabase' && <AutomationPanel establishment={existing} />}
      {existing && (
        <Button
          variant="danger"
          block
          onClick={async () => {
            if (!window.confirm(`Delete ${existing.name} and all its ratings? Prefer "Archived" to hide it instead.`)) return
            try {
              await api.admin.deleteEstablishment(existing.id)
              await qc.invalidateQueries()
              toast('Listing deleted')
              navigate('/admin/listings', { replace: true })
            } catch (e) {
              toast(errorMessage(e), 'error')
            }
          }}
        >
          <Trash2 className="size-4" /> Delete listing
        </Button>
      )}
    </div>
  )
}

function Panel({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-card bg-white p-4 shadow-card">
      <div>
        <h2 className="text-lg font-extrabold text-choc">{title}</h2>
        {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
      </div>
      {children}
    </section>
  )
}

function VerifyPanel({ establishment }: { establishment: Establishment }) {
  const sources = useQuery({ queryKey: ['admin', 'sources', establishment.id], queryFn: () => api.admin.listSources(establishment.id) })
  const [kind, setKind] = useState<ListingSource['kind']>('phone')
  const [note, setNote] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const qc = useQueryClient()
  const toast = useToast()
  return (
    <Panel title="Verify happy hour" subtitle="Record how you confirmed the current schedule and specials. This stamps today's date.">
      <select aria-label="Source" value={kind} onChange={(e) => setKind(e.target.value as ListingSource['kind'])} className="h-12 w-full rounded-tile bg-white px-3 ring-1 ring-line">
        {SOURCE_KINDS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
      </select>
      <Input placeholder="Note (who you spoke to, what changed)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Verification note" />
      <Input type="url" placeholder="Source URL (optional)" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Source URL" />
      <Button
        variant="butter"
        block
        loading={busy}
        disabled={!!url && !/^https?:\/\//.test(url)}
        onClick={async () => {
          setBusy(true)
          try {
            await api.admin.verifyListing(establishment.id, kind, note.trim() || null, url.trim() || null)
            await qc.invalidateQueries({ queryKey: ['admin'] })
            await qc.invalidateQueries({ queryKey: ['listings'] })
            toast('Marked verified today')
            setNote('')
            setUrl('')
          } catch (e) {
            toast(errorMessage(e), 'error')
          } finally {
            setBusy(false)
          }
        }}
      >
        <BadgeCheck className="size-5" /> Mark verified today
      </Button>
      {(sources.data ?? []).length > 0 && (
        <ul className="divide-y divide-line text-sm">
          {sources.data!.map((s) => (
            <li key={s.id} className="py-2">
              <b className="text-choc">{new Date(s.createdAt).toLocaleDateString()}</b> · {SOURCE_KINDS.find((k) => k.key === s.kind)?.label ?? AUTO_SOURCE_LABEL[s.kind] ?? s.kind}
              {s.note && <span className="block text-muted">{s.note}</span>}
              {s.url && <a className="block truncate text-choc underline" href={s.url} target="_blank" rel="noreferrer">{s.url}</a>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

/** Who manages the happy-hour data, what automation did, and a manual refresh. */
function AutomationPanel({ establishment }: { establishment: Establishment }) {
  const history = useQuery({ queryKey: ['admin', 'history', establishment.id], queryFn: () => api.admin.pipeline.history(establishment.id) })
  const findings = useQuery({ queryKey: ['admin', 'findings', 'all', establishment.id], queryFn: () => api.admin.pipeline.listFindings('all', establishment.id) })
  const qc = useQueryClient()
  const toast = useToast()
  const h = history.data
  const l = h?.listing
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn()
      await qc.invalidateQueries({ queryKey: ['admin'] })
      toast(ok)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }
  const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')
  return (
    <Panel
      title="Automation & history"
      subtitle="Admin edits lock the happy-hour data: automated refreshes then only propose changes for review. Hand it back to let the pipeline keep it current."
    >
      {!l ? (
        <Spinner />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted">Managed by</dt>
            <dd className="font-semibold text-choc">{l.managedBy === 'admin' ? 'Admin (locked)' : 'Automation'}</dd>
            <dt className="text-muted">Origin</dt>
            <dd className="text-choc">{l.origin}</dd>
            <dt className="text-muted">Internal confidence</dt>
            <dd className="text-choc">{l.confidence == null ? '—' : `${Math.round(l.confidence * 100)}%`}{l.conflict ? ' · sources conflict' : ''}</dd>
            <dt className="text-muted">Last confirmed</dt>
            <dd className="text-choc">{fmt(l.lastConfirmedAt)}</dd>
            <dt className="text-muted">Last refresh</dt>
            <dd className="text-choc">{fmt(l.lastEnrichAttemptAt)}{l.enrichFailures ? ` · ${l.enrichFailures} failures` : ''}</dd>
            <dt className="text-muted">Next refresh</dt>
            <dd className="text-choc">{fmt(l.nextEnrichAt)}</dd>
            {l.lockedFields.length > 0 && (
              <>
                <dt className="text-muted">Locked fields</dt>
                <dd className="text-choc">{l.lockedFields.join(', ')}</dd>
              </>
            )}
            {l.attribution && (
              <>
                <dt className="text-muted">Attribution</dt>
                <dd className="text-choc">{l.attribution}</dd>
              </>
            )}
          </dl>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => act(async () => {
              await api.admin.pipeline.enqueueRefresh('enrich_establishment', establishment.id)
              await api.admin.pipeline.runNow()
            }, 'Refresh queued')}>
              Refresh now
            </Button>
            {l.managedBy === 'admin' ? (
              <Button size="sm" variant="secondary" onClick={() => act(() => api.admin.pipeline.setManagedBy(establishment.id, 'auto'), 'Handed back to automation')}>
                Hand back to automation
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => act(() => api.admin.pipeline.setManagedBy(establishment.id, 'admin'), 'Locked for admin management')}>
                Lock (admin-managed)
              </Button>
            )}
          </div>
        </>
      )}
      {(findings.data ?? []).filter((f) => f.status === 'pending').length > 0 && (
        <p className="rounded-tile bg-gold/15 p-3 text-sm text-choc">
          {(findings.data ?? []).filter((f) => f.status === 'pending').length} finding(s) waiting for review —{' '}
          <Link to="/admin/data/findings" className="font-bold underline">review</Link>
        </p>
      )}
      {h && h.changes.length > 0 && (
        <div>
          <h3 className="text-sm font-bold text-muted uppercase">Change history</h3>
          <ul className="mt-1 divide-y divide-line text-sm">
            {h.changes.map((c) => (
              <li key={c.id} className="py-1.5">
                <b className="text-choc">{fmt(c.created_at)}</b> · {c.actor === 'admin' ? 'Admin' : 'Pipeline'} · {c.summary}
              </li>
            ))}
          </ul>
        </div>
      )}
      {h && h.documents.length > 0 && (
        <div>
          <h3 className="text-sm font-bold text-muted uppercase">Sources checked</h3>
          <ul className="mt-1 space-y-1 text-xs">
            {h.documents.map((d) => (
              <li key={d.url} className="truncate text-choc">
                {d.outcome ?? '—'} ({d.last_status ?? '—'}) · {fmt(d.last_attempt_at)} · <a href={d.url} target="_blank" rel="noopener noreferrer nofollow" className="underline">{d.url}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {h && h.externalIds.length > 0 && (
        <p className="text-xs text-muted">Provider ids: {h.externalIds.map((x) => `${x.provider}:${x.external_id}`).join(' · ')}</p>
      )}
      {h && h.jobs.length > 0 && <JobList jobs={h.jobs.slice(0, 5)} />}
    </Panel>
  )
}

function PhotosPanel({ establishment }: { establishment: Establishment }) {
  const file = useRef<HTMLInputElement>(null)
  const [alt, setAlt] = useState('')
  const [attribution, setAttribution] = useState('')
  const [busy, setBusy] = useState(false)
  const qc = useQueryClient()
  const toast = useToast()
  return (
    <Panel title="Photos" subtitle="Only upload photos you took or have written permission/licence to use. Credit is shown on the photo.">
      <div className="flex flex-wrap gap-2">
        {establishment.photos.map((p) => (
          <div key={p.id} className="relative">
            <img src={p.url} alt={p.alt ?? ''} className="size-24 rounded-tile object-cover" />
            <button
              type="button"
              aria-label="Delete photo"
              onClick={async () => {
                await api.admin.deletePhoto(p.id)
                await qc.invalidateQueries({ queryKey: ['admin'] })
              }}
              className="absolute -top-2 -right-2 flex size-7 items-center justify-center rounded-full bg-choc text-cream"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
      <Input placeholder="Alt text (describe the photo)" value={alt} onChange={(e) => setAlt(e.target.value)} aria-label="Alt text" />
      <Input placeholder="Credit, e.g. Photo: venue / © Name, CC BY 4.0" value={attribution} onChange={(e) => setAttribution(e.target.value)} aria-label="Photo credit" />
      <Button variant="secondary" loading={busy} disabled={!attribution.trim()} onClick={() => file.current?.click()}>
        Upload photo
      </Button>
      <input
        ref={file}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES}
        hidden
        onChange={async (e) => {
          const fl = e.target.files?.[0]
          e.target.value = ''
          if (!fl) return
          setBusy(true)
          try {
            await api.admin.addPhoto(establishment.id, await compressImage(fl, 2000, 0.82), alt.trim() || null, attribution.trim())
            await qc.invalidateQueries({ queryKey: ['admin'] })
            await qc.invalidateQueries({ queryKey: ['listings'] })
            setAlt('')
            toast('Photo added')
          } catch (err) {
            toast(errorMessage(err), 'error')
          } finally {
            setBusy(false)
          }
        }}
      />
    </Panel>
  )
}
