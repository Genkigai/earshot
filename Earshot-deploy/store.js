// store.js — unifying data layer the UI talks to. Local-only when the backend isn't configured;
// when configured + signed in, it mirrors memos to Supabase, streams new ones in via Realtime,
// caches downloaded audio locally (so replays never re-spend data), and queues uploads while offline.
import * as db from './db.js';
import { isConfigured } from './supabase-client.js';
import * as sync from './sync.js';

const S = {
  mode: 'local',        // 'local' | 'cloud'
  me: null,             // { id, name }
  others: [],           // other member profiles
  channel: null,
  reactionChannel: null,
  changeCbs: [],
  syncCbs: [],
  sync: 'synced',       // 'syncing' | 'synced' | 'offline' | 'error'
  downloading: 0,       // count of audio blobs currently downloading
  connectivityWired: false,
  memberOk: true,       // false = signed in but not in the members allowlist (setup not finished)
};

export function onMemosChanged(cb) { S.changeCbs.push(cb); }
function emitChange() { for (const cb of S.changeCbs) { try { cb(); } catch (_) {} } }

// ---- sync status (so the UI can show a connecting/synced/offline indicator) ----
export function onSyncChange(cb) { S.syncCbs.push(cb); }
export function syncStatus() { return { state: S.sync, downloading: S.downloading }; }
function emitSync() { for (const cb of S.syncCbs) { try { cb(S.sync, S.downloading); } catch (_) {} } }
function setSync(state) { S.sync = state; emitSync(); }

export function mode() { return S.mode; }
export function me() { return S.me; }
export function otherName() { return S.others[0]?.display_name || 'the other person'; }
// false once we know the signed-in account isn't on the allowlist yet (SETUP.md step 4 unfinished).
export function membershipOk() { return S.memberOk; }

// Boot the store with the current auth session (or null for local-only).
export async function initStore(session) {
  if (isConfigured() && session) {
    S.mode = 'cloud';
    S.me = { id: session.user.id, name: session.user.email };
    // If a DIFFERENT user signs in on this device, wipe the previous user's cached memos so their
    // read/unread/reaction state doesn't leak into this account's view.
    const prevUser = localStorage.getItem('earshot.userId');
    if (prevUser && prevUser !== S.me.id) { try { await db.clearMemos(); } catch (_) {} }
    localStorage.setItem('earshot.userId', S.me.id);
    await hydrateProfiles();
    await refreshFromCloud();
    await reconcileLocalMemos();   // queue any local memos of mine that never made it to the server
    await subscribe();
    await subscribeReactionsRealtime();
    wireConnectivity();
    flushOutbox();
  } else {
    S.mode = 'local';
  }
}

async function hydrateProfiles() {
  try {
    const profs = await sync.fetchProfiles();
    const mine = profs.find((p) => p.id === S.me.id);
    if (mine?.display_name) S.me.name = mine.display_name;
    S.others = profs.filter((p) => p.id !== S.me.id);
    // A member can always read at least their own profile row. Online with no own row ⇒ not
    // on the allowlist yet. (Left untouched on throw so we don't false-alarm while offline.)
    S.memberOk = !!mine;
  } catch (_) { /* offline / transient — keep prior memberOk */ }
}

// Enqueue any local memo authored by me that isn't on the server yet (e.g. recorded before the
// backend was connected, or while signed out). pushMemo upserts by id, so this is idempotent.
async function reconcileLocalMemos() {
  try {
    const all = await db.getAllMemos();
    for (const m of all) {
      if (m.sender === 'me' && !m.audioPath && m.blob) {
        await db.addOutbox({ key: 'memo:' + m.id, kind: 'memo', memoId: m.id });
      }
    }
  } catch (_) {}
}

// iOS suspends/closes the realtime WebSocket when the PWA backgrounds, and emits no 'online' event
// on resume. So on every foreground we pull missed memos and rebuild the (likely dead) socket.
let resyncing = false;
export async function resyncOnForeground() {
  if (S.mode !== 'cloud' || resyncing) return;
  resyncing = true;
  try { await refreshFromCloud(); await subscribe(); await subscribeReactionsRealtime(); flushOutbox(); }
  finally { resyncing = false; }
}

// ---- reads (UI source of truth is the local cache) ----
export async function getAllMemos() {
  return db.getAllMemos();
}

