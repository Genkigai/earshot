// analysis.js — decode an audio Blob once into: waveform peaks (for the scrubber visual),
// silent regions (for skip-silence), and peak amplitude (for loudness normalization).
// Cached in memory per memo id. decodeAudioData handles m4a/aac (iPhone) and wav (dev) natively.
//
// Decodes on the app-wide shared context (audio-context.js), resumed first — a private context here
// used to get auto-suspended after an iOS route flip and silently return empty analysis, which is
// part of why older memos stopped scrubbing/playing.

import { resumeSharedCtx } from './audio-context.js';

const cache = new Map();

const EMPTY = (peakCount) => ({ peaks: new Float32Array(peakCount), duration: 0, silences: [], peakAmplitude: 0, ok: false });
const CACHE_CAP = 60;   // bound the cache so a long listening session can't grow it without limit

export async function analyze(id, blob, opts = {}) {
  const peakCount = opts.peakCount || 240;
  if (id && cache.has(id)) { const v = cache.get(id); cache.delete(id); cache.set(id, v); return v; }   // LRU touch
  if (!blob) return EMPTY(peakCount);

  let audioBuffer;
  try {
    const arr = await blob.arrayBuffer();
    const ctx = await resumeSharedCtx();
    try { audioBuffer = await ctx.decodeAudioData(arr.slice(0)); }
    catch (_) { await resumeSharedCtx(); audioBuffer = await ctx.decodeAudioData(arr.slice(0)); }   // resume + retry once
  } catch (e) {
    const empty = EMPTY(peakCount);
    if (id) cache.set(id, empty);
    return empty;
  }

  const data = audioBuffer.getChannelData(0);
  const duration = audioBuffer.duration;
  const sampleRate = audioBuffer.sampleRate;

  // --- waveform peaks (max-abs per block, normalized to 0..1) ---
  const block = Math.max(1, Math.floor(data.length / peakCount));
  const peaks = new Float32Array(peakCount);
  let gmax = 0;
  for (let i = 0; i < peakCount; i++) {
    let max = 0;
    const start = i * block;
    const end = Math.min(start + block, data.length);
    for (let j = start; j < end; j++) { const v = Math.abs(data[j]); if (v > max) max = v; }
    peaks[i] = max;
    if (max > gmax) gmax = max;
  }
  if (gmax > 0) for (let i = 0; i < peakCount; i++) peaks[i] = peaks[i] / gmax;

  // --- silent regions (RMS over ~30ms windows below threshold for >= minSilenceMs) ---
  const silenceDb = opts.silenceDb ?? -42;
  const minSilenceMs = opts.minSilenceMs ?? 450;
  const thresh = Math.pow(10, silenceDb / 20);
  const win = Math.max(1, Math.floor(sampleRate * 0.03));
  const silences = [];
  let silStart = -1;
  for (let i = 0; i < data.length; i += win) {
    let sum = 0, n = 0;
    const end = Math.min(i + win, data.length);
    for (let j = i; j < end; j++) { const v = data[j]; sum += v * v; n++; }
    const rms = Math.sqrt(sum / (n || 1));
    const t = i / sampleRate;
    if (rms < thresh) {
      if (silStart < 0) silStart = t;
    } else if (silStart >= 0) {
      if ((t - silStart) * 1000 >= minSilenceMs) silences.push({ start: silStart, end: t });
      silStart = -1;
    }
  }
  if (silStart >= 0 && (duration - silStart) * 1000 >= minSilenceMs) silences.push({ start: silStart, end: duration });

  const result = { peaks, duration, silences, peakAmplitude: gmax, ok: true };
  if (id) { cache.set(id, result); if (cache.size > CACHE_CAP) cache.delete(cache.keys().next().value); }
  return result;
}

export function clearAnalysis(id) { cache.delete(id); }
