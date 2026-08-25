import { createClient } from '@supabase/supabase-js'
import { env } from './env'

/**
 * The single Supabase client for the app.
 *
 * Note on E2EE: this client only ever transports ciphertext for media,
 * media titles and thumbnails. Plaintext keys must never be passed to any
 * `.from()` / `.storage` call. See docs/CRYPTO.md.
 */
export const supabase = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  realtime: {
    params: { eventsPerSecond: 20 },
  },
})
