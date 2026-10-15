import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Camera, ChevronDown, Lock, Globe, Trash2, Trophy, X } from 'lucide-react'
import { useAuth } from '@/app/auth'
import { useDeleteVisit, useMyVisits, usePlace, usePreferences, useSaveVisit } from '@/data/hooks'
import { buildRankings, formatScore, visitComposite } from '@/core/rating'
import { DETAIL_CATEGORIES, DETAIL_GROUP_LABELS, PRIMARY_CATEGORIES, PRIMARY_CATEGORY_KEYS, TAGS, type CategoryGroup } from '@/core/categories'
import type { Establishment, Visibility, Visit } from '@/core/types'
import { compressImage, ACCEPTED_IMAGE_TYPES } from '@/lib/image'
import { cn } from '@/lib/cn'
import { ScoreSlider } from '@/components/ScoreSlider'
import { ScoreBadge } from '@/components/score'
import { PlaceThumb } from '@/components/place'
import { Button, Chip, EmptyState, IconButton, Segmented, Spinner, Textarea } from '@/components/ui'
import { errorMessage, useToast } from '@/components/toast'
import { haptic } from '@/lib/share'

type Scores = Record<string, number | null | undefined>

interface Draft {
  mode: 'quick' | 'detailed'
  visitedOn: string
  scores: Scores
  tags: string[]
  note: string
  review: string
  visibility: Visibility
  keepPhotos: string[]
}

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function RateFlowScreen() {
  const { slug, visitId } = useParams()
  const { user, profile, loading } = useAuth()
  const visits = useMyVisits()
  const navigate = useNavigate()
  const existing = visitId ? visits.data?.find((v) => v.id === visitId) : undefined
  const place = usePlace(slug ?? existing?.establishmentId ?? '')

  useEffect(() => {
    if (!loading && !user) navigate(`/signin?next=${encodeURIComponent(window.location.pathname)}&reason=rate`, { replace: true })
  }, [loading, user, navigate])

  if (loading || (visitId && visits.isLoading) || place.isLoading || !profile) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner />
      </div>
    )
  }
  if (visitId && !existing) return <EmptyState className="pt-safe mt-20" icon="🤷" title="Visit not found" action={<Button onClick={() => navigate('/rankings')}>My rankings</Button>} />
  if (!place.data) return <EmptyState className="pt-safe mt-20" icon="🧭" title="Place not found" action={<Button onClick={() => navigate('/rate')}>Pick a place</Button>} />
  return <RateForm key={existing?.id ?? place.data.id} place={place.data} existing={existing} defaultVisibility={profile.defaultVisitVisibility} />
}

