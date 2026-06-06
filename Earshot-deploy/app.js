// app.js — Earshot. Record → library → play, with optional Supabase sync (see config.js / SETUP.md).
import { getAllMemos, saveMemo, updateMemo, initStore, onMemosChanged, getAudioBlob, mode, otherName, membershipOk } from './store.js';
import { saveMemo as cacheMemoLocal } from './db.js';
import * as auth from './auth.js';
import { isConfigured } from './supabase-client.js';
import { Recorder } from './recorder.js';
import { Player } from './player.js';

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const SKIP_BACK = 15;
const SKIP_FWD = 30;

// Inline SVG icons (currentColor adapts to each button's text color) — no emoji.
const ICONS = {
  play: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>',
  pause: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 5h3.4v14H7zM13.6 5H17v14h-3.4z"/></svg>',
  back: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 2.6-6.4"/><path d="M3 4v4h4"/></svg>',
  fwd: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v4h-4"/></svg>',
  warn: '<svg class="ico-sm" viewBox="0 0 24 24" fill="none" stroke="#f5b14c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4 2.5 20.5h19z"/><path d="M12 10v4.5"/><path d="M12 17.6h.01"/></svg>',
};

const els = {
  library: document.getElementById('library'),
  recordBtn: document.getElementById('record-btn'),
  overlay: document.getElementById('rec-overlay'),
  wave: document.getElementById('wave'),
  timer: document.getElementById('rec-timer'),
  recControls: document.querySelector('.rec-controls'),
  reviewControls: document.querySelector('.review-controls'),
  recPause: document.getElementById('rec-pause'),
  recStop: document.getElementById('rec-stop'),
  recCancel: document.getElementById('rec-cancel'),
  reviewAudio: document.getElementById('review-audio'),
  reviewPlay: document.getElementById('review-play'),
  reviewDiscard: document.getElementById('review-discard'),
  reviewSave: document.getElementById('review-save'),
  toast: document.getElementById('toast'),
};

const state = {
  memos: [],
  selectedId: null,
  playing: false,
  speed: Number(localStorage.getItem('earshot.speed')) || 1,
  pendingTake: null,
};

const recorder = new Recorder();
const player = new Player();

let levels = [];
let waveRAF = null;
let timerInt = null;

// ---------- helpers ----------
const pad = (n) => String(n).padStart(2, '0');
function fmtClock(sec) { sec = Math.max(0, Math.floor(sec || 0)); return `${Math.floor(sec / 60)}:${pad(sec % 60)}`; }
const fmtDuration = (ms) => fmtClock((ms || 0) / 1000);
const fmtSpeed = (s) => String(s);

function fmtDate(ts) {
  const d = new Date(ts), now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

const escapeHtml = (s) => (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.add('hidden'), 2800);
}

// ---------- library ----------
function memoRow(m) {
  const selected = m.id === state.selectedId;
  const unl = m.listened ? '' : '<i class="dot" title="Unlistened"></i>';
  const who = m.sender === 'me' ? 'You' : 'Cousin';
  const glyph = selected && state.playing ? ICONS.pause : ICONS.play;
  return `
  <article class="memo${selected ? ' selected' : ''}" data-id="${m.id}">
    <button class="memo-main" data-act="toggle">
      <span class="memo-play">${glyph}</span>
      <span class="memo-meta">
        <span class="memo-title">${escapeHtml(m.title)} ${unl}</span>
        <span class="memo-sub">${fmtDate(m.createdAt)} · ${fmtDuration(m.durationMs)} · ${who}</span>
      </span>
    </button>
    ${selected ? playerControls(m) : ''}
  </article>`;
}

function playerControls(m) {
  return `
  <div class="player">
    <input type="range" class="scrub" min="0" max="1000" value="0" step="1" aria-label="Seek" />
    <div class="times"><span class="cur">0:00</span><span class="dur">${fmtDuration(m.durationMs)}</span></div>
    <div class="player-row">
      <button class="pbtn" data-act="back" aria-label="Back 15 seconds">${ICONS.back}<small>15</small></button>
      <button class="pbtn play" data-act="play" aria-label="Play or pause">${state.playing ? ICONS.pause : ICONS.play}</button>
      <button class="pbtn" data-act="fwd" aria-label="Forward 30 seconds"><small>30</small>${ICONS.fwd}</button>
      <button class="pbtn speed" data-act="speed" aria-label="Playback speed">${fmtSpeed(state.speed)}×</button>
    </div>
  </div>`;
}

