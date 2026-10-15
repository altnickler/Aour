import { useState } from 'react'
import { Check, Lock, Plus } from 'lucide-react'
import { useCollectionMutations, useMyCollections } from '@/data/hooks'
import { Button, Input, Sheet, Spinner } from './ui'
import { errorMessage, useToast } from './toast'
import { cn } from '@/lib/cn'

/** Add/remove a place from the user's collections, or create a new one inline. */
export function CollectionPicker({ open, onClose, establishmentId }: { open: boolean; onClose: () => void; establishmentId: string }) {
  const collections = useMyCollections()
  const { save, setItem } = useCollectionMutations()
  const toast = useToast()
  const [name, setName] = useState('')

  return (
    <Sheet open={open} onClose={onClose} title="Add to collection">
      {collections.isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : (
        <ul className="space-y-2">
          {(collections.data ?? []).map((c) => {
            const included = c.items.some((i) => i.establishmentId === establishmentId)
            return (
              <li key={c.id}>
                <button
                  type="button"
                  aria-pressed={included}
                  onClick={() =>
                    setItem.mutate(
                      { collectionId: c.id, establishmentId, included: !included },
                      { onSuccess: () => toast(included ? `Removed from ${c.name}` : `Added to ${c.name}`), onError: (e) => toast(errorMessage(e), 'error') },
                    )
                  }
                  className="press flex w-full items-center gap-3 rounded-tile bg-white p-3 text-left shadow-press ring-1 ring-line"
                >
                  <span className={cn('flex size-8 items-center justify-center rounded-full', included ? 'bg-choc text-butter' : 'bg-cream-deep text-muted')}>
                    {included ? <Check className="size-4" /> : <Plus className="size-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-bold text-choc">{c.name}</span>
                    <span className="text-xs text-muted">
                      {c.items.length} places {c.visibility === 'private' && <Lock className="inline size-3" aria-label="private" />}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!name.trim()) return
          save.mutate(
            { name: name.trim(), description: null, visibility: 'private' },
            {
              onSuccess: (c) => {
                setItem.mutate({ collectionId: c.id, establishmentId, included: true })
                toast(`Created ${c.name}`)
                setName('')
              },
              onError: (err) => toast(errorMessage(err), 'error'),
            },
          )
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New collection, e.g. Best in Stuart" maxLength={60} aria-label="New collection name" />
        <Button type="submit" loading={save.isPending} disabled={!name.trim()}>
          Create
        </Button>
      </form>
    </Sheet>
  )
}
