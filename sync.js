// sync.js — remote operations against Supabase (Storage + Postgres + Realtime).
import { getSupabase } from './supabase-client.js';

function ext(mime) {
  if (/mp4|m4a|aac/i.test(mime)) return 'm4a';
  if (/wav/i.test(mime)) return 'wav';
  if (/ogg/i.test(mime)) return 'ogg';
  return 'webm';
}

// Upload audio to Storage, then upsert the memo row. Idempotent (safe to retry) because the
// memo id is the primary key and the storage path is derived from it.
export async function pushMemo(memo, userId) {
  const sb = await getSupabase();
  if (!sb) throw new Error('no backend');
  const path = `${memo.id}.${ext(memo.mimeType || '')}`;
  const up = await sb.storage.from('memos').upload(path, memo.blob, {
    contentType: memo.mimeType || 'application/octet-stream',
    upsert: true,
  });
  if (up.error) throw up.error;
  const { error } = await sb.from('memos').upsert({
    id: memo.id,
    sender_id: userId,
    created_at: new Date(memo.createdAt).toISOString(),
    duration_ms: Math.round(memo.durationMs || 0),
    mime_type: memo.mimeType || 'audio/webm',
    audio_path: path,
    title: memo.title || null,
    transcript: memo.transcript || null,
  }, { onConflict: 'id' });
  if (error) throw error;
  return path;
}

export async function pullMemos() {
  const sb = await getSupabase();
  const { data, error } = await sb.from('memos').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function pullListens(userId) {
  const sb = await getSupabase();
  const { data, error } = await sb.from('memo_listens').select('memo_id').eq('user_id', userId);
  if (error) throw error;
  return data || [];
}

export async function markListenedRemote(memoId, userId) {
  const sb = await getSupabase();
  const { error } = await sb.from('memo_listens').upsert(
    { memo_id: memoId, user_id: userId },
    { onConflict: 'memo_id,user_id', ignoreDuplicates: true }
  );
  if (error) throw error;
}

export async function downloadAudio(path) {
  const sb = await getSupabase();
  const { data, error } = await sb.storage.from('memos').download(path);
  if (error) throw error;
  return data; // Blob
}

export async function fetchProfiles() {
  const sb = await getSupabase();
  const { data, error } = await sb.from('profiles').select('*');
  if (error) throw error;
  return data || [];
}

export async function subscribeMemoInserts(onInsert) {
  const sb = await getSupabase();
  if (!sb) return null;
  const channel = sb
    .channel('memos-realtime')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'memos' }, (payload) => onInsert(payload.new))
    .subscribe();
  return channel;
}

export async function removeChannel(channel) {
  const sb = await getSupabase();
  if (sb && channel) sb.removeChannel(channel);
}
