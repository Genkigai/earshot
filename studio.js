// studio.js — the fun engine: voice effects, synthesized sound effects, and music beds.
// Everything is generated in-code (no external audio files, no copyright issues) and rendered
// offline via OfflineAudioContext, so results are deterministic and testable.

import { resumeSharedCtx, getSharedCtx } from './audio-context.js';

const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
const STUDIO_SR = 22050;   // render remixes at voice-grade rate so output stays small (~2.6 MB/min, not ~5.5)

async function toRate(buffer, rate) {
  if (buffer.sampleRate === rate) return buffer;
  const len = Math.max(1, Math.ceil((buffer.length * rate) / buffer.sampleRate));
  const off = new OAC(1, len, rate);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  return off.startRendering();
}

// ---------- WAV encoding (mono, 16-bit) ----------
export function encodeWavBuffer(audioBuffer) {
  const data = audioBuffer.getChannelData(0);
  const sr = audioBuffer.sampleRate;
  const n = data.length;
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, data[i])); v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true); off += 2; }
  return new Blob([v], { type: 'audio/wav' });
}

async function blobToBuffer(blob) {
  // Decode on the shared context (never closed) — a throwaway context per remix used to flip the
  // iOS audio route and could come back suspended.
  const ctx = await resumeSharedCtx();
  const arr = await blob.arrayBuffer();
  let b;
  try { b = await ctx.decodeAudioData(arr.slice(0)); }
  catch (_) { await resumeSharedCtx(); b = await ctx.decodeAudioData(arr.slice(0)); }   // resume + retry once
  return b;
}

// ---------- voice effects ----------
export const EFFECTS = [
  { id: 'none', name: 'Normal' },
  { id: 'warm', name: 'Warm' },
  { id: 'radio', name: 'Radio' },
  { id: 'phone', name: 'Telephone' },
  { id: 'hall', name: 'Hall' },
  { id: 'deep', name: 'Deep' },
  { id: 'chipmunk', name: 'Chipmunk' },
];

function makeImpulse(ctx, seconds, decay) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const imp = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = imp.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  return imp;
}

function makeDistortionCurve(amount) {
  const n = 1024, curve = new Float32Array(n), k = amount;
  for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; curve[i] = ((3 + k) * x * 20 * Math.PI / 180) / (Math.PI + k * Math.abs(x)); }
  return curve;
}

// Render a decoded voice buffer through an effect. Returns a new AudioBuffer.
export async function renderEffect(voiceBuffer, effectId) {
  const sr = voiceBuffer.sampleRate;
  const rate = effectId === 'deep' ? 0.82 : effectId === 'chipmunk' ? 1.55 : 1;
  const tail = effectId === 'hall' ? 1.6 : 0.05;
  const outLen = Math.ceil(voiceBuffer.length / rate) + Math.floor(sr * tail);
  const ctx = new OAC(1, Math.max(1, outLen), sr);

  const src = ctx.createBufferSource();
  src.buffer = voiceBuffer;
  src.playbackRate.value = rate;
  let node = src;

  const chain = (n) => { node.connect(n); node = n; };

  if (effectId === 'warm') {
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7500;
    const lo = ctx.createBiquadFilter(); lo.type = 'lowshelf'; lo.frequency.value = 200; lo.gain.value = 4;
    chain(lo); chain(lp);
  } else if (effectId === 'radio') {
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 500;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
    const ws = ctx.createWaveShaper(); ws.curve = makeDistortionCurve(8);
    chain(hp); chain(lp); chain(ws);
  } else if (effectId === 'phone') {
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1700; bp.Q.value = 0.7;
    const bp2 = ctx.createBiquadFilter(); bp2.type = 'bandpass'; bp2.frequency.value = 1700; bp2.Q.value = 0.9;
    chain(bp); chain(bp2);
  } else if (effectId === 'hall') {
    const conv = ctx.createConvolver(); conv.buffer = makeImpulse(ctx, 1.6, 2.5);
    const dry = ctx.createGain(); dry.gain.value = 0.75;
    const wet = ctx.createGain(); wet.gain.value = 0.5;
    node.connect(dry); node.connect(conv); conv.connect(wet);
    const merge = ctx.createGain(); dry.connect(merge); wet.connect(merge); node = merge;
  }

  const out = ctx.createGain(); out.gain.value = effectId === 'radio' ? 0.85 : 1;
  chain(out);
  node.connect(ctx.destination);
  src.start(0);
  return ctx.startRendering();
}