function renderLibrary() {
  const cloud = mode() === 'cloud';
  if (!state.memos.length) {
    const emptyNote = cloud
      ? `Synced with ${escapeHtml(otherName())} · record the first one.`
      : "Local preview · your cousin's copy syncs once we connect the backend.";
    els.library.innerHTML = `
      <div class="empty">
        <img class="empty-art" src="mic.svg" alt="" />
        <h2>No memos yet</h2>
        <p>Tap the red button to record your first one — it saves right here.</p>
        <p class="note">${emptyNote}</p>
      </div>`;
    return;
  }
  const n = state.memos.length;
  const libNote = cloud
    ? `${n} memo${n > 1 ? 's' : ''} · synced with ${escapeHtml(otherName())}`
    : `Local preview · ${n} memo${n > 1 ? 's' : ''} on this device. Cousin sync connects next.`;
  els.library.innerHTML = `<p class="lib-note">${libNote}</p>` + state.memos.map(memoRow).join('');
}

function updateGlyphs() {
  const play = els.library.querySelector('.pbtn.play');
  if (play) play.innerHTML = state.playing ? ICONS.pause : ICONS.play;
  const mp = els.library.querySelector('.memo.selected .memo-play');
  if (mp) mp.innerHTML = state.playing ? ICONS.pause : ICONS.play;
}

// ---------- playback ----------
async function selectMemo(id) {
  const m = state.memos.find((x) => x.id === id);
  if (!m) return;
  state.selectedId = id;
  state.playing = false;
  renderLibrary();
  let blob = m.blob;
  if (!blob) {
    try { blob = await getAudioBlob(m); m.blob = blob; }
    catch (_) { toast('Could not load this memo — check your connection.'); return; }
  }
  if (!blob) { toast('Audio not available yet.'); return; }
  player.load({ ...m, blob });
  try { await player.play(); } catch (_) { /* autoplay may need a tap */ }
}

async function togglePlay() {
  if (!state.selectedId) return;
  if (player.audio.paused) { try { await player.play(); } catch (_) {} }
  else { player.pause(); persistPosition(); }
}

function cycleSpeed() {
  const i = SPEEDS.indexOf(state.speed);
  state.speed = SPEEDS[(i + 1) % SPEEDS.length];
  player.setRate(state.speed);
  localStorage.setItem('earshot.speed', String(state.speed));
  const el = els.library.querySelector('.pbtn.speed');
  if (el) el.textContent = `${fmtSpeed(state.speed)}×`;
}

async function persistPosition() {
  if (!state.selectedId) return;
  const ms = Math.round((player.audio.currentTime || 0) * 1000);
  const m = state.memos.find((x) => x.id === state.selectedId);
  if (m) m.positionMs = ms;
  await updateMemo(state.selectedId, { positionMs: ms });
}

async function markListened(id) {
  const m = state.memos.find((x) => x.id === id);
  if (m && m.listened) return;
  if (m) m.listened = true;
  const dot = els.library.querySelector(`.memo[data-id="${id}"] .dot`);
  if (dot) dot.remove();
  await updateMemo(id, { listened: true });
}

function wirePlayer() {
  const a = player.audio;
  a.addEventListener('timeupdate', () => {
    const scrub = els.library.querySelector('.scrub');
    const cur = els.library.querySelector('.cur');
    if (scrub && isFinite(a.duration) && a.duration > 0) scrub.value = String(Math.round((a.currentTime / a.duration) * 1000));
    if (cur) cur.textContent = fmtClock(a.currentTime);
    if (state.selectedId && isFinite(a.duration) && a.duration > 0 && a.currentTime > a.duration - 1.2) markListened(state.selectedId);
  });
  a.addEventListener('play', () => { state.playing = true; updateGlyphs(); });
  a.addEventListener('pause', () => { state.playing = false; updateGlyphs(); });
  a.addEventListener('ended', async () => {
    state.playing = false; updateGlyphs();
    if (state.selectedId) { await markListened(state.selectedId); await updateMemo(state.selectedId, { positionMs: 0 }); const m = state.memos.find((x) => x.id === state.selectedId); if (m) m.positionMs = 0; }
  });
}

els.library.addEventListener('click', async (e) => {
  const memoEl = e.target.closest('.memo');
  if (!memoEl) return;
  const id = memoEl.dataset.id;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'toggle') { if (state.selectedId === id) togglePlay(); else await selectMemo(id); return; }
  if (act === 'play') return void togglePlay();
  if (act === 'back') { player.skip(-SKIP_BACK); persistPosition(); return; }
  if (act === 'fwd') { player.skip(SKIP_FWD); persistPosition(); return; }
  if (act === 'speed') return void cycleSpeed();
});

els.library.addEventListener('input', (e) => {
  if (!e.target.classList.contains('scrub')) return;
  const d = player.audio.duration;
  if (isFinite(d) && d > 0) player.seek((e.target.value / 1000) * d);
});

