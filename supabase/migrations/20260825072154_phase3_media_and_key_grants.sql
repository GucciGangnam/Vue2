-- Phase 3: encrypted media and per-recipient key grants.
--
-- `media` holds everything needed to *read* a stored object -- chunk size,
-- chunk count, nonce prefix, sizes -- because the object itself has no header.
-- It also holds the title and poster as ciphertext: an encrypted file called
-- "holiday-2019.mp4" with a visible thumbnail is very nearly the content, so
-- neither is stored in the clear. See docs/CRYPTO.md sections 3 and 4.
--
-- `media_keys` is one row per (media, recipient): the content key wrapped to
-- that person's identity key. **The owner holds one of these too.** They are
-- not a special case -- they are simply the first recipient, which is what lets
-- them recover their own content key after a page refresh.
--
-- GRANTs ship beside the policies (D14), and every policy helper is caller-
-- scoped so that being callable over REST is harmless (D18).

-- ============================================================================
-- media
-- ============================================================================

create table if not exists public.media (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  storage_path text not null unique,
  status text not null default 'uploading'
    check (status in ('uploading', 'ready', 'failed')),

  -- Sizing. Both are needed: plaintext_size is the Content-Length the video
  -- element is told, ciphertext_size is what the stored object must weigh.
  plaintext_size bigint not null check (plaintext_size >= 0),
  ciphertext_size bigint not null check (ciphertext_size >= 0),
  chunk_size int not null check (chunk_size > 0),
  chunk_count int not null check (chunk_count >= 0),
  nonce_prefix bytea not null check (octet_length(nonce_prefix) = 4),

  -- Needed before a single byte can be decrypted, so it cannot itself be
  -- encrypted. It leaks only the container format.
  mime_type text not null check (char_length(mime_type) between 1 and 128),

  encrypted_metadata bytea not null check (octet_length(encrypted_metadata) between 16 and 8192),
  metadata_nonce bytea not null check (octet_length(metadata_nonce) = 12),
  encrypted_thumbnail bytea check (octet_length(encrypted_thumbnail) between 16 and 262144),
  thumbnail_nonce bytea check (octet_length(thumbnail_nonce) = 12),

  created_at timestamptz not null default now(),

  -- The path is fully derivable from the row, so a media row can never be
  -- pointed at somebody else's object. This is what makes the storage policies
  -- safe to write in terms of the path alone.
  constraint media_storage_path_matches
    check (storage_path = owner_id::text || '/' || id::text || '.enc'),

  -- Either both thumbnail columns are present or neither is; a ciphertext with
  -- no nonce is unreadable and a nonce with no ciphertext is noise.
  constraint media_thumbnail_complete
    check ((encrypted_thumbnail is null) = (thumbnail_nonce is null))
);

comment on table public.media is
  'One encrypted video. The server holds ciphertext plus the parameters needed to read it; the title and poster are ciphertext too.';
comment on column public.media.mime_type is
  'Deliberately plaintext: the browser needs it to set up decoding before anything can be decrypted.';
comment on column public.media.chunk_size is
  'Per item, never a client constant -- raising the default later must not break media already uploaded.';

create index if not exists media_owner_idx on public.media (owner_id, created_at desc);

alter table public.media enable row level security;

-- A row must not be able to claim it is ready before its bytes exist, and the
-- path is ours to compute rather than the client's to assert.
create or replace function public.media_validate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.status := 'uploading';
  new.created_at := now();
  new.storage_path := new.owner_id::text || '/' || new.id::text || '.enc';
  return new;
end;
$$;

revoke execute on function public.media_validate() from public;

drop trigger if exists media_validate on public.media;
create trigger media_validate
  before insert on public.media
  for each row execute function public.media_validate();

-- Everything that describes the ciphertext is fixed once the bytes are written.
-- Changing chunk_size or nonce_prefix after an upload does not corrupt the
-- object -- it silently makes it unreadable, which is worse, because it looks
-- like a decryption bug rather than a schema mistake. Renaming (the encrypted
-- metadata), re-postering and the status transition stay open.
create or replace function public.media_protect_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.id := old.id;
  new.owner_id := old.owner_id;
  new.storage_path := old.storage_path;
  new.created_at := old.created_at;
  new.plaintext_size := old.plaintext_size;
  new.ciphertext_size := old.ciphertext_size;
  new.chunk_size := old.chunk_size;
  new.chunk_count := old.chunk_count;
  new.nonce_prefix := old.nonce_prefix;
  return new;
end;
$$;

revoke execute on function public.media_protect_immutable() from public;

drop trigger if exists media_protect_immutable on public.media;
create trigger media_protect_immutable
  before update on public.media
  for each row execute function public.media_protect_immutable();

-- ============================================================================
-- media_keys
-- ============================================================================

