# Earshot — Product Brief & Roadmap

> *Working title — rename freely (alts: **Frequency**, **Channel**, **Walkie**, **CommuteCast**).*

**One-liner:** A private, two-person audio-messaging app — a tiny podcast network for you and your cousin — that fixes everything annoying about Apple's voice memos and adds the quality-of-life features they never built.

**Status:** Vision / pre-build · **Last updated:** June 5, 2026

---

## Why we're building this

We send each other voice memos *every day* — about an hour a day between us, mostly recorded on the drive to work. Apple's default app (and iMessage audio) gets in the way: memos that expire and vanish, no speed control, no way to search or organize months of conversation, and audio that's rough over road noise. We want our own thing, built exactly for how the two of us actually talk.

## What it should feel like

Your daily commute becomes a conversation that never gets lost. You talk; it records clean. Your cousin listens at 2x on their drive, reads the transcript when they can't, and our months of back-and-forth quietly organize themselves into searchable topics with a timeline we can edit. Plus it's *fun* — sound effects, music, the works.

## Who it's for

**Literally two people.** That's a feature, not a limitation. No growth, no feeds, no strangers, no moderation. Every decision optimizes for intimacy and delight between exactly two cousins — which also makes the whole thing dramatically simpler to build.

## Design principles

1. **Voice-first, glance-free.** We record while *driving*. The core loop is one tap or one word — never make someone look at the screen to start, stop, or send.
2. **Never lose a memo.** Nothing expires (Apple's cardinal sin), nothing auto-deletes, recordings survive dead zones. This is sacred.
3. **Reading equals listening.** Every memo is also text you can search, skim, and reply to silently.
4. **Featherweight on data.** Built around a 5 GB plan. Voice-grade audio, fetch-on-open, cached replays. The 5 GB cousin never thinks about data.
5. **Just for two.** Optimize for two people having a great time, not for scale.

---

## Roadmap

### 🦴 MVP — "Beats Apple this week" (the spine)
The thin slice that's genuinely usable the day it's done. Everything else hangs off this.
- Dead-simple login — just the two of us (invite-only, 2 accounts)
- **Record:** giant one-tap (and voice-activated) button, live waveform, auto-stop on silence
- **Auto-cleanup on capture:** browser noise suppression + high-pass filter (kills engine rumble) + auto-leveling
- **Send → push notification → shows up in a simple library** (newest first)
- **Playback QoL:** 0.5x–3x speed *with pitch preserved*, scrubbable waveform, 15s-back / 30s-forward, resume-where-you-left-off
- Voice-grade audio at a capped bitrate (protects the 5 GB plan)
- **Offline-safe:** record with no signal in a tunnel → auto-sends the moment you reconnect
- Listened / unlistened badges

### 🚗 v1 — "Our real everyday app"
The features that make it the thing we open every day.
- **Auto-transcription** with tap-to-jump synced playback (karaoke-style word highlight)
- **Editable transcripts** — fix a misheard word and it sticks
- **Full-text search** across everything we've ever said
- **Auto-threading into topics** — memos cluster into ongoing conversations ("Kitchen reno," "Fantasy football"); rename, merge, split, pin
- **Timeline view** with dates we can go in and edit
- **Skip-silence** playback, loudness normalize, continuous "podcast" autoplay of the morning batch
- **One-tap "Enhance"** — ML noise removal for rough recordings
- Reactions (❤️😂🔥), reply to a memo *at a specific timestamp*, star / save / pin
- **"Catch me up"** summaries + a weekly digest of what we actually talked about

### 🎛️ v2 — "Make it *ours*" (the dream)
- **Soundboard** — drop airhorns, rimshots, applause, custom clips mid-recording
- **Background music beds** with auto-ducking (music dips while you talk, swells when you pause)
- **Intro/outro stingers** + a per-person theme song
- **Voice effects** for laughs (radio, reverb, telephone, on-purpose chipmunk)
- **Clips/quotes** — pull a snippet and save or share it
- **Smart extras** — action items ("you said you'd send the recipe"), mentions
- *Maybe:* a native app for true **hands-free CarPlay** + best-in-class on-device noise removal & transcription

---

## Key technical decisions (already made)

| Area | Decision | Why |
|---|---|---|
| **Platform** | Progressive Web App (PWA), "Add to Home Screen" | Free, works on both iPhones today, no App Store, no $99 |
| **Backend** | Firebase *or* Supabase (free tier) | Storage + relay + auth + push for two people, $0 |
| **Audio** | Voice-grade bitrate (~24–32 kbps), capped on purpose | Clear speech, tiny files, protects the 5 GB plan |
| **Noise** | getUserMedia constraints + Web Audio (high-pass, auto-level) + optional ML "Enhance" (RNNoise free / cloud studio pass) | Car hum is steady = the *easy* noise to remove |
| **Transcription** | Whisper or Deepgram API (or on-device for free) | Powers search, threads, read-mode; transcribe once, both read it |
| **Push** | Web Push (iOS 16.4+ home-screen PWAs) | Free, no native app needed |

*Proposed stack (swappable):* React PWA · Web Audio API + MediaRecorder · Firebase/Supabase · Whisper/Deepgram.

## Budget — what this actually costs

| Item | Cost | Notes |
|---|---|---|
| Audio data (cousin, ~1 hr/day) | **~0.3 GB/mo (~6% of 5 GB)** | capped voice-grade bitrate; replays cached, don't re-download |
| Backend (storage + relay + auth) | **$0** | free tier, miles of headroom for two people |
| Push notifications | **$0** | web push |
| Transcription | **~$5–10/mo total** (or **$0** on-device) | the only recurring cost; optional, and shared (transcribe once) |
| Distribution | **$0** | PWA — add to home screen |
| **Total** | **~$0–10 / month** | |

## Known constraints & the future native path

- A **PWA can't use CarPlay** (native-only). For now we design glance-free + voice-triggered on a phone mount. If true hands-free-in-the-car becomes the #1 priority, that's the main reason to graduate to a native app later — and nothing we build on the web gets thrown away.
- The **deepest** noise removal and the **best** on-device transcription are stronger natively. The web versions are very good; native is the someday-upgrade.
- Copyrighted background music is a gray area — fine privately for two, but use your own / royalty-free tracks to be safe.

## Open questions (only you two can decide)

1. **Name** — keep "Earshot" or pick something else?
2. **Backend owner** — whose Firebase/Supabase account hosts it? (Probably you — you're driving this and have unlimited data.)
3. **Transcription** — start with paid cloud (~$10/mo, fast) or free on-device (slower)? *(MVP can ship without it and add it in v1.)*
4. **Hands-free style** — voice-trigger, one giant button, or both? (Safety while driving.)
5. **Retention** — keep everything forever (storage is cheap) or auto-archive old threads?

## Full feature backlog (so nothing we dreamed up gets lost)

**Recording:** one-tap / voice-activated · pause & resume mid-memo · re-record before sending · live waveform · auto-trim dead air · drafts to send later
**Playback:** 0.5–3x pitch-preserved · skip-silence · 15/30s skip · scrub · resume position · lock-screen & headphone controls · continuous autoplay · loudness normalize · in-memo bookmarks
**Messaging:** listened receipts · reactions · reply-at-timestamp · quick text replies · star / pin / save · never expires · push on new memo
**Library/organization:** auto-threads/topics · tags · full-text search · timeline with editable dates · auto-titles
**Transcription:** editable transcripts · tap-to-jump synced playback · read-mode · "catch me up" / weekly digest · action items & mentions
**Fun/studio:** soundboard · ducking music beds · intro/outro stingers · per-person theme song · voice effects · clips/quotes
**Reliability:** offline record + auto-send · cached replays · nothing auto-deletes