// ---------- recording ----------
function openOverlay() {
  els.overlay.classList.remove('hidden');
  els.overlay.setAttribute('aria-hidden', 'false');
  els.recControls.classList.remove('hidden');
  els.reviewControls.classList.add('hidden');
  els.recPause.textContent = 'Pause';
  els.timer.textContent = '0:00';
}
function closeOverlay() {
  els.overlay.classList.add('hidden');
  els.overlay.setAttribute('aria-hidden', 'true');
}

function micError(err) {
  if (err && err.name === 'NotAllowedError') return 'Microphone blocked — enable mic access to record.';
  if (err && err.name === 'NotFoundError') return 'No microphone found on this device.';
  return 'Could not start recording: ' + (err?.message || err);
}

function startTimer() {
  const tick = () => { els.timer.textContent = fmtClock(recorder.activeMs() / 1000); };
  tick(); timerInt = setInterval(tick, 200);
}
const stopTimer = () => clearInterval(timerInt);

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawWave() {
  const c = els.wave, ctx = c.getContext('2d');
  const W = c.width, H = c.height, n = 64, bw = W / n;
  const render = () => {
    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < n; i++) {
      const lv = levels[i] || 0;
      const h = Math.max(3, Math.min(H, lv * H * 2.6));
      ctx.fillStyle = '#ff5d5d';
      roundRect(ctx, i * bw + bw * 0.2, (H - h) / 2, bw * 0.6, h, bw * 0.3);
      ctx.fill();
    }
    if (recorder.state === 'recording' || recorder.state === 'paused') waveRAF = requestAnimationFrame(render);
  };
  render();
}

async function startRecording() {
  if (!player.audio.paused) { player.pause(); }
  openOverlay();
  levels = [];
  try {
    await recorder.start((rms) => { levels.push(rms); if (levels.length > 64) levels.shift(); });
  } catch (err) {
    closeOverlay();
    toast(micError(err));
    return;
  }
  startTimer();
  drawWave();
}

els.recordBtn.addEventListener('click', startRecording);

els.recPause.addEventListener('click', () => {
  if (recorder.state === 'recording') { recorder.pause(); els.recPause.textContent = 'Resume'; }
  else if (recorder.state === 'paused') { recorder.resume(); els.recPause.textContent = 'Pause'; drawWave(); }
});

els.recCancel.addEventListener('click', async () => {
  stopTimer(); if (waveRAF) cancelAnimationFrame(waveRAF);
  try { await recorder.stop(); } catch (_) {}
  closeOverlay();
});

els.recStop.addEventListener('click', async () => {
  stopTimer(); if (waveRAF) cancelAnimationFrame(waveRAF);
  const take = await recorder.stop();
  if (!take.blob.size) { toast('Nothing recorded — try again.'); closeOverlay(); return; }
  take.url = URL.createObjectURL(take.blob);
  state.pendingTake = take;
  els.reviewAudio.src = take.url;
  els.recControls.classList.add('hidden');
  els.reviewControls.classList.remove('hidden');
  els.reviewPlay.innerHTML = ICONS.play + 'Preview';
  els.timer.textContent = fmtClock(take.durationMs / 1000);
});

els.reviewPlay.addEventListener('click', () => {
  if (els.reviewAudio.paused) { els.reviewAudio.play(); els.reviewPlay.innerHTML = ICONS.pause + 'Pause'; }
  else { els.reviewAudio.pause(); els.reviewPlay.innerHTML = ICONS.play + 'Preview'; }
});
els.reviewAudio.addEventListener('ended', () => { els.reviewPlay.innerHTML = ICONS.play + 'Preview'; });

function discardTake() {
  els.reviewAudio.pause(); els.reviewAudio.removeAttribute('src');
  if (state.pendingTake?.url) URL.revokeObjectURL(state.pendingTake.url);
  state.pendingTake = null;
}

els.reviewDiscard.addEventListener('click', () => { discardTake(); closeOverlay(); });

els.reviewSave.addEventListener('click', async () => {
  const t = state.pendingTake;
  if (!t) return;
  const memo = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    durationMs: Math.round(t.durationMs),
    blob: t.blob,
    mimeType: t.mimeType,
    sender: 'me',
    title: `Memo · ${new Date().toLocaleDateString([], { month: 'short', day: 'numeric' })}`,
    listened: true,
    positionMs: 0,
    transcript: null,
  };
  await saveMemo(memo);
  state.memos.unshift(memo);
  discardTake();
  closeOverlay();
  renderLibrary();
  toast(mode() === 'cloud' ? 'Saved & sent' : 'Saved locally — cousin sync connects next');
});

