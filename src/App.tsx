import { useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { PlaceholderScreen } from './components/PlaceholderScreen'
import { Friends } from './routes/Friends'
import { Library } from './routes/Library'
import { Player } from './routes/Player'
import { RecoveryPhrase } from './routes/RecoveryPhrase'
import { SignIn } from './routes/SignIn'
import { SignUp } from './routes/SignUp'
import { Unlock } from './routes/Unlock'
import { VaultSetup } from './routes/VaultSetup'
import { useSession } from './stores/sessionStore'

/**
 * Session status is a gate, not a route: an account with a locked vault must
 * not be able to reach any screen that needs a key, whatever URL is typed.
 * Only once the vault is `ready` do the real routes mount.
 */
export default function App() {
  const status = useSession((s) => s.status)
  const pendingRecoveryPhrase = useSession((s) => s.pendingRecoveryPhrase)
  const initialize = useSession((s) => s.initialize)

  useEffect(() => initialize(), [initialize])

  if (status === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Loader2 className="size-6 animate-spin text-ink-700" aria-label="Loading" />
      </div>
    )
  }

  if (status === 'signed-out') {
    return (
      <Routes>
        <Route path="/signup" element={<SignUp />} />
        <Route path="/signin" element={<SignIn />} />
        <Route path="*" element={<Navigate to="/signin" replace />} />
      </Routes>
    )
  }

  // Takes priority over everything: the phrase is shown once and must not be
  // navigable away from before it is confirmed.
  if (pendingRecoveryPhrase) {
    return <RecoveryPhrase phrase={pendingRecoveryPhrase} />
  }

  if (status === 'needs-vault') return <VaultSetup />
  if (status === 'locked') return <Unlock />

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/library" replace />} />
      <Route path="/library" element={<Library />} />
      <Route path="/friends" element={<Friends />} />
      <Route path="/watch/:mediaId" element={<Player />} />
      <Route
        path="/room/:roomId"
        element={<PlaceholderScreen title="Room" phase="Phase 5 — Rooms & sync" />}
      />
      <Route path="*" element={<Navigate to="/library" replace />} />
    </Routes>
  )
}
