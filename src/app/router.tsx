import { lazy } from 'react'
import { createBrowserRouter, Navigate } from 'react-router'
import { Shell } from './Shell'
import { RouteError } from '@/screens/RouteError'
import DiscoverScreen from '@/screens/Discover'

// Discover is eagerly loaded (first paint); everything else is split per route.
const SearchScreen = lazy(() => import('@/screens/Search'))
const MapScreen = lazy(() => import('@/screens/MapScreen'))
const PlaceScreen = lazy(() => import('@/screens/Place'))
const RatePickerScreen = lazy(() => import('@/screens/RatePicker'))
const RateFlowScreen = lazy(() => import('@/screens/RateFlow'))
const RankingsScreen = lazy(() => import('@/screens/Rankings'))
const CollectionScreen = lazy(() => import('@/screens/Collection'))
const ActivityScreen = lazy(() => import('@/screens/Activity'))
const MeScreen = lazy(() => import('@/screens/Me'))
const HistoryScreen = lazy(() => import('@/screens/History'))
const SettingsScreen = lazy(() => import('@/screens/Settings'))
const EditProfileScreen = lazy(() => import('@/screens/EditProfile'))
const UserProfileScreen = lazy(() => import('@/screens/UserProfile'))
const SignInScreen = lazy(() => import('@/screens/SignIn'))
const WelcomeScreen = lazy(() => import('@/screens/Welcome'))
const SuggestScreen = lazy(() => import('@/screens/Suggest'))
const LegalScreen = lazy(() => import('@/screens/Legal'))
const FindPeopleScreen = lazy(() => import('@/screens/FindPeople'))
const AdminScreen = lazy(() => import('@/screens/admin/Admin'))

export const router = createBrowserRouter([
  {
    element: <Shell />,
    errorElement: <RouteError />,
    children: [
      { path: '/', element: <DiscoverScreen /> },
      { path: '/search', element: <SearchScreen /> },
      { path: '/map', element: <MapScreen /> },
      { path: '/place/:slug', element: <PlaceScreen /> },
      { path: '/rate', element: <RatePickerScreen /> },
      { path: '/rate/:slug', element: <RateFlowScreen /> },
      { path: '/visit/:visitId/edit', element: <RateFlowScreen /> },
      { path: '/rankings', element: <RankingsScreen /> },
      { path: '/collections/:shareId', element: <CollectionScreen /> },
      { path: '/c/:shareId', element: <CollectionScreen /> },
      { path: '/activity', element: <ActivityScreen /> },
      { path: '/people', element: <FindPeopleScreen /> },
      { path: '/me', element: <MeScreen /> },
      { path: '/me/history', element: <HistoryScreen /> },
      { path: '/me/edit', element: <EditProfileScreen /> },
      { path: '/settings', element: <SettingsScreen /> },
      { path: '/u/:username', element: <UserProfileScreen /> },
      { path: '/signin', element: <SignInScreen /> },
      { path: '/welcome', element: <WelcomeScreen /> },
      { path: '/suggest', element: <SuggestScreen /> },
      { path: '/privacy', element: <LegalScreen doc="privacy" /> },
      { path: '/terms', element: <LegalScreen doc="terms" /> },
      { path: '/admin/*', element: <AdminScreen /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])