// ---------- auth / boot ----------
const authEls = {
  login: document.getElementById('login'),
  form: document.getElementById('login-form'),
  email: document.getElementById('login-email'),
  password: document.getElementById('login-password'),
  error: document.getElementById('login-error'),
  banner: document.getElementById('banner'),
  signout: document.getElementById('signout-btn'),
};

function setBanner(kind) {
  if (!authEls.banner) return;
  if (kind === 'cloud') {
    authEls.banner.innerHTML = `Synced with ${escapeHtml(otherName())} · <button id="signout-btn" class="link-btn">Sign out</button>`;
    authEls.banner.querySelector('#signout-btn')?.addEventListener('click', doSignOut);
  } else if (kind === 'notmember') {
    authEls.banner.innerHTML = `${ICONS.warn} Not on the allowlist yet · <a href="SETUP.md" target="_blank" rel="noopener">finish setup →</a> · <button id="signout-btn" class="link-btn">Sign out</button>`;
    authEls.banner.querySelector('#signout-btn')?.addEventListener('click', doSignOut);
  } else if (kind === 'unconfigured') {
    authEls.banner.innerHTML = `Local only · <a href="SETUP.md" target="_blank" rel="noopener">connect sync →</a>`;
  } else {
    authEls.banner.textContent = '';
  }
}

function showLogin(msg) {
  if (authEls.error) authEls.error.textContent = msg || '';
  authEls.login?.classList.remove('hidden');
}
function hideLogin() { authEls.login?.classList.add('hidden'); }

async function doSignOut() {
  await auth.signOut();
  location.reload();
}

// Notifications are wired up in Phase 2 (push), where the permission prompt will be triggered from
// an explicit tap — iOS only honors Notification.requestPermission() inside a live user gesture,
// not after the awaits in the sign-in chain.

authEls.form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (authEls.error) authEls.error.textContent = '';
  const btn = authEls.form.querySelector('button[type="submit"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
  try {
    const session = await auth.signIn(authEls.email.value, authEls.password.value);
    await startSession(session);
  } catch (err) {
    showLogin(err?.message || 'Sign-in failed. Check your email and password.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
  }
});

async function startSession(session) {
  hideLogin();
  await auth.ensureProfile();
  await initStore(session);
  if (membershipOk()) {
    setBanner('cloud');
  } else {
    // Signed in fine, but this account isn't in the members allowlist — the most likely setup slip.
    setBanner('notmember');
    toast("Signed in, but this account isn't on the allowlist yet — finish step 4 in SETUP.md.");
  }
  state.memos = await getAllMemos();
  renderLibrary();
}

async function boot() {
  try {
    if (!isConfigured()) {
      setBanner('unconfigured');
      await initStore(null);            // local-only
      state.memos = await getAllMemos();
      renderLibrary();
      return;
    }
    const session = await auth.getSession();   // fail-soft: null on offline/SDK failure
    if (!session) {
      setBanner('none');
      state.memos = await getAllMemos();        // show cached memos behind the sign-in screen
      renderLibrary();
      showLogin();
      return;
    }
    await startSession(session);
  } catch (_) {
    // Never leave a blank, locked app — fall back to the local cache.
    setBanner('none');
    try { state.memos = await getAllMemos(); renderLibrary(); } catch (__) {}
  }
}

// ---------- init ----------
async function init() {
  if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('./sw.js'); } catch (_) {} }
  player.setRate(state.speed);
  wirePlayer();
  document.addEventListener('visibilitychange', () => { if (document.hidden) persistPosition(); });
  onMemosChanged(async () => { state.memos = await getAllMemos(); renderLibrary(); });
  await boot();
}

// Dev seed — used to verify library + player without a live mic. Harmless in production.
window.__earshotSeed = async function (seconds = 5, sender = 'cousin') {
  const sr = 16000, n = sr * seconds, data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = 0.45 * (1 + Math.sin(2 * Math.PI * 2.3 * t));   // speech-like amplitude wobble
    data[i] = Math.sin(2 * Math.PI * 175 * t) * 0.35 * env;
  }
  const blob = encodeWav(data, sr);
  const memo = {
    id: crypto.randomUUID(), createdAt: Date.now() - Math.floor(Math.random() * 6e6),
    durationMs: seconds * 1000, blob, mimeType: 'audio/wav', sender,
    title: sender === 'cousin' ? 'Demo from cousin (test tone)' : 'Demo memo (test tone)',
    listened: false, positionMs: 0, transcript: null,
  };
  await cacheMemoLocal(memo); state.memos = await getAllMemos(); renderLibrary();
  return memo.id;
};

function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buf);
  const w = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  w(36, 'data'); view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true); off += 2; }
  return new Blob([view], { type: 'audio/wav' });
}

init();