// ---------- synthesized sound effects ----------
export const SFX = [
  { id: 'airhorn', name: 'Airhorn', emoji: '📢' },
  { id: 'rimshot', name: 'Rimshot', emoji: '🥁' },
  { id: 'applause', name: 'Applause', emoji: '👏' },
  { id: 'ding', name: 'Ding', emoji: '🔔' },
  { id: 'boo', name: 'Boo', emoji: '👎' },
  { id: 'tada', name: 'Ta-da', emoji: '🎉' },
];

// Build an SFX into a Float32Array at the given sample rate.
function synthSFX(id, sr) {
  const sec = id === 'applause' ? 2.2 : id === 'airhorn' ? 0.9 : id === 'tada' ? 1.4 : id === 'boo' ? 1.0 : 0.5;
  const n = Math.floor(sr * sec), d = new Float32Array(n);
  const env = (i, a, r) => { const t = i / n; const atk = Math.min(1, t / a); const rel = Math.min(1, (1 - t) / r); return Math.max(0, Math.min(atk, rel)); };
  if (id === 'airhorn') {
    for (let i = 0; i < n; i++) { const t = i / sr; const f = 300 + 8 * Math.sin(2 * Math.PI * 6 * t); let s = 0; for (const k of [1, 2, 3]) s += Math.sin(2 * Math.PI * f * k * t) / k; d[i] = s * 0.3 * env(i, 0.02, 0.15); }
  } else if (id === 'rimshot') {
    for (let i = 0; i < n; i++) { const t = i / sr; const click = Math.sin(2 * Math.PI * 320 * t) * Math.exp(-t * 30); const noise = (Math.random() * 2 - 1) * Math.exp(-t * 22); d[i] = (click * 0.7 + noise * 0.5) * (t < 0.25 ? 1 : 0); }
  } else if (id === 'applause') {
    for (let i = 0; i < n; i++) { const t = i / sr; const claps = (Math.random() * 2 - 1) * (0.5 + 0.5 * Math.random()); d[i] = claps * 0.35 * env(i, 0.15, 0.4); }
  } else if (id === 'ding') {
    for (let i = 0; i < n; i++) { const t = i / sr; d[i] = (Math.sin(2 * Math.PI * 1180 * t) + 0.5 * Math.sin(2 * Math.PI * 2360 * t)) * 0.4 * Math.exp(-t * 6); }
  } else if (id === 'boo') {
    for (let i = 0; i < n; i++) { const t = i / sr; const tone = Math.sin(2 * Math.PI * (160 - 40 * t) * t); const crowd = (Math.random() * 2 - 1) * 0.3; d[i] = (tone * 0.5 + crowd) * 0.4 * env(i, 0.05, 0.3); }
  } else if (id === 'tada') {
    const notes = [523, 659, 784, 1047];
    for (let i = 0; i < n; i++) { const t = i / sr; let s = 0; const stepDur = 0.09; const idx = Math.min(notes.length - 1, Math.floor(t / stepDur)); const chordT = t - notes.length * stepDur; if (t < notes.length * stepDur) s = Math.sin(2 * Math.PI * notes[idx] * t); else { for (const f of notes) s += Math.sin(2 * Math.PI * f * t) / notes.length; } d[i] = s * 0.35 * env(i, 0.01, 0.45); }
  }
  return d;
}

