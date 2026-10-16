import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronRight, LogOut, RotateCcw, Trash2 } from 'lucide-react'
import { useAuth } from '@/app/auth'
import { useListingIndex, usePreferences, useRankings, useSavePreferences, useUpdateProfile } from '@/data/hooks'
import { api } from '@/data'
import { DEFAULT_WEIGHTS, buildRankings, validateWeights, weightShares, type Weights } from '@/core/rating'
import { PRIMARY_CATEGORIES, PRIMARY_CATEGORY_KEYS } from '@/core/categories'
import { isDemoMode } from '@/lib/config'
import { cn } from '@/lib/cn'
import { Button, Card, Input, PageHeader, Segmented, Sheet, Toggle } from '@/components/ui'
import { errorMessage, useToast } from '@/components/toast'
import { InstallCard } from '@/components/InstallCard'

export default function SettingsScreen() {
  const { user, profile } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()
  const qc = useQueryClient()
  const update = useUpdateProfile()

  useEffect(() => {
    if (window.location.hash === '#weights') document.getElementById('weights')?.scrollIntoView({ block: 'start' })
  }, [])

  return (
    <div className="pb-10">
      <PageHeader title="Settings" back />
      <div className="space-y-6 px-4">
        {user && profile ? (
          <>
            <WeightsCard />

            <section>
              <h2 className="mb-2 px-1 text-sm font-bold tracking-wide text-muted uppercase">Privacy</h2>
              <Card className="px-4">
                <Toggle
                  label="Public profile"
                  description={profile.visibility === 'public' ? 'Anyone can see your profile and public ratings.' : 'Only your name is visible. Your ratings are hidden from everyone.'}
                  checked={profile.visibility === 'public'}
                  onChange={(v) => update.mutate({ visibility: v ? 'public' : 'private' }, { onError: (e) => toast(errorMessage(e), 'error') })}
                />
                <div className="border-t border-line py-3">
                  <p className="text-[15px] font-semibold text-choc">New ratings are</p>
                  <Segmented
                    className="mt-2"
                    label="Default rating visibility"
                    value={profile.defaultVisitVisibility}
                    onChange={(v) => update.mutate({ defaultVisitVisibility: v })}
                    options={[
                      { value: 'public', label: 'Public' },
                      { value: 'private', label: 'Only me' },
                    ]}
                  />
                </div>
                <div className="border-t border-line">
                  <Toggle
                    label="Count my public ratings in community scores"
                    description="Anonymously include your public ratings in each place's community average. Private ratings are never included."
                    checked={profile.contributeToCommunity}
                    onChange={(v) => update.mutate({ contributeToCommunity: v })}
                  />
                </div>
              </Card>
              <p className="mt-2 px-1 text-xs text-muted">Your exact location is never stored or shared. Private notes are only ever visible to you.</p>
            </section>

            <section>
              <h2 className="mb-2 px-1 text-sm font-bold tracking-wide text-muted uppercase">Account</h2>
              <Card className="overflow-hidden">
                <Row to="/me/edit" label="Edit profile" />
                <Row to="/people" label="Find people to follow" />
                <div className="border-b border-line px-4 py-3.5 text-sm text-muted">Signed in as {user.email ?? profile.username}</div>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-3.5 text-left font-semibold text-choc hover:bg-cream"
                  onClick={async () => {
                    await api.signOut()
                    qc.clear()
                    navigate('/')
                  }}
                >
                  <LogOut className="size-5" /> Sign out
                </button>
              </Card>
            </section>
            <DeleteAccount />
          </>
        ) : (
          <Card className="p-5 text-center">
            <p className="font-bold text-choc">Sign in to customize rankings and privacy.</p>
            <Button className="mt-3" onClick={() => navigate('/signin?next=/settings')}>
              Sign in
            </Button>
          </Card>
        )}

        <InstallCard />

        <section>
          <h2 className="mb-2 px-1 text-sm font-bold tracking-wide text-muted uppercase">About</h2>
          <Card className="overflow-hidden">
            <Row to="/privacy" label="Privacy policy" />
            <Row to="/terms" label="Terms of service" />
            <Row to="/suggest" label="Suggest a place" />
            <a href="mailto:hello@aour.app" className="flex items-center justify-between px-4 py-3.5 font-semibold text-choc hover:bg-cream">
              Contact us <ChevronRight className="size-4 text-muted" />
            </a>
          </Card>
          <p className="mt-4 text-center text-xs text-muted">
            Aour — short for “Allie’s Hour”. v{__APP_VERSION__}
            {isDemoMode && ' · demo mode'}
          </p>
        </section>
      </div>
    </div>
  )
}

function Row({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="flex items-center justify-between border-b border-line px-4 py-3.5 font-semibold text-choc last:border-0 hover:bg-cream">
      {label} <ChevronRight className="size-4 text-muted" />
    </Link>
  )
}

