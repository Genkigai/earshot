// app.js — Earshot. Record → library → play, with optional Supabase sync (see config.js / SETUP.md).
import { getAllMemos, saveMemo, updateMemo, initStore, onMemosChanged, getAudioBlob, mode, otherName, membershipOk } from './store.js';
import { saveMemo as cacheMemoLocal } from './db.js';
import * as auth from './auth.js';
import { isConfigured } from './supabase-client.js';
import { Recorder } from './recorder.js';
import { Player } from './player.js';
import { analyze } from './analysis.js';
import { EFFECTS, MUSIC, SFX, sfxBuffer, sfxToBlob, remix } from './studio.js';
import { getSharedCtx, resumeSharedCtx } from './audio-context.js';

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
  text: '<svg class="ico-c" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  fx: '<svg class="ico-c" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5z"/><path d="M5 14l.9 2.1L8 17l-2.1.9L5 20l-.9-2.1L2 17l2.1-.9z"/></svg>',
  reply: '<svg class="ico-c" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 17l-5-5 5-5"/><path d="M4 12h10a6 6 0 0 1 6 6v1"/></svg>',
  unread: '<svg class="ico-c" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
};

// Reactions (synced via migration-v2; local-only without it). Each its own colour for a bit of fun.
const REACTIONS = [
  { id: 'love', color: '#ff5d5d', svg: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 20.5C6 16.5 3 13 3 9.5 3 7 4.9 5.2 7.2 5.2c1.5 0 2.8.8 3.6 2 .8-1.2 2.1-2 3.6-2C19.1 5.2 21 7 21 9.5c0 3.5-3 7-9 11z"/></svg>' },
  { id: 'haha', color: '#f5b14c', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 13c0 2.2 1.8 3.6 4 3.6s4-1.4 4-3.6z" fill="currentColor" stroke="none"/><path d="M8.5 9.3l1.6 1M15.5 9.3l-1.6 1"/></svg>' },
  { id: 'fire', color: '#ff8a3d', svg: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2c.6 3.2 3.6 4.4 3.6 7.9 0 1.2-.5 2.2-1.3 2.9.2-1 .1-2.2-.8-3.2.1 2.4-1.3 3.1-2.2 4.2-.8 1-.6 2.4-.6 2.4s-2.1-.9-2.1-3.5c0-1.5.8-2.4 1.5-3.3-2 .3-2.7 1.9-2.7 3.5 0 .9.3 1.8.8 2.5A5 5 0 0 1 7 12c0-4 4-4.9 5-10z"/></svg>' },
  { id: 'like', color: '#2dd4bf', svg: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2 10h4v11H2zM8 21V10l4-7c1.1 0 2 .9 2 2l-.6 4H19a2 2 0 0 1 2 2.4l-1.3 6A2 2 0 0 1 17.7 21z"/></svg>' },
];
function reactBadge(id, mine) {
  const r = REACTIONS.find((x) => x.id === id); if (!r) return '';
  return `<span class="react-badge${mine ? ' mine' : ''}" style="color:${r.color}" title="${mine ? 'You reacted' : otherName() + ' reacted'}">${r.svg}</span>`;
}
function reactionBadges(m) {
  const items = [];
  if (m.theirReaction) items.push(reactBadge(m.theirReaction, false));
  if (m.myReaction) items.push(reactBadge(m.myReaction, true));
  return items.length ? `<span class="memo-reacts">${items.join('')}</span>` : '';
}
function replyLine(m) {
  const orig = state.memos.find((x) => x.id === m.replyToId);
  const t = (m.replyToMs || 0) / 1000;
  const title = orig ? orig.title : 'a memo';
  return `<button class="reply-line" data-act="gotoreply" data-rid="${m.replyToId}" data-rt="${m.replyToMs || 0}">${ICONS.reply}Re: ${escapeHtml(title)} · ${fmtClock(t)}</button>`;
}

const SFX_ICONS = {
  airhorn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10v4l5 1.5 6 3V5.5l-6 3z"/><path d="M17.5 8.5a5 5 0 0 1 0 7"/></svg>',
  rimshot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="9" rx="8" ry="3"/><path d="M4 9v6c0 1.7 3.6 3 8 3s8-1.3 8-3V9"/><path d="M9 4l2.5 4.5M18 3l-3.5 5.5"/></svg>',
  applause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v3M6 4l1.5 2.5M18 4l-1.5 2.5"/><path d="M7 21c-1.2-3.5-.8-7 1.5-9s5.5-.5 5.5 2.5"/><path d="M10 21c-.8-2.5-.5-5 1-6.5"/></svg>',
  ding: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16a6 6 0 0 1 12 0z"/><path d="M12 4v2M10 19a2 2 0 0 0 4 0"/></svg>',
  boo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 15.5s1.4-2 3.5-2 3.5 2 3.5 2M9 9.5h.01M15 9.5h.01"/></svg>',
  tada: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l4.5-11.5L15 15z"/><path d="M14 6l1.5-2.5M18 8.5l2.5-1M17.5 12.5l2.5 1M16 4l.01.01"/></svg>',
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
  const mine = m.sender === 'me';
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
          <span class="memo-sub">${fmtDuration(m.durationMs)} · ${fmtDate(m.createdAt)} ${tx}</span>
          ${reactionBadges(m)}
        </span>
      </button>
      <button class="star-btn${m.starred ? ' on' : ''}" data-act="star" aria-label="${m.starred ? 'Unstar' : 'Star'}">${ICONS.star}</button>
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
      <button class="chip" data-act="effects" aria-label="Remix with effects">${ICONS.fx}Effects</button>
    </div>
    <div class="reactions">
      ${REACTIONS.map((r) => `<button class="rbtn${m.myReaction === r.id ? ' on' : ''}" data-react="${r.id}" style="color:${r.color}" aria-label="React ${r.id}">${r.svg}</button>`).join('')}
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
  const unreadN = state.memos.filter((m) => !m.listened && m.sender !== 'me').length;
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
  els.library.innerHTML = html;
}

function visibleMemos() {
  const q = state.query.trim().toLowerCase();
  return state.memos.filter((m) => {
    if (state.filter === 'unlistened' && (m.listened || m.sender === 'me')) return false;
    if (state.filter === 'starred' && !m.starred) return false;
    if (q) {
      const hay = `${m.title || ''} ${m.transcript || ''} ${m.sender === 'me' ? 'you' : 'them'}`.toLowerCase();
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
    catch (_) { toast('Could not load this memo — check your connection.'); return; }
  }
  if (!blob) { toast('Audio not available yet.'); return; }
  player.load({ ...m, blob }, seekTo);
  player.skipSilence = state.skipSilence;
  drawPlayerWave();
  setupMediaSession(m);
  analyze(m.id, blob).then((res) => {
    if (state.selectedId !== id) return;
    currentAnalysis = res;
    player.setSilences(res.silences);
    drawPlayerWave();
  });
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
    if (m.sender !== 'me') memoEl.classList.add('heard');
    memoEl.querySelector('.dot')?.remove();
  }
  updateUnreadPill();
  await updateMemo(id, { listened: true });
}

function updateUnreadPill() {
  const note = els.library.querySelector('.lib-note');
  if (!note) return;
  const unreadN = state.memos.filter((x) => !x.listened && x.sender !== 'me').length;
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
  const dur = player.audio.duration || currentAnalysis?.duration || 0;
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
      artist: m.sender === 'me' ? 'You' : otherName(),
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
    drawPlayerWave();
    const _txo = document.getElementById('transcript');
    if (_txo && !_txo.classList.contains('hidden')) highlightTranscript(a.currentTime);
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && isFinite(a.duration) && a.duration > 0) {
      try { navigator.mediaSession.setPositionState({ duration: a.duration, position: Math.min(a.currentTime, a.duration), playbackRate: a.playbackRate }); } catch (_) {}
    }
    if (state.selectedId && isFinite(a.duration) && a.duration > 0 && a.currentTime > a.duration - 1.2) markListened(state.selectedId);
  });
  a.addEventListener('play', () => { state.playing = true; updateGlyphs(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
  a.addEventListener('pause', () => { state.playing = false; updateGlyphs(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });
  a.addEventListener('ended', async () => {
    state.playing = false; updateGlyphs();
    const finishedId = state.selectedId;
    if (finishedId) { await markListened(finishedId); await updateMemo(finishedId, { positionMs: 0 }); const m = state.memos.find((x) => x.id === finishedId); if (m) m.positionMs = 0; }
    if (state.autoplay) { const next = nextUnlistened(finishedId); if (next) selectMemo(next.id); }
  });
}

els.library.addEventListener('click', async (e) => {
  const memoEl = e.target.closest('.memo');
  if (!memoEl) return;
  const id = memoEl.dataset.id;
  const reactEl = e.target.closest('[data-react]');
  if (reactEl) return void toggleReaction(id, reactEl.dataset.react);
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
  if (act === 'effects') return void openRemix();
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

async function toggleReaction(id, reaction) {
  const m = state.memos.find((x) => x.id === id);
  if (!m) return;
  m.myReaction = m.myReaction === reaction ? null : reaction;   // tap again to remove
  await updateMemo(id, { myReaction: m.myReaction });
  // update the player reaction row + the memo badges in place
  const memoEl = els.library.querySelector(`.memo[data-id="${id}"]`);
  memoEl?.querySelectorAll('.rbtn').forEach((b) => b.classList.toggle('on', b.dataset.react === m.myReaction));
  renderLibrary();
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
  await updateMemo(id, { starred: m.starred });
  const btn = els.library.querySelector(`.memo[data-id="${id}"] .star-btn`);
  if (btn) { btn.classList.toggle('on', m.starred); btn.setAttribute('aria-label', m.starred ? 'Unstar' : 'Star'); }
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
function openSettings() {
  if (!settingsEl) return;
  document.getElementById('set-skipsilence').checked = state.skipSilence;
  document.getElementById('set-autoplay').checked = state.autoplay;
  document.getElementById('set-drive').checked = state.driveMode;
  document.getElementById('set-autotranscribe').checked = localStorage.getItem('earshot.autoTranscribe') === '1';
  import('./push.js').then(async (p) => { const el = document.getElementById('set-push'); if (el) el.checked = await p.pushEnabled(); }).catch(() => {});
  renderSpeedSeg();
  renderQualitySeg();
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

// ---------- studio: soundboard + remix ----------
// Soundboard plays through the app-wide shared context (no per-tap context = no iOS route flip).
function playSfx(id) { try { const ctx = getSharedCtx(); resumeSharedCtx(); const src = ctx.createBufferSource(); src.buffer = sfxBuffer(id, ctx); src.connect(ctx.destination); src.start(); } catch (_) {} }

async function sendStudioMemo(blob, title) {
  let durMs = 0;
  try { const c = await resumeSharedCtx(); const b = await c.decodeAudioData((await blob.arrayBuffer()).slice(0)); durMs = Math.round(b.duration * 1000); } catch (_) {}
  const memo = { id: crypto.randomUUID(), createdAt: Date.now(), durationMs: durMs, blob, mimeType: 'audio/wav', sender: 'me', title, listened: true, positionMs: 0, transcript: null, bookmarks: [] };
  await saveMemo(memo);
  state.memos.unshift(memo);
  renderLibrary();
  toast(mode() === 'cloud' ? 'Sent' : 'Saved');
}

const soundboardEl = document.getElementById('soundboard');
let sbSelected = null;
function openSoundboard() {
  if (!soundboardEl) return;
  const grid = document.getElementById('pad-grid');
  grid.innerHTML = SFX.map((s) => `<button class="pad" data-sfx="${s.id}"><span class="pad-icon">${SFX_ICONS[s.id] || ''}</span>${s.name}</button>`).join('');
  grid.querySelectorAll('.pad').forEach((p) => p.addEventListener('click', () => {
    const id = p.dataset.sfx; playSfx(id); sbSelected = id;
    grid.querySelectorAll('.pad').forEach((x) => x.classList.toggle('on', x === p));
    const btn = document.getElementById('sb-send'); btn.disabled = false; btn.textContent = `Send “${SFX.find((s) => s.id === id).name}”`;
  }));
  const sendBtn = document.getElementById('sb-send'); sendBtn.disabled = true; sendBtn.textContent = 'Tap a sound to send it'; sbSelected = null;
  soundboardEl.classList.remove('hidden'); soundboardEl.setAttribute('aria-hidden', 'false');
}
function closeSoundboard() { soundboardEl?.classList.add('hidden'); soundboardEl?.setAttribute('aria-hidden', 'true'); }
document.getElementById('soundboard-btn')?.addEventListener('click', openSoundboard);
document.getElementById('sb-send')?.addEventListener('click', async () => {
  if (!sbSelected) return;
  const name = SFX.find((s) => s.id === sbSelected).name;
  await sendStudioMemo(sfxToBlob(sbSelected), `${name} (sound)`);
  closeSoundboard();
});
soundboardEl?.addEventListener('click', (e) => { if (e.target === soundboardEl) closeSoundboard(); });

const remixEl = document.getElementById('remix');
let fxState = { effect: 'none', music: 'none', introSfx: null };
function renderFxSelectors() {
  const eff = document.getElementById('fx-effects');
  eff.innerHTML = EFFECTS.map((e) => `<button class="pill${e.id === fxState.effect ? ' on' : ''}" data-fx-effect="${e.id}">${e.name}</button>`).join('');
  const mus = document.getElementById('fx-music');
  mus.innerHTML = MUSIC.map((m) => `<button class="pill${m.id === fxState.music ? ' on' : ''}" data-fx-music="${m.id}">${m.name}</button>`).join('');
  const sfx = document.getElementById('fx-sfx');
  sfx.innerHTML = `<button class="pill${fxState.introSfx === null ? ' on' : ''}" data-fx-sfx="none">None</button>` + SFX.map((s) => `<button class="pill${s.id === fxState.introSfx ? ' on' : ''}" data-fx-sfx="${s.id}">${s.name}</button>`).join('');
  remixEl.querySelectorAll('[data-fx-effect]').forEach((b) => b.onclick = () => { fxState.effect = b.dataset.fxEffect; renderFxSelectors(); });
  remixEl.querySelectorAll('[data-fx-music]').forEach((b) => b.onclick = () => { fxState.music = b.dataset.fxMusic; renderFxSelectors(); });
  remixEl.querySelectorAll('[data-fx-sfx]').forEach((b) => b.onclick = () => { fxState.introSfx = b.dataset.fxSfx === 'none' ? null : b.dataset.fxSfx; renderFxSelectors(); });
}
async function openRemix() {
  const m = state.memos.find((x) => x.id === state.selectedId);
  if (!m) { toast('Open a memo first'); return; }
  if (!m.blob) { try { m.blob = await getAudioBlob(m); } catch (_) {} }
  if (!m.blob) { toast('Audio not loaded yet'); return; }
  fxState = { effect: 'none', music: 'none', introSfx: null };
  renderFxSelectors();
  remixEl.classList.remove('hidden'); remixEl.setAttribute('aria-hidden', 'false');
}
function closeRemix() { remixEl?.classList.add('hidden'); remixEl?.setAttribute('aria-hidden', 'true'); const a = document.getElementById('fx-audio'); a?.pause(); if (_fxPreviewUrl) { try { URL.revokeObjectURL(_fxPreviewUrl); } catch (_) {} _fxPreviewUrl = null; } }
remixEl?.addEventListener('click', (e) => { if (e.target === remixEl) closeRemix(); });
let _fxPreviewUrl = null;
document.getElementById('fx-preview')?.addEventListener('click', async () => {
  const m = state.memos.find((x) => x.id === state.selectedId); if (!m?.blob) return;
  const btn = document.getElementById('fx-preview'); btn.disabled = true; btn.textContent = 'Rendering…';
  try {
    const blob = await remix(m.blob, fxState);
    const a = document.getElementById('fx-audio');
    if (_fxPreviewUrl) URL.revokeObjectURL(_fxPreviewUrl);   // don't leak the previous preview
    _fxPreviewUrl = URL.createObjectURL(blob);
    a.src = _fxPreviewUrl;
    await a.play();
  }
  catch (_) { toast('Preview failed'); }
  btn.disabled = false; btn.textContent = 'Preview';
});
document.getElementById('fx-send')?.addEventListener('click', async () => {
  const m = state.memos.find((x) => x.id === state.selectedId); if (!m?.blob) return;
  const btn = document.getElementById('fx-send'); btn.disabled = true; btn.textContent = 'Rendering…';
  try { const blob = await remix(m.blob, fxState); await sendStudioMemo(blob, `${m.title || 'Memo'} (remix)`); closeRemix(); }
  catch (_) { toast('Remix failed'); }
  btn.disabled = false; btn.textContent = 'Send remix';
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
enableSheetDismiss('soundboard', closeSoundboard);
enableSheetDismiss('remix', closeRemix);
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
  const durOf = () => player.audio.duration || currentAnalysis?.duration || 0;
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

async function startRecording() {
  if (!player.audio.paused) { player.pause(); }
  openOverlay();
  levels = [];
  const drive = state.driveMode;
  driveWatch.hasSpoken = false; driveWatch.silenceStart = 0; driveWatch.stopped = false;
  try {
    await recorder.start((rms) => {
      levels.push(rms); if (levels.length > 64) levels.shift();
      if (drive && !driveWatch.stopped && recorder.state === 'recording' && driveTick(rms, performance.now())) { driveWatch.stopped = true; finishRecording(true); }
    });
  } catch (err) {
    closeOverlay();
    toast(micError(err));
    return;
  }
  startTimer();
  drawWave();
}

let finishing = false;
async function finishRecording(autoSend) {
  if (finishing) return;   // de-dupe: auto-stop racing a manual Stop, or a double-tap
  finishing = true;
  try {
    stopTimer(); if (waveRAF) cancelAnimationFrame(waveRAF);
    let take;
    try { take = await recorder.stop(); } catch (_) { closeOverlay(); return; }
    if (!take.blob.size) { toast('Nothing recorded — try again.'); closeOverlay(); return; }
    if (autoSend) { await buildAndSaveMemo(take); return; }
    take.url = URL.createObjectURL(take.blob);
    state.pendingTake = take;
    els.reviewAudio.src = take.url;
    els.recControls.classList.add('hidden');
    els.reviewControls.classList.remove('hidden');
    els.reviewPlay.innerHTML = ICONS.play + 'Preview';
    els.timer.textContent = fmtClock(take.durationMs / 1000);
  } finally { finishing = false; }
}

async function buildAndSaveMemo(take) {
  const rc = state.replyContext;
  const ds = new Date().toLocaleDateString([], { month: 'short', day: 'numeric' });
  const memo = {
    id: crypto.randomUUID(), createdAt: Date.now(), durationMs: Math.round(take.durationMs),
    blob: take.blob, mimeType: take.mimeType, sender: 'me',
    title: rc ? `Reply · ${ds}` : `Memo · ${ds}`,
    listened: true, positionMs: 0, transcript: null, bookmarks: [],
    replyToId: rc?.id || null, replyToMs: rc?.ms ?? null,
  };
  await saveMemo(memo);
  state.memos.unshift(memo);
  closeOverlay();
  renderLibrary();
  toast(mode() === 'cloud' ? 'Saved & sent' : 'Saved locally — sync connects next');
}

els.recordBtn.addEventListener('click', startRecording);

els.recPause.addEventListener('click', () => {
  if (recorder.state === 'recording') { recorder.pause(); els.recPause.textContent = 'Resume'; }
  else if (recorder.state === 'paused') { recorder.resume(); driveWatch.silenceStart = 0; els.recPause.textContent = 'Pause'; drawWave(); }
});

els.recCancel.addEventListener('click', async () => {
  stopTimer(); if (waveRAF) cancelAnimationFrame(waveRAF);
  try { await recorder.stop(); } catch (_) {}
  closeOverlay();
});

els.recStop.addEventListener('click', () => finishRecording(false));

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
  const take = { durationMs: t.durationMs, blob: t.blob, mimeType: t.mimeType };
  discardTake();                 // revoke the preview URL; the blob stays valid
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

function setBanner(kind) {
  if (!authEls.banner) return;
  if (kind === 'cloud') {
    authEls.banner.textContent = `Synced with ${otherName()}`;   // sign-out moved to Settings (bigger tap target)
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
    const prev = new Map(state.memos.map((m) => [m.id, m]));
    const fresh = await getAllMemos();
    state.memos = fresh.map((n) => (n.blob ? n : { ...n, blob: prev.get(n.id)?.blob || null }));
    // A resync can briefly read a memo's row before an in-flight position write commits; keep the
    // actively-playing memo's resume point honest from the live player so it never jumps backward.
    if (player.currentId) {
      const cur = state.memos.find((m) => m.id === player.currentId);
      const t = player.audio && player.audio.currentTime;
      if (cur && typeof t === 'number' && t > 0) cur.positionMs = Math.round(t * 1000);
    }
    renderLibrary();
  });
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
