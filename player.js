// player.js — wraps a detached HTMLAudioElement with pitch-preserved speed, seeking, and resume.
//
// iOS LEAK GUARD: MediaRecorder files can be "fragmented" (no seek index, Infinity duration), and iOS
// Safari leaks memory streaming them during long playback → OOM ~a minute in. New recordings avoid
// this (recorder.js now records a single finalized blob). For any memo that STILL loads as fragmented
// (e.g. older ones), we re-finalize it on the fly into a small, seekable mono WAV before playing.

const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;

function encodeWavMono(data, rate) {
  const n = data.length;
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, data[i])); v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true); off += 2; }
  return new Blob([v], { type: 'audio/wav' });
}

// Silence detection over ~30ms RMS windows — IDENTICAL constants to analysis.js (-42 dB, 450 ms) so the
// two code paths agree. We run it on the PCM the finalize pass ALREADY rendered, so skip-silence works on
// long memos without ever decoding the blob a second time (analysis.js skips silence for >60s memos).
function detectSilences(data, rate, silenceDb = -42, minSilenceMs = 450) {
  const thresh = Math.pow(10, silenceDb / 20);
  const win = Math.max(1, Math.floor(rate * 0.03));
  const out = []; let silStart = -1;
  for (let i = 0; i < data.length; i += win) {
    let sum = 0, n = 0; const end = Math.min(i + win, data.length);
    for (let j = i; j < end; j++) { const v = data[j]; sum += v * v; n++; }
    const rms = Math.sqrt(sum / (n || 1)); const t = i / rate;
    if (rms < thresh) { if (silStart < 0) silStart = t; }
    else if (silStart >= 0) { if ((t - silStart) * 1000 >= minSilenceMs) out.push({ start: silStart, end: t }); silStart = -1; }
  }
  const dur = data.length / rate;
  if (silStart >= 0 && (dur - silStart) * 1000 >= minSilenceMs) out.push({ start: silStart, end: dur });
  return out;
}

// Gentle, capped peak-normalization (byte-neutral — mutates samples in place before 16-bit quantization).
// Lifts abnormally-quiet memos toward a safe ceiling without blasting: normalizes the peak TO ~-1 dBFS,
// caps makeup gain at +12 dB, leaves near-silence alone, and hard-limits so it can never clip past full scale.
function normalizeInPlace(data, { targetPeak = 0.89, maxGain = 4.0, noiseFloor = 0.02 } = {}) {
  let peak = 0;
  for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
  if (peak < noiseFloor) return;            // near-silence: don't amplify hiss
  let gain = targetPeak / peak;
  if (gain > maxGain) gain = maxGain;       // cap the makeup gain
  if (gain <= 1.001) return;                // already loud enough — leave it untouched
  for (let i = 0; i < data.length; i++) {
    let s = data[i] * gain;
    if (s > 1) s = 1; else if (s < -1) s = -1;   // hard limiter (rarely engages given targetPeak)
    data[i] = s;
  }
}

// Decode a fragmented/unseekable blob and re-encode it as a finite, seekable mono WAV at 24 kHz (voice).
// Returns { wav, silences }: silences are detected from the rendered PCM here (pre-normalization, so the
// -42 dB threshold matches the original levels) so the caller can drive skip-silence on long memos.
export async function finalizeBlob(blob) {
  const arr = await blob.arrayBuffer();
  const rate = 24000;
  const tmp = new OAC(1, 1, rate);
  let decoded = await tmp.decodeAudioData(arr.slice(0));
  const frames = Math.max(1, Math.ceil(decoded.duration * rate));
  const rctx = new OAC(1, frames, rate);
  const src = rctx.createBufferSource(); src.buffer = decoded; src.connect(rctx.destination); src.start();
  const rendered = await rctx.startRendering();
  decoded = null;
  const channel = rendered.getChannelData(0);
  const silences = detectSilences(channel, rate);   // detect on original levels (before the boost below)
  normalizeInPlace(channel);                         // then lift quiet memos to a comfortable level
  return { wav: encodeWavMono(channel, rate), silences };
}

