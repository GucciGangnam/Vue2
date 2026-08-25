import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'
import { env } from './env'

/**
 * The single Supabase client for the app.
 *
 * Note on E2EE: this client only ever transports ciphertext for media, media
 * titles and thumbnails. Plaintext key material must never be passed to any
 * `.from()`, `.rpc()` or `.storage` call. See docs/CRYPTO.md.
 */
export const supabase = createClient<Database>(env.supabaseUrl, env.supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  realtime: {
    params: { eventsPerSecond: 20 },
  },
})
