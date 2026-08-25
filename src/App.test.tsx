import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { useSession } from './stores/sessionStore'

// The store talks to Supabase on initialize; the gate itself is what we assert.
vi.mock('./lib/supabase', () => ({ supabase: {} }))

/**
 * The real providers from main.tsx. The library screen reads through TanStack
 * Query, and its query stays disabled while there is no identity key -- so the
 * gate can be asserted without Supabase being reachable.
 */
function renderApp(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
    </QueryClientProvider>
  )
  return render(<App />, { wrapper })
}

function setStatus(status: ReturnType<typeof useSession.getState>['status']) {
  useSession.setState({ status, initialize: () => () => {}, pendingRecoveryPhrase: null })
}

describe('App session gate', () => {
  beforeEach(() => {
    useSession.setState({ profile: null, identityKey: null })
  })

  it('shows a loading indicator while the session is restored', () => {
    setStatus('loading')
    renderApp('/library')
    expect(screen.getByLabelText('Loading')).toBeInTheDocument()
  })

  it('redirects a signed-out visitor to sign in, whatever they asked for', () => {
    setStatus('signed-out')
    renderApp('/library')
    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument()
  })

  it('blocks a locked vault from reaching the library', () => {
    setStatus('locked')
    renderApp('/library')
    expect(screen.getByRole('heading', { name: 'Unlock your vault' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Library|Hello/ })).not.toBeInTheDocument()
  })

  it('sends a signed-in user with no keys to vault setup', () => {
    setStatus('needs-vault')
    renderApp('/library')
    expect(screen.getByRole('heading', { name: 'Set up your keys' })).toBeInTheDocument()
  })

  it('shows the recovery phrase before anything else once a vault is created', () => {
    setStatus('ready')
    useSession.setState({
      pendingRecoveryPhrase:
        'legal winner thank year wave sausage worth useful legal winner thank yellow',
    })
    renderApp('/library')
    expect(screen.getByRole('heading', { name: 'Your recovery phrase' })).toBeInTheDocument()
  })

  it('renders the library once the vault is ready', () => {
    setStatus('ready')
    renderApp('/library')
    expect(screen.getByRole('heading', { name: 'Library' })).toBeInTheDocument()
  })
})
