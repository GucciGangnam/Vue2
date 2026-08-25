import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { useSession } from './stores/sessionStore'

// The store talks to Supabase on initialize; the gate itself is what we assert.
vi.mock('./lib/supabase', () => ({ supabase: {} }))

function setStatus(status: ReturnType<typeof useSession.getState>['status']) {
  useSession.setState({ status, initialize: () => () => {}, pendingRecoveryPhrase: null })
}

describe('App session gate', () => {
  beforeEach(() => {
    useSession.setState({ profile: null, identityKey: null })
  })

  it('shows a loading indicator while the session is restored', () => {
    setStatus('loading')
    render(
      <MemoryRouter initialEntries={['/library']}>
        <App />
      </MemoryRouter>,
    )
    expect(screen.getByLabelText('Loading')).toBeInTheDocument()
  })

  it('redirects a signed-out visitor to sign in, whatever they asked for', () => {
    setStatus('signed-out')
    render(
      <MemoryRouter initialEntries={['/library']}>
        <App />
      </MemoryRouter>,
    )
    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument()
  })

  it('blocks a locked vault from reaching the library', () => {
    setStatus('locked')
    render(
      <MemoryRouter initialEntries={['/library']}>
        <App />
      </MemoryRouter>,
    )
    expect(screen.getByRole('heading', { name: 'Unlock your vault' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Library|Hello/ })).not.toBeInTheDocument()
  })

  it('sends a signed-in user with no keys to vault setup', () => {
    setStatus('needs-vault')
    render(
      <MemoryRouter initialEntries={['/library']}>
        <App />
      </MemoryRouter>,
    )
    expect(screen.getByRole('heading', { name: 'Set up your keys' })).toBeInTheDocument()
  })

  it('shows the recovery phrase before anything else once a vault is created', () => {
    setStatus('ready')
    useSession.setState({
      pendingRecoveryPhrase:
        'legal winner thank year wave sausage worth useful legal winner thank yellow',
    })
    render(
      <MemoryRouter initialEntries={['/library']}>
        <App />
      </MemoryRouter>,
    )
    expect(screen.getByRole('heading', { name: 'Your recovery phrase' })).toBeInTheDocument()
  })

  it('renders the library once the vault is ready', () => {
    setStatus('ready')
    render(
      <MemoryRouter initialEntries={['/library']}>
        <App />
      </MemoryRouter>,
    )
    expect(screen.getByRole('heading', { name: 'Library' })).toBeInTheDocument()
  })
})
