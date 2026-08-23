import { lazy, Suspense } from 'react'
import ImmersiveGame from './pages/ImmersiveGame'

const DebugPlanet = lazy(() => import('./pages/DebugPlanet'))

export default function App() {
  if (window.location.pathname === '/debug-planet') {
    return <Suspense fallback={null}><DebugPlanet /></Suspense>
  }
  return <ImmersiveGame />
}
