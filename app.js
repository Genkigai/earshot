// app.js — Earshot. Record → library → play, with optional Supabase sync (see config.js / SETUP.md).
import { getAllMemos, saveMemo, updateMemo, initStore, onMemosChanged, getAudioBlob, mode, otherName, membershipOk, onSyncChange, syncStatus, me, dataUsage, enforceStorageCap } from './store.js';

// Whose memo is this? Prefer the immutable server senderId vs the live signed-in id; fall back to the
// local 'sender' tag only for a just-recorded memo that hasn't synced yet. (A mutable 'sender' string
// could get mis-stamped and paint a received memo in MY color — the "cousin's memo turned teal" bug.)
function isMine(m) {
  // Use the persisted user id when me() is momentarily null (pre-init / iOS cold-resume), so a present,
  // immutable senderId is ALWAYS authoritative and the mutable `sender` string is never load-bearing for
  // color. (earshot.userId is account-correct: the memo cache is cleared before it's overwritten on a
  // different-user login.) This is what stops a received memo from flickering teal↔red across re-renders.
  const myId = me()?.id ?? localStorage.getItem('earshot.userId');
  if (m.senderId != null && myId != null) return m.senderId === myId;
  return m.sender === 'me';
}
import { saveMemo as cacheMemoLocal } from './db.js';
import * as auth from './auth.js';
import { isConfigured } from './supabase-client.js';
import { Recorder } from './recorder.js';
import { Player, finalizeBlob } from './player.js';
import { analyze } from './analysis.js';
import { getSharedCtx, resumeSharedCtx, setSessionType } from './audio-context.js';

// Semantic versioning (MAJOR.MINOR.PATCH): bump PATCH for fixes, MINOR for new features, MAJOR for
// breaking changes. Shown under the title + in Settings to confirm which build a phone is running.
// IMPORTANT: when you change this, also bump CACHE in sw.js to the same version so phones drop the old
// cached build instead of serving stale code.
const APP_VERSION = '1.0.1';
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
  silence: '<svg class="ico-c" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>',
  autoplay: '<svg class="ico-c" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  bookmark: '<svg class="ico-c" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/></svg>',
  search: '<svg class="ico-c" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  star: '<svg class="ico-c" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 18.8 6.2 21l1.1-6.5L2.6 9.8l6.5-.9z"/></svg>',
  // Filled star for the "starred" state. Uses fill="currentColor" (NOT a CSS var) so it reliably
  // fills on iOS WebKit, where `fill: var(--x)` overriding a presentation `fill="none"` was flaky.
  starOn: '<svg class="ico-c" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 18.8 6.2 21l1.1-6.5L2.6 9.8l6.5-.9z"/></svg>',
  text: '<svg class="ico-c" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  fx: '<svg class="ico-c" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5z"/><path d="M5 14l.9 2.1L8 17l-2.1.9L5 20l-.9-2.1L2 17l2.1-.9z"/></svg>',
  reply: '<svg class="ico-c" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 17l-5-5 5-5"/><path d="M4 12h10a6 6 0 0 1 6 6v1"/></svg>',
  unread: '<svg class="ico-c" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
};

function replyLine(m) {
  const orig = state.memos.find((x) => x.id === m.replyToId);
  const t = (m.replyToMs || 0) / 1000;
  const title = orig ? orig.title : 'a memo';
  return `<button class="reply-line" data-act="gotoreply" data-rid="${m.replyToId}" data-rt="${m.replyToMs || 0}">${ICONS.reply}Re: ${escapeHtml(title)} · ${fmtClock(t)}</button>`;
}

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
  skipSilence: localStorage.getItem('earshot.skipSilence') === '1',
  autoplay: localStorage.getItem('earshot.autoplay') !== '0',   // default ON
  query: '',
  filter: 'all',
  replyContext: null,
  driveMode: localStorage.getItem('earshot.driveMode') === '1',
};

const recorder = new Recorder();
const player = new Player();

let levels = [];
let waveRAF = null;
let timerInt = null;
let currentAnalysis = null;
let _lastWaveDraw = 0;

// ---------- helpers ----------
const pad = (n) => String(n).padStart(2, '0');
function fmtClock(sec) { sec = Math.max(0, Math.floor(sec || 0)); return `${Math.floor(sec / 60)}:${pad(sec % 60)}`; }
const fmtDuration = (ms) => fmtClock((ms || 0) / 1000);
// Storage size per memo: actual blob size when we have it, else estimate from duration × bitrate.
function memoBytes(m) {
  if (m.bytes) return m.bytes;
  if (m.blob && m.blob.size) return m.blob.size;
  const br = Number(localStorage.getItem('earshot.bitrate')) || 32000;
  return Math.round(((m.durationMs || 0) / 1000) * (br / 8));
}
function fmtBytes(b) {
  if (!b) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}
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
  const mine = isMine(m);
  const unread = !m.listened && !mine;                 // received & not heard
  const glyph = selected && state.playing ? ICONS.pause : ICONS.play;
  const tx = m.transcript ? `<span class="has-tx" title="Transcribed">${ICONS.text}</span>` : '';
  const cls = ['memo', mine ? 'mine' : 'theirs', selected ? 'selected' : '', (m.listened && !mine) ? 'heard' : '', unread ? 'unread' : ''].filter(Boolean).join(' ');
  return `
  <article class="${cls}" data-id="${m.id}">
    ${m.replyToId ? replyLine(m) : ''}
    <div class="memo-row-top">
      <button class="memo-main" data-act="toggle">
        <span class="memo-play">${glyph}</span>
        <span class="memo-meta">
          <span class="memo-title">${unread ? '<i class="dot" title="Unlistened"></i>' : ''}${escapeHtml(m.title)}</span>
          <span class="memo-sub">${fmtDuration(m.durationMs)} · ${fmtBytes(memoBytes(m))} · ${fmtDate(m.createdAt)} ${tx}</span>
        </span>
      </button>
      <button class="star-btn${m.starred ? ' on' : ''}" data-act="star" aria-label="${m.starred ? 'Unstar' : 'Star'}">${m.starred ? ICONS.starOn : ICONS.star}</button>
    </div>
    ${selected ? playerControls(m) : ''}
  </article>`;
}

function playerControls(m) {
  return `
  <div class="player">
    <canvas class="wave-player" aria-label="Waveform — tap to seek"></canvas>
    <div class="times"><span class="cur">0:00</span><span class="dur">${fmtDuration(m.durationMs)}</span></div>
    <div class="player-row">
      <button class="pbtn" data-act="back" aria-label="Back 15 seconds">${ICONS.back}<small>15</small></button>
      <button class="pbtn play" data-act="play" aria-label="Play or pause">${state.playing ? ICONS.pause : ICONS.play}</button>
      <button class="pbtn" data-act="fwd" aria-label="Forward 30 seconds"><small>30</small>${ICONS.fwd}</button>
      <button class="pbtn speed" data-act="speed" aria-label="Playback speed">${fmtSpeed(state.speed)}×</button>
    </div>
    <div class="chips">
      <button class="chip" data-act="reply" aria-label="Reply at this moment">${ICONS.reply}Reply</button>
      <button class="chip" data-act="transcript" aria-label="Transcript">${ICONS.text}Transcript</button>
      <button class="chip${state.skipSilence ? ' on' : ''}" data-act="silence" aria-label="Skip silence">${ICONS.silence}Skip silence</button>
      <button class="chip" data-act="bookmark" aria-label="Add bookmark">${ICONS.bookmark}Bookmark</button>
      <button class="chip" data-act="markunread" aria-label="Mark unread">${ICONS.unread}Mark unread</button>
    </div>
  </div>`;
}

