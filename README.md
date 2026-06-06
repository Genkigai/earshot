# Earshot — MVP (local build)

A private audio-messaging PWA for two people. See [PRODUCT_BRIEF.md](PRODUCT_BRIEF.md) for the full vision and roadmap.

This is the **MVP spine, running fully on-device** — no backend yet. It records, stores, and plays
memos locally with all the playback quality-of-life features. The cousin-to-cousin **sync layer is
the next step** (swaps local IndexedDB for a Firebase/Supabase relay + push).

## What works now
- 🎙️ **Record** with built-in noise suppression + auto-gain (voice-grade, ~32 kbps → tiny files), live waveform, pause/resume, timer
- 🔍 **Review** before saving — preview, discard, or save
- 📚 **Library** of memos, newest first, with unlistened dots
- ▶️ **Playback QoL:** 0.5×–3× speed with **pitch preserved** (no chipmunk), −15s / +30s skip, draggable scrubber, **resume where you left off**, auto-mark-listened
- 📴 **Installable + offline:** add to home screen; the app shell is cached by a service worker
- 💾 Everything stored locally in IndexedDB (audio Blobs + metadata)

## Cousin sync (Supabase) — Phase 1 built ✅
Auth, storage, realtime delivery, and an offline outbox are coded. To turn it on, follow
[SETUP.md](SETUP.md) (create a free Supabase project, paste 2 keys into `config.js`). Until then
the app stays in local-only mode. Schema lives in [supabase/schema.sql](supabase/schema.sql).

## What's next (see roadmap)
- 🔔 **Push when the app is closed** (Phase 2 — VAPID + Supabase Edge Function; scaffolded in `sw.js`)
- 📝 Transcription, search, auto-threading, timeline
- ✨ "Enhance" (ML noise removal), skip-silence, soundboard & music beds

## Run it locally
The app needs to be served over `http://localhost` (mic access requires a secure context, and ES
modules / service workers don't run from `file://`). Any static server works:

```bash
cd voice-app
python3 -m http.server 4321
# then open http://localhost:4321
```

To try it on your **phone** (real mic), host the folder anywhere with HTTPS — e.g. drag it onto
[Netlify Drop](https://app.netlify.com/drop) or `npx vercel`, then "Add to Home Screen" in Safari.

## Files
| File | Purpose |
|---|---|
| `index.html` | App shell + overlay markup |
| `styles.css` | Dark, mobile-first, big-touch-target UI |
| `app.js` | UI, library render, record flow, player wiring |
| `recorder.js` | Mic capture, cleanup constraints, level metering |
| `player.js` | Pitch-preserved speed, seek, resume |
| `db.js` | IndexedDB wrapper (memos store) |
| `sw.js` | Service worker (offline app shell) |
| `manifest.webmanifest`, `icon.svg` | PWA install metadata |

## Data model (one memo)
```js
{ id, createdAt, durationMs, blob, mimeType, sender, title, listened, positionMs, transcript }
```
