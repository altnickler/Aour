import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useQueries } from '@tanstack/react-query'
import { Lock, Pencil, Share, Trash2, X } from 'lucide-react'
import { useAuth } from '@/app/auth'
import { useLocationState } from '@/app/location'
import { useCollection, useCollectionMutations, useListingIndex, useRankings } from '@/data/hooks'
import { api } from '@/data'
import { shareLink } from '@/lib/share'
import { useNow } from '@/app/useNow'
import { PlaceRow } from '@/components/place'
import { ScoreBadge } from '@/components/score'
import { Badge, Button, EmptyState, IconButton, PageHeader, Skeleton } from '@/components/ui'
import { errorMessage, useToast } from '@/components/toast'
import { CollectionEditor } from './Rankings'
import type { Establishment } from '@/core/types'

export default function CollectionScreen() {
  const { shareId = '' } = useParams()
  const collection = useCollection(shareId)
  const { user } = useAuth()
  const { market } = useLocationState()
  const { index } = useListingIndex(market?.id)
  const { byPlace } = useRankings()
  const { remove, setItem } = useCollectionMutations()
  const toast = useToast()
  const navigate = useNavigate()
  const now = useNow()
  const [editing, setEditing] = useState(false)

  const c = collection.data
  const missing = (c?.items ?? []).map((i) => i.establishmentId).filter((id) => !index.has(id))
  const extra = useQueries({ queries: missing.map((id) => ({ queryKey: ['place', id], queryFn: () => api.getEstablishment(id), staleTime: 300_000 })) })
  const places = (c?.items ?? [])
    .map((i) => index.get(i.establishmentId) ?? extra.find((q) => q.data?.id === i.establishmentId)?.data)
    .filter((e): e is Establishment => !!e)

  if (collection.isLoading) {
    return (
      <div>
        <PageHeader title="" back />
        <div className="space-y-3 px-4">
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      </div>
    )
  }
  if (!c) {
    return (
      <div>
        <PageHeader title="Collection" back />
        <EmptyState icon="🔒" title="Collection not available" body="It may be private or no longer exist." action={<Button onClick={() => navigate('/')}>Discover</Button>} />
      </div>
    )
  }

  const isOwner = user?.id === c.userId
  return (
    <div>
      <PageHeader
        title={c.name}
        back
        actions={
          <>
            {c.visibility === 'public' && (
              <IconButton
                label="Share collection"
                onClick={async () => {
                  const r = await shareLink(`/c/${c.shareId}`, c.name, `${c.name} — a happy hour list on Aour`)
                  if (r === 'copied') toast('Link copied')
                }}
              >
                <Share className="size-5" />
              </IconButton>
            )}
            {isOwner && (
              <IconButton label="Edit collection" onClick={() => setEditing(true)}>
                <Pencil className="size-5" />
              </IconButton>
            )}
          </>
        }
      />
      <div className="px-5">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          {c.ownerUsername && (
            <Link to={`/u/${c.ownerUsername}`} className="font-semibold text-choc">
              @{c.ownerUsername}
            </Link>
          )}
          <span>{c.items.length} places</span>
          {c.visibility === 'private' ? (
            <Badge>
              <Lock className="size-3" /> Private
            </Badge>
          ) : (
            <Badge tone="butter">Public</Badge>
          )}
          {c.featured && <Badge tone="dark">Featured</Badge>}
        </div>
        {c.description && <p className="mt-2 text-[15px] text-espresso">{c.description}</p>}
      </div>

      {places.length === 0 ? (
        <EmptyState icon="📍" title="No places yet" body={isOwner ? 'Add places from any place page using the collection button.' : 'Check back soon.'} />
      ) : (
        <ol className="mt-3 px-3">
          {places.map((e) => (
            <li key={e.id} className="flex items-center">
              <div className="min-w-0 flex-1">
                <PlaceRow
                  place={e}
                  now={now}
                  trailing={
                    <div className="flex flex-col items-center gap-1">
                      <ScoreBadge score={e.community.average} size="sm" />
                      {byPlace.has(e.id) && <ScoreBadge score={byPlace.get(e.id)!.score} kind="mine" size="sm" className="size-7 text-[11px]" />}
                    </div>
                  }
                />
              </div>
              {isOwner && (
                <IconButton label={`Remove ${e.name}`} onClick={() => setItem.mutate({ collectionId: c.id, establishmentId: e.id, included: false })}>
                  <X className="size-4" />
                </IconButton>
              )}
            </li>
          ))}
        </ol>
      )}

      {isOwner && (
        <div className="mt-8 px-4">
          <Button
            variant="danger"
            block
            loading={remove.isPending}
            onClick={async () => {
              if (!window.confirm(`Delete "${c.name}"? Places stay in your rankings.`)) return
              try {
                await remove.mutateAsync(c.id)
                toast('Collection deleted')
                navigate('/rankings?tab=collections', { replace: true })
              } catch (e) {
                toast(errorMessage(e), 'error')
              }
            }}
          >
            <Trash2 className="size-4" /> Delete collection
          </Button>
        </div>
      )}
      {isOwner && (
        <CollectionEditor
          key={c.updatedAt}
          open={editing}
          onClose={() => setEditing(false)}
          initial={{ id: c.id, name: c.name, description: c.description, visibility: c.visibility }}
          onSaved={() => collection.refetch()}
        />
      )}
    </div>
  )
}