export async function getAudioBlob(memo) {
  if (memo.blob) return memo.blob;
  const cached = await db.getMemo(memo.id);
  if (cached?.blob) return cached.blob;
  if (S.mode === 'cloud' && (memo.audioPath || cached?.audioPath)) {
    S.downloading++; emitSync();           // surface "downloading audio…" in the UI
    try {
      const blob = await sync.downloadAudio(memo.audioPath || cached.audioPath);
      await db.updateMemo(memo.id, { blob });   // cache once — protects the 5 GB plan
      return blob;
    } finally { S.downloading = Math.max(0, S.downloading - 1); emitSync(); }
  }
  return null;
}

// ---- writes ----
export async function saveMemo(memo) {
  await db.saveMemo(memo);                     // optimistic local write
  if (S.mode === 'cloud') {
    await db.addOutbox({ key: 'memo:' + memo.id, kind: 'memo', memoId: memo.id });
    flushOutbox();
  }
  return memo;
}

export async function updateMemo(id, patch) {
  await db.updateMemo(id, patch);
  if (S.mode === 'cloud' && patch.listened !== undefined) {
    try { if (patch.listened) await sync.markListenedRemote(id, S.me.id); else await sync.unmarkListenedRemote(id, S.me.id); }
    catch (_) { await db.addOutbox({ key: 'listen:' + id, kind: 'listen', memoId: id }); flushOutbox(); }
  }
  // Sync transcripts so a memo transcribed on one phone is readable on the other (needs migration-v2).
  if (S.mode === 'cloud' && patch.transcript !== undefined) {
    try { await sync.updateMemoTranscript(id, patch.transcript, patch.transcriptChunks ?? null); } catch (_) {}
  }
  // Sync your reaction so your cousin sees it (needs migration-v2 memo_reactions table).
  if (S.mode === 'cloud' && patch.myReaction !== undefined) {
    try { await sync.setReactionRemote(id, S.me.id, patch.myReaction || null); }
    catch (_) { await db.addOutbox({ key: 'react:' + id, kind: 'react', memoId: id }); flushOutbox(); }
  }
  return patch;
}

// Re-pull just the reactions and fold them into the cached memos (fast realtime update).
async function refreshReactionsOnly() {
  try {
    const reactions = await sync.fetchReactions();
    const map = {};
    for (const x of reactions) { (map[x.memo_id] ||= {})[x.user_id === S.me.id ? 'mine' : 'theirs'] = x.reaction; }
    const all = await db.getAllMemos();
    for (const m of all) {
      const next = { myReaction: map[m.id]?.mine || null, theirReaction: map[m.id]?.theirs || null };
      if (next.myReaction !== (m.myReaction || null) || next.theirReaction !== (m.theirReaction || null)) {
        await db.updateMemo(m.id, next);
      }
    }
    emitChange();
  } catch (_) {}
}

async function subscribeReactionsRealtime() {
  if (S.reactionChannel) { try { await sync.removeChannel(S.reactionChannel); } catch (_) {} }
  S.reactionChannel = await sync.subscribeReactions(() => { refreshReactionsOnly(); });
}

// ---- cloud sync internals ----
async function refreshFromCloud() {
  setSync('syncing');
  try {
    const [rows, listens, reactions] = await Promise.all([sync.pullMemos(), sync.pullListens(S.me.id), sync.fetchReactions().catch(() => null)]);
    const listened = new Set(listens.map((l) => l.memo_id));
    let reactionMap = null;
    if (reactions) { reactionMap = {}; for (const x of reactions) { (reactionMap[x.memo_id] ||= {})[x.user_id === S.me.id ? 'mine' : 'theirs'] = x.reaction; } }
    for (const r of rows) {
      const local = await db.getMemo(r.id);
      await db.saveMemo({
        id: r.id,
        createdAt: new Date(r.created_at).getTime(),
        durationMs: r.duration_ms,
        mimeType: r.mime_type,
        audioPath: r.audio_path,
        sender: r.sender_id === S.me.id ? 'me' : 'cousin',
        senderId: r.sender_id,
        title: r.title || 'Memo',
        transcript: r.transcript || local?.transcript || null,
        transcriptChunks: r.transcript_chunks || local?.transcriptChunks || null,
        bookmarks: local?.bookmarks || [],      // local-only personal data — preserve across refreshes
        starred: local?.starred || false,
        // reactions: authoritative from server when the fetch worked, else keep local
        myReaction: reactionMap ? (reactionMap[r.id]?.mine || null) : (local?.myReaction || null),
        theirReaction: reactionMap ? (reactionMap[r.id]?.theirs || null) : (local?.theirReaction || null),
        // reply-to metadata (memos columns exist only after migration-v2; undefined → null pre-migration)
        replyToId: r.reply_to_id || local?.replyToId || null,
        replyToMs: r.reply_to_ms != null ? r.reply_to_ms : (local?.replyToMs ?? null),
        // listened is server-authoritative (from memo_listens) so it's correct per-user and
        // supports mark-as-unread. Your own memos are always "heard".
        listened: r.sender_id === S.me.id ? true : listened.has(r.id),
        positionMs: local?.positionMs || 0,
        blob: local?.blob,                      // preserve any cached audio
      });
    }
    emitChange();
    setSync(navigator.onLine === false ? 'offline' : 'synced');
  } catch (e) {
    console.warn('refreshFromCloud failed', e?.message || e);
    setSync(navigator.onLine === false ? 'offline' : 'error');
  }
}

