import { Screen, ScreenHeader } from '@/components/ui/Screen'
import { Button } from '@/components/ui/Button'
import { useSession } from '@/stores/sessionStore'

/**
 * Placeholder until Phase 3. It exists now so Phase 1 can be verified end to
 * end: if the friend code and identity key render here, the whole chain worked.
 */
export function Library() {
  const profile = useSession((s) => s.profile)
  const identityKey = useSession((s) => s.identityKey)
  const signOut = useSession((s) => s.signOut)

  return (
    <Screen>
      <ScreenHeader
        title={profile ? `Hello, ${profile.display_name}` : 'Library'}
        subtitle="Your encrypted library arrives in Phase 3."
      />

      {profile && (
        <dl className="flex flex-col gap-3 rounded-xl bg-ink-900 p-4 text-sm">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-ink-500">Friend code</dt>
            <dd className="font-mono text-base tracking-widest text-lamp-500">
              {profile.friend_code}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-ink-500">Identity key</dt>
            <dd className={identityKey ? 'text-ok-500' : 'text-danger-500'}>
              {identityKey ? 'unlocked' : 'locked'}
            </dd>
          </div>
        </dl>
      )}

      <Button variant="ghost" onClick={signOut}>
        Sign out
      </Button>
    </Screen>
  )
}
