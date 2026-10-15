import { useState } from 'react'
import { Share, Smartphone, X } from 'lucide-react'
import { isIOS, isStandalone, promptInstall } from '@/app/pwa'
import { Button, IconButton } from './ui'

const KEY = 'aour-install-dismissed'

/** Encourage "Add to Home Screen" (iOS has no install prompt, so we show instructions). */
export function InstallCard() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(KEY) === '1'
    } catch {
      return false
    }
  })
  const [showSteps, setShowSteps] = useState(false)
  if (dismissed || isStandalone()) return null
  const dismiss = () => {
    setDismissed(true)
    try {
      localStorage.setItem(KEY, '1')
    } catch {
      /* ignore */
    }
  }
  return (
    <div className="relative rounded-card bg-choc p-4 text-cream shadow-card">
      <IconButton label="Dismiss" onClick={dismiss} className="absolute top-1 right-1 size-9 text-cream/70 hover:bg-white/10">
        <X className="size-4" />
      </IconButton>
      <div className="flex items-start gap-3 pr-6">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-butter text-choc">
          <Smartphone className="size-5" />
        </span>
        <div>
          <p className="font-extrabold">Add Aour to your Home Screen</p>
          <p className="text-sm text-cream/80">Opens full-screen like an app, with your rankings one tap away.</p>
        </div>
      </div>
      {showSteps ? (
        <ol className="mt-3 list-decimal space-y-1 pl-6 text-sm text-cream/90">
          <li>
            Tap <Share className="inline size-4 align-text-bottom" aria-label="Share" /> in Safari's toolbar
          </li>
          <li>Choose “Add to Home Screen”</li>
          <li>Tap “Add”</li>
        </ol>
      ) : (
        <Button
          variant="butter"
          size="sm"
          className="mt-3"
          onClick={async () => {
            if (!isIOS() && (await promptInstall())) return dismiss()
            setShowSteps(true)
          }}
        >
          Show me how
        </Button>
      )}
    </div>
  )
}
