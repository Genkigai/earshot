-- Earshot backend schema — paste into Supabase → SQL Editor → Run (one time).
-- Model: a private two-person channel. Both members see every memo; the sender is recorded.
-- Privacy rests entirely on Row-Level Security below, so the public anon key is safe to ship.

-- ============================================================
-- membership allowlist (defense in depth: only these users can touch anything)
-- ============================================================
create table if not exists public.members (
  user_id uuid primary key references auth.users(id) on delete cascade
);

-- SECURITY DEFINER so policies can check membership without recursive RLS on members.
create or replace function public.is_member(uid uuid)
returns boolean language sql security definer stable
set search_path = public as $$
  select exists (select 1 from public.members where user_id = uid);
$$;

-- ============================================================
-- profiles (display names for the two of you)
-- ============================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Cousin',
  created_at timestamptz not null default now()
);

-- ============================================================
-- memos (the shared channel)
-- ============================================================
create table if not exists public.memos (
  id uuid primary key,                       -- client-generated; matches storage path + local cache id
  sender_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  duration_ms integer not null default 0,
  mime_type text not null default 'audio/webm',
  audio_path text not null,                  -- object path inside the 'memos' storage bucket
  title text,
  transcript text
);
create index if not exists memos_created_idx on public.memos (created_at desc);

-- ============================================================
-- per-user listened state (so "listened" is tracked per person, not shared)
-- ============================================================
create table if not exists public.memo_listens (
  memo_id uuid not null references public.memos(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  listened_at timestamptz not null default now(),
  primary key (memo_id, user_id)
);

-- ============================================================
-- Row-Level Security
-- ============================================================
alter table public.members enable row level security;
alter table public.profiles enable row level security;
alter table public.memos enable row level security;
alter table public.memo_listens enable row level security;

drop policy if exists "members read" on public.members;
create policy "members read" on public.members for select to authenticated
  using (public.is_member(auth.uid()));

drop policy if exists "profiles read" on public.profiles;
create policy "profiles read" on public.profiles for select to authenticated
  using (public.is_member(auth.uid()));
drop policy if exists "profiles insert own" on public.profiles;
create policy "profiles insert own" on public.profiles for insert to authenticated
  with check (id = auth.uid() and public.is_member(auth.uid()));
drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "memos read" on public.memos;
create policy "memos read" on public.memos for select to authenticated
  using (public.is_member(auth.uid()));
drop policy if exists "memos insert" on public.memos;
create policy "memos insert" on public.memos for insert to authenticated
  with check (sender_id = auth.uid() and public.is_member(auth.uid()));

drop policy if exists "listens read" on public.memo_listens;
create policy "listens read" on public.memo_listens for select to authenticated
  using (public.is_member(auth.uid()));
drop policy if exists "listens insert own" on public.memo_listens;
create policy "listens insert own" on public.memo_listens for insert to authenticated
  with check (user_id = auth.uid() and public.is_member(auth.uid()));

-- ============================================================
-- Storage bucket for audio (private) + policies
-- ============================================================
insert into storage.buckets (id, name, public)
  values ('memos', 'memos', false)
  on conflict (id) do nothing;

drop policy if exists "memo audio read" on storage.objects;
create policy "memo audio read" on storage.objects for select to authenticated
  using (bucket_id = 'memos' and public.is_member(auth.uid()));
drop policy if exists "memo audio insert" on storage.objects;
create policy "memo audio insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'memos' and public.is_member(auth.uid()));

-- ============================================================
-- Realtime (instant in-app delivery while the app is open)
-- ============================================================
do $$ begin
  alter publication supabase_realtime add table public.memos;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.memo_listens;
exception when duplicate_object then null; end $$;

-- NEXT: create your two users (Authentication → Users → Add user), then run the
-- members + profiles INSERT shown in SETUP.md with their User UIDs.
