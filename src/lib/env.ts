/**
 * Validated environment access. Fails loudly at boot rather than producing
 * confusing `undefined` errors deep inside the Supabase client.
 */
function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Copy .env.example to .env and fill it in.`,
    )
  }
  return value
}

/**
 * The largest object Supabase Storage will accept, in bytes.
 *
 * This is a **project setting, not a bucket setting**: a bucket may declare a
 * higher `file_size_limit` and still be overruled by the plan's global cap. The
 * free plan caps it at 50 MiB, which is what this default reflects; raising the
 * project setting on a paid plan means raising this too, hence an env var
 * rather than a constant buried in the upload code.
 *
 * Getting it wrong is not subtle: storage rejects the whole upload with a 413
 * at tus creation time, after the file has already been read and encrypted.
 */
const DEFAULT_MAX_CIPHERTEXT_BYTES = 50 * 1024 * 1024

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`)
  }
  return parsed
}

export const env = {
  supabaseUrl: required('VITE_SUPABASE_URL', import.meta.env.VITE_SUPABASE_URL),
  supabaseAnonKey: required('VITE_SUPABASE_ANON_KEY', import.meta.env.VITE_SUPABASE_ANON_KEY),
  maxCiphertextBytes: positiveInteger(
    'VITE_MAX_CIPHERTEXT_BYTES',
    import.meta.env.VITE_MAX_CIPHERTEXT_BYTES,
    DEFAULT_MAX_CIPHERTEXT_BYTES,
  ),
} as const