function RateForm({ place, existing, defaultVisibility }: { place: Establishment; existing?: Visit; defaultVisibility: Visibility }) {
  const navigate = useNavigate()
  const toast = useToast()
  const save = useSaveVisit()
  const del = useDeleteVisit()
  const prefs = usePreferences()
  const visits = useMyVisits()
  const fileInput = useRef<HTMLInputElement>(null)
  const draftKey = `aour-draft-${existing?.id ?? place.id}`

  const [draft, setDraft] = useState<Draft>(() => {
    if (existing) {
      return {
        mode: existing.mode,
        visitedOn: existing.visitedOn,
        scores: { ...existing.scores },
        tags: existing.tags,
        note: existing.note ?? '',
        review: existing.review ?? '',
        visibility: existing.visibility,
        keepPhotos: existing.photoUrls,
      }
    }
    try {
      const saved = sessionStorage.getItem(draftKey)
      if (saved) return JSON.parse(saved) as Draft
    } catch {
      /* ignore */
    }
    return { mode: 'quick', visitedOn: today(), scores: {}, tags: [], note: '', review: '', visibility: defaultVisibility, keepPhotos: [] }
  })
  const [newPhotos, setNewPhotos] = useState<{ blob: Blob; url: string }[]>([])
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
  const [showWriting, setShowWriting] = useState(!!(existing?.review || existing?.note))
  const [result, setResult] = useState<{ rank: number; total: number; score: number; placeScore: number } | null>(null)

  // Persist unsaved new ratings so an accidental swipe-back doesn't lose them.
  useEffect(() => {
    if (existing || result) return
    try {
      sessionStorage.setItem(draftKey, JSON.stringify(draft))
    } catch {
      /* ignore */
    }
  }, [draft, draftKey, existing, result])

  // Revoke preview URLs on unmount only (revoking on every change broke visible thumbnails).
  const photosRef = useRef(newPhotos)
  useEffect(() => {
    photosRef.current = newPhotos
  }, [newPhotos])
  useEffect(() => () => photosRef.current.forEach((p) => URL.revokeObjectURL(p.url)), [])

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  const setScore = (key: string, v: number | null | undefined) => setDraft((d) => ({ ...d, scores: { ...d.scores, [key]: v } }))

  const cleanScores = useMemo(() => {
    const out: Record<string, number | null> = {}
    for (const [k, v] of Object.entries(draft.scores)) {
      if (v === undefined) continue
      if (draft.mode === 'quick' && !PRIMARY_CATEGORY_KEYS.includes(k as never)) continue
      out[k] = v
    }
    return out
  }, [draft.scores, draft.mode])

  const weights = prefs.data?.weights
  const composite = visitComposite(cleanScores, weights)
  const scoredPrimary = PRIMARY_CATEGORY_KEYS.filter((k) => typeof cleanScores[k] === 'number').length

  // Live preview of where this place would land in the user's rankings.
  const preview = useMemo(() => {
    if (composite === null) return null
    const others = (visits.data ?? []).filter((v) => v.id !== existing?.id)
    const draftVisit = { id: 'draft', establishmentId: place.id, visitedOn: draft.visitedOn, createdAt: new Date().toISOString(), scores: cleanScores }
    const ranked = buildRankings([...others, draftVisit], weights)
    const entry = ranked.find((r) => r.establishmentId === place.id)
    return entry ? { rank: entry.rank, total: ranked.length, placeScore: entry.score } : null
  }, [composite, visits.data, existing?.id, place.id, draft.visitedOn, cleanScores, weights])

  const submit = async () => {
    if (!scoredPrimary) {
      toast('Score at least one category', 'error')
      return
    }
    try {
      await save.mutateAsync({
        id: existing?.id,
        establishmentId: place.id,
        visitedOn: draft.visitedOn,
        mode: draft.mode,
        scores: cleanScores,
        tags: draft.tags,
        note: draft.note.trim() || null,
        review: draft.review.trim() || null,
        visibility: draft.visibility,
        keepPhotoUrls: draft.keepPhotos,
        newPhotos: newPhotos.map((p) => p.blob),
      })
      try {
        sessionStorage.removeItem(draftKey)
      } catch {
        /* ignore */
      }
      haptic(20)
      setResult({ rank: preview?.rank ?? 1, total: preview?.total ?? 1, score: composite ?? 0, placeScore: preview?.placeScore ?? composite ?? 0 })
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  const addPhotos = async (files: FileList | null) => {
    if (!files) return
    const room = 4 - draft.keepPhotos.length - newPhotos.length
    const picked = [...files].slice(0, Math.max(0, room))
    if (files.length > room) toast('Up to 4 photos per visit', 'info')
    try {
      const compressed = await Promise.all(picked.map((f) => compressImage(f)))
      setNewPhotos((p) => [...p, ...compressed.map((blob) => ({ blob, url: URL.createObjectURL(blob) }))])
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  if (result) return <RateResult place={place} result={result} edited={!!existing} />

  const groups = Object.keys(DETAIL_GROUP_LABELS) as Exclude<CategoryGroup, 'primary'>[]

  return (
    <div className="min-h-dvh pb-40">
      <header className="pt-safe sticky top-0 z-20 bg-cream/92 backdrop-blur-xl">
        <div className="flex h-14 items-center gap-2 px-2">
          <IconButton label="Close" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate(`/place/${place.slug}`))}>
            <X className="size-6" />
          </IconButton>
          <PlaceThumb place={place} className="size-9 text-sm" rounded="rounded-xl" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-muted">{existing ? 'Edit rating' : 'Rate'}</p>
            <h1 className="truncate text-[17px] font-extrabold text-choc">{place.name}</h1>
          </div>
        </div>
        <div className="px-4 pb-3">
          <Segmented
            label="Rating mode"
            value={draft.mode}
            onChange={(mode) => set({ mode })}
            options={[
              { value: 'quick', label: 'Quick' },
              { value: 'detailed', label: 'Detailed' },
            ]}
          />
        </div>
      </header>

      <div className="space-y-3 px-4">
        <div className="flex items-center justify-between gap-3 rounded-card bg-white px-4 py-3 shadow-card">
          <label htmlFor="visit-date" className="font-bold text-choc">
            When did you go?
          </label>
          <input
            id="visit-date"
            type="date"
            value={draft.visitedOn}
            max={today()}
            onChange={(e) => set({ visitedOn: e.target.value || today() })}
            className="rounded-full bg-cream-deep px-3 py-1.5 font-semibold text-choc"
          />
        </div>

        <p className="px-1 pt-2 text-sm text-muted">Slide to score 1–10. Skip anything you didn't try — it won't count against them.</p>
        {PRIMARY_CATEGORIES.map((c) => (
          <ScoreSlider key={c.key} label={c.label} description={c.description} value={draft.scores[c.key]} onChange={(v) => setScore(c.key, v)} />
        ))}

        <section className="rounded-card bg-white p-4 shadow-card" aria-labelledby="tags-title">
          <h2 id="tags-title" className="font-extrabold text-choc">
            Describe it <span className="font-normal text-muted">(optional)</span>
          </h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {TAGS.map((t) => (
              <Chip key={t.key} selected={draft.tags.includes(t.key)} onClick={() => set({ tags: draft.tags.includes(t.key) ? draft.tags.filter((x) => x !== t.key) : [...draft.tags, t.key] })}>
                <span aria-hidden>{t.emoji}</span> {t.label}
              </Chip>
            ))}
          </div>
        </section>

        {draft.mode === 'detailed' && (
          <>
            <h2 className="px-1 pt-3 text-lg font-extrabold text-choc">Go deeper</h2>
            <p className="-mt-2 px-1 text-sm text-muted">Only rate what matters to you. These show in breakdowns but don't change your main score.</p>
            {groups.map((g) => {
              const open = openGroups.has(g)
              const cats = DETAIL_CATEGORIES.filter((c) => c.group === g)
              const done = cats.filter((c) => draft.scores[c.key] !== undefined).length
              return (
                <div key={g} className="overflow-hidden rounded-card bg-white shadow-card">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setOpenGroups((s) => { const n = new Set(s); if (open) n.delete(g); else n.add(g); return n })}
                    className="flex w-full items-center justify-between px-4 py-3.5 text-left"
                  >
                    <span className="font-extrabold text-choc">{DETAIL_GROUP_LABELS[g]}</span>
                    <span className="flex items-center gap-2 text-sm text-muted">
                      {done > 0 && `${done} rated`}
                      <ChevronDown className={cn('size-5 transition-transform', open && 'rotate-180')} />
                    </span>
                  </button>
                  {open && (
                    <div className="space-y-2 bg-cream-deep/60 p-2">
                      {cats.map((c) => (
                        <ScoreSlider key={c.key} compact label={c.label} value={draft.scores[c.key]} onChange={(v) => setScore(c.key, v)} />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}

            <section className="rounded-card bg-white p-4 shadow-card">
              <h2 className="font-extrabold text-choc">Photos</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {draft.keepPhotos.map((u) => (
                  <PhotoThumb key={u} url={u} onRemove={() => set({ keepPhotos: draft.keepPhotos.filter((x) => x !== u) })} />
                ))}
                {newPhotos.map((p) => (
                  <PhotoThumb key={p.url} url={p.url} onRemove={() => { URL.revokeObjectURL(p.url); setNewPhotos((list) => list.filter((x) => x !== p)) }} />
                ))}
                {draft.keepPhotos.length + newPhotos.length < 4 && (
                  <button type="button" onClick={() => fileInput.current?.click()} className="press flex size-20 flex-col items-center justify-center gap-1 rounded-tile bg-cream-deep text-xs font-semibold text-choc">
                    <Camera className="size-5" /> Add
                  </button>
                )}
              </div>
              <input ref={fileInput} type="file" accept={ACCEPTED_IMAGE_TYPES} multiple hidden onChange={(e) => { void addPhotos(e.target.files); e.target.value = '' }} />
              <p className="mt-2 text-xs text-muted">Photos are resized and location data is removed before upload.</p>
            </section>
          </>
        )}

        {draft.mode === 'detailed' || showWriting ? (
          <section className="space-y-3 rounded-card bg-white p-4 shadow-card">
            <div>
              <label htmlFor="review" className="font-extrabold text-choc">Review</label>
              <p className="text-xs text-muted">Shown publicly on the place page when your rating is public.</p>
              <Textarea id="review" className="mt-2" maxLength={2000} value={draft.review} onChange={(e) => set({ review: e.target.value })} placeholder="What should people order? When should they go?" />
            </div>
            <div>
              <label htmlFor="note" className="flex items-center gap-1.5 font-extrabold text-choc"><Lock className="size-3.5" /> Private note</label>
              <p className="text-xs text-muted">Only you can see this.</p>
              <Textarea id="note" className="mt-2 min-h-16" maxLength={2000} value={draft.note} onChange={(e) => set({ note: e.target.value })} placeholder="Sat at the bar, ask for Sam" />
            </div>
          </section>
        ) : (
          <button type="button" onClick={() => setShowWriting(true)} className="w-full rounded-card bg-white px-4 py-3.5 text-left font-bold text-choc shadow-card">
            + Add a review or private note
          </button>
        )}

        <div className="rounded-card bg-white px-4 py-2 shadow-card">
          <Segmented
            className="my-2"
            label="Who can see this rating"
            value={draft.visibility}
            onChange={(visibility) => set({ visibility })}
            options={[
              { value: 'public', label: <><Globe className="size-4" /> Public</> },
              { value: 'private', label: <><Lock className="size-4" /> Only me</> },
            ]}
          />
          <p className="pb-1 text-xs text-muted">
            {draft.visibility === 'public' ? 'Shown on your profile and included in community scores.' : 'Still counts in your rankings. Hidden from everyone else and left out of community scores.'}
          </p>
        </div>

        {existing && (
          <Button
            variant="danger"
            block
            loading={del.isPending}
            onClick={async () => {
              if (!window.confirm('Delete this rating? This cannot be undone.')) return
              try {
                await del.mutateAsync(existing)
                toast('Rating deleted')
                navigate('/rankings', { replace: true })
              } catch (e) {
                toast(errorMessage(e), 'error')
              }
            }}
          >
            <Trash2 className="size-4" /> Delete this rating
          </Button>
        )}
      </div>

      {/* Sticky live score + save */}
      <div className="pb-safe fixed inset-x-0 bottom-0 z-30 mx-auto max-w-lg border-t border-line bg-cream/95 backdrop-blur-xl">
        <div className="flex items-center gap-3 px-4 pt-3 pb-3">
          <ScoreBadge score={composite} kind="mine" size="lg" label={composite === null ? 'No score yet' : `Your score ${formatScore(composite)}`} />
          <div className="min-w-0 flex-1" aria-live="polite">
            {preview ? (
              <>
                <p className="text-sm font-extrabold text-choc">
                  #{preview.rank} of {preview.total} in your rankings
                </p>
                <p className="text-xs text-muted">{scoredPrimary} of 6 scored{draft.tags.length ? ` · ${draft.tags.length} tags` : ''}</p>
              </>
            ) : (
              <p className="text-sm text-muted">Score a category to see where it ranks</p>
            )}
          </div>
          <Button size="lg" onClick={submit} loading={save.isPending} disabled={!scoredPrimary}>
            {existing ? 'Save' : 'Save rating'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function PhotoThumb({ url, onRemove }: { url: string; onRemove: () => void }) {
  return (
    <div className="relative">
      <img src={url} alt="Selected photo" className="size-20 rounded-tile object-cover" />
      <button type="button" aria-label="Remove photo" onClick={onRemove} className="absolute -top-2 -right-2 flex size-7 items-center justify-center rounded-full bg-choc text-cream shadow-press">
        <X className="size-4" />
      </button>
    </div>
  )
}

function RateResult({ place, result, edited }: { place: Establishment; result: { rank: number; total: number; score: number; placeScore: number }; edited: boolean }) {
  const navigate = useNavigate()
  return (
    <div className="pt-safe flex min-h-dvh flex-col items-center justify-center bg-cream px-8 text-center">
      <div className="animate-pop relative">
        <div className="flex size-36 flex-col items-center justify-center rounded-full bg-choc text-butter shadow-float">
          <Trophy className="size-7" />
          <span className="text-5xl font-extrabold tracking-tight">#{result.rank}</span>
        </div>
        <span className="absolute -top-2 -right-4 rotate-12 text-4xl" aria-hidden>🥂</span>
      </div>
      <h1 className="animate-rise mt-8 text-2xl font-extrabold text-choc">{edited ? 'Rating updated' : 'Rating saved!'}</h1>
      <p className="animate-rise mt-2 text-[17px] text-muted">
        <b className="text-choc">{place.name}</b> is <b className="text-choc">#{result.rank}</b> of {result.total} in your rankings.
      </p>
      <div className="animate-rise mt-5 flex items-center gap-4 rounded-card bg-white px-5 py-3 shadow-card">
        <div>
          <p className="text-xs text-muted">This visit</p>
          <p className="tabular text-xl font-extrabold text-choc">{formatScore(result.score)}</p>
        </div>
        <div className="h-8 w-px bg-line" />
        <div>
          <p className="text-xs text-muted">Your place score</p>
          <p className="tabular text-xl font-extrabold text-choc">{formatScore(result.placeScore)}</p>
        </div>
        <div className="h-8 w-px bg-line" />
        <div>
          <p className="text-xs text-muted">Community</p>
          <p className="tabular text-xl font-extrabold text-choc">{formatScore(place.community.average)}</p>
        </div>
      </div>
      <div className="mt-8 flex w-full max-w-xs flex-col gap-2">
        <Button size="lg" onClick={() => navigate('/rankings', { replace: true })}>
          See my rankings
        </Button>
        <Button size="lg" variant="ghost" onClick={() => navigate(`/place/${place.slug}`, { replace: true })}>
          Back to {place.name}
        </Button>
      </div>
      <Link to="/rate" replace className="mt-4 text-sm font-semibold text-muted underline">
        Rate another place
      </Link>
    </div>
  )
}
