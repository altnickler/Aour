import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useAuth, useRequireAuth } from '@/app/auth'
import { api } from '@/data'
import { Button, Field, Input, PageHeader, Textarea, EmptyState } from '@/components/ui'
import { errorMessage, useToast } from '@/components/toast'

/** Users suggest new places. Submissions go to the admin queue — never straight to the map. */
export default function SuggestScreen() {
  const { user } = useAuth()
  const requireAuth = useRequireAuth()
  const navigate = useNavigate()
  const toast = useToast()
  const [form, setForm] = useState({ name: '', area: '', address: '', happyHour: '', specials: '', website: '', notes: '' })
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })

  if (done) {
    return (
      <div>
        <PageHeader title="Suggest a place" back />
        <EmptyState icon="🙌" title="Thanks for the tip!" body="Our team will verify the details before it appears on Aour." action={<Button onClick={() => navigate('/')}>Back to Discover</Button>} />
      </div>
    )
  }

  return (
    <div>
      <PageHeader title="Suggest a place" subtitle="We verify every listing before publishing" back />
      <form
        className="space-y-4 px-5 pb-10"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!requireAuth('report')) return
          setBusy(true)
          try {
            const payload = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v))
            await api.submit('new_place', null, payload)
            setDone(true)
          } catch (err) {
            toast(errorMessage(err), 'error')
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field label="Place name">{(id) => <Input id={id} required maxLength={100} value={form.name} onChange={set('name')} />}</Field>
        <Field label="Town or neighborhood">{(id) => <Input id={id} maxLength={80} value={form.area} onChange={set('area')} placeholder="e.g. Jensen Beach" />}</Field>
        <Field label="Address">{(id) => <Input id={id} maxLength={200} value={form.address} onChange={set('address')} />}</Field>
        <Field label="Happy hour days & times" hint="As best you know — we'll confirm.">
          {(id) => <Input id={id} maxLength={200} value={form.happyHour} onChange={set('happyHour')} placeholder="Mon–Fri 4–7pm" />}
        </Field>
        <Field label="Specials">{(id) => <Textarea id={id} maxLength={500} value={form.specials} onChange={set('specials')} placeholder="$5 wine, half-price apps…" />}</Field>
        <Field label="Website or menu link">{(id) => <Input id={id} type="url" maxLength={300} value={form.website} onChange={set('website')} placeholder="https://" />}</Field>
        <Field label="Anything else?">{(id) => <Textarea id={id} maxLength={500} value={form.notes} onChange={set('notes')} />}</Field>
        <Button type="submit" size="lg" block loading={busy} disabled={!form.name.trim()}>
          {user ? 'Send suggestion' : 'Sign in to send'}
        </Button>
      </form>
    </div>
  )
}
