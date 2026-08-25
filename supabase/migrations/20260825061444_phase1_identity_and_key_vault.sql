-- Phase 1: identity, profiles, and the encrypted key vault.
--
-- The server never sees an unwrapped private key. `user_private_keys` holds two
-- independent AES-GCM wraps of the same PKCS8 blob (password-derived and
-- recovery-phrase-derived); both are opaque ciphertext here. See docs/CRYPTO.md.

-- ============================================================================
-- friend codes
-- ============================================================================

-- Crockford base32 minus I, L, O and U -- the characters people misread aloud.
create or replace function public.generate_friend_code()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  candidate text;
  raw bytea;
  attempts int := 0;
begin
  loop
    -- gen_random_bytes rather than random(): a guessable code lets a stranger
    -- enumerate users and spam friend requests.
    raw := extensions.gen_random_bytes(8);
    candidate := '';
    for i in 0..7 loop
      candidate := candidate || substr(alphabet, (get_byte(raw, i) % 32) + 1, 1);
    end loop;

    exit when not exists (
      select 1 from public.profiles where friend_code = candidate
    );

    attempts := attempts + 1;
    if attempts > 50 then
      raise exception 'could not generate a unique friend code after % attempts', attempts;
    end if;
  end loop;

  return candidate;
end;
$$;

revoke execute on function public.generate_friend_code() from public;

-- ============================================================================
-- profiles
-- ============================================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null
    check (char_length(display_name) between 1 and 32),
  friend_code text not null unique
    check (friend_code ~ '^[0-9A-HJKMNP-TV-Z]{8}$'),
  avatar_hue smallint not null default 0
    check (avatar_hue between 0 and 359),
  created_at timestamptz not null default now()
);

comment on table public.profiles is
  'Public-facing user identity. Readable by the owner only in Phase 1; Phase 2 widens this to friends.';
comment on column public.profiles.friend_code is
  'Shareable 8-char code used to send friend requests. Immutable after creation.';

alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));

create policy "profiles_update_own"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- No insert policy: rows are created only by the SECURITY DEFINER signup trigger.
-- No delete policy: profiles cascade from auth.users.

-- Identity columns must survive any client-side update attempt.
create or replace function public.profiles_protect_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.id := old.id;
  new.friend_code := old.friend_code;
  new.created_at := old.created_at;
  return new;
end;
$$;

drop trigger if exists profiles_protect_immutable on public.profiles;
create trigger profiles_protect_immutable
  before update on public.profiles
  for each row execute function public.profiles_protect_immutable();

-- ============================================================================
-- key material
-- ============================================================================

-- P-256 SPKI is 91 bytes; the bounds just catch obvious junk.
create table if not exists public.user_public_keys (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  public_key bytea not null check (octet_length(public_key) between 32 and 256),
  created_at timestamptz not null default now()
);

comment on table public.user_public_keys is
  'ECDH P-256 identity public keys (SPKI). Readable by any authenticated user: you need it to share media.';

alter table public.user_public_keys enable row level security;

create policy "public_keys_select_all"
  on public.user_public_keys for select to authenticated
  using (true);

create policy "public_keys_insert_own"
  on public.user_public_keys for insert to authenticated
  with check (user_id = (select auth.uid()));

-- Deliberately no update/delete policy: rotating an identity key would orphan
-- every existing media_keys grant. Key rotation is a feature, not an accident.

create table if not exists public.user_private_keys (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  version smallint not null default 1,
  kdf_params jsonb not null
    default '{"algo":"argon2id","m":65536,"t":3,"p":1}'::jsonb,
  pw_salt bytea not null check (octet_length(pw_salt) = 16),
  pw_nonce bytea not null check (octet_length(pw_nonce) = 12),
  pw_wrapped_key bytea not null check (octet_length(pw_wrapped_key) between 32 and 2048),
  rc_salt bytea not null check (octet_length(rc_salt) = 16),
  rc_nonce bytea not null check (octet_length(rc_nonce) = 12),
  rc_wrapped_key bytea not null check (octet_length(rc_wrapped_key) between 32 and 2048),
  updated_at timestamptz not null default now()
);

comment on table public.user_private_keys is
  'Wrapped ECDH private key (PKCS8), encrypted twice: once under an Argon2id key from the password, once from the recovery phrase. Server-opaque. Never readable by anyone but the owner.';
comment on column public.user_private_keys.kdf_params is
  'Argon2id cost used for THIS row. Always read cost from here, never from a client constant, so parameters can be raised without breaking existing vaults.';

alter table public.user_private_keys enable row level security;

create policy "private_keys_select_own"
  on public.user_private_keys for select to authenticated
  using (user_id = (select auth.uid()));

create policy "private_keys_insert_own"
  on public.user_private_keys for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "private_keys_update_own"
  on public.user_private_keys for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists user_private_keys_touch on public.user_private_keys;
create trigger user_private_keys_touch
  before update on public.user_private_keys
  for each row execute function public.touch_updated_at();

-- ============================================================================
-- signup trigger
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, friend_code, avatar_hue)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
      'Viewer'
    ),
    public.generate_friend_code(),
    (abs(hashtext(new.id::text)) % 360)::smallint
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- friend code lookup
-- ============================================================================

-- SECURITY DEFINER so `profiles` itself stays non-enumerable: without this, a
-- select policy broad enough to support code lookup would leak the whole roster.
create or replace function public.find_profile_by_code(p_code text)
returns table (
  id uuid,
  display_name text,
  avatar_hue smallint,
  friend_code text,
  public_key bytea
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_code text;
  v_caller uuid := (select auth.uid());
begin
  if v_caller is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  v_code := upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g'));
  -- Crockford: these are transcription errors, not distinct symbols.
  v_code := translate(v_code, 'ILO', '110');

  if v_code !~ '^[0-9A-HJKMNP-TV-Z]{8}$' then
    return;
  end if;

  return query
    select p.id, p.display_name, p.avatar_hue, p.friend_code, k.public_key
    from public.profiles p
    left join public.user_public_keys k on k.user_id = p.id
    where p.friend_code = v_code
      and p.id <> v_caller;
end;
$$;

revoke execute on function public.find_profile_by_code(text) from public;
grant execute on function public.find_profile_by_code(text) to authenticated;
