import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router'
import { api, type AuthUser } from '@/data'
import type { Profile } from '@/core/types'

interface AuthState {
  user: AuthUser | null
  profile: Profile | null
  /** True until the persisted session has been read. */
  loading: boolean
  isAdmin: boolean
}

const AuthContext = createContext<AuthState>({ user: null, profile: null, loading: true, isAdmin: false })

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const qc = useQueryClient()

  useEffect(() => {
    let alive = true
    api.getUser().then((u) => {
      if (!alive) return
      setUser(u)
      setLoading(false)
    })
    const off = api.onAuthChange((u) => {
      setUser((prev) => {
        // Drop every user-scoped cache when the account changes.
        if (prev?.id !== u?.id) qc.removeQueries({ predicate: (q) => !['markets', 'listings', 'place'].includes(String(q.queryKey[0])) })
        return u
      })
      setLoading(false)
    })
    return () => {
      alive = false
      off()
    }
  }, [qc])

  const profile = useQuery({
    queryKey: ['me', user?.id ?? null],
    queryFn: () => api.getMyProfile(),
    enabled: !!user,
    staleTime: 5 * 60_000,
  })

  const value: AuthState = {
    user,
    profile: user ? (profile.data ?? null) : null,
    loading: loading || (!!user && profile.isLoading),
    isAdmin: !!user && profile.data?.role === 'admin' && !profile.data.suspended,
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}

/**
 * Returns a guard for actions that need an account. Browsing never requires sign-in;
 * saving, rating, following and collections do.
 */
export function useRequireAuth() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  return useCallback(
    (reason?: string): boolean => {
      if (user) return true
      const next = location.pathname + location.search
      navigate(`/signin?next=${encodeURIComponent(next)}${reason ? `&reason=${encodeURIComponent(reason)}` : ''}`)
      return false
    },
    [user, navigate, location],
  )
}
