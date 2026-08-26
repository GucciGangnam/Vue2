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
      media: {
        Row: {
          chunk_count: number
          chunk_size: number
          ciphertext_size: number
          created_at: string
          encrypted_metadata: string
          encrypted_thumbnail: string | null
          id: string
          metadata_nonce: string
          mime_type: string
          nonce_prefix: string
          owner_id: string
          plaintext_size: number
          status: string
          storage_path: string
          thumbnail_nonce: string | null
        }
        Insert: {
          chunk_count: number
          chunk_size: number
          ciphertext_size: number
          created_at?: string
          encrypted_metadata: string
          encrypted_thumbnail?: string | null
          id?: string
          metadata_nonce: string
          mime_type: string
          nonce_prefix: string
          owner_id: string
          plaintext_size: number
          status?: string
          storage_path: string
          thumbnail_nonce?: string | null
        }
        Update: {
          chunk_count?: number
          chunk_size?: number
          ciphertext_size?: number
          created_at?: string
          encrypted_metadata?: string
          encrypted_thumbnail?: string | null
          id?: string
          metadata_nonce?: string
          mime_type?: string
          nonce_prefix?: string
          owner_id?: string
          plaintext_size?: number
          status?: string
          storage_path?: string
          thumbnail_nonce?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'media_owner_id_fkey'
            columns: ['owner_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      media_keys: {
        Row: {
          created_at: string
          ephemeral_public_key: string
          granted_by: string
          hkdf_salt: string
          id: string
          media_id: string
          nonce: string
          recipient_id: string
          version: number
          wrapped_key: string
        }
        Insert: {
          created_at?: string
          ephemeral_public_key: string
          granted_by: string
          hkdf_salt: string
          id?: string
          media_id: string
          nonce: string
          recipient_id: string
          version?: number
          wrapped_key: string
        }
        Update: {
          created_at?: string
          ephemeral_public_key?: string
          granted_by?: string
          hkdf_salt?: string
          id?: string
          media_id?: string
          nonce?: string
          recipient_id?: string
          version?: number
          wrapped_key?: string
        }
        Relationships: [
          {
            foreignKeyName: 'media_keys_granted_by_fkey'
            columns: ['granted_by']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'media_keys_media_id_fkey'
            columns: ['media_id']
            isOneToOne: false
            referencedRelation: 'media'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'media_keys_recipient_id_fkey'
            columns: ['recipient_id']
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
      room_members: {
        Row: {
          can_control: boolean
          invited_at: string
          joined_at: string | null
          role: string
          room_id: string
          state: string
          user_id: string
        }
        Insert: {
          can_control?: boolean
          invited_at?: string
          joined_at?: string | null
          role?: string
          room_id: string
          state?: string
          user_id: string
        }
        Update: {
          can_control?: boolean
          invited_at?: string
          joined_at?: string | null
          role?: string
          room_id?: string
          state?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'room_members_room_id_fkey'
            columns: ['room_id']
            isOneToOne: false
            referencedRelation: 'rooms'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'room_members_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      rooms: {
        Row: {
          anchor_server_time: string
          control_mode: string
          created_at: string
          ended_at: string | null
          id: string
          is_playing: boolean
          last_actor_id: string | null
          media_id: string
          owner_id: string
          position_ms: number
          seq: number
          status: string
        }
        Insert: {
          anchor_server_time?: string
          control_mode?: string
          created_at?: string
          ended_at?: string | null
          id?: string
          is_playing?: boolean
          last_actor_id?: string | null
          media_id: string
          owner_id: string
          position_ms?: number
          seq?: number
          status?: string
        }
        Update: {
          anchor_server_time?: string
          control_mode?: string
          created_at?: string
          ended_at?: string | null
          id?: string
          is_playing?: boolean
          last_actor_id?: string | null
          media_id?: string
          owner_id?: string
          position_ms?: number
          seq?: number
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: 'rooms_media_id_fkey'
            columns: ['media_id']
            isOneToOne: false
            referencedRelation: 'media'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'rooms_owner_id_fkey'
            columns: ['owner_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
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
      get_or_create_room: { Args: { p_media_id: string }; Returns: string }
      has_media_key: { Args: { p_media_id: string }; Returns: boolean }
      has_pending_request_with: { Args: { p_other: string }; Returns: boolean }
      in_room: { Args: { p_room_id: string }; Returns: boolean }
      is_friend_of_caller: { Args: { p_other: string }; Returns: boolean }
      media_object_readable: { Args: { p_name: string }; Returns: boolean }
      owns_media: { Args: { p_media_id: string }; Returns: boolean }
      owns_room: { Args: { p_room_id: string }; Returns: boolean }
      server_now: { Args: never; Returns: string }
      set_playback_state: {
        Args: { p_room_id: string; p_action: string; p_position_ms: number }
        Returns: {
          anchor_server_time: string
          is_playing: boolean
          last_actor_id: string | null
          position_ms: number
          seq: number
          server_time: string
        }[]
      }
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
export type MediaRow = Tables<'media'>
export type MediaKeyRow = Tables<'media_keys'>
export type RoomRow = Tables<'rooms'>
export type RoomMemberRow = Tables<'room_members'>
