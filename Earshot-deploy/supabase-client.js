// supabase-client.js — lazily loads the Supabase SDK (only when configured), so local-only mode
// stays fully offline-capable with zero network dependency.
import { SUPABASE_URL, SUPABASE_ANON_KEY, isConfigured } from './config.js';

let _client = null;
let _loading = null;

export async function getSupabase() {
  if (!isConfigured()) return null;
  if (_client) return _client;
  if (!_loading) {
    // Pinned to an exact version so the resolved bundle can't drift under us. The service worker
    // runtime-caches this on first online load, so later launches work offline.
    _loading = import('https://esm.sh/@supabase/supabase-js@2.58.0').then(({ createClient }) => {
      _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, storage: window.localStorage },
      });
      return _client;
    });
  }
  await _loading;
  return _client;
}

export { isConfigured };