create table if not exists public.media_keys (
  id uuid primary key default gen_random_uuid(),
  media_id uuid not null references public.media (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  ephemeral_public_key bytea not null
    check (octet_length(ephemeral_public_key) between 32 and 256),
  hkdf_salt bytea not null check (octet_length(hkdf_salt) = 32),
  nonce bytea not null check (octet_length(nonce) = 12),
  -- A wrapped 32-byte CEK plus a 16-byte tag.
  wrapped_key bytea not null check (octet_length(wrapped_key) = 48),
  version smallint not null default 1,
  granted_by uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (media_id, recipient_id)
);

comment on table public.media_keys is
  'The content key, wrapped per recipient with a fresh ephemeral ECDH key. The owner holds a row here too -- that is how they recover their own key after a refresh.';
comment on column public.media_keys.ephemeral_public_key is
  'Fresh per grant, so compromising the owner''s long-term key later cannot retroactively unwrap past grants.';

create index if not exists media_keys_recipient_idx on public.media_keys (recipient_id);

alter table public.media_keys enable row level security;

-- ============================================================================
-- helpers
-- ============================================================================

-- Both are caller-scoped (D18): they answer only about the current user, so
-- exposing them over REST reveals nothing the caller cannot already see. They
-- are also what keeps the two tables' policies from recursing into each other
-- -- `media` asks about `media_keys` and `media_keys` asks about `media`, and
-- SECURITY DEFINER means neither round trip re-enters RLS.

create or replace function public.owns_media(p_media_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.media
    where id = p_media_id and owner_id = (select auth.uid())
  );
$$;

comment on function public.owns_media(uuid) is
  'True when the calling user owns p_media_id. Caller-scoped on purpose.';

revoke execute on function public.owns_media(uuid) from public;
grant execute on function public.owns_media(uuid) to authenticated;

create or replace function public.has_media_key(p_media_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.media_keys
    where media_id = p_media_id and recipient_id = (select auth.uid())
  );
$$;

comment on function public.has_media_key(uuid) is
  'True when the calling user has been granted the content key for p_media_id. Caller-scoped on purpose.';

revoke execute on function public.has_media_key(uuid) from public;
grant execute on function public.has_media_key(uuid) to authenticated;

-- ============================================================================
-- policies
-- ============================================================================

-- Holding a key grant is what makes a media row visible. The owner is covered
-- by their own grant too, but owner_id is checked first so a half-finished
-- upload -- row written, grant not yet -- is still visible to its owner.
create policy "media_select_owner_or_grantee"
  on public.media for select to authenticated
  using (
    owner_id = (select auth.uid())
    or public.has_media_key(id)
  );

create policy "media_insert_own"
  on public.media for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy "media_update_own"
  on public.media for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy "media_delete_own"
  on public.media for delete to authenticated
  using (owner_id = (select auth.uid()));

create policy "media_keys_select_recipient_or_owner"
  on public.media_keys for select to authenticated
  using (
    recipient_id = (select auth.uid())
    or public.owns_media(media_id)
  );

create policy "media_keys_insert_by_owner"
  on public.media_keys for insert to authenticated
  with check (
    public.owns_media(media_id)
    and granted_by = (select auth.uid())
  );

create policy "media_keys_delete_by_owner"
  on public.media_keys for delete to authenticated
  using (public.owns_media(media_id));

-- No update policy, and no update grant. Re-granting means delete then insert
-- with a fresh ephemeral key: editing a wrap in place would reuse the ephemeral
-- keypair, which is the one thing the ephemeral design exists to avoid.

-- ============================================================================
-- grants
-- ============================================================================

grant select, insert, update, delete on public.media to authenticated;
grant select, insert, delete on public.media_keys to authenticated;

-- `anon` gets nothing.

-- ============================================================================
-- storage
-- ============================================================================

-- Private bucket. No mime restriction: what is uploaded is ciphertext, not
-- video, and a resumable upload may label it differently along the way.
insert into storage.buckets (id, name, public, file_size_limit)
values ('media', 'media', false, 2147483648)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit;

-- Parses `{owner_id}/{media_id}.enc` and answers whether the caller may read
-- that object. The media_storage_path_matches constraint is what makes reading
-- the id out of the path trustworthy: a row cannot claim a path it does not own.
create or replace function public.media_object_readable(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_media uuid;
begin
  if v_caller is null then
    return false;
  end if;

  -- A name that is not one of ours is simply not readable; never raise here,
  -- or an unrelated object breaks every storage listing.
  begin
    v_media := split_part(split_part(p_name, '/', 2), '.', 1)::uuid;
  exception when others then
    return false;
  end;

  return exists (
    select 1
    from public.media m
    where m.id = v_media
      and (
        m.owner_id = v_caller
        or exists (
          select 1 from public.media_keys k
          where k.media_id = m.id and k.recipient_id = v_caller
        )
      )
  );
end;
$$;

comment on function public.media_object_readable(text) is
  'Storage-side counterpart of the media select policy: owner or key-holder, resolved from the object path.';

revoke execute on function public.media_object_readable(text) from public;
grant execute on function public.media_object_readable(text) to authenticated;

drop policy if exists "media_objects_read" on storage.objects;
drop policy if exists "media_objects_insert_own" on storage.objects;
drop policy if exists "media_objects_update_own" on storage.objects;
drop policy if exists "media_objects_delete_own" on storage.objects;

create policy "media_objects_read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'media'
    and public.media_object_readable(name)
  );

-- Writes are scoped to the caller's own prefix only. Deliberately not tied to
-- an existing `media` row: a resumable upload has to be able to retry, and the
-- path already pins the object to its owner.
create policy "media_objects_insert_own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'media'
    and split_part(name, '/', 1) = (select auth.uid())::text
  );

create policy "media_objects_update_own"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'media'
    and split_part(name, '/', 1) = (select auth.uid())::text
  )
  with check (
    bucket_id = 'media'
    and split_part(name, '/', 1) = (select auth.uid())::text
  );

create policy "media_objects_delete_own"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'media'
    and split_part(name, '/', 1) = (select auth.uid())::text
  );
