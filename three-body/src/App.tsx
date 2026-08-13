import { Routes, Route } from 'react-router'
import Home from './pages/Home'
import Game from './pages/Game'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/game" element={<Game />} />
    </Routes>
  )
}
