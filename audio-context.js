// audio-context.js — ONE hardware-facing AudioContext for the whole app.
//
// iOS Safari re-runs AVAudioSession route negotiation every time a *realtime* AudioContext is
// created (or the mic is grabbed). Earshot used to spin up a separate context for recording,
// playback metering, waveform analysis, the soundboard, remix decode, and transcription — so almost
// any tap renegotiated the route and the OS would yank the output from AirPods back to CarPlay.
// Those throwaway contexts also got auto-suspended when the route flipped and were never resumed,
// which silently broke decode/playback for already-recorded memos ("old messages stop working").
//
// Fix: every realtime decode/playback/record path shares this single, long-lived context, we hint
// the iOS audio-session category once, and we keep it awake across route flips / app foregrounding.
// (OfflineAudioContext is fine to create per-render — it never touches the hardware route.)

let _ctx = null;

function makeCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  let c;
  try { c = new AC(); }
  catch (_) { return null; }   // never let a WebAudio construction failure crash the app — playback falls back to the HTMLAudioElement
  // iOS 16.4+: declare the session category to keep the route stable. Default to 'playback' — the full-
  // volume MEDIA route — because the app spends nearly all its time listening; the 'play-and-record'
  // category routes output to the quieter receiver path, which made memos sound too quiet. We bump to
  // 'play-and-record' only while the mic is actually open (see setSessionType calls in app.js).
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) {}
  // Whenever iOS suspends/interrupts us (route flip, phone call, Siri), come back so later decodes work.
  const wake = () => {
    if (c.state === 'suspended' || c.state === 'interrupted') { c.resume().catch(() => {}); }
  };
  try { c.addEventListener('statechange', wake); } catch (_) {}
  return c;
}

// The single shared context. Created lazily; recreated only if something closed it.
export function getSharedCtx() {
  if (!_ctx || _ctx.state === 'closed') _ctx = makeCtx();
  return _ctx;
}

// Resume the shared context. iOS starts it 'suspended' and re-suspends on route flips/interruptions,
// so call this from inside a user gesture (record/play tap) and before any decodeAudioData.
// May return null if WebAudio is unavailable — callers fall back to the HTMLAudioElement for playback.
export async function resumeSharedCtx() {
  const c = getSharedCtx();
  if (c && c.state !== 'running') {
    // iOS quirk: after HTMLAudio playback the shared realtime context can sit in 'interrupted', and
    // c.resume() then returns a promise that NEVER settles while the page is foregrounded. Awaiting it
    // froze the record path (overlay opened but nothing recorded until an app restart). So kick resume()
    // fire-and-forget and only wait a short bounded budget — recording never depends on the context
    // (MediaRecorder reads the raw mic stream); this is just for the live level meter.
    c.resume().catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
  }
  return c;
}

// Switch the iOS audio-session category if ever needed ('playback' | 'play-and-record').
export function setSessionType(type) {
  try { if (navigator.audioSession) navigator.audioSession.type = type; } catch (_) {}
}

// Foregrounding the app is a safe moment to recover a context the OS suspended while we were away —
// without this, the first tap after a route flip would hit a dead context and old memos wouldn't play.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resumeSharedCtx(); });
}
