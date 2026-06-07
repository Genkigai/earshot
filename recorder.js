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

export class Recorder {
  constructor() { this.reset(); }

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

  activeMs() {
    return this._elapsed + (this.state === 'recording' ? performance.now() - this._segStart : 0);
  }

  async start(onLevel) {
    this.reset();
    this.stream = await getMicStream();   // reused across recordings → iOS only prompts the first time

    // Live level meter (tap only — never connected to destination, so no echo/feedback).
    // Uses the app-wide shared context so recording doesn't trigger an iOS route renegotiation.
    // If WebAudio is unavailable the meter is skipped but recording still works (MediaRecorder uses
    // the raw mic stream, not the context).
    this.audioCtx = await resumeSharedCtx();
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
    this.mr.start(100);

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

  async stop() {
    return new Promise((resolve, reject) => {
      if (!this.mr) { resolve({ blob: new Blob(), durationMs: 0, mimeType: this._mime }); return; }
      // idempotent: a second stop() (auto-stop racing manual Stop) returns what we already have
      // instead of reassigning onstop and orphaning the first call's promise.
      if (this.state === 'inactive') { resolve({ blob: new Blob(this.chunks, { type: this._mime }), durationMs: this._elapsed, mimeType: this._mime }); return; }
      if (this.state === 'recording') this._elapsed += performance.now() - this._segStart;
      const durationMs = this._elapsed;
      this.mr.onstop = () => {
        if (this._lvlRAF) cancelAnimationFrame(this._lvlRAF);
        const blob = new Blob(this.chunks, { type: this._mime });
        // Disconnect our analyser tap but DO NOT close the shared audioCtx, and DO NOT stop the mic
        // tracks — the stream is cached and reused so iOS never re-prompts. It's released after an idle
        // window (scheduleMicRelease) or on pagehide (releaseMic).
        try { this._src && this._src.disconnect(); } catch (_) {}
        try { this.analyser && this.analyser.disconnect(); } catch (_) {}
        this.analyser = null; this._src = null; this.audioCtx = null;
        this.stream = null;            // drop our reference; the module keeps _mic alive
        scheduleMicRelease();
        resolve({ blob, durationMs, mimeType: this._mime });
      };
      try { this.mr.stop(); } catch (e) { reject(e); }
    });
  }
}