export function sfxBuffer(id, ctx) {
  // Build the AudioBuffer on the shared context so soundboard playback never spins up its own.
  const c = ctx || getSharedCtx();
  const sr = c.sampleRate;
  const data = synthSFX(id, sr);
  const buf = c.createBuffer(1, data.length, sr);
  buf.copyToChannel(data, 0);
  return buf;
}

// Render an SFX to a standalone WAV blob (to send as a memo).
export function sfxToBlob(id) {
  const sr = 24000;
  const data = synthSFX(id, sr);
  const fake = { getChannelData: () => data, sampleRate: sr, length: data.length };
  return encodeWavBuffer(fake);
}

// ---------- music beds (simple synthesized loops, ducked under voice) ----------
export const MUSIC = [
  { id: 'none', name: 'No music' },
  { id: 'chill', name: 'Chill pad' },
  { id: 'lofi', name: 'Lo-fi' },
  { id: 'upbeat', name: 'Upbeat' },
];

function musicBed(id, sr, seconds) {
  const n = Math.floor(sr * seconds), d = new Float32Array(n);
  if (id === 'none') return d;
  const chords = id === 'upbeat' ? [[262, 330, 392], [294, 370, 440], [349, 440, 523], [392, 494, 587]]
    : [[220, 277, 330], [196, 247, 294], [262, 330, 392], [174, 220, 262]];
  const barDur = id === 'upbeat' ? 1.0 : 2.0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const ch = chords[Math.floor(t / barDur) % chords.length];
    let s = 0;
    for (const f of ch) s += Math.sin(2 * Math.PI * f * t);
    s /= ch.length;
    if (id === 'lofi') s += (Math.random() * 2 - 1) * 0.04; // vinyl hiss
    if (id === 'upbeat') s += Math.sin(2 * Math.PI * 2 * t) > 0.9 ? 0.15 * (Math.random() * 2 - 1) : 0; // light hat
    d[i] = s * 0.18;
  }
  return d;
}

// ---------- high-level remix: voice + effect + music + intro/outro sfx -> WAV blob ----------
export async function remix(blob, { effect = 'none', music = 'none', introSfx = null, outroSfx = null } = {}) {
  const voiceRaw = await blobToBuffer(blob);
  if (voiceRaw.duration > 600) throw new Error('Memo too long to remix');
  const voice = await toRate(voiceRaw, STUDIO_SR);   // keep the rendered file small (data-friendly)
  let processed = effect && effect !== 'none' ? await renderEffect(voice, effect) : voice;
  const sr = processed.sampleRate;

  const introData = introSfx ? synthSFX(introSfx, sr) : new Float32Array(0);
  const outroData = outroSfx ? synthSFX(outroSfx, sr) : new Float32Array(0);
  const voiceData = processed.getChannelData(0);
  const total = introData.length + voiceData.length + outroData.length;
  const musicData = music && music !== 'none' ? musicBed(music, sr, total / sr) : null;

  const out = new Float32Array(total);
  // intro sfx
  out.set(introData, 0);
  // voice
  for (let i = 0; i < voiceData.length; i++) out[introData.length + i] += voiceData[i];
  // outro sfx
  for (let i = 0; i < outroData.length; i++) out[introData.length + voiceData.length + i] += outroData[i];
  // music bed, ducked under voice region
  if (musicData) {
    const vStart = introData.length, vEnd = introData.length + voiceData.length;
    for (let i = 0; i < total; i++) {
      const inVoice = i >= vStart && i < vEnd;
      out[i] += (musicData[i] || 0) * (inVoice ? 0.28 : 0.7); // duck under speech, swell in gaps
    }
  }
  // soft limit
  for (let i = 0; i < total; i++) { const x = out[i]; out[i] = Math.tanh(x * 0.9); }

  const fake = { getChannelData: () => out, sampleRate: sr, length: total };
  return encodeWavBuffer(fake);
}