export class Player {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'metadata';
    // Keep playback inline on iOS so starting a memo doesn't hand the route to a full-screen/AirPlay
    // takeover (part of the AirPods↔CarPlay flapping).
    this.audio.playsInline = true;
    try { this.audio.setAttribute('playsinline', ''); } catch (_) {}
    this._preservePitch();
    this.url = null;
    this.currentId = null;
    this.silences = [];
    this.skipSilence = false;
    this._wantPlay = false;
    this._pendingFinalize = false;
    this._lastSilenceGap = null;
    this._rate = 1;   // remembered playback rate, re-applied after every src swap (src+load() reset it to 1)
  }

  setSilences(silences) { this.silences = silences || []; }

  // Only seek when the target is actually inside a seekable range (a fragmented iOS file isn't seekable,
  // and seeking it re-buffers/leaks). De-duped per gap so we never re-seek the same gap.
  _canSeekTo(target) {
    const sk = this.audio.seekable;
    if (!sk || sk.length === 0) return false;
    for (let i = 0; i < sk.length; i++) { if (target >= sk.start(i) && target <= sk.end(i)) return true; }
    return false;
  }
  tickSkipSilence() {
    if (!this.skipSilence || !this.silences.length) return false;
    const t = this.audio.currentTime;
    for (const s of this.silences) {
      if (t > s.start + 0.18 && t < s.end - 0.12) {
        if (this._lastSilenceGap === s) return false;
        const target = Math.max(t, s.end - 0.12);
        if (!this._canSeekTo(target)) return false;
        try { this.audio.currentTime = target; this._lastSilenceGap = s; } catch (_) {}
        return true;
      }
    }
    return false;
  }

  _preservePitch() {
    this.audio.preservesPitch = true;
    this.audio.mozPreservesPitch = true;
    this.audio.webkitPreservesPitch = true;
  }

  load(memo, seekTo = null) {
    if (this.url) { try { URL.revokeObjectURL(this.url); } catch (_) {} this.url = null; }
    this.currentId = memo.id;
    this.durationMs = memo.durationMs || 0;   // finite duration from the recorder (audio.duration may be Infinity)
    this.silences = [];
    this._lastSilenceGap = null;
    this._wantPlay = false;
    const startAt = seekTo != null ? seekTo : (memo.positionMs || 0) / 1000;
    const myId = memo.id;

    // LONG memos: re-encode to a clean, seekable WAV FIRST and only ever play that — never let the
    // audio element stream the original (a fragmented MediaRecorder file leaks memory on iOS and OOMs
    // ~15-60s in). Short memos play directly (they finish before any leak matters).
    if (this.durationMs > 60000) {
      this._pendingFinalize = true;
      finalizeBlob(memo.blob).then(({ wav, silences }) => {
        if (this.currentId !== myId) return;
        this.setSilences(silences);   // long-memo skip-silence: gaps detected during the finalize decode
        this._setSrc(URL.createObjectURL(wav), startAt);
      }).catch(() => {
        if (this.currentId !== myId) return;
        this._setSrc(URL.createObjectURL(memo.blob), startAt);   // fall back (rare) to the original
      });
    } else {
      this._pendingFinalize = false;
      this._setSrc(URL.createObjectURL(memo.blob), startAt);
    }
  }

  _setSrc(url, startAt) {
    this.url = url;
    if (this._onMeta) { try { this.audio.removeEventListener('loadedmetadata', this._onMeta); } catch (_) {} }
    this.audio.src = url;
    this.audio.load();
    this._preservePitch();
    if (this._rate != null) this.audio.playbackRate = this._rate;   // src+load() reset rate to 1 — restore it
    this._onMeta = () => {
      this.audio.removeEventListener('loadedmetadata', this._onMeta); this._onMeta = null;
      this._pendingFinalize = false;
      this._afterReady(startAt);
    };
    this.audio.addEventListener('loadedmetadata', this._onMeta);
  }

  _afterReady(startAt) {
    const dur = this.durationSec();
    if (startAt > 0 && dur > 0 && startAt < dur - 0.5) { try { this.audio.currentTime = startAt; } catch (_) {} }
    // Re-apply the chosen rate AFTER metadata settles (WebKit resets playbackRate during the media-load
    // algorithm); do it before play() so the memo starts at the right speed AND pitch. Fixes "label says
    // 2x but a long memo plays at 1x" — long memos load their src async, after the call-site setRate ran.
    if (this._rate != null) { this.audio.playbackRate = this._rate; this._preservePitch(); }
    if (this._wantPlay) { this._wantPlay = false; this.audio.play().catch(() => {}); }
  }

  // A finite duration in seconds for all UI/seek math (audio.duration is often Infinity pre-finalize).
  durationSec() {
    const d = this.audio.duration;
    if (isFinite(d) && d > 0) return d;
    if (this.durationMs > 0) return this.durationMs / 1000;
    return 0;
  }

  setRate(r) { this._rate = r; this.audio.playbackRate = r; this._preservePitch(); }   // remember + apply
  play() {
    if (this._pendingFinalize) { this._wantPlay = true; return Promise.resolve(); }   // wait until the file is ready
    return this.audio.play();
  }
  pause() { this.audio.pause(); }

  seek(sec) {
    const dur = this.durationSec();
    const target = dur > 0 ? Math.max(0, Math.min(dur, sec)) : Math.max(0, sec);
    try { this.audio.currentTime = target; } catch (_) {}
  }

  skip(delta) { this.seek((this.audio.currentTime || 0) + delta); }

  reset() {
    try { this.audio.pause(); } catch (_) {}
    try { this.audio.removeAttribute('src'); this.audio.load(); } catch (_) {}
    if (this.url) { try { URL.revokeObjectURL(this.url); } catch (_) {} this.url = null; }
    this.currentId = null; this.durationMs = 0; this.silences = []; this._pendingFinalize = false; this._wantPlay = false;
  }
}
