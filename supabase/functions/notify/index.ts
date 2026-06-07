// Supabase Edge Function "notify" — sends a Web Push when a new memo is inserted.
// Deploy with: supabase functions deploy notify --no-verify-jwt
// Triggered by a Database Webhook on INSERT into public.memos (see SETUP-EXTRAS.md).
// Secrets needed: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (a mailto:), and the
// auto-provided SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:earshot@example.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    const memo = payload.record || payload.new || payload;     // DB webhook sends { record: {...} }
    if (!memo || !memo.sender_id) return new Response('no memo', { status: 200 });

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    // everyone except the sender (i.e. the cousin)
    const { data: subs } = await sb.from('push_subscriptions').select('*').neq('user_id', memo.sender_id);
    if (!subs || !subs.length) return new Response('no subscribers', { status: 200 });

    const { data: profiles } = await sb.from('profiles').select('id, display_name');
    const senderName = profiles?.find((p) => p.id === memo.sender_id)?.display_name || 'Your cousin';
    const body = JSON.stringify({ title: 'New memo', body: `${senderName} sent you a memo` });

    await Promise.all(subs.map((s) =>
      webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body)
        .catch(async (err: any) => {
          // 404/410 = subscription expired; clean it up
          if (err?.statusCode === 404 || err?.statusCode === 410) {
            await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
          }
        })
    ));

    return new Response('sent', { status: 200 });
  } catch (e) {
    return new Response('error: ' + (e as Error).message, { status: 200 });
  }
});
