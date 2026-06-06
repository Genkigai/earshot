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

export async function signIn(email, password) {
  const sb = await getSupabase();
  if (!sb) throw new Error('Backend not configured');
  const { data, error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
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
