import { Routes, Route } from 'react-router'
import Home from './pages/Home'
import Game from './pages/Game'
import DebugPlanet from './pages/DebugPlanet'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/game" element={<Game />} />
      {/* 行星材质隔离测试台（不进导航，供无头截图排查） */}
      <Route path="/debug-planet" element={<DebugPlanet />} />
    </Routes>
  )
}
