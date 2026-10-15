import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Mail, X } from 'lucide-react'
import { api } from '@/data'
import { DEMO_CODE } from '@/data/demo/constants'
import { useAuth } from '@/app/auth'
import { config, isDemoMode } from '@/lib/config'
import { Logo } from '@/components/brand'
import { Button, IconButton, Input } from '@/components/ui'
import { errorMessage } from '@/components/toast'

const REASONS: Record<string, string> = {
  save: 'Sign in to save places to your lists.',
  rate: 'Sign in to rate happy hours and build your rankings.',
  rankings: 'Sign in to keep your personal rankings.',
  follow: 'Sign in to follow people.',
  collections: 'Sign in to create collections.',
  report: 'Sign in to send reports.',
}

/** Passwordless sign-in: email → 6-digit code. No passwords to manage or leak. */
export default function SignInScreen() {
  const [params] = useSearchParams()
  const next = params.get('next') || '/'
  const reason = REASONS[params.get('reason') ?? '']
  const navigate = useNavigate()
  const { user } = useAuth()
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState(isDemoMode ? DEMO_CODE : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cooldown, setCooldown] = useState(0)
  const codeRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Only allow same-site relative redirects.
    if (user) navigate(next.startsWith('/') && !next.startsWith('//') ? next : '/', { replace: true })
  }, [user, next, navigate])

  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.sendEmailCode(email)
      setStep('code')
      setCooldown(30)
      setTimeout(() => codeRef.current?.focus(), 50)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const verify = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.verifyEmailCode(email, code)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <div className="pt-safe flex min-h-dvh flex-col bg-cream px-6">
      <div className="flex h-14 items-center justify-end">
        <IconButton label="Close" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))}>
          <X className="size-6" />
        </IconButton>
      </div>
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center pb-24">
        <Logo size={36} />
        <h1 className="mt-6 text-[28px] leading-tight font-extrabold tracking-tight text-choc">
          {step === 'email' ? 'Your happy hours, ranked.' : 'Check your email'}
        </h1>
        <p className="mt-2 text-[15px] text-muted">
          {step === 'email' ? (reason ?? 'Sign in or create an account with your email. No password needed.') : `We sent a 6-digit code to ${email}.`}
        </p>

        {step === 'email' ? (
          <form
            className="mt-8 space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              void send()
            }}
          >
            <label htmlFor="email" className="sr-only">Email</label>
            <Input id="email" type="email" autoComplete="email" inputMode="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Button type="submit" size="lg" block loading={busy} disabled={!email}>
              <Mail className="size-5" /> Continue with email
            </Button>
            {config.appleSignIn && (
              <Button
                size="lg"
                block
                variant="secondary"
                onClick={async () => {
                  try {
                    await api.signInWithApple()
                  } catch (e) {
                    setError(errorMessage(e))
                  }
                }}
              >
                <svg viewBox="0 0 24 24" className="size-5" aria-hidden fill="currentColor"><path d="M16.37 12.6c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.19-1.72-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.88-.76-1.48.02-2.85.86-3.61 2.19-1.54 2.67-.39 6.63 1.1 8.8.73 1.06 1.6 2.25 2.74 2.2 1.1-.04 1.52-.71 2.85-.71 1.33 0 1.71.71 2.88.69 1.19-.02 1.94-1.08 2.66-2.14.84-1.23 1.19-2.42 1.21-2.48-.03-.01-2.32-.89-2.3-3.56zM14.2 6.13c.61-.74 1.02-1.76.91-2.78-.88.04-1.94.59-2.57 1.33-.56.65-1.06 1.69-.93 2.69.98.08 1.98-.5 2.59-1.24z" /></svg>
                Continue with Apple
              </Button>
            )}
          </form>
        ) : (
          <form
            className="mt-8 space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              void verify()
            }}
          >
            <label htmlFor="code" className="sr-only">6-digit code</label>
            <Input
              ref={codeRef}
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              className="text-center text-2xl font-extrabold tracking-[0.4em]"
            />
            {isDemoMode && <p className="text-center text-xs text-muted">Demo mode: the code is {DEMO_CODE}.</p>}
            <Button type="submit" size="lg" block loading={busy} disabled={code.length !== 6}>
              Verify & continue
            </Button>
            <div className="flex justify-between text-sm">
              <button type="button" className="font-semibold text-muted" onClick={() => { setStep('email'); setError(null) }}>
                Use a different email
              </button>
              <button type="button" className="font-semibold text-choc disabled:text-muted" disabled={cooldown > 0 || busy} onClick={() => void send()}>
                {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
              </button>
            </div>
          </form>
        )}
        {error && (
          <p role="alert" className="mt-4 rounded-tile bg-danger/10 p-3 text-sm text-danger">
            {error}
          </p>
        )}
        <p className="mt-10 text-center text-xs text-muted">
          By continuing you agree to our <Link to="/terms" className="underline">Terms</Link> and <Link to="/privacy" className="underline">Privacy Policy</Link>.
        </p>
      </div>
    </div>
  )
}
