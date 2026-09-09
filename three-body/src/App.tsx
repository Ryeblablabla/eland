import { lazy, Suspense } from 'react'
import ImmersiveGame from './pages/ImmersiveGame'

// A development comparison only. Production always opens the real game.
const RiverbendStudy = import.meta.env.DEV ? lazy(() => import('./pages/RiverbendStudy')) : null
const AgentReplay = lazy(() => import('./pages/AgentReplay'))

export default function App() {
  const location = new URL(window.location.href)
  if (location.pathname === '/replay') {
    return <Suspense fallback={null}><AgentReplay /></Suspense>
  }
  if (RiverbendStudy && (location.searchParams.get('scene') === 'riverbend' || location.pathname === '/riverbend')) {
    return <Suspense fallback={null}><RiverbendStudy /></Suspense>
  }
  return <ImmersiveGame />
}
