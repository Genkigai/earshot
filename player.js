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

// Decode a fragmented/unseekable blob and re-encode it as a finite, seekable mono WAV at 24 kHz (voice).
async function finalizeBlob(blob) {
  const arr = await blob.arrayBuffer();
  const rate = 24000;
  const tmp = new OAC(1, 1, rate);
  let decoded = await tmp.decodeAudioData(arr.slice(0));
  const frames = Math.max(1, Math.ceil(decoded.duration * rate));
  const rctx = new OAC(1, frames, rate);
  const src = rctx.createBufferSource(); src.buffer = decoded; src.connect(rctx.destination); src.start();
  const rendered = await rctx.startRendering();
  decoded = null;
  return encodeWavMono(rendered.getChannelData(0), rate);
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
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(memo.blob);
    this.currentId = memo.id;
    this.durationMs = memo.durationMs || 0;   // finite duration from the recorder (audio.duration may be Infinity)
    this.silences = [];
    this._lastSilenceGap = null;
    this._wantPlay = false;
    // Long memos: defer play() until we know whether the file needs re-finalizing (a moment), so we
    // never start streaming a leaky fragmented file.
    this._pendingFinalize = this.durationMs > 60000;
    if (this._onMeta) { try { this.audio.removeEventListener('loadedmetadata', this._onMeta); } catch (_) {} }
    this.audio.src = this.url;
    this.audio.load();
    this._preservePitch();

    const startAt = seekTo != null ? seekTo : (memo.positionMs || 0) / 1000;
    this._onMeta = async () => {
      this.audio.removeEventListener('loadedmetadata', this._onMeta); this._onMeta = null;
      const myId = this.currentId;
      // Fragmented long memo (Infinity duration) → re-finalize to a clean, seekable WAV and reload.
      if (this.durationMs > 60000 && !isFinite(this.audio.duration)) {
        try {
          const wav = await finalizeBlob(memo.blob);
          if (this.currentId !== myId) return;
          if (this.url) URL.revokeObjectURL(this.url);
          this.url = URL.createObjectURL(wav);
          this.audio.src = this.url; this.audio.load(); this._preservePitch();
          await new Promise((res) => { const h = () => { this.audio.removeEventListener('loadedmetadata', h); res(); }; this.audio.addEventListener('loadedmetadata', h); });
        } catch (_) { /* fall back to the original blob */ }
      }
      if (this.currentId !== myId) return;
      this._pendingFinalize = false;
      this._afterReady(startAt);
    };
    this.audio.addEventListener('loadedmetadata', this._onMeta);
  }

  _afterReady(startAt) {
    const dur = this.durationSec();
    if (startAt > 0 && dur > 0 && startAt < dur - 0.5) { try { this.audio.currentTime = startAt; } catch (_) {} }
    if (this._wantPlay) { this._wantPlay = false; this.audio.play().catch(() => {}); }
  }

  // A finite duration in seconds for all UI/seek math (audio.duration is often Infinity pre-finalize).
  durationSec() {
    const d = this.audio.duration;
    if (isFinite(d) && d > 0) return d;
    if (this.durationMs > 0) return this.durationMs / 1000;
    return 0;
  }

  setRate(r) { this.audio.playbackRate = r; this._preservePitch(); }
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
