// auth.js — thin wrapper over Supabase Auth. The app's own login UI calls these; the user
// signs in with credentials they created in the Supabase dashboard.
import { getSupabase, isConfigured } from './supabase-client.js';

export { isConfigured };

export async function getSession() {
  // Fail-soft: if the SDK import fails (offline in a tunnel at cold start), return null instead of
  // throwing — the caller falls back to a usable offline UI rather than a blank locked-out app.
  try {
    const sb = await getSupabase();
    if (!sb) return null;
    const { data } = await sb.auth.getSession();
    return data.session || null;
  } catch (_) {
    return null;
  }
}

// Accepts a plain name OR an email. A bare name (no "@") is mapped to a hidden synthetic email
// (e.g. "dawn" → "dawn@earshot.app") so neither cousin has to expose a real email address.
export function nameToEmail(input) {
  let id = (input || '').trim();
  if (id && !id.includes('@')) id = id.toLowerCase().replace(/[^a-z0-9._-]+/g, '') + '@earshot.app';
  return id;
}

export async function signIn(nameOrEmail, password) {
  const sb = await getSupabase();
  if (!sb) throw new Error('Backend not configured');
  const { data, error } = await sb.auth.signInWithPassword({ email: nameToEmail(nameOrEmail), password });
  if (error) throw error;
  return data.session;
}

export async function signOut() {
  const sb = await getSupabase();
  if (sb) await sb.auth.signOut();
}

export async function onAuthChange(cb) {
  const sb = await getSupabase();
  if (!sb) return;
  sb.auth.onAuthStateChange((_event, session) => cb(session));
}

// Make sure this user has a profile row (display name defaults to the email's local part).
export async function ensureProfile() {
  const sb = await getSupabase();
  if (!sb) return;
  const { data } = await sb.auth.getUser();
  const u = data?.user;
  if (!u) return;
  try {
    await sb.from('profiles').upsert(
      { id: u.id, display_name: (u.email || 'me').split('@')[0] },
      { onConflict: 'id', ignoreDuplicates: true }
    );
  } catch (_) { /* RLS may reject if not yet a member — harmless */ }
}
