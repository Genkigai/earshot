// recorder.js — mic capture with built-in cleanup, capped voice-grade bitrate, live level metering.
//
// Cleanup strategy for the MVP: we lean on the browser's own real-time DSP via getUserMedia
// constraints (noiseSuppression + echoCancellation + autoGainControl). These are cross-platform
// (incl. iOS Safari) and handle steady car noise well. Heavier high-pass / ML "Enhance" is a v1
// post-processing step — kept out of the live record path so iOS recording stays rock-solid.
//
// Routing note: the level-meter tap runs on the app-wide shared AudioContext (audio-context.js) and
// is NEVER closed here. Creating/closing a context per recording made iOS renegotiate the audio
// route and grab CarPlay away from AirPods on every record.

import { resumeSharedCtx } from './audio-context.js';

// ---- one persistent mic stream, reused across recordings ----
// Re-acquiring the mic (getUserMedia) and fully stopping its tracks after EVERY recording made iOS
// Safari (esp. an installed PWA) renegotiate the audio route AND re-prompt for mic permission each
// time. So we grab the stream once, keep it alive between recordings, and release it only after an
// idle window or on app teardown — so permission is asked just the first time.
let _mic = null;
let _micIdleTimer = null;
const MIC_IDLE_MS = 60000;   // drop the mic (and the iOS orange dot) after 60s of not recording

async function getMicStream() {
  if (_micIdleTimer) { clearTimeout(_micIdleTimer); _micIdleTimer = null; }
  // Reuse only if every track is still live — iOS can silently end a track on a route flip.
  if (_mic && _mic.getAudioTracks().every((t) => t.readyState === 'live')) return _mic;
  if (_mic) { try { _mic.getTracks().forEach((t) => t.stop()); } catch (_) {} _mic = null; }
  _mic = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, noiseSuppression: true, echoCancellation: true, autoGainControl: true },
  });
  return _mic;
}
function scheduleMicRelease() {
  if (_micIdleTimer) clearTimeout(_micIdleTimer);
  _micIdleTimer = setTimeout(releaseMic, MIC_IDLE_MS);
}
export function releaseMic() {
  if (_micIdleTimer) { clearTimeout(_micIdleTimer); _micIdleTimer = null; }
  if (_mic) { try { _mic.getTracks().forEach((t) => t.stop()); } catch (_) {} _mic = null; }
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', releaseMic);

// Combine recorded segments into one playable blob. A SINGLE segment is returned as-is (small m4a,
// no decode). Multiple segments (from pause→preview→continue, or a call interruption) are decoded and
// stitched into one seekable mono WAV — the only client-side way to concatenate m4a/AAC. (So a stitched
// memo is larger; a normal single-take memo stays small.)
const _OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
// Gentle, capped peak-normalization (byte-neutral, in place): lift a quiet stitched memo toward ~-1 dBFS,
// cap makeup gain at +12 dB, leave near-silence alone, hard-limit so it never clips. (Mirror of player.js.)
function _normalizeInPlace(data, targetPeak = 0.89, maxGain = 4.0, noiseFloor = 0.02) {
  let peak = 0;
  for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
  if (peak < noiseFloor) return;
  let gain = targetPeak / peak;
  if (gain > maxGain) gain = maxGain;
  if (gain <= 1.001) return;
  for (let i = 0; i < data.length; i++) { let s = data[i] * gain; if (s > 1) s = 1; else if (s < -1) s = -1; data[i] = s; }
}
function _wavMono(data, rate) {
  const n = data.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  let off = 44; for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, data[i])); v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true); off += 2; }
  return new Blob([v], { type: 'audio/wav' });
}
async function combineSegments(takes) {
  if (takes.length === 0) return { blob: new Blob(), durationMs: 0, mimeType: 'audio/mp4' };
  if (takes.length === 1) return { blob: takes[0].blob, durationMs: takes[0].durationMs, mimeType: takes[0].blob.type || 'audio/mp4' };
  const rate = 24000; const parts = []; let total = 0;
  for (const t of takes) {
    try {
      const arr = await t.blob.arrayBuffer();
      const dctx = new _OAC(1, 1, rate);
      let dec = await dctx.decodeAudioData(arr.slice(0));
      const frames = Math.max(1, Math.ceil(dec.duration * rate));
      const rctx = new _OAC(1, frames, rate);
      const src = rctx.createBufferSource(); src.buffer = dec; src.connect(rctx.destination); src.start();
      const rendered = await rctx.startRendering(); dec = null;
      parts.push(rendered.getChannelData(0).slice()); total += frames;
    } catch (_) {}
  }
  const all = new Float32Array(total); let off = 0;
  for (const p of parts) { all.set(p, off); off += p.length; }
  _normalizeInPlace(all);   // bring stitched (multi-segment) memos up to a consistent, comfortable level
  return { blob: _wavMono(all, rate), durationMs: Math.round((total / rate) * 1000), mimeType: 'audio/wav' };
}

export class Recorder {
  constructor() { this._takes = []; this.reset(); }   // _takes survives across pause/continue (NOT reset per-segment)

  clearTakes() { this._takes = []; }
  hasTakes() { return this._takes.length > 0; }
  takesMs() { return this._takes.reduce((s, t) => s + (t.durationMs || 0), 0); }   // total of banked segments

