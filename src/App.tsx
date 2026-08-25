import { Navigate, Route, Routes } from 'react-router-dom'
import { PlaceholderScreen } from './components/PlaceholderScreen'

/**
 * Route skeleton. Phase 0 renders placeholders only -- each phase replaces
 * one of these with the real screen. See docs/PHASES.md.
 */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/library" replace />} />
      <Route
        path="/signin"
        element={<PlaceholderScreen title="Sign in" phase="Phase 1 — Identity & crypto core" />}
      />
      <Route
        path="/library"
        element={<PlaceholderScreen title="Library" phase="Phase 3 — Encrypted upload" />}
      />
      <Route
        path="/friends"
        element={<PlaceholderScreen title="Friends" phase="Phase 2 — Friends" />}
      />
      <Route
        path="/room/:roomId"
        element={<PlaceholderScreen title="Room" phase="Phase 5 — Rooms & sync" />}
      />
      <Route path="*" element={<PlaceholderScreen title="Not found" phase="—" />} />
    </Routes>
  )
}
