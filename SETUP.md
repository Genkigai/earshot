# Earshot — Backend Setup (Supabase)

This connects your two phones so memos actually sync. **~15 minutes, free, no credit card.**
Everything is already coded — you just create the project and paste two values into `config.js`.

> Until you finish this, the app runs in **local-only mode** (records & plays on one device, no sync).
> That's expected — it won't break anything.

---

## 1. Create a Supabase project
1. Go to **https://supabase.com** → **Start your project** → sign in with GitHub or email.
2. **New project.** Give it a name (e.g. `earshot`), set a **database password** (save it somewhere),
   pick the **region closest to you**, and create it. Wait ~2 min for it to spin up.

## 2. Run the schema
1. In the project, open **SQL Editor** (left sidebar) → **New query**.
2. Open the file [`supabase/schema.sql`](supabase/schema.sql) from this folder, copy **all** of it,
   paste into the editor, and click **Run**. You should see "Success."

## 3. Create your two accounts
1. Left sidebar → **Authentication** → **Providers** (or **Sign In / Providers**) → make sure
   **Email** is enabled. Then under **Sign-ups**, turn **OFF "Allow new users to sign up."**
   (You're the only two — this stops strangers from creating accounts.)
2. **Authentication → Users → Add user → Create new user.** Make one for **you** and one for **your
   cousin** (email + a password each). ✅ Check "Auto-confirm" so they can log in right away.
3. Click each user and copy their **User UID** (a long `xxxx-xxxx-…` string). You'll need both.

## 4. Add yourselves to the allowlist
Back in **SQL Editor → New query**, paste this with your two UIDs filled in, and **Run**:

```sql
insert into public.members (user_id) values
  ('YOUR_UUID_HERE'),
  ('COUSIN_UUID_HERE')
on conflict do nothing;

insert into public.profiles (id, display_name) values
  ('YOUR_UUID_HERE', 'You'),
  ('COUSIN_UUID_HERE', 'Cousin')
on conflict (id) do update set display_name = excluded.display_name;
```

**Keep the single quotes around every UUID** — they're text values, so `('e1ea…')` not `(e1ea…)`,
or Postgres errors with "trailing junk after numeric literal."

(Change `'You'` / `'Cousin'` to your real names — that's what shows in the app.)

## 5. Paste your keys into the app
1. Left sidebar → **Project Settings → API**.
2. Copy the **Project URL** and the **anon public** key.
3. Open [`config.js`](config.js) and paste them in:
   ```js
   export const SUPABASE_URL = 'https://YOURPROJECT.supabase.co';
   export const SUPABASE_ANON_KEY = 'eyJhbGci...'; // the long anon public key
   ```
4. Reload the app. You'll get a **sign-in screen** → log in with the account from step 3.

That's it. Record a memo → it uploads → your cousin sees it appear (and hears the ping if the app
is open). Send your cousin their email + password and the app's URL.

---

## Putting it on your phones
Host this `voice-app` folder anywhere with HTTPS and "Add to Home Screen":
- **Easiest:** drag the folder onto **https://app.netlify.com/drop** → you get a URL in seconds.
- Or `npx vercel` from this folder.

Open the URL in **Safari → Share → Add to Home Screen** on both iPhones.

## What works after this (Phase 1)
- ✅ Sign in, send memos that sync to your cousin, receive theirs
- ✅ **Instant delivery + a notification while the app is open** (Realtime)
- ✅ Audio cached after first listen (replays don't re-spend data — protects the 5 GB plan)
- ✅ Record offline in a tunnel → auto-uploads when you reconnect (outbox)

## What's next (Phase 2 — push when the app is closed)
True background push (a banner when Earshot isn't open) needs VAPID keys + a small Supabase Edge
Function that fires on new memos. That's the next build — it's scaffolded in `sw.js` already.

## Notes / gotchas
- The **anon key is meant to be public** — your privacy comes from the Row-Level Security in the
  schema (only the two allowlisted members can read anything), not from hiding the key.
- Free Supabase projects **pause after ~1 week of zero activity**. You use it daily, so this won't
  hit you — but if it ever sleeps, open the dashboard once to wake it.
