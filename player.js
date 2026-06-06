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
    this.audio.src = this.url;
    this.audio.load();
    this._preservePitch();
    this.silences = [];

    // seekTo overrides the saved resume position (used by "go to reply timestamp")
    const startAt = seekTo != null ? seekTo : (memo.positionMs || 0) / 1000;
    const onMeta = () => {
      this.audio.removeEventListener('loadedmetadata', onMeta);
      // MediaRecorder WebM often reports Infinity duration until coaxed — nudge it, then restore.
      if (this.audio.duration === Infinity || isNaN(this.audio.duration)) {
        const fix = () => {
          this.audio.removeEventListener('durationchange', fix);
          try { this.audio.currentTime = startAt || 0; } catch (_) {}
        };
        this.audio.addEventListener('durationchange', fix);
        try { this.audio.currentTime = 1e6; } catch (_) {}
      } else if (startAt && startAt < this.audio.duration) {
        this.audio.currentTime = startAt;
      }
    };
    this.audio.addEventListener('loadedmetadata', onMeta);
  }

  setRate(r) { this.audio.playbackRate = r; this._preservePitch(); }
  play() { return this.audio.play(); }
  pause() { this.audio.pause(); }

  seek(sec) {
    const d = this.audio.duration;
    if (isFinite(d) && d > 0) this.audio.currentTime = Math.max(0, Math.min(d, sec));
    else this.audio.currentTime = Math.max(0, sec);
  }

  skip(delta) { this.seek((this.audio.currentTime || 0) + delta); }
}
