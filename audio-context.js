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
  const c = new AC();
  // iOS 16.4+: declaring the session category once keeps playback + recording on one stable route
  // instead of iOS re-selecting its preferred device (CarPlay) every time a new sound starts.
  try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch (_) {}
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
export async function resumeSharedCtx() {
  const c = getSharedCtx();
  if (c.state !== 'running') { try { await c.resume(); } catch (_) {} }
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
