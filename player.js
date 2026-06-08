// player.js — wraps a detached HTMLAudioElement with pitch-preserved speed, seeking, and resume.

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
  }

  setSilences(silences) { this.silences = silences || []; }

  // Called on timeupdate: when inside a silent gap, jump to just before it ends. Returns true if it skipped.
  tickSkipSilence() {
    if (!this.skipSilence || !this.silences.length) return false;
    const t = this.audio.currentTime;
    for (const s of this.silences) {
      if (t > s.start + 0.18 && t < s.end - 0.12) {
        try { this.audio.currentTime = Math.max(t, s.end - 0.12); } catch (_) {}
        return true;
      }
    }
    return false;
  }

  _preservePitch() {
    // Keep voices natural at 2x instead of chipmunk. Default true in modern browsers; set explicitly.
    this.audio.preservesPitch = true;
    this.audio.mozPreservesPitch = true;
    this.audio.webkitPreservesPitch = true;
  }

  load(memo, seekTo = null) {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(memo.blob);
    this.currentId = memo.id;
    this.durationMs = memo.durationMs || 0;   // finite duration from the recorder (audio.duration is often Infinity on iOS m4a)
    if (this._onMeta) { try { this.audio.removeEventListener('loadedmetadata', this._onMeta); } catch (_) {} }
    this.audio.src = this.url;
    this.audio.load();
    this._preservePitch();
    this.silences = [];

    // seekTo overrides the saved resume position (used by "go to reply timestamp")
    const startAt = seekTo != null ? seekTo : (memo.positionMs || 0) / 1000;
    this._onMeta = () => {
      this.audio.removeEventListener('loadedmetadata', this._onMeta); this._onMeta = null;
      // Resume to startAt ONLY if it's within the known duration. NEVER seek to a value outside the
      // media — the old "currentTime = 1e6" coax made iOS progressively buffer toward 1e6 and crash
      // the tab ~a minute into playback.
      const dur = this.durationSec();
      if (startAt > 0 && dur > 0 && startAt < dur - 0.5) { try { this.audio.currentTime = startAt; } catch (_) {} }
    };
    this.audio.addEventListener('loadedmetadata', this._onMeta);
  }

  // A finite duration in seconds for all UI/seek math: real audio.duration if available, else the
  // recorder's stored durationMs (iOS m4a frequently reports Infinity).
  durationSec() {
    const d = this.audio.duration;
    if (isFinite(d) && d > 0) return d;
    if (this.durationMs > 0) return this.durationMs / 1000;
    return 0;
  }

  setRate(r) { this.audio.playbackRate = r; this._preservePitch(); }
  play() { return this.audio.play(); }
  pause() { this.audio.pause(); }

  seek(sec) {
    const dur = this.durationSec();
    const target = dur > 0 ? Math.max(0, Math.min(dur, sec)) : Math.max(0, sec);
    try { this.audio.currentTime = target; } catch (_) {}
  }

  skip(delta) { this.seek((this.audio.currentTime || 0) + delta); }

  // Fully detach the current media — used by the error-recovery path so the next memo loads clean.
  reset() {
    try { this.audio.pause(); } catch (_) {}
    try { this.audio.removeAttribute('src'); this.audio.load(); } catch (_) {}
    if (this.url) { try { URL.revokeObjectURL(this.url); } catch (_) {} this.url = null; }
    this.currentId = null; this.durationMs = 0; this.silences = [];
  }
}
