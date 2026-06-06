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
  changeCbs: [],
  connectivityWired: false,
  memberOk: true,       // false = signed in but not in the members allowlist (setup not finished)
};

export function onMemosChanged(cb) { S.changeCbs.push(cb); }
function emitChange() { for (const cb of S.changeCbs) { try { cb(); } catch (_) {} } }

export function mode() { return S.mode; }
export function me() { return S.me; }
export function otherName() { return S.others[0]?.display_name || 'Your cousin'; }
// false once we know the signed-in account isn't on the allowlist yet (SETUP.md step 4 unfinished).
export function membershipOk() { return S.memberOk; }

// Boot the store with the current auth session (or null for local-only).
export async function initStore(session) {
  if (isConfigured() && session) {
    S.mode = 'cloud';
    S.me = { id: session.user.id, name: session.user.email };
    await hydrateProfiles();
    await refreshFromCloud();
    await reconcileLocalMemos();   // queue any local memos of mine that never made it to the server
    await subscribe();
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
  try { await refreshFromCloud(); await subscribe(); flushOutbox(); }
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
    const blob = await sync.downloadAudio(memo.audioPath || cached.audioPath);
    await db.updateMemo(memo.id, { blob });   // cache once — protects the 5 GB plan
    return blob;
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
  if (S.mode === 'cloud' && patch.listened) {
    try { await sync.markListenedRemote(id, S.me.id); }
    catch (_) { await db.addOutbox({ key: 'listen:' + id, kind: 'listen', memoId: id }); }
  }
  return patch;
}

// ---- cloud sync internals ----
async function refreshFromCloud() {
  try {
    const [rows, listens] = await Promise.all([sync.pullMemos(), sync.pullListens(S.me.id)]);
    const listened = new Set(listens.map((l) => l.memo_id));
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
        transcript: r.transcript || null,
        // "listened" is monotonic — OR the local flag so a still-queued remote listen write
        // can't make an already-heard memo flash back to unlistened.
        listened: r.sender_id === S.me.id ? true : (local?.listened || listened.has(r.id)),
        positionMs: local?.positionMs || 0,
        blob: local?.blob,                      // preserve any cached audio
      });
    }
    emitChange();
  } catch (e) { console.warn('refreshFromCloud failed', e?.message || e); }
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
  window.addEventListener('online', async () => { await flushOutbox(); refreshFromCloud(); });
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
          await sync.markListenedRemote(item.memoId, S.me.id);
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