function renderLibrary() {
  const cloud = mode() === 'cloud';
  if (!state.memos.length) {
    const emptyNote = cloud
      ? `Synced with ${escapeHtml(otherName())} · record the first one.`
      : 'Local preview · memos sync once you connect the backend.';
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
  const unreadN = state.memos.filter((m) => !m.listened && !isMine(m)).length;
  const them = escapeHtml(cloud ? otherName() : 'the other person');
  const libNote = unreadN
    ? `<span class="unread-pill">${unreadN} unheard</span> from ${them}`
    : (cloud ? `All caught up with ${them}` : `Local preview · ${n} memo${n > 1 ? 's' : ''} on this device`);
  const list = visibleMemos();
  let html = `<p class="lib-note">${libNote}</p>`;
  if (!list.length) {
    html += `<div class="empty-search">No memos match${state.query ? ` “${escapeHtml(state.query)}”` : ' this filter'}.</div>`;
  } else {
    let lastDay = null;
    for (const m of list) {
      const dl = dayLabel(m.createdAt);
      if (dl !== lastDay) { html += `<div class="day-head">${dl}</div>`; lastDay = dl; }
      html += memoRow(m);
    }
  }
  // Chat-style scroll: stick to the bottom (newest) if you're already near it or we just got/sent a
  // memo; otherwise keep your place while scrolling back through history (innerHTML resets scroll).
  const lib = els.library;
  const fromBottom = lib.scrollHeight - lib.scrollTop - lib.clientHeight;
  const stick = _forceBottom || fromBottom < 90;
  lib.innerHTML = html;
  if (stick) lib.scrollTop = lib.scrollHeight;
  else lib.scrollTop = Math.max(0, lib.scrollHeight - lib.clientHeight - fromBottom);
  _forceBottom = false;
}
let _forceBottom = false;
function scrollLibBottom() { _forceBottom = true; }

function visibleMemos() {
  const q = state.query.trim().toLowerCase();
  return state.memos.filter((m) => {
    if (state.filter === 'unlistened' && (m.listened || isMine(m))) return false;
    if (state.filter === 'starred' && !m.starred) return false;
    if (q) {
      const hay = `${m.title || ''} ${m.transcript || ''} ${isMine(m) ? 'you' : 'them'}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function dayLabel(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function updateGlyphs() {
  const play = els.library.querySelector('.pbtn.play');
  if (play) play.innerHTML = state.playing ? ICONS.pause : ICONS.play;
  const mp = els.library.querySelector('.memo.selected .memo-play');
  if (mp) mp.innerHTML = state.playing ? ICONS.pause : ICONS.play;
}

// ---------- playback ----------
async function selectMemo(id, seekTo = null) {
  const m = state.memos.find((x) => x.id === id);
  if (!m) return;
  state.selectedId = id;
  state.playing = false;
  currentAnalysis = null;
  renderLibrary();
  let blob = m.blob;
  if (!blob) {
    try { blob = await getAudioBlob(m); m.blob = blob; }
    catch (e) { console.warn('getAudioBlob failed', { id: m.id, audioPath: m.audioPath, error: e }); toast('Could not load this memo — check your connection.'); return; }
  }
  if (!blob) { toast('Audio not available yet.'); return; }
  player.load({ ...m, blob }, seekTo);
  player.setRate(state.speed);          // keep your chosen speed across memos (load() resets it to 1×)
  player.skipSilence = state.skipSilence;
  drawPlayerWave();
  setupMediaSession(m);
  analyze(m.id, blob, { durationMs: m.durationMs }).then((res) => {
    if (state.selectedId !== id) return;
    currentAnalysis = res;                  // peaks/waveform always come from analyze (flat bars for long)
    // Long memos (>60s) get their silences from the finalize decode in player.load(); analyze() returns
    // none for them, so don't let this late resolve clobber the good ones. Short memos own silences here.
    if ((m.durationMs || 0) <= 60000) player.setSilences(res.silences);
    drawPlayerWave();
  }).catch(() => {});
  if (localStorage.getItem('earshot.autoTranscribe') === '1' && !m.transcript) {
    setTimeout(() => { const cur = state.memos.find((x) => x.id === id); if (cur && !cur.transcript && cur.blob) runTranscription(cur); }, 1500);
  }
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
  if (!m || m.listened) return;
  m.listened = true;
  // in-place UI update (no full re-render mid-playback): gray the bubble, drop the dot, update the count
  const memoEl = els.library.querySelector(`.memo[data-id="${id}"]`);
  if (memoEl) {
    memoEl.classList.remove('unread');
    if (!isMine(m)) memoEl.classList.add('heard');
    memoEl.querySelector('.dot')?.remove();
  }
  updateUnreadPill();
  await updateMemo(id, { listened: true });
}

function updateUnreadPill() {
  const note = els.library.querySelector('.lib-note');
  if (!note) return;
  const unreadN = state.memos.filter((x) => !x.listened && !isMine(x)).length;
  const them = escapeHtml(mode() === 'cloud' ? otherName() : 'the other person');
  note.innerHTML = unreadN
    ? `<span class="unread-pill">${unreadN} unheard</span> from ${them}`
    : (mode() === 'cloud' ? `All caught up with ${them}` : `Local preview · ${state.memos.length} memo${state.memos.length > 1 ? 's' : ''} on this device`);
}

// ---------- waveform scrubber + power features ----------
function drawPlayerWave() {
  const canvas = els.library.querySelector('.wave-player');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.parentElement?.clientWidth || 320;
  const cssH = 54;
  const needW = Math.round(cssW * dpr), needH = Math.round(cssH * dpr);
  if (canvas.width !== needW || canvas.height !== needH) { canvas.width = needW; canvas.height = needH; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const peaks = currentAnalysis?.peaks;
  const dur = player.durationSec() || currentAnalysis?.duration || 0;
  const prog = dur > 0 ? Math.min(1, (player.audio.currentTime || 0) / dur) : 0;
  const gap = 1.5;
  const srcN = peaks ? peaks.length : 80;
  const n = Math.max(1, Math.min(srcN, Math.floor((cssW + gap) / (2 + gap))));  // only as many bars as fit the width
  const bw = Math.max(1, (cssW - (n - 1) * gap) / n);
  const mid = cssH / 2;
  for (let i = 0; i < n; i++) {
    let v = 0.12;
    if (peaks) { const s = Math.floor(i * srcN / n), e = Math.max(s + 1, Math.floor((i + 1) * srcN / n)); let mx = 0; for (let k = s; k < e && k < srcN; k++) if (peaks[k] > mx) mx = peaks[k]; v = mx; }
    const h = Math.max(2, v * (cssH - 8));
    const x = i * (bw + gap);
    ctx.fillStyle = (i / n) <= prog ? '#2dd4bf' : '#39404f';
    roundRect(ctx, x, mid - h / 2, bw, h, Math.min(bw / 2, 2));
    ctx.fill();
  }
  const m = state.memos.find((x) => x.id === state.selectedId);
  if (m && m.bookmarks && m.bookmarks.length && dur > 0) {
    ctx.fillStyle = '#f5b14c';
    for (const bt of m.bookmarks) { const x = Math.min(cssW - 2, (bt / dur) * cssW); ctx.fillRect(x, 0, 2, cssH); }
  }
}

function toggleSkipSilence(e) {
  state.skipSilence = !state.skipSilence;
  player.skipSilence = state.skipSilence;
  localStorage.setItem('earshot.skipSilence', state.skipSilence ? '1' : '0');
  e?.target?.closest('.chip')?.classList.toggle('on', state.skipSilence);
  toast(state.skipSilence ? 'Skip-silence on — trims the dead air' : 'Skip-silence off');
}

function toggleAutoplay(e) {
  state.autoplay = !state.autoplay;
  localStorage.setItem('earshot.autoplay', state.autoplay ? '1' : '0');
  e?.target?.closest('.chip')?.classList.toggle('on', state.autoplay);
  toast(state.autoplay ? 'Autoplay on — plays unlistened memos in a row' : 'Autoplay off');
}

async function addBookmark() {
  const m = state.memos.find((x) => x.id === state.selectedId);
  if (!m) return;
  const t = Math.round((player.audio.currentTime || 0) * 10) / 10;
  m.bookmarks = (m.bookmarks || []).concat(t).sort((a, b) => a - b);
  await updateMemo(m.id, { bookmarks: m.bookmarks });
  drawPlayerWave();
  toast(`Bookmarked at ${fmtClock(t)}`);
}

function nextUnlistened(currentId) {
  const list = visibleMemos();          // respect search/filter — never autoplay a memo that's hidden
  const n = list.length;
  if (!n) return null;
  const idx = Math.max(0, list.findIndex((m) => m.id === currentId));
  for (let k = 1; k <= n; k++) {
    const m = list[(idx + k) % n];
    if (m && m.id !== currentId && !m.listened) return m;
  }
  return null;
}

function playAdjacent(dir) {
  const idx = state.memos.findIndex((m) => m.id === state.selectedId);
  if (idx < 0) return;
  const next = state.memos[idx + dir];
  if (next) selectMemo(next.id);
}

function setupMediaSession(m) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: m.title || 'Memo',
      artist: isMine(m) ? 'You' : otherName(),
      album: 'Earshot',
      artwork: [{ src: 'icon.svg', sizes: '512x512', type: 'image/svg+xml' }],
    });
    const set = (a, h) => { try { navigator.mediaSession.setActionHandler(a, h); } catch (_) {} };
    set('play', () => togglePlay());
    set('pause', () => { player.pause(); persistPosition(); });
    set('seekbackward', () => { player.skip(-SKIP_BACK); persistPosition(); });
    set('seekforward', () => { player.skip(SKIP_FWD); persistPosition(); });
    set('previoustrack', () => playAdjacent(-1));
    set('nexttrack', () => playAdjacent(1));
    set('seekto', (d) => { if (d && d.seekTime != null) { player.seek(d.seekTime); persistPosition(); } });
  } catch (_) {}
}

function wirePlayer() {
  const a = player.audio;
  a.addEventListener('timeupdate', () => {
    player.tickSkipSilence();
    const cur = els.library.querySelector('.cur');
    if (cur) cur.textContent = fmtClock(a.currentTime);
    const nowT = performance.now();
    if (nowT - _lastWaveDraw > 80) { drawPlayerWave(); _lastWaveDraw = nowT; }   // throttle redraw to ~12fps
    const _txo = document.getElementById('transcript');
    if (_txo && !_txo.classList.contains('hidden')) highlightTranscript(a.currentTime);
    const d = player.durationSec();   // finite (iOS m4a reports Infinity)
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && isFinite(d) && d > 0) {
      try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(a.currentTime, d), playbackRate: a.playbackRate }); } catch (_) {}
    }
    if (state.selectedId && d > 0 && a.currentTime > d - 1.2) markListened(state.selectedId);
  });
  a.addEventListener('play', () => { state.playing = true; updateGlyphs(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
  a.addEventListener('pause', () => { state.playing = false; updateGlyphs(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });
  // A decode/source error on one memo must NOT wedge the rest: fully detach the media so the NEXT tap
  // on ANY memo loads clean (this is the "once it crashed it kept crashing" symptom).
  a.addEventListener('error', () => {
    state.playing = false;
    const failed = player.currentId;
    player.reset();
    currentAnalysis = null;
    updateGlyphs();
    if (failed) toast('That memo couldn’t be played — try another one.');
  });
  a.addEventListener('ended', async () => {
    state.playing = false; updateGlyphs();
    const finishedId = state.selectedId;
    // Persist in a guard so a failed write never throws out of the handler and blocks autoplay-next.
    try { if (finishedId) { await markListened(finishedId); await updateMemo(finishedId, { positionMs: 0 }); const m = state.memos.find((x) => x.id === finishedId); if (m) m.positionMs = 0; } } catch (_) {}
    if (state.autoplay) { const next = nextUnlistened(finishedId); if (next) selectMemo(next.id); }
  });
}

els.library.addEventListener('click', async (e) => {
  const memoEl = e.target.closest('.memo');
  if (!memoEl) return;
  const id = memoEl.dataset.id;
  const actEl = e.target.closest('[data-act]');
  const act = actEl?.dataset.act;
  if (act === 'gotoreply') { const rid = actEl.dataset.rid, rt = Number(actEl.dataset.rt) || 0; await selectMemo(rid, rt / 1000); if (state.selectedId !== rid) toast('Original memo not available yet.'); return; }
  if (act === 'toggle') { if (state.selectedId === id) togglePlay(); else await selectMemo(id); return; }
  if (act === 'play') return void togglePlay();
  if (act === 'back') { player.skip(-SKIP_BACK); persistPosition(); return; }
  if (act === 'fwd') { player.skip(SKIP_FWD); persistPosition(); return; }
  if (act === 'speed') return void cycleSpeed();
  if (act === 'silence') return void toggleSkipSilence(e);
  if (act === 'autoplay') return void toggleAutoplay(e);
  if (act === 'bookmark') return void addBookmark();
  if (act === 'star') return void toggleStar(id);
  if (act === 'transcript') return void openTranscript();
  if (act === 'reply') return void startReply();
  if (act === 'markunread') return void markUnread(id);
});

async function markUnread(id) {
  const m = state.memos.find((x) => x.id === id);
  if (!m) return;
  m.listened = false;
  await updateMemo(id, { listened: false });
  renderLibrary();
  toast('Marked unread');
}

function startReply() {
  const m = state.memos.find((x) => x.id === state.selectedId);
  if (!m) return;
  state.replyContext = { id: m.id, ms: Math.round((player.audio.currentTime || 0) * 1000), title: m.title };
  if (!player.audio.paused) { player.pause(); persistPosition(); }
  startRecording();
}

async function toggleStar(id) {
  const m = state.memos.find((x) => x.id === id);
  if (!m) return;
  m.starred = !m.starred;
  // Update the icon optimistically (before the awaited write, so a resync can't beat the visual):
  // swap to the filled glyph + the gold "on" class so it clearly switches to filled.
  const btn = els.library.querySelector(`.memo[data-id="${id}"] .star-btn`);
  if (btn) { btn.classList.toggle('on', m.starred); btn.innerHTML = m.starred ? ICONS.starOn : ICONS.star; btn.setAttribute('aria-label', m.starred ? 'Unstar' : 'Star'); }
  await updateMemo(id, { starred: m.starred });
  if (state.filter === 'starred' && !m.starred) renderLibrary();
  toast(m.starred ? 'Starred' : 'Unstarred');
}

// ---------- search / filters / settings ----------
const searchEl = document.getElementById('search');
searchEl?.addEventListener('input', () => { state.query = searchEl.value; renderLibrary(); });
document.querySelectorAll('.filter').forEach((b) => b.addEventListener('click', () => {
  state.filter = b.dataset.filter;
  document.querySelectorAll('.filter').forEach((x) => x.classList.toggle('on', x === b));
  renderLibrary();
}));

const settingsEl = document.getElementById('settings');
function syncChips() {
  const sc = els.library.querySelector('[data-act="silence"]'); if (sc) sc.classList.toggle('on', state.skipSilence);
  const ac = els.library.querySelector('[data-act="autoplay"]'); if (ac) ac.classList.toggle('on', state.autoplay);
}
function renderSpeedSeg() {
  const seg = document.getElementById('set-speed'); if (!seg) return;
  const def = Number(localStorage.getItem('earshot.speed')) || 1;
  const closest = [1, 1.5, 2].reduce((a, b) => (Math.abs(b - def) < Math.abs(a - def) ? b : a));
  seg.innerHTML = [1, 1.5, 2].map((s) => `<button class="seg-btn${s === closest ? ' on' : ''}" data-speed="${s}">${s}×</button>`).join('');
  seg.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
    const s = Number(b.dataset.speed); state.speed = s; player.setRate(s); localStorage.setItem('earshot.speed', String(s));
    const sp = els.library.querySelector('.pbtn.speed'); if (sp) sp.textContent = `${s}×`;
    renderSpeedSeg();
  }));
}
function renderQualitySeg() {
  const seg = document.getElementById('set-quality'); if (!seg) return;
  const cur = Number(localStorage.getItem('earshot.bitrate')) || 32000;
  const opts = [['Low', 24000], ['Standard', 32000], ['High', 48000]];
  seg.innerHTML = opts.map(([label, br]) => `<button class="seg-btn${br === cur ? ' on' : ''}" data-br="${br}">${label}</button>`).join('');
  seg.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => { localStorage.setItem('earshot.bitrate', b.dataset.br); renderQualitySeg(); }));
}
function renderStorageSeg() {
  const seg = document.getElementById('set-storage'); if (!seg) return;
  const cur = Number(localStorage.getItem('earshot.storageCapMB')) || 0;
  const opts = [['50 MB', 50], ['200 MB', 200], ['500 MB', 500], ['Off', 0]];
  seg.innerHTML = opts.map(([label, mb]) => `<button class="seg-btn${mb === cur ? ' on' : ''}" data-mb="${mb}">${label}</button>`).join('');
  seg.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => { localStorage.setItem('earshot.storageCapMB', b.dataset.mb); renderStorageSeg(); enforceStorageCap(); }));
}
function renderDataUsage() {
  const note = document.getElementById('set-data-note');
  const u = dataUsage();
  const since = new Date(u.since).toLocaleDateString([], { month: 'short', day: 'numeric' });
  if (note) note.textContent = `${fmtBytes(u.bytes)} since ${since}`;
  const seg = document.getElementById('set-monthstart'); if (!seg) return;
  const curDay = Number(localStorage.getItem('earshot.monthStartDay')) || 1;
  const days = [1, 5, 10, 15, 20, 25];
  seg.innerHTML = `<span class="seg-cap">resets day</span>` + days.map((d) => `<button class="seg-btn${d === curDay ? ' on' : ''}" data-day="${d}">${d}</button>`).join('');
  seg.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => { localStorage.setItem('earshot.monthStartDay', b.dataset.day); renderDataUsage(); }));
}

// ---------- per-person bubble accent colors ----------
const ACCENTS = [
  ['Teal', '#2dd4bf'], ['Red', '#ff5d5d'], ['Indigo', '#7c96ff'],
  ['Amber', '#f5b14c'], ['Green', '#34d399'], ['Pink', '#f472b6'], ['Violet', '#a78bfa'],
];
function hexToRgb(hex) { const h = hex.replace('#', ''); const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h; const n = parseInt(f, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function applyAccent(which, hex) {
  const [r, g, b] = hexToRgb(hex); const rgb = `${r},${g},${b}`; const s = document.documentElement.style;
  if (which === 'mine') {
    s.setProperty('--mine-bg', `rgba(${rgb},.11)`); s.setProperty('--mine-bd', `rgba(${rgb},.26)`);
    s.setProperty('--mine-play-bg', `rgba(${rgb},.16)`); s.setProperty('--mine-play-fg', hex);
  } else {
    s.setProperty('--theirs-bg', `rgba(${rgb},.11)`); s.setProperty('--theirs-bd', `rgba(${rgb},.30)`);
    s.setProperty('--theirs-play-bg', `rgba(${rgb},.18)`); s.setProperty('--theirs-play-fg', hex);
    s.setProperty('--theirs-unread-bg', `rgba(${rgb},.22)`); s.setProperty('--theirs-unread-bd', hex);
    s.setProperty('--theirs-glow', `rgba(${rgb},.20)`);
  }
}
function applyAccents() {
  applyAccent('mine', localStorage.getItem('earshot.colorMine') || '#2dd4bf');
  applyAccent('theirs', localStorage.getItem('earshot.colorTheirs') || '#ff5d5d');
}
function renderAccentPickers() {
  const mineKey = 'earshot.colorMine', themKey = 'earshot.colorTheirs';
  const mineCur = localStorage.getItem(mineKey) || '#2dd4bf';
  const themCur = localStorage.getItem(themKey) || '#ff5d5d';
  const build = (el, cur, key) => {
    if (!el) return;
    el.innerHTML = ACCENTS.map(([name, hex]) => `<button class="swatch${hex === cur ? ' on' : ''}" data-hex="${hex}" title="${name}" aria-label="${name}" style="background:${hex}"></button>`).join('');
    el.querySelectorAll('.swatch').forEach((b) => b.addEventListener('click', () => { localStorage.setItem(key, b.dataset.hex); applyAccents(); renderAccentPickers(); renderLibrary(); }));
  };
  build(document.getElementById('set-color-mine'), mineCur, mineKey);
  build(document.getElementById('set-color-theirs'), themCur, themKey);
}
function openSettings() {
  if (!settingsEl) return;
  document.getElementById('set-skipsilence').checked = state.skipSilence;
  document.getElementById('set-autoplay').checked = state.autoplay;
  document.getElementById('set-drive').checked = state.driveMode;
  document.getElementById('set-autotranscribe').checked = localStorage.getItem('earshot.autoTranscribe') === '1';
  import('./push.js').then(async (p) => { const el = document.getElementById('set-push'); if (el) el.checked = await p.pushEnabled(); }).catch(() => {});
  renderSpeedSeg();
  renderQualitySeg();
  renderStorageSeg();
  renderDataUsage();
  renderAccentPickers();
  const ver = document.getElementById('set-version'); if (ver) ver.textContent = `Sight and Sound · ${APP_VERSION}`;
  const so = document.getElementById('set-signout'); if (so) so.style.display = mode() === 'cloud' ? 'block' : 'none';
  settingsEl.classList.remove('hidden');
  settingsEl.setAttribute('aria-hidden', 'false');
}
function closeSettings() { settingsEl?.classList.add('hidden'); settingsEl?.setAttribute('aria-hidden', 'true'); }
document.getElementById('settings-btn')?.addEventListener('click', openSettings);
document.getElementById('set-close')?.addEventListener('click', closeSettings);
document.getElementById('set-signout')?.addEventListener('click', doSignOut);
settingsEl?.addEventListener('click', (e) => { if (e.target === settingsEl) closeSettings(); });
document.getElementById('set-skipsilence')?.addEventListener('change', (e) => { state.skipSilence = e.target.checked; player.skipSilence = state.skipSilence; localStorage.setItem('earshot.skipSilence', state.skipSilence ? '1' : '0'); syncChips(); });
document.getElementById('set-autoplay')?.addEventListener('change', (e) => { state.autoplay = e.target.checked; localStorage.setItem('earshot.autoplay', state.autoplay ? '1' : '0'); syncChips(); });
document.getElementById('set-drive')?.addEventListener('change', (e) => { state.driveMode = e.target.checked; localStorage.setItem('earshot.driveMode', state.driveMode ? '1' : '0'); });
document.getElementById('set-autotranscribe')?.addEventListener('change', (e) => { localStorage.setItem('earshot.autoTranscribe', e.target.checked ? '1' : '0'); });
document.getElementById('set-push')?.addEventListener('change', async (e) => {
  const p = await import('./push.js');
  if (e.target.checked) {
    try { await p.enablePush(); toast('Notifications on'); }
    catch (err) { e.target.checked = false; toast(err?.message || 'Could not enable notifications'); }
  } else {
    try { await p.disablePush(); toast('Notifications off'); } catch (_) {}
  }
});

// ---------- transcript ----------
const txEl = document.getElementById('transcript');
let txEditing = false;
function renderTranscriptBody(m) {
  const body = document.getElementById('tx-body');
  const empty = document.getElementById('tx-empty');
  const editBtn = document.getElementById('tx-edit');
  const area = document.getElementById('tx-edit-area');
  const status = document.getElementById('tx-status');
  status.classList.add('hidden'); area.classList.add('hidden');
  txEditing = false; editBtn.textContent = 'Edit';
  if (m && m.transcript) {
    empty.classList.add('hidden');
    editBtn.classList.remove('hidden');
    if (m.transcriptChunks && m.transcriptChunks.length) {
      let lastT = 0;
      body.innerHTML = m.transcriptChunks.map((c) => {
        let t = c.timestamp && c.timestamp[0];
        if (t == null || Number.isNaN(t)) t = lastT;          // Whisper can drop a start timestamp — carry forward
        lastT = (c.timestamp && c.timestamp[1] != null) ? c.timestamp[1] : t;
        return `<span class="tx-seg" data-t="${t}">${escapeHtml(c.text || '')}</span>`;
      }).join(' ');
    } else {
      body.innerHTML = `<span class="tx-seg" data-t="0">${escapeHtml(m.transcript)}</span>`;
    }
    body.classList.remove('hidden');
  } else {
    body.classList.add('hidden');
    editBtn.classList.add('hidden');
    empty.classList.remove('hidden');
  }
}
function openTranscript() {
  const m = state.memos.find((x) => x.id === state.selectedId);
  if (!m) { toast('Open a memo first'); return; }
  renderTranscriptBody(m);
  txEl.classList.remove('hidden'); txEl.setAttribute('aria-hidden', 'false');
}
function closeTranscript() { txEl?.classList.add('hidden'); txEl?.setAttribute('aria-hidden', 'true'); }
function highlightTranscript(t) {
  const body = document.getElementById('tx-body'); if (!body) return;
  const segs = body.querySelectorAll('.tx-seg'); let active = null;
  segs.forEach((s) => { if ((Number(s.dataset.t) || 0) <= t) active = s; });
  segs.forEach((s) => s.classList.toggle('cur', s === active));
}
document.getElementById('tx-close')?.addEventListener('click', closeTranscript);
txEl?.addEventListener('click', (e) => { if (e.target === txEl) closeTranscript(); });

// ---------- swipe-to-dismiss for bottom sheets ----------
// The grab-handle now actually drags: pull the sheet down past a threshold to dismiss it
// (it looked draggable before but wasn't).
function enableSheetDismiss(overlayId, closeFn) {
  const overlay = document.getElementById(overlayId);
  const sheet = overlay?.querySelector('.sheet');
  const handle = overlay?.querySelector('.sheet-handle');
  if (!overlay || !sheet || !handle) return;
  let startY = 0, dy = 0, dragging = false;
  handle.addEventListener('pointerdown', (e) => {
    dragging = true; startY = e.clientY; dy = 0;
    sheet.style.transition = 'none';
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dy = Math.max(0, e.clientY - startY);
    sheet.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = '';
    const dismiss = dy > 90;
    sheet.style.transform = '';
    if (dismiss) closeFn();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
enableSheetDismiss('settings', closeSettings);
enableSheetDismiss('transcript', closeTranscript);
document.getElementById('tx-body')?.addEventListener('click', (e) => {
  const seg = e.target.closest('.tx-seg'); if (!seg) return;
  const t = Number(seg.dataset.t) || 0;
  player.seek(t); if (player.audio.paused) player.play(); persistPosition();
});
document.getElementById('tx-edit')?.addEventListener('click', async () => {
  const m = state.memos.find((x) => x.id === state.selectedId); if (!m) return;
  const area = document.getElementById('tx-edit-area'), body = document.getElementById('tx-body'), editBtn = document.getElementById('tx-edit');
  if (!txEditing) {
    txEditing = true; editBtn.textContent = 'Save';
    area.value = m.transcript || ''; area.classList.remove('hidden'); body.classList.add('hidden');
  } else {
    txEditing = false; editBtn.textContent = 'Edit';
    m.transcript = area.value.trim(); m.transcriptChunks = null;
    await updateMemo(m.id, { transcript: m.transcript, transcriptChunks: null });
    area.classList.add('hidden'); renderTranscriptBody(m); renderLibrary();
  }
});
document.getElementById('tx-run')?.addEventListener('click', async () => {
  const m = state.memos.find((x) => x.id === state.selectedId); if (!m) return;
  if (!m.blob) { try { m.blob = await getAudioBlob(m); } catch (_) {} }
  if (!m.blob) { toast('Audio not loaded'); return; }
  runTranscription(m);
});

let _txBusy = false;
async function runTranscription(m) {
  if (_txBusy) { toast('Already transcribing one memo…'); return; }
  _txBusy = true;
  const empty = document.getElementById('tx-empty'), status = document.getElementById('tx-status');
  empty?.classList.add('hidden');
  if (status) { status.classList.remove('hidden'); status.textContent = 'Loading model…'; }
  try {
    const { transcribe } = await import('./transcription.js');
    const res = await transcribe(m.blob, (s, pct) => {
      if (!status) return;
      if (s === 'download') status.textContent = `Downloading model… ${pct || 0}%`;
      else if (s === 'loading-model') status.textContent = 'Loading model…';
      else if (s === 'transcribing') status.textContent = 'Transcribing…';
    });
    m.transcript = res.text || '(no speech detected)';
    m.transcriptChunks = (res.chunks && res.chunks.length) ? res.chunks : null;
    await updateMemo(m.id, { transcript: m.transcript, transcriptChunks: m.transcriptChunks });
    if (state.selectedId === m.id && txEl && !txEl.classList.contains('hidden')) renderTranscriptBody(m);
    renderLibrary();
    toast('Transcribed');
  } catch (e) {
    const tooLong = String((e && e.message) || '').includes('too long');
    if (status) status.textContent = tooLong ? 'This memo is too long to transcribe on device.' : 'Couldn’t transcribe — connect to Wi-Fi for the one-time model download, then try again.';
    toast(tooLong ? 'Memo too long to transcribe' : 'Could not transcribe');
  } finally { _txBusy = false; }
}

// Waveform tap/drag to seek
els.library.addEventListener('pointerdown', (e) => {
  const canvas = e.target.closest?.('.wave-player');
  if (!canvas) return;
  e.preventDefault();
  const durOf = () => player.durationSec() || currentAnalysis?.duration || 0;
  const seekFromEvent = (ev) => {
    const live = els.library.querySelector('.wave-player');   // re-resolve: a re-render can detach the captured canvas
    if (!live) return;
    const rect = live.getBoundingClientRect();
    if (rect.width <= 0) return;
    const x = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
    const d = durOf();
    if (d > 0) {
      player.seek((x / rect.width) * d);
      drawPlayerWave();
      const cur = els.library.querySelector('.cur');
      if (cur) cur.textContent = fmtClock(player.audio.currentTime);
    }
  };
  seekFromEvent(e);
  const move = (ev) => seekFromEvent(ev);
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); persistPosition(); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

// ---------- recording ----------
function openOverlay() {
  els.overlay.classList.remove('hidden');
  els.overlay.setAttribute('aria-hidden', 'false');
  els.recControls.classList.remove('hidden');
  els.reviewControls.classList.add('hidden');
  els.recPause.textContent = 'Pause';
  els.timer.textContent = '0:00';
  const rb = document.getElementById('rec-reply');
  if (rb) {
    if (state.replyContext) { rb.innerHTML = `${ICONS.reply} Replying to “${escapeHtml(state.replyContext.title || 'memo')}” · ${fmtClock(state.replyContext.ms / 1000)}`; rb.classList.remove('hidden'); }
    else rb.classList.add('hidden');
  }
  const hint = document.getElementById('rec-hint');
  if (hint) {
    if (state.driveMode) { hint.textContent = 'Hands-free — just talk; it stops & sends when you finish.'; hint.classList.remove('hidden'); }
    else hint.classList.add('hidden');
  }
}
function closeOverlay() {
  els.overlay.classList.add('hidden');
  els.overlay.setAttribute('aria-hidden', 'true');
  state.replyContext = null;   // any close clears a pending reply
  setSessionType('playback');  // back to the full-volume media route now the mic session is done
}

function micError(err) {
  if (err && err.name === 'NotAllowedError') return 'Microphone blocked — enable mic access to record.';
  if (err && err.name === 'NotFoundError') return 'No microphone found on this device.';
  return 'Could not start recording: ' + (err?.message || err);
}

function startTimer() {
  const tick = () => { els.timer.textContent = fmtClock((recorder.takesMs() + recorder.activeMs()) / 1000); };  // total across segments
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
    const paused = recorder.state === 'paused';
    for (let i = 0; i < n; i++) {
      const lv = levels[i] || 0;
      const h = Math.max(3, Math.min(H, lv * H * 2.6));
      ctx.fillStyle = paused ? '#4a5160' : '#ff5d5d';   // grey + frozen bars = clearly paused
      roundRect(ctx, i * bw + bw * 0.2, (H - h) / 2, bw * 0.6, h, bw * 0.3);
      ctx.fill();
    }
    if (paused) {
      ctx.fillStyle = '#9aa1b2';
      ctx.font = '600 16px -apple-system, system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('Paused', W / 2, H / 2);
    }
    if (recorder.state === 'recording' || recorder.state === 'paused') waveRAF = requestAnimationFrame(render);
  };
  render();
}

// Hands-free auto-stop: once you've spoken, stop after ~2.5s of continuous silence. Pure + testable.
const DRIVE_SPEECH = 0.06, DRIVE_SILENCE_MS = 2500;
const driveWatch = { hasSpoken: false, silenceStart: 0, stopped: false };
function driveTick(rms, now) {
  if (rms > DRIVE_SPEECH) { driveWatch.hasSpoken = true; driveWatch.silenceStart = 0; return false; }
  if (driveWatch.hasSpoken) {
    if (!driveWatch.silenceStart) driveWatch.silenceStart = now;
    else if (now - driveWatch.silenceStart > DRIVE_SILENCE_MS) return true;
  }
  return false;
}
window.__driveTick = driveTick; window.__driveWatch = driveWatch;   // exposed for testing only

// Standard record-loop callbacks, shared by every path that opens a mic segment (new memo, Continue
// from preview, and resume-after-a-phone-call). `drive` is captured per-segment.
function recCallbacks(drive) {
  const onLevel = (rms) => {
    levels.push(rms); if (levels.length > 64) levels.shift();
    if (drive && !driveWatch.stopped && recorder.state === 'recording' && driveTick(rms, performance.now())) { driveWatch.stopped = true; finishRecording(true); }
  };
  // input device vanished mid-recording (e.g. AirPods removed, or a phone call grabbed the mic) →
  // bail to the review screen with what we captured rather than lose it. From there: Continue.
  const onLost = () => { if (recorder.state !== 'inactive') { toast('Input changed — tap Continue to keep going.'); finishRecording(false); } };
  return { onLevel, onLost };
}

// Open ONE mic segment and (re)start the timer + waveform. _takes is preserved across segments, so each
// call appends to the same memo. stopTimer() first guarantees exactly one live interval.
async function beginSegment() {
  // Switch the iOS audio session to record mode ONLY while the mic is open. beginSegment is the single
  // chokepoint for every record path (new memo, Continue-from-preview, resume-after-call), so this one
  // line covers them all; closeOverlay restores 'playback' (the louder route) on every exit.
  setSessionType('play-and-record');
  levels = [];
  const { onLevel, onLost } = recCallbacks(state.driveMode);
  await recorder.start(onLevel, onLost);
  stopTimer(); startTimer();
  drawWave();
}

async function startRecording() {
  if (!player.audio.paused) { player.pause(); }
  openOverlay();
  recorder.clearTakes();   // fresh memo — drop any segments left over from a prior take
  driveWatch.hasSpoken = false; driveWatch.silenceStart = 0; driveWatch.stopped = false;
  try {
    await beginSegment();
  } catch (err) {
    closeOverlay();
    toast(micError(err));
  }
}

let finishing = false;
async function finishRecording(autoSend) {
  if (finishing) return;   // de-dupe: auto-stop racing a manual Stop, or a double-tap
  finishing = true;
  try {
    stopTimer(); if (waveRAF) cancelAnimationFrame(waveRAF);
    let take;
    try { take = await recorder.stop(); } catch (_) { recorder.clearTakes(); closeOverlay(); return; }
    if (!take.blob.size) { toast('Nothing recorded — try again.'); recorder.clearTakes(); closeOverlay(); return; }
    if (autoSend) { await buildAndSaveMemo(take); recorder.clearTakes(); return; }
    await setupReview(take);
  } finally { finishing = false; }
}

// --- rich preview/review: scrub, speed, play — plus Continue to keep recording ---
let _reviewSpeed = 1, _reviewDurSec = 0, _revSeeking = false;
async function setupReview(take) {
  state.pendingTake = take;            // the blob we SAVE (small m4a if a single take; WAV if stitched)
  _reviewDurSec = (take.durationMs || 0) / 1000;
  // A long single-take m4a leaks on iOS during playback, so finalize a clean copy JUST for preview.
  let previewBlob = take.blob;
  if ((take.durationMs || 0) > 60000 && !/wav/i.test(take.mimeType || take.blob.type || '')) {
    try { previewBlob = (await finalizeBlob(take.blob)).wav; } catch (_) {}
  }
  if (take.url) URL.revokeObjectURL(take.url);
  take.url = URL.createObjectURL(previewBlob);
  const a = els.reviewAudio;
  a.src = take.url; a.load();
  a.preservesPitch = true; a.webkitPreservesPitch = true;
  _reviewSpeed = 1; a.playbackRate = 1;
  els.recControls.classList.add('hidden');
  els.reviewControls.classList.remove('hidden');
  document.getElementById('rev-play').textContent = 'Play';
  document.getElementById('rev-speed').textContent = '1×';
  document.getElementById('rev-cur').textContent = '0:00';
  document.getElementById('rev-dur').textContent = fmtClock(_reviewDurSec);
  document.getElementById('rev-seek').value = 0;
  els.timer.textContent = fmtClock(_reviewDurSec);
}
function reviewDur() { const d = els.reviewAudio.duration; return (isFinite(d) && d > 0) ? d : _reviewDurSec; }

async function buildAndSaveMemo(take) {
  const rc = state.replyContext;
  const ds = new Date().toLocaleDateString([], { month: 'short', day: 'numeric' });
  const memo = {
    id: crypto.randomUUID(), createdAt: Date.now(), durationMs: Math.round(take.durationMs),
    blob: take.blob, bytes: take.blob.size, mimeType: take.mimeType, sender: 'me', senderId: me()?.id ?? null,
    title: rc ? `Reply · ${ds}` : `Memo · ${ds}`,
    listened: true, positionMs: 0, transcript: null, bookmarks: [],
    replyToId: rc?.id || null, replyToMs: rc?.ms ?? null,
  };
  await saveMemo(memo);
  state.memos.push(memo);          // newest goes to the BOTTOM (chat order)
  closeOverlay();
  scrollLibBottom();
  renderLibrary();
  toast(mode() === 'cloud' ? 'Saved & sent' : 'Saved locally — sync connects next');
}

els.recordBtn.addEventListener('click', startRecording);

els.recPause.addEventListener('click', async () => {
  if (recorder.state === 'recording') { recorder.pause(); els.recPause.textContent = 'Resume'; drawWave(); return; }
  if (recorder.state !== 'paused') return;
  driveWatch.silenceStart = 0;
  els.recPause.textContent = 'Pause';
  if (recorder.tracksLive()) {
    recorder.resume(); drawWave();   // normal pause → resume
  } else {
    // The mic was taken while paused (you answered a phone call). MediaRecorder.resume() would silently
    // do nothing here, which is the exact "hit resume and it didn't record" bug. Bank what we have and
    // start a FRESH segment that appends to the same memo — seamless from your side.
    try {
      await recorder.stop();    // finalizes + banks the paused segment into _takes
      await beginSegment();     // re-acquires the mic and records segment 2
    } catch (err) { toast(micError(err)); finishRecording(false); }
  }
});

els.recCancel.addEventListener('click', async () => {
  stopTimer(); if (waveRAF) cancelAnimationFrame(waveRAF);
  try { await recorder.stop(); } catch (_) {}
  recorder.clearTakes();   // throw away every banked segment
  closeOverlay();
});

els.recStop.addEventListener('click', () => finishRecording(false));

document.getElementById('rev-play')?.addEventListener('click', () => {
  const a = els.reviewAudio;
  if (a.paused) { a.play().catch(() => {}); document.getElementById('rev-play').textContent = 'Pause'; }
  else { a.pause(); document.getElementById('rev-play').textContent = 'Play'; }
});
document.getElementById('rev-back')?.addEventListener('click', () => { els.reviewAudio.currentTime = Math.max(0, els.reviewAudio.currentTime - 15); });
document.getElementById('rev-fwd')?.addEventListener('click', () => { els.reviewAudio.currentTime = Math.min(reviewDur(), els.reviewAudio.currentTime + 30); });
document.getElementById('rev-speed')?.addEventListener('click', () => {
  const i = SPEEDS.indexOf(_reviewSpeed); _reviewSpeed = SPEEDS[(i + 1) % SPEEDS.length];
  const a = els.reviewAudio; a.playbackRate = _reviewSpeed; a.preservesPitch = true; a.webkitPreservesPitch = true;
  document.getElementById('rev-speed').textContent = `${fmtSpeed(_reviewSpeed)}×`;
});
const _revSeek = document.getElementById('rev-seek');
_revSeek?.addEventListener('input', () => { _revSeeking = true; document.getElementById('rev-cur').textContent = fmtClock((_revSeek.value / 1000) * reviewDur()); });
_revSeek?.addEventListener('change', () => { els.reviewAudio.currentTime = (_revSeek.value / 1000) * reviewDur(); _revSeeking = false; });
els.reviewAudio.addEventListener('timeupdate', () => {
  const d = reviewDur(), cur = els.reviewAudio.currentTime;
  const c = document.getElementById('rev-cur'); if (c) c.textContent = fmtClock(cur);
  if (!_revSeeking && d > 0 && _revSeek) _revSeek.value = Math.round((cur / d) * 1000);
});
els.reviewAudio.addEventListener('ended', () => { const p = document.getElementById('rev-play'); if (p) p.textContent = 'Play'; });

// Continue: go back to recording and append a NEW segment to the same take (also how a phone-call
// interruption is recovered — it drops you here, then you Continue).
document.getElementById('rev-continue')?.addEventListener('click', async () => {
  els.reviewAudio.pause();
  if (state.pendingTake?.url) { URL.revokeObjectURL(state.pendingTake.url); state.pendingTake.url = null; }
  state.pendingTake = null;   // the banked segments live in the recorder; we'll re-combine on the next stop
  els.reviewControls.classList.add('hidden');
  els.recControls.classList.remove('hidden');
  els.recPause.textContent = 'Pause';
  try {
    await beginSegment();   // appends a new segment to the banked _takes
  } catch (err) { toast(micError(err)); finishRecording(false); }
});

function discardTake() {
  els.reviewAudio.pause(); els.reviewAudio.removeAttribute('src');
  if (state.pendingTake?.url) URL.revokeObjectURL(state.pendingTake.url);
  state.pendingTake = null;
  recorder.clearTakes();   // drop every banked segment
}

els.reviewDiscard.addEventListener('click', () => { discardTake(); closeOverlay(); });

els.reviewSave.addEventListener('click', async () => {
  const t = state.pendingTake;
  if (!t) return;
  const take = { durationMs: t.durationMs, blob: t.blob, mimeType: t.mimeType };
  discardTake();                 // revokes the preview URL + clears segments; the blob stays valid
  await buildAndSaveMemo(take);  // reads replyContext, then closeOverlay clears it
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

let _bannerCloud = false;
// Live connection/sync indicator — a colored dot + label so you can tell at a glance whether the app
// is actually talking to the backend (and whether audio is still downloading).
function renderSyncBanner() {
  if (!authEls.banner) return;
  const { state, downloading } = syncStatus();
  let cls = 'ok', label = `Synced with ${escapeHtml(otherName())}`;
  if (downloading > 0) { cls = 'busy'; label = `Downloading audio…`; }
  else if (state === 'syncing') { cls = 'busy'; label = 'Syncing…'; }
  else if (state === 'offline') { cls = 'off'; label = 'Offline · changes sync when you reconnect'; }
  else if (state === 'error') { cls = 'err'; label = 'Connection issue · retrying…'; }
  authEls.banner.innerHTML = `<span class="sync-dot ${cls}"></span>${label}`;
}
function setBanner(kind) {
  if (!authEls.banner) return;
  _bannerCloud = kind === 'cloud';
  if (kind === 'cloud') {
    renderSyncBanner();
  } else if (kind === 'notmember') {
    authEls.banner.innerHTML = `${ICONS.warn} Not on the allowlist yet · <a href="SETUP.md" target="_blank" rel="noopener">finish setup →</a> · <button id="signout-btn" class="link-btn">Sign out</button>`;
    authEls.banner.querySelector('#signout-btn')?.addEventListener('click', doSignOut);
  } else if (kind === 'unconfigured') {
    authEls.banner.innerHTML = `Local only · <a href="SETUP.md" target="_blank" rel="noopener">connect sync →</a>`;
  } else {
    authEls.banner.textContent = '';
  }
}
// Keep the cloud banner's dot/label in sync with live connection + download activity.
onSyncChange(() => { if (_bannerCloud) renderSyncBanner(); });

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
  const sl = document.getElementById('status-line'); if (sl) sl.textContent = `Private audio memos · ${APP_VERSION}`;
  applyAccents();   // paint each person's chosen bubble color (default: you teal, them red)
  // Global safety net: a stray rejection/error (a bad decode, a half-synced memo) should never take
  // the whole app down — log it and keep going instead of leaving the UI wedged.
  window.addEventListener('unhandledrejection', (e) => { console.warn('unhandled rejection', e?.reason); });
  window.addEventListener('error', (e) => { console.warn('error', e?.error || e?.message); });
  // Ask iOS to keep our storage so the on-device transcription model isn't evicted (re-downloaded) each session.
  try { navigator.storage?.persist?.(); } catch (_) {}
  // Establish the ONE shared audio context up front so the iOS audio-session category is set before
  // any record/playback, and resume it on the first tap (iOS starts it suspended).
  try { getSharedCtx(); } catch (_) {}
  document.addEventListener('pointerdown', () => { resumeSharedCtx(); }, { passive: true });
  player.setRate(state.speed);
  player.skipSilence = state.skipSilence;
  wirePlayer();
  document.addEventListener('visibilitychange', () => { if (document.hidden) persistPosition(); });
  // Merge by id on every resync so already-loaded memos keep their in-memory audio blob — wholesale
  // replacement was dropping the blob and wedging playback of older memos ("old messages stop working").
  onMemosChanged(async () => {
    const prevCount = state.memos.length;
    const prev = new Map(state.memos.map((m) => [m.id, m]));
    const fresh = await getAllMemos();
    if (fresh.length > prevCount) scrollLibBottom();   // a new memo arrived → jump to it (chat style)
    // Carry the in-memory audio blob forward for the memo in the player AND the currently-selected one
    // (so a resync mid-open can't strand it). Everything else drops its RAM blob and re-hydrates from
    // IndexedDB on tap, so a long session can't pile up audio bytes and OOM-crash the tab.
    const keepBlob = new Set([player.currentId, state.selectedId].filter(Boolean));
    state.memos = fresh.map((n) => (n.blob ? n : { ...n, blob: (keepBlob.has(n.id) ? prev.get(n.id)?.blob : null) || null }));
    // A resync can briefly read a memo's row before an in-flight position write commits; keep the
    // actively-playing memo's resume point honest from the live player so it never jumps backward.
    if (player.currentId) {
      const cur = state.memos.find((m) => m.id === player.currentId);
      const t = player.audio && player.audio.currentTime;
      if (cur && typeof t === 'number' && t > 0) cur.positionMs = Math.round(t * 1000);
    }
    renderLibrary();
  });
  scrollLibBottom();   // open at the newest memo (bottom)
  await boot();
}

// Dev seed — used to verify library + player without a live mic. Disabled in cloud mode so a fake
// memo can never be pushed to the server (and mis-attributed) in production.
window.__earshotSeed = async function (seconds = 5, sender = 'cousin') {
  if (mode() === 'cloud') { console.warn('__earshotSeed is disabled in cloud mode'); return; }
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
    title: sender === 'cousin' ? 'Demo received (test tone)' : 'Demo memo (test tone)',
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
