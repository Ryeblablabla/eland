import ImmersiveGame from './pages/ImmersiveGame'
import DebugPlanet from './pages/DebugPlanet'

export default function App() {
  if (window.location.pathname === '/debug-planet') return <DebugPlanet />
  return <ImmersiveGame />
}
