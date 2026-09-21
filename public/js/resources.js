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
    /** ZipReader of a `.note` opened from disk (no server copy involved). */
    this.archive = null;
    this.pending = new Map();
    this.onLoad = null;
  }

  /**
   * Point the store at the board that is being opened.  Everything cached so
   * far belonged to the previous board (or to a board that was just closed),
   * so it is dropped unconditionally — including the files pasted during the
   * session, which by then either live inside the saved `.note` or were
   * discarded together with the unsaved changes.
   */
  setNote(path) {
    this.clear();            // also forgets a previously opened local archive
    this.notePath = path;
    this.archive = null;
  }

  /**
   * Take images from a `.note` read in the browser (opened from local disk).
   * Entries are inflated on demand and turned into session object URLs, so a
   * board with hundreds of images never loads them all up front.
   */
  setLocalArchive(archive) {
    this.clear();            // clear() drops the archive too, so set it after
    this.notePath = null;
    this.archive = archive || null;
  }

  clear() {
    // Revoke every object URL this session created *and* forget the pasted
    // files that point at them.  Keeping `local` while its URLs are revoked
    // is what made a freshly pasted image disappear after switching boards:
    // `urlFor` kept returning the dead `blob:` URL, the <img> failed to load,
    // and `has` even reported it as present so the server was never asked —
    // only a full page reload (empty store) brought the picture back.
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.local.clear();
    this.images.clear();
    this.pending.clear();
    this.archive = null;
  }

  urlFor(fileName) {
    // A pasted file is addressable through its session object URL, which is
    // only usable while it is still registered in `urls`; otherwise fall back
    // to the copy inside the `.note` archive.
    const local = this.local.get(fileName);
    if (local && this.urls.has(fileName)) return local.url;
    if (!this.notePath) return null;
    return `/api/note/entry?path=${encodeURIComponent(this.notePath)}&name=${encodeURIComponent('Resources/Images/' + fileName)}`;
  }

  /** Synchronously fetch an already-decoded image (may be undefined). */
  get(fileName) { return this.images.get(fileName); }

  /** True when the image can be drawn right now or still be fetched. */
  has(fileName) {
    if (this.images.has(fileName)) return true;
    const local = this.local.get(fileName);
    return !!local && this.urls.has(fileName);
  }

  load(fileName) {
    if (this.images.has(fileName)) return Promise.resolve(this.images.get(fileName));
    if (this.pending.has(fileName)) return this.pending.get(fileName);
    if (this.archive) return this.#loadFromArchive(fileName);
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

  /** Pull one image out of the locally opened archive. */
  #loadFromArchive(fileName) {
    const name = 'Resources/Images/' + fileName;
    const p = (async () => {
      try {
        const bytes = await this.archive.read(name);
        if (!bytes) return null;
        const url = URL.createObjectURL(new Blob([bytes]));
        this.urls.set(fileName, url);
        const img = await new Promise((resolve) => {
          const el = new Image();
          el.onload = () => resolve(el);
          el.onerror = () => resolve(null);
          el.src = url;
        });
        if (!img) return null;
        this.images.set(fileName, img);
        this.#evict();
        if (this.onLoad) this.onLoad(fileName);
        return img;
      } catch (err) {
        console.warn('本地归档里的图片读取失败', fileName, err);
        return null;
      } finally {
        this.pending.delete(fileName);
      }
    })();
    this.pending.set(fileName, p);
    return p;
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
