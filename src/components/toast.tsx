import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, CircleAlert } from 'lucide-react'
import { cn } from '@/lib/cn'
import { haptic } from '@/lib/share'

interface Toast {
  id: number
  message: string
  tone: 'success' | 'error' | 'info'
}

const Ctx = createContext<(message: string, tone?: Toast['tone']) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const show = useCallback((message: string, tone: Toast['tone'] = 'success') => {
    const id = Date.now() + Math.random()
    if (tone === 'success') haptic()
    setToasts((t) => [...t.slice(-2), { id, message, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 4500 : 2600)
  }, [])
  return (
    <Ctx.Provider value={show}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 px-4 pt-[max(env(safe-area-inset-top),12px)]" aria-live="polite">
          {toasts.map((t) => (
            <div
              key={t.id}
              role={t.tone === 'error' ? 'alert' : 'status'}
              className={cn(
                'animate-rise flex max-w-sm items-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold shadow-float',
                t.tone === 'error' ? 'bg-danger text-white' : 'bg-choc text-cream',
              )}
            >
              {t.tone === 'error' ? <CircleAlert className="size-4 shrink-0" /> : <Check className="size-4 shrink-0 text-butter" />}
              {t.message}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </Ctx.Provider>
  )
}

export function useToast() {
  return useContext(Ctx)
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong. Please try again.'
}
