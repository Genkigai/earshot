# Earshot — Optional Extras Setup

The app is fully usable without any of this. These steps unlock the features that need a backend
touch: **synced transcripts** and **push notifications**. Do them whenever you like.

> Re-upload note: after any of this, re-upload the `Earshot-deploy` folder to GitHub (⌘A → drag),
> since `config.js` now includes your push public key.

---

## 1. Run the migration (2 min) — enables synced transcripts

1. Supabase → **SQL Editor** → **New query**
2. Open [`supabase/migration-v2.sql`](supabase/migration-v2.sql), copy all, paste, **Run**.

That's it. Now when either of you transcribes a memo, the other sees the transcript too.

---

## 2. Push notifications (get pinged when a memo arrives while the app is closed)

Your VAPID keys are **already generated**:
- The **public** key is already in `config.js` ✅
- The **private** key is in **`~/Documents/earshot-SECRETS.txt`** (kept out of your public repo on purpose — don't move it into the deploy folder)

### a. Deploy the Edge Function
**Dashboard way (no install):** Supabase → **Edge Functions** → **Deploy a new function** → name it
exactly **`notify`** → paste the contents of [`supabase/functions/notify/index.ts`](supabase/functions/notify/index.ts) → **Deploy**.

*CLI alternative (if you'd rather):* `npx supabase functions deploy notify --no-verify-jwt`

### b. Add the secrets
Supabase → **Edge Functions** → **Secrets** (or Project Settings → Edge Functions) → add three secrets,
copying the values from `~/Documents/earshot-SECRETS.txt`:
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`  (e.g. `mailto:leland@example.com`)

(`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically — you don't add those.)

### c. Fire the function on every new memo
Supabase → **Database** → **Webhooks** → **Create a new hook**:
- Table: **`public.memos`**, Events: **Insert**
- Type: **Supabase Edge Functions** → choose **`notify`**
- Create.

### d. Turn it on, on each phone
Make sure Earshot is **added to the Home Screen** (push only works in the installed PWA on iPhone),
then open it → **Settings (⚙️)** → **Push notifications** → toggle **on** and allow when asked. Do this
on both your phone and Dawn's.

Now: Dawn records a memo → your phone buzzes with "New memo," even if Earshot is closed. 🎉

---

### Troubleshooting
- **No notification?** Check: function deployed as `notify`, the 3 secrets set, the webhook points at
  `notify` on `memos`/Insert, and each phone toggled Push on **as an installed Home-Screen app**.
- **iPhone won't show the toggle / prompt** → it's not installed as a PWA yet. Share → Add to Home Screen first.
- The notify function never sends a push to the person who *sent* the memo — only the other cousin.

---

## 3. Log in with just your name (no email needed)

The login screen now takes a **name + password** instead of an email, so Dawn never has to put a real
email out there. Under the hood the app turns a name into a private synthetic address —
`Dawn` → `dawn@earshot.app` — and signs in with that. Nothing leaves your two phones.

For this to work, **each Supabase account's email must be `firstname@earshot.app`.** You don't need to
recreate anything — just rename the two users you already made:

1. Supabase → **Authentication → Users**
2. Click your user → edit the email to **`leland@earshot.app`** → save. (The password and User UID stay
   the same, so your allowlist rows still match — nothing else to change.)
3. Do the same for Dawn → **`dawn@earshot.app`**.

Now each of you just types your **first name** (lowercase, no spaces) + your password. A normal email
still works too if you ever type one — anything with an `@` is passed straight through.

> Tip: whatever first name you log in with should match the `display_name` you set in SETUP.md step 4,
> so the right name shows up as "Synced with …" for the other cousin.
