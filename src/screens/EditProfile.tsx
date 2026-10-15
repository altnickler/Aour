import { useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Camera } from 'lucide-react'
import { useAuth } from '@/app/auth'
import { useUpdateProfile } from '@/data/hooks'
import { api } from '@/data'
import { validateUsername } from '@/core/listing'
import { compressImage, ACCEPTED_IMAGE_TYPES } from '@/lib/image'
import { Avatar, Button, Field, Input, PageHeader, Textarea } from '@/components/ui'
import { errorMessage, useToast } from '@/components/toast'

export default function EditProfileScreen() {
  const { profile } = useAuth()
  const update = useUpdateProfile()
  const toast = useToast()
  const navigate = useNavigate()
  const file = useRef<HTMLInputElement>(null)
  const [form, setForm] = useState({
    displayName: profile?.displayName ?? '',
    username: profile?.username ?? '',
    bio: profile?.bio ?? '',
    homeCity: profile?.homeCity ?? '',
    avatarUrl: profile?.avatarUrl ?? null,
  })
  const [uploading, setUploading] = useState(false)
  if (!profile) return null
  const usernameError = form.username !== profile.username ? validateUsername(form.username) : null

  return (
    <div>
      <PageHeader title="Edit profile" back />
      <form
        className="space-y-5 px-5 pb-10"
        onSubmit={async (e) => {
          e.preventDefault()
          try {
            await update.mutateAsync({
              displayName: form.displayName.trim(),
              username: form.username,
              bio: form.bio.trim() || null,
              homeCity: form.homeCity.trim() || null,
              avatarUrl: form.avatarUrl,
            })
            toast('Profile saved')
            navigate('/me')
          } catch (err) {
            toast(errorMessage(err), 'error')
          }
        }}
      >
        <div className="flex items-center gap-4">
          <Avatar name={form.displayName || '?'} url={form.avatarUrl} size={80} />
          <div className="flex flex-col gap-2">
            <Button variant="secondary" size="sm" loading={uploading} onClick={() => file.current?.click()}>
              <Camera className="size-4" /> Change photo
            </Button>
            {form.avatarUrl && (
              <button type="button" className="text-left text-sm font-semibold text-muted" onClick={() => setForm({ ...form, avatarUrl: null })}>
                Remove photo
              </button>
            )}
          </div>
          <input
            ref={file}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES}
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (!f) return
              setUploading(true)
              try {
                const url = await api.uploadAvatar(await compressImage(f, 512, 0.85))
                setForm((s) => ({ ...s, avatarUrl: url }))
              } catch (err) {
                toast(errorMessage(err), 'error')
              } finally {
                setUploading(false)
              }
            }}
          />
        </div>
        <Field label="Display name">{(id) => <Input id={id} value={form.displayName} maxLength={50} required onChange={(e) => setForm({ ...form, displayName: e.target.value })} />}</Field>
        <Field label="Username" error={usernameError} hint="Lowercase letters, numbers and underscores.">
          {(id) => <Input id={id} value={form.username} maxLength={24} autoCapitalize="none" autoCorrect="off" onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} />}
        </Field>
        <Field label="Bio" hint={`${form.bio.length}/280`}>{(id) => <Textarea id={id} value={form.bio} maxLength={280} onChange={(e) => setForm({ ...form, bio: e.target.value })} placeholder="Espresso martinis > everything" />}</Field>
        <Field label="Home city">{(id) => <Input id={id} value={form.homeCity} maxLength={60} onChange={(e) => setForm({ ...form, homeCity: e.target.value })} placeholder="Stuart, FL" />}</Field>
        <Button type="submit" size="lg" block loading={update.isPending} disabled={!!usernameError || !form.displayName.trim()}>
          Save
        </Button>
      </form>
    </div>
  )
}
