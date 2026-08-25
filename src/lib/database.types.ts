/**
 * Generated from the live schema. Regenerate with `npm run db:types`
 * (requires the Supabase CLI to be linked) after every migration.
 *
 * Note: `bytea` columns arrive as PostgREST hex strings (`\xdeadbeef`).
 * Use `fromBytea` / `toBytea` in src/lib/crypto/bytes.ts -- never treat them
 * as opaque strings.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  __InternalSupabase: { PostgrestVersion: '14.15' }
  public: {
    Tables: {
      friend_requests: {
        Row: {
          addressee_id: string
          created_at: string
          id: string
          requester_id: string
          responded_at: string | null
          status: string
        }
        Insert: {
          addressee_id: string
          created_at?: string
          id?: string
          requester_id: string
          responded_at?: string | null
          status?: string
        }
        Update: {
          addressee_id?: string
          created_at?: string
          id?: string
          requester_id?: string
          responded_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: 'friend_requests_addressee_id_fkey'
            columns: ['addressee_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'friend_requests_requester_id_fkey'
            columns: ['requester_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      friendships: {
        Row: { created_at: string; user_a: string; user_b: string }
        Insert: { created_at?: string; user_a: string; user_b: string }
        Update: { created_at?: string; user_a?: string; user_b?: string }
        Relationships: [
          {
            foreignKeyName: 'friendships_user_a_fkey'
            columns: ['user_a']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'friendships_user_b_fkey'
            columns: ['user_b']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      profiles: {
        Row: {
          avatar_hue: number
          created_at: string
          display_name: string
          friend_code: string
          id: string
        }
        Insert: {
          avatar_hue?: number
          created_at?: string
          display_name: string
          friend_code: string
          id: string
        }
        Update: {
          avatar_hue?: number
          created_at?: string
          display_name?: string
          friend_code?: string
          id?: string
        }
        Relationships: []
      }
      user_private_keys: {
        Row: {
          kdf_params: Json
          pw_nonce: string
          pw_salt: string
          pw_wrapped_key: string
          rc_nonce: string
          rc_salt: string
          rc_wrapped_key: string
          updated_at: string
          user_id: string
          version: number
        }
        Insert: {
          kdf_params?: Json
          pw_nonce: string
          pw_salt: string
          pw_wrapped_key: string
          rc_nonce: string
          rc_salt: string
          rc_wrapped_key: string
          updated_at?: string
          user_id: string
          version?: number
        }
        Update: {
          kdf_params?: Json
          pw_nonce?: string
          pw_salt?: string
          pw_wrapped_key?: string
          rc_nonce?: string
          rc_salt?: string
          rc_wrapped_key?: string
          updated_at?: string
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: 'user_private_keys_user_id_fkey'
            columns: ['user_id']
            isOneToOne: true
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      user_public_keys: {
        Row: { created_at: string; public_key: string; user_id: string }
        Insert: { created_at?: string; public_key: string; user_id: string }
        Update: { created_at?: string; public_key?: string; user_id?: string }
        Relationships: [
          {
            foreignKeyName: 'user_public_keys_user_id_fkey'
            columns: ['user_id']
            isOneToOne: true
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
    }
    Views: { [_ in never]: never }
    Functions: {
      are_friends: { Args: { p_one: string; p_two: string }; Returns: boolean }
      find_profile_by_code: {
        Args: { p_code: string }
        Returns: {
          avatar_hue: number
          display_name: string
          friend_code: string
          id: string
          public_key: string
        }[]
      }
      generate_friend_code: { Args: never; Returns: string }
      has_pending_request_with: { Args: { p_other: string }; Returns: boolean }
      is_friend_of_caller: { Args: { p_other: string }; Returns: boolean }
    }
    Enums: { [_ in never]: never }
    CompositeTypes: { [_ in never]: never }
  }
}

type PublicSchema = Database['public']

export type Tables<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Row']
export type TablesInsert<T extends keyof PublicSchema['Tables']> =
  PublicSchema['Tables'][T]['Insert']
export type TablesUpdate<T extends keyof PublicSchema['Tables']> =
  PublicSchema['Tables'][T]['Update']

export type Profile = Tables<'profiles'>
