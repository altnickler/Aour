import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { router } from '@/app/router'
import { AuthProvider } from '@/app/auth'
import { LocationProvider } from '@/app/location'
import { ToastProvider } from '@/components/toast'
import { registerServiceWorker } from '@/app/pwa'
import { initMonitoring } from '@/app/monitoring'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
})

// AuthProvider uses router hooks only inside screens, so providers can wrap the router.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <LocationProvider>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </LocationProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
)

registerServiceWorker()
initMonitoring()
