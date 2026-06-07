// db.js — promise wrapper around IndexedDB. Stores: `memos` (audio Blobs + metadata, also the
// local cache for synced memos) and `outbox` (uploads/actions queued while offline).
const DB_NAME = 'earshot';
const DB_VERSION = 2;
const STORE = 'memos';
const OUTBOX = 'outbox';

let _db = null;

function open() {
  if (_db) return _db;
  _db = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(OUTBOX)) {
        db.createObjectStore(OUTBOX, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _db;
}

function tx(storeName, mode) {
  return open().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

// ---- memos ----
export async function saveMemo(memo) {
  const s = await tx(STORE, 'readwrite');
  return new Promise((res, rej) => { const r = s.put(memo); r.onsuccess = () => res(memo); r.onerror = () => rej(r.error); });
}

export async function getAllMemos() {
  const s = await tx(STORE, 'readonly');
  return new Promise((res, rej) => { const r = s.getAll(); r.onsuccess = () => res((r.result || []).sort((a, b) => b.createdAt - a.createdAt)); r.onerror = () => rej(r.error); });
}

export async function getMemo(id) {
  const s = await tx(STORE, 'readonly');
  return new Promise((res, rej) => { const r = s.get(id); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

export async function updateMemo(id, patch) {
  // get + merge + put inside ONE transaction so overlapping updates (e.g. position vs listened)
  // are serialized by IndexedDB and neither drops the other's field.
  const s = await tx(STORE, 'readwrite');
  return new Promise((res, rej) => {
    const g = s.get(id);
    g.onsuccess = () => {
      const cur = g.result;
      if (!cur) return res(null);
      const next = { ...cur, ...patch };
      const p = s.put(next);
      p.onsuccess = () => res(next);
      p.onerror = () => rej(p.error);
    };
    g.onerror = () => rej(g.error);
  });
}

export async function deleteMemo(id) {
  const s = await tx(STORE, 'readwrite');
  return new Promise((res, rej) => { const r = s.delete(id); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
}

// Wipe the local memo cache (used when a DIFFERENT user signs in on the same device, so one
// person's read/unread/reaction state never leaks into the other's view).
export async function clearMemos() {
  const s = await tx(STORE, 'readwrite');
  return new Promise((res, rej) => { const r = s.clear(); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
}

// ---- outbox (offline queue) ----
export async function addOutbox(item) {
  const s = await tx(OUTBOX, 'readwrite');
  return new Promise((res, rej) => { const r = s.put(item); r.onsuccess = () => res(item); r.onerror = () => rej(r.error); });
}

export async function getAllOutbox() {
  const s = await tx(OUTBOX, 'readonly');
  return new Promise((res, rej) => { const r = s.getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); });
}

export async function removeOutbox(key) {
  const s = await tx(OUTBOX, 'readwrite');
  return new Promise((res, rej) => { const r = s.delete(key); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
}
