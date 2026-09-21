/**
 * Remembering where a local file lives.
 *
 * A browser never reveals the path of a file the user picked, and it cannot
 * re-open one on its own.  The File System Access API (Chrome/Edge) hands out
 * a `FileSystemFileHandle` instead, which *is* a durable link to that location:
 * storing it lets the recent list reopen the very same file later (asking for
 * permission once) without copying anything anywhere.
 *
 * Handles are structured-cloneable, so IndexedDB is the only place they can be
 * kept.  When the API is missing the helpers degrade to no-ops and the recent
 * list simply asks the user to pick the file again.
 */

const DB_NAME = 'whitesoft';
const STORE = 'file-handles';

export function handlesSupported() {
  return typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function';
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 不可用'));
  });
}

function tx(mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    try {
      result = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    t.oncomplete = () => { db.close(); resolve(result?.result ?? result); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error || new Error('IndexedDB 事务中止')); };
  }));
}

/** Store a handle under `id`; returns the id (or null when unsupported). */
export async function saveHandle(id, handle) {
  if (!handlesSupported() || !handle) return null;
  try {
    await tx('readwrite', (store) => store.put(handle, id));
    return id;
  } catch {
    return null;
  }
}

/** Fetch a stored handle (null when it is gone or the API is missing). */
export async function loadHandle(id) {
  if (!handlesSupported() || !id) return null;
  try {
    return (await tx('readonly', (store) => store.get(id))) || null;
  } catch {
    return null;
  }
}

/** Forget one handle. */
export async function forgetHandle(id) {
  if (!id) return;
  try { await tx('readwrite', (store) => store.delete(id)); } catch { /* ignore */ }
}

/** Forget every stored handle (used by 清空记录). */
export async function forgetAllHandles() {
  try { await tx('readwrite', (store) => store.clear()); } catch { /* ignore */ }
}

/**
 * Make sure we may read (and optionally write) a stored handle.
 * Permission prompts need a user gesture, which a click on the recent list is.
 */
export async function ensurePermission(handle, mode = 'read') {
  if (!handle?.queryPermission) return true;
  const opts = { mode };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}
