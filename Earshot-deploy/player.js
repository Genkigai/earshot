// player.js — wraps a detached HTMLAudioElement with pitch-preserved speed, seeking, and resume.

export class Player {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'metadata';
    this._preservePitch();
    this.url = null;
    this.currentId = null;
  }

  _preservePitch() {
    // Keep voices natural at 2x instead of chipmunk. Default true in modern browsers; set explicitly.
    this.audio.preservesPitch = true;
    this.audio.mozPreservesPitch = true;
    this.audio.webkitPreservesPitch = true;
  }

  load(memo) {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(memo.blob);
    this.currentId = memo.id;
    this.audio.src = this.url;
    this.audio.load();
    this._preservePitch();

    const startAt = (memo.positionMs || 0) / 1000;
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
