/**
 * Image resource store.
 *
 * Handles three sources of image bytes:
 *   - entries inside an opened `.note` archive (served by the app server)
 *   - files the user pastes / inserts during the session (kept in memory)
 *   - newly written files destined to be saved into a `.note`
 */
import { uuid } from './util.js';

const MAX_ENTRIES = 160;

export class ResourceStore {
  constructor() {
    /** @type {Map<string, HTMLImageElement>} */
    this.images = new Map();
    /** @type {Map<string, {blob: Blob, url: string}>} */
    this.local = new Map();
    /** @type {Map<string, string>} fileName -> object URL for the session */
    this.urls = new Map();
    this.notePath = null;
    this.pending = new Map();
    this.onLoad = null;
  }

  setNote(path) {
    if (this.notePath !== path) {
      this.notePath = path;
      this.clear();
    }
  }

  clear() {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.images.clear();
    this.pending.clear();
  }

  urlFor(fileName) {
    if (this.local.has(fileName)) return this.local.get(fileName).url;
    if (!this.notePath) return null;
    return `/api/note/entry?path=${encodeURIComponent(this.notePath)}&name=${encodeURIComponent('Resources/Images/' + fileName)}`;
  }

  /** Synchronously fetch an already-decoded image (may be undefined). */
  get(fileName) { return this.images.get(fileName); }

  has(fileName) { return this.images.has(fileName) || this.local.has(fileName); }

  load(fileName) {
    if (this.images.has(fileName)) return Promise.resolve(this.images.get(fileName));
    if (this.pending.has(fileName)) return this.pending.get(fileName);
    const url = this.urlFor(fileName);
    if (!url) return Promise.resolve(null);
    const p = new Promise((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        this.images.set(fileName, img);
        this.pending.delete(fileName);
        this.#evict();
        if (this.onLoad) this.onLoad(fileName);
        resolve(img);
      };
      img.onerror = () => { this.pending.delete(fileName); resolve(null); };
      img.src = url;
    });
    this.pending.set(fileName, p);
    return p;
  }

  /** Load every image used by a page; resolves when all have settled. */
  async loadForPage(page) {
    const names = [...new Set(page.elements.filter((e) => e.type === 300001 && e.fileName).map((e) => e.fileName))];
    await Promise.all(names.map((n) => this.load(n)));
  }

  /** Register raw bytes as a new resource; returns the generated file name. */
  addBytes(bytes, ext = 'png') {
    const blob = new Blob([bytes], { type: ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png' });
    const fileName = `${uuid()}.${ext}`;
    const url = URL.createObjectURL(blob);
    this.local.set(fileName, { blob, url });
    this.urls.set(fileName, url);
    const img = new Image();
    img.onload = () => { this.images.set(fileName, img); if (this.onLoad) this.onLoad(fileName); };
    img.src = url;
    return fileName;
  }

  isNew(fileName) { return this.local.has(fileName); }

  async newFilesAsBase64() {
    const out = {};
    for (const [name, rec] of this.local) {
      const buf = await rec.blob.arrayBuffer();
      out['Resources/Images/' + name] = bytesToBase64(new Uint8Array(buf));
    }
    return out;
  }

  #evict() {
    if (this.images.size <= MAX_ENTRIES) return;
    const keep = new Set(this.pending.keys());
    for (const k of this.images.keys()) {
      if (this.images.size <= MAX_ENTRIES) break;
      if (keep.has(k)) continue;
      const img = this.images.get(k);
      // Never evict images that are still referenced by an open blob URL.
      if (this.local.has(k)) continue;
      void img;
      this.images.delete(k);
    }
  }
}

export function bytesToBase64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