/** Personal category weights, with a live preview of how the top of the ranking changes. */
function WeightsCard() {
  const prefs = usePreferences()
  const save = useSavePreferences()
  const toast = useToast()
  const { visits } = useRankings()
  const { index } = useListingIndex()
  const [draft, setDraft] = useState<Weights | null>(null)
  const weights = draft ?? prefs.data?.weights ?? DEFAULT_WEIGHTS
  const shares = weightShares(weights)
  const valid = validateWeights(weights)
  const dirty = draft !== null && PRIMARY_CATEGORY_KEYS.some((k) => draft[k] !== (prefs.data?.weights ?? DEFAULT_WEIGHTS)[k])
  const preview = useMemo(() => buildRankings(visits, weights).slice(0, 3), [visits, weights])
  const isDefault = PRIMARY_CATEGORY_KEYS.every((k) => weights[k] === DEFAULT_WEIGHTS[k])

  return (
    <section id="weights" className="scroll-mt-20">
      <h2 className="mb-2 px-1 text-sm font-bold tracking-wide text-muted uppercase">What matters most to you</h2>
      <Card className="p-4">
        <p className="text-sm text-muted">Your rankings weigh each category by these amounts. Categories you mark N/A are left out automatically.</p>
        <div className="mt-4 space-y-4">
          {PRIMARY_CATEGORIES.map((c) => {
            const k = c.key as keyof Weights
            return (
              <div key={c.key}>
                <div className="flex items-baseline justify-between">
                  <label htmlFor={`w-${c.key}`} className="font-bold text-choc">
                    {c.label}
                  </label>
                  <span className="tabular text-sm font-bold text-choc">{shares[k]}%</span>
                </div>
                <input
                  id={`w-${c.key}`}
                  type="range"
                  min={0}
                  max={50}
                  step={5}
                  value={weights[k]}
                  aria-valuetext={`${shares[k]} percent of your score`}
                  onChange={(e) => setDraft({ ...weights, [k]: Number(e.target.value) })}
                  className="score-range"
                  style={{ ['--fill' as string]: `${(weights[k] / 50) * 100}%` }}
                />
              </div>
            )
          })}
        </div>
        {!valid.ok && <p className="mt-2 text-sm text-danger">{valid.error}</p>}

        {preview.length > 0 && (
          <div className="mt-4 rounded-tile bg-cream-deep p-3">
            <p className="text-xs font-bold tracking-wide text-muted uppercase">Your top 3 with these weights</p>
            <ol className="mt-1.5 space-y-1">
              {preview.map((r) => (
                <li key={r.establishmentId} className="flex justify-between text-sm">
                  <span className="truncate font-semibold text-choc">
                    {r.rank}. {index.get(r.establishmentId)?.name ?? '…'}
                  </span>
                  <span className="tabular font-bold text-choc">{r.score.toFixed(1)}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        <div className="mt-4 flex gap-2">
          <Button variant="ghost" size="sm" disabled={isDefault} onClick={() => setDraft({ ...DEFAULT_WEIGHTS })}>
            <RotateCcw className="size-4" /> Defaults
          </Button>
          <Button
            className="ml-auto"
            size="sm"
            disabled={!dirty || !valid.ok}
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                { weights },
                {
                  onSuccess: () => {
                    setDraft(null)
                    toast('Rankings recalculated')
                  },
                  onError: (e) => toast(errorMessage(e), 'error'),
                },
              )
            }
          >
            Save weights
          </Button>
        </div>
      </Card>
    </section>
  )
}

function DeleteAccount() {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const qc = useQueryClient()
  const navigate = useNavigate()
  return (
    <section>
      <button type="button" onClick={() => setOpen(true)} className="flex w-full items-center justify-center gap-2 rounded-card py-3 font-semibold text-danger hover:bg-danger/5">
        <Trash2 className="size-4" /> Delete account
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Delete your account?">
        <p className="text-[15px] text-espresso">
          This permanently deletes your profile, every rating and review, your photos, lists, collections and follows. Community scores update to remove your ratings. <b>This can’t be undone.</b>
        </p>
        <label htmlFor="confirm-delete" className="mt-4 block text-sm font-semibold text-choc">
          Type DELETE to confirm
        </label>
        <Input id="confirm-delete" className="mt-1.5" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoCapitalize="characters" />
        <Button
          variant="danger"
          className={cn('mt-4 bg-danger text-white ring-0 hover:bg-danger/90')}
          block
          disabled={confirm !== 'DELETE'}
          loading={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await api.deleteAccount()
              qc.clear()
              toast('Your account has been deleted')
              navigate('/', { replace: true })
            } catch (e) {
              toast(errorMessage(e), 'error')
              setBusy(false)
            }
          }}
        >
          Permanently delete my account
        </Button>
      </Sheet>
    </section>
  )
}
