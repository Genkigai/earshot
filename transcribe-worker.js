// transcribe-worker.js — runs Whisper (tiny.en) entirely on-device via transformers.js in a Web
// Worker, so the UI never freezes. The model (~40 MB) downloads once on first use and is cached by
// the browser. No audio ever leaves the phone. Loaded lazily — this file isn't fetched until the
// user actually transcribes something.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';

env.allowLocalModels = false;          // fetch the model from the HF hub
env.backends.onnx.wasm.numThreads = 1; // safest across mobile Safari

let asr = null;

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type === 'ping') {
    self.postMessage({ type: 'pong', ok: typeof pipeline === 'function' });
    return;
  }
  if (msg.type === 'transcribe') {
    try {
      if (!asr) {
        self.postMessage({ type: 'status', id: msg.id, status: 'loading-model' });
        asr = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
          progress_callback: (p) => { if (p && p.status === 'progress') self.postMessage({ type: 'progress', id: msg.id, pct: Math.round(p.progress || 0) }); },
        });
      }
      self.postMessage({ type: 'status', id: msg.id, status: 'transcribing' });
      const out = await asr(msg.audio, { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 });
      self.postMessage({ type: 'result', id: msg.id, text: out.text || '', chunks: out.chunks || [] });
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, error: String((err && err.message) || err) });
    }
  }
};
