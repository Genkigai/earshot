// transcription.js — main-thread side of on-device transcription. Decodes + resamples audio to
// 16 kHz mono (what Whisper wants) and hands it to the worker. Fully optional and lazy: the worker
// (and the ~40 MB model) only load when the user actually transcribes.

let _worker = null;
let _seq = 0;

function getWorker() {
  if (_worker) return _worker;
  _worker = new Worker(new URL('./transcribe-worker.js', import.meta.url), { type: 'module' });
  return _worker;
}

// Quick check the worker + transformers.js can load at all (no model download).
export async function transcriptionAvailable() {
  try {
    const w = getWorker();
    return await new Promise((resolve) => {
      const t = setTimeout(() => { w.removeEventListener('message', h); resolve(false); }, 10000);
      const h = (e) => { if (e.data && e.data.type === 'pong') { clearTimeout(t); w.removeEventListener('message', h); resolve(!!e.data.ok); } };
      w.addEventListener('message', h);
      w.postMessage({ type: 'ping' });
    });
  } catch (_) { return false; }
}

async function decodeTo16kMono(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const tmp = new AC();
  try { await tmp.resume(); } catch (_) {}
  const arrbuf = await blob.arrayBuffer();
  let decoded;
  try { decoded = await tmp.decodeAudioData(arrbuf.slice(0)); }
  catch (_) { decoded = await tmp.decodeAudioData(arrbuf.slice(0)); }   // retry once
  tmp.close && tmp.close();
  if (decoded.duration > 600) throw new Error('Memo too long to transcribe');
  const targetRate = 16000;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const frames = Math.max(1, Math.ceil(decoded.duration * targetRate));
  const off = new OAC(1, frames, targetRate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

// Transcribe a blob. onStatus(status|{progress}) is called with 'loading-model' | 'transcribing'
// and progress percentages. Resolves { text, chunks:[{text, timestamp:[start,end]}] }.
export async function transcribe(blob, onStatus) {
  const audio = await decodeTo16kMono(blob);
  const w = getWorker();
  const id = ++_seq;
  return new Promise((resolve, reject) => {
    let timer;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => { w.removeEventListener('message', h); reject(new Error('transcription timed out')); }, 120000); };
    const h = (e) => {
      const d = e.data || {};
      if (d.id !== id) return;
      if (d.type === 'status') { arm(); onStatus && onStatus(d.status); }
      else if (d.type === 'progress') { arm(); onStatus && onStatus('download', d.pct); }
      else if (d.type === 'result') { clearTimeout(timer); w.removeEventListener('message', h); resolve({ text: (d.text || '').trim(), chunks: d.chunks || [] }); }
      else if (d.type === 'error') { clearTimeout(timer); w.removeEventListener('message', h); reject(new Error(d.error)); }
    };
    w.addEventListener('message', h);
    arm();
    w.postMessage({ type: 'transcribe', id, audio }, [audio.buffer]);
  });
}