async function subscribe() {
  if (S.channel) await sync.removeChannel(S.channel);
  S.channel = await sync.subscribeMemoInserts(async (r) => {
    if (r.sender_id === S.me.id) return;        // ignore our own echo
    const existing = await db.getMemo(r.id);
    if (existing) return;
    await db.saveMemo({
      id: r.id,
      createdAt: new Date(r.created_at).getTime(),
      durationMs: r.duration_ms,
      mimeType: r.mime_type,
      audioPath: r.audio_path,
      sender: 'cousin',
      senderId: r.sender_id,
      title: r.title || 'Memo',
      transcript: r.transcript || null,
      transcriptChunks: r.transcript_chunks || null,
      bookmarks: [],
      starred: false,
      myReaction: null,
      theirReaction: null,
      replyToId: r.reply_to_id || null,
      replyToMs: r.reply_to_ms != null ? r.reply_to_ms : null,
      listened: false,
      positionMs: 0,
    });
    emitChange();
    notifyNewMemo();
  });
}

function wireConnectivity() {
  if (S.connectivityWired) return;
  S.connectivityWired = true;
  window.addEventListener('offline', () => setSync('offline'));
  window.addEventListener('online', async () => { setSync('syncing'); await flushOutbox(); refreshFromCloud(); });
  // Catch up + re-subscribe whenever the app comes back to the foreground.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resyncOnForeground(); });
  window.addEventListener('pageshow', () => resyncOnForeground());
}

let flushing = false;
export async function flushOutbox() {
  if (S.mode !== 'cloud' || flushing || !navigator.onLine) return;
  flushing = true;
  try {
    const items = await db.getAllOutbox();
    for (const item of items) {
      try {
        if (item.kind === 'listen') {
          const memo = await db.getMemo(item.memoId);   // mark or unmark based on current local state
          if (memo && memo.listened) await sync.markListenedRemote(item.memoId, S.me.id);
          else await sync.unmarkListenedRemote(item.memoId, S.me.id);
        } else if (item.kind === 'react') {
          const memo = await db.getMemo(item.memoId);   // read current reaction at flush time (last-write-wins)
          await sync.setReactionRemote(item.memoId, S.me.id, memo?.myReaction || null);
        } else {
          const memo = await db.getMemo(item.memoId);
          if (memo && memo.blob) {
            const path = await sync.pushMemo(memo, S.me.id);
            await db.updateMemo(memo.id, { audioPath: path });
          }
        }
        await db.removeOutbox(item.key);
      } catch (_) {
        break; // network/permission hiccup — keep the rest queued, retry on next online/flush
      }
    }
  } finally {
    flushing = false;
  }
}

function notifyNewMemo() {
  // Phase 1: best-effort local notification if permission was granted. Real push (closed app) = Phase 2.
  try {
    if ('Notification' in window && Notification.permission === 'granted' && navigator.serviceWorker) {
      navigator.serviceWorker.ready.then((reg) =>
        reg.showNotification('New memo', { body: `${otherName()} sent you a memo`, icon: 'icon.svg', tag: 'earshot-memo' })
      );
    }
  } catch (_) {}
}
