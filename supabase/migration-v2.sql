-- Earshot migration v2 — paste into Supabase → SQL Editor → Run (one time).
-- Adds: push notifications, the reactions table (UI pending), and synced transcripts.
-- Safe to run on top of the original schema.sql. The app works WITHOUT this (those features just
-- stay local/off until you run it).

-- ============================================================
-- 1. Push notification subscriptions (one row per device)
-- ============================================================
create table if not exists public.push_subscriptions (
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  primary key (endpoint)
);
alter table public.push_subscriptions enable row level security;

drop policy if exists "push manage own" on public.push_subscriptions;
create policy "push manage own" on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.is_member(auth.uid()));
-- No broad SELECT policy: the client only manages its own row, and the notify function uses the
-- service role (which bypasses RLS). "push manage own" already covers each device reading its own row,
-- so we don't expose one member's push credentials to the other.
drop policy if exists "push read members" on public.push_subscriptions;

-- ============================================================
-- 2. Reactions (per-user reaction on a memo)
-- ============================================================
create table if not exists public.memo_reactions (
  memo_id uuid not null references public.memos(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  reaction text not null,
  created_at timestamptz not null default now(),
  primary key (memo_id, user_id)
);
alter table public.memo_reactions enable row level security;

drop policy if exists "reactions read" on public.memo_reactions;
create policy "reactions read" on public.memo_reactions for select to authenticated
  using (public.is_member(auth.uid()));
drop policy if exists "reactions write own" on public.memo_reactions;
create policy "reactions write own" on public.memo_reactions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.is_member(auth.uid()));

-- ============================================================
-- 3. Synced transcripts — let members update a memo's transcript (transcribe once, both read)
-- ============================================================
alter table public.memos add column if not exists transcript_chunks jsonb;

-- reply-to-a-timestamp: a memo can reference a moment in another memo
alter table public.memos add column if not exists reply_to_id uuid references public.memos(id) on delete set null;
alter table public.memos add column if not exists reply_to_ms integer;

drop policy if exists "memos update transcript" on public.memos;
create policy "memos update transcript" on public.memos for update to authenticated
  using (public.is_member(auth.uid())) with check (public.is_member(auth.uid()));

-- RLS can't restrict WHICH columns an UPDATE touches — a column GRANT can. Lock member updates to
-- just the transcript fields, so neither cousin can rewrite the other's title/audio_path/sender_id.
revoke update on public.memos from authenticated;
grant update (transcript, transcript_chunks) on public.memos to authenticated;

-- ============================================================
-- 4. Realtime for the new tables
-- ============================================================
do $$ begin alter publication supabase_realtime add table public.memo_reactions; exception when duplicate_object then null; end $$;

-- ============================================================
-- 5. Notify the Edge Function on every new memo (so it can send a push)
--    The "notify" Edge Function is fired by a Database Webhook (Database → Webhooks) on memos/Insert,
--    which you set up in SETUP-EXTRAS.md §2c after deploying the function. There is no SQL trigger to
--    create here (no pg_net needed). If you skip push, ignore this section.
-- ============================================================
