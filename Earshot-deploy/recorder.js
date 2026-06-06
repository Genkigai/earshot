// recorder.js — mic capture with built-in cleanup, capped voice-grade bitrate, live level metering.
//
// Cleanup strategy for the MVP: we lean on the browser's own real-time DSP via getUserMedia
// constraints (noiseSuppression + echoCancellation + autoGainControl). These are cross-platform
// (incl. iOS Safari) and handle steady car noise well. Heavier high-pass / ML "Enhance" is a v1
// post-processing step — kept out of the live record path so iOS recording stays rock-solid.

export class Recorder {
  constructor() { this.reset(); }

  reset() {
    this.stream = null;
    this.mr = null;
    this.chunks = [];
    this.audioCtx = null;
    this.analyser = null;
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
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, noiseSuppression: true, echoCancellation: true, autoGainControl: true },
    });

    // Live level meter (tap only — never connected to destination, so no echo/feedback).
    const AC = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new AC();
    const src = this.audioCtx.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);

    const mime = Recorder.pickMimeType();
    const opts = { audioBitsPerSecond: 32000 }; // ~0.24 MB/min — clear voice, tiny files
    if (mime) opts.mimeType = mime;
    this.mr = new MediaRecorder(this.stream, opts);
    this._mime = this.mr.mimeType || mime || 'audio/webm';
    this.chunks = [];
    this.mr.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.mr.start(100);

    this._elapsed = 0;
    this._segStart = performance.now();

    const buf = new Uint8Array(this.analyser.frequencyBinCount);
    const loop = () => {
      if (!this.analyser) return;
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
      if (this.state === 'recording') this._elapsed += performance.now() - this._segStart;
      const durationMs = this._elapsed;
      this.mr.onstop = () => {
        if (this._lvlRAF) cancelAnimationFrame(this._lvlRAF);
        const blob = new Blob(this.chunks, { type: this._mime });
        const stream = this.stream, ctx = this.audioCtx;
        this.analyser = null;
        if (stream) stream.getTracks().forEach((t) => t.stop());
        if (ctx && ctx.state !== 'closed') ctx.close();
        resolve({ blob, durationMs, mimeType: this._mime });
      };
      try { this.mr.stop(); } catch (e) { reject(e); }
    });
  }
}
