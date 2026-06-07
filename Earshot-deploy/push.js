// push.js — client side of Web Push. Subscribes this device and stores the subscription in Supabase
// so the "notify" Edge Function can ping it on new memos. iOS only allows push for an installed PWA
// (Add to Home Screen) on iOS 16.4+, and the permission prompt must come from a real tap.
import { getSupabase } from './supabase-client.js';
import * as cfg from './config.js';
const VAPID_PUBLIC_KEY = cfg.VAPID_PUBLIC_KEY || '';

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && !!VAPID_PUBLIC_KEY;
}

export async function pushEnabled() {
  if (!pushSupported()) return false;
  try { const reg = await navigator.serviceWorker.ready; return !!(await reg.pushManager.getSubscription()); }
  catch (_) { return false; }
}

// Must be called from a user gesture (iOS requirement).
export async function enablePush() {
  if (!pushSupported()) throw new Error('Push not supported here. On iPhone, add Earshot to your Home Screen first.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications were not allowed.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) });
  const sb = await getSupabase();
  if (!sb) throw new Error('Backend not configured.');
  const { data } = await sb.auth.getUser();
  const uid = data?.user?.id;
  const j = sub.toJSON();
  const { error } = await sb.from('push_subscriptions').upsert({ user_id: uid, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: 'endpoint' });
  if (error) throw error;
  return true;
}

export async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const sb = await getSupabase();
      if (sb) await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
      await sub.unsubscribe();
    }
  } catch (_) {}
}
