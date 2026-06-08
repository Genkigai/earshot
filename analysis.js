// analysis.js — decode an audio Blob once into: waveform peaks (for the scrubber visual),
// silent regions (for skip-silence), and peak amplitude (for loudness normalization).
// Cached in memory per memo id. decodeAudioData handles m4a/aac (iPhone) and wav (dev) natively.
//
// MEMORY SAFETY (this used to crash iOS): we decode in a throwaway OfflineAudioContext at a LOW rate
// (8 kHz) — peaks/silence don't need 48 kHz, and it cuts the decoded buffer ~6×. And we NEVER decode a
// long/large memo at all (flat bars instead): a multi-minute file decoded at native rate was tens of
// MB of transient allocation per play, which pushed the WebKit tab over its memory ceiling and crashed.

const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
const DECODE_RATE = 8000;          // low-rate decode — plenty for peaks + silence detection
const MAX_ANALYZE_MS = 180000;     // > 3 min → skip the decode (flat bars) so iOS can't OOM
const MAX_ANALYZE_BYTES = 3000000; // belt-and-suspenders if durationMs is missing

const cache = new Map();

const EMPTY = (peakCount) => ({ peaks: new Float32Array(peakCount), duration: 0, silences: [], peakAmplitude: 0, ok: false });
const FLAT = (peakCount, durationMs) => ({ peaks: new Float32Array(peakCount).fill(0.4), duration: (durationMs || 0) / 1000, silences: [], peakAmplitude: 0, ok: false });
const CACHE_CAP = 60;   // bound the cache so a long listening session can't grow it without limit

export async function analyze(id, blob, opts = {}) {
  const peakCount = opts.peakCount || 240;
  if (id && cache.has(id)) { const v = cache.get(id); cache.delete(id); cache.set(id, v); return v; }   // LRU touch
  if (!blob) return EMPTY(peakCount);

  // OOM guard: a long/large memo is never fully decoded — show flat bars and skip silence-detection.
  if ((opts.durationMs && opts.durationMs > MAX_ANALYZE_MS) || (blob.size && blob.size > MAX_ANALYZE_BYTES)) {
    const flat = FLAT(peakCount, opts.durationMs);
    if (id) { cache.set(id, flat); if (cache.size > CACHE_CAP) cache.delete(cache.keys().next().value); }
    return flat;
  }

  let audioBuffer;
  try {
    const arr = await blob.arrayBuffer();
    // Decode in a throwaway low-rate OfflineAudioContext (does NOT touch the hardware audio route).
    const dctx = new OAC(1, 1, DECODE_RATE);
    try { audioBuffer = await dctx.decodeAudioData(arr.slice(0)); }
    catch (_) { audioBuffer = await dctx.decodeAudioData(arr.slice(0)); }   // retry once
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