  reset() {
    this.stream = null;
    this.mr = null;
    this.chunks = [];
    this.audioCtx = null;
    this.analyser = null;
    this._src = null;
    this._elapsed = 0;      // accumulated active ms (excludes paused time)
    this._segStart = 0;
    this._mime = '';
    this._lvlRAF = null;
  }

  static pickMimeType() {
    // MP4/AAC first: every iPhone records AND plays it back natively. Modern iOS Safari can now
    // *record* WebM/Opus but can't reliably *play* it from a blob URL, so WebM is last-resort only.
    const types = [
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/aac',
      'audio/webm;codecs=opus',
      'audio/webm',
    ];
    if (typeof MediaRecorder === 'undefined') return '';
    for (const t of types) {
      try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (_) {}
    }
    return '';
  }

  get state() { return this.mr ? this.mr.state : 'inactive'; }

  // True only if the current mic stream still has live tracks. After a phone call (or unplugging the
  // input) iOS ends the track, so a paused MediaRecorder can't actually resume — we detect that here
  // and restart into a fresh segment instead of calling a no-op resume().
  tracksLive() {
    if (!this.stream) return false;
    const tr = this.stream.getAudioTracks();
    return tr.length > 0 && tr.every((t) => t.readyState === 'live');
  }

  activeMs() {
    return this._elapsed + (this.state === 'recording' ? performance.now() - this._segStart : 0);
  }

  async start(onLevel, onLost) {
    this.reset();
    this.stream = await getMicStream();   // reused across recordings → iOS only prompts the first time
    // If the input device disappears mid-recording (e.g. AirPods removed), the track ends and the OS
    // can't seamlessly swap sources for an in-flight MediaRecorder. Rather than silently lose the take,
    // notify the app so it can finalize + save whatever was captured.
    try { this.stream.getAudioTracks().forEach((t) => t.addEventListener('ended', () => { if (onLost) onLost(); }, { once: true })); } catch (_) {}

    // Live level meter (tap only — never connected to destination, so no echo/feedback).
    // Uses the app-wide shared context so recording doesn't trigger an iOS route renegotiation.
    // If WebAudio is unavailable the meter is skipped but recording still works (MediaRecorder uses
    // the raw mic stream, not the context).
    // resumeSharedCtx is timeout-bounded (audio-context.js) so this can't hang the record start even if
    // iOS left the shared context 'interrupted' after playback — the freeze-after-listening bug.
    try { this.audioCtx = await resumeSharedCtx(); } catch (_) { this.audioCtx = null; }
    if (this.audioCtx) {
      try {
        const src = this.audioCtx.createMediaStreamSource(this.stream);
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 1024;
        src.connect(this.analyser);
        this._src = src;
      } catch (_) { this.analyser = null; this._src = null; }
    }

    const mime = Recorder.pickMimeType();
    const bitrate = Number(localStorage.getItem('earshot.bitrate')) || 32000; // voice-grade default
    const opts = { audioBitsPerSecond: bitrate };
    if (mime) opts.mimeType = mime;
    this.mr = new MediaRecorder(this.stream, opts);
    this._mime = this.mr.mimeType || mime || 'audio/webm';
    this.chunks = [];
    this.mr.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    // NO timeslice: emit ONE finalized blob on stop instead of 100ms fragments. A fragmented file has
    // no seek index + reports Infinity duration, and iOS Safari LEAKS memory streaming it during
    // playback → OOM ~a minute into long memos. A single finalized blob has a proper moov/duration and
    // plays cleanly. (The live level meter reads the analyser, not these chunks, so it's unaffected.)
    this.mr.start();

    this._elapsed = 0;
    this._segStart = performance.now();

    const buf = this.analyser ? new Uint8Array(this.analyser.frequencyBinCount) : null;
    const loop = () => {
      if (!this.analyser || !buf) return;
      this.analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      if (onLevel) onLevel(Math.sqrt(sum / buf.length));
      this._lvlRAF = requestAnimationFrame(loop);
    };
    loop();
  }

  pause() {
    if (this.state === 'recording') {
      this._elapsed += performance.now() - this._segStart;
      this.mr.pause();
    }
  }

  resume() {
    if (this.state === 'paused') {
      this._segStart = performance.now();
      this.mr.resume();
    }
  }

  // Finalize the current segment, bank it, and resolve with the COMBINED take (all segments so far).
  async stop() {
    return new Promise((resolve, reject) => {
      if (!this.mr || this.state === 'inactive') { combineSegments(this._takes).then(resolve); return; }
      if (this.state === 'recording') this._elapsed += performance.now() - this._segStart;
      const durationMs = this._elapsed;
      this.mr.onstop = () => {
        if (this._lvlRAF) cancelAnimationFrame(this._lvlRAF);
        const blob = new Blob(this.chunks, { type: this._mime });
        // Disconnect our analyser tap but DO NOT close the shared audioCtx; mic OFF immediately (no
        // lingering iOS orange dot).
        try { this._src && this._src.disconnect(); } catch (_) {}
        try { this.analyser && this.analyser.disconnect(); } catch (_) {}
        this.analyser = null; this._src = null; this.audioCtx = null;
        this.stream = null;
        releaseMic();
        if (blob.size) this._takes.push({ blob, durationMs });   // bank this segment
        combineSegments(this._takes).then(resolve);
      };
      try { this.mr.stop(); } catch (e) { reject(e); }
    });
  }
}
