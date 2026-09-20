/**
 * PDF support: opens a PDF once and hands out rasterised page bitmaps on
 * demand, scaled to whatever resolution the current zoom level needs.
 */
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

/** CJK / CID font data — required for the Chinese text in most imported PDFs. */
const CMAP_URL = new URL('../vendor/pdfjs/cmaps/', import.meta.url).href;
const STANDARD_FONTS_URL = new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href;

export { pdfjsLib };

const MAX_BUCKET = 4;
const MIN_BUCKET = 0.5;
const MAX_CACHE_ENTRIES = 24;

export class PdfManager {
  constructor() {
    this.doc = null;
    this.docKey = null;
    this.pageCount = 0;
    /** @type {Map<string, {canvas:any, w:number, h:number, used:number}>} */
    this.cache = new Map();
    this.loading = new Map();
    this.onReady = null;
    this.pageSizes = new Map();
  }

  get isOpen() { return !!this.doc; }

  async open(src, key = null) {
    if (this.docKey && key && this.docKey === key) return this;
    await this.close();
    const params = typeof src === 'string'
      ? { url: src }
      : { data: src instanceof Uint8Array ? src.slice() : new Uint8Array(src) };
    this.doc = await pdfjsLib.getDocument({
      ...params,
      isEvalSupported: false,
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: STANDARD_FONTS_URL,
      useSystemFonts: true,
    }).promise;
    this.docKey = key || (typeof src === 'string' ? src : 'local');
    this.pageCount = this.doc.numPages;
    return this;
  }

  async close() {
    if (this.doc) { try { await this.doc.destroy(); } catch {} }
    this.doc = null; this.docKey = null; this.pageCount = 0;
    this.cache.clear(); this.loading.clear(); this.pageSizes.clear();
  }

  async getPageSize(pageNumber) {
    if (!this.doc) return null;
    if (this.pageSizes.has(pageNumber)) return this.pageSizes.get(pageNumber);
    const page = await this.doc.getPage(pageNumber);
    const vp = page.getViewport({ scale: 1 });
    const size = { width: vp.width, height: vp.height };
    this.pageSizes.set(pageNumber, size);
    return size;
  }

  /**
   * Returns a canvas containing `pageNumber` rendered at approximately
   * `targetWidth` device pixels.  Results are cached per resolution bucket.
   */
  async getPageBitmap(pageNumber, targetWidth) {
    if (!this.doc) return null;
    const bucket = Math.min(MAX_BUCKET, Math.max(MIN_BUCKET, roundBucket(targetWidth / 800)));
    const key = `${pageNumber}@${bucket}`;
    const hit = this.cache.get(key);
    if (hit) { hit.used = performance.now(); return hit.canvas; }
    if (this.loading.has(key)) return this.loading.get(key);

    const job = (async () => {
      const page = await this.doc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = (targetWidth * bucket) / base.width;
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(vp.width));
      canvas.height = Math.max(1, Math.ceil(vp.height));
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp, intent: 'display' }).promise;
      page.cleanup();
      this.cache.set(key, { canvas, w: canvas.width, h: canvas.height, used: performance.now() });
      this.#evict();
      this.loading.delete(key);
      if (this.onReady) this.onReady();
      return canvas;
    })();
    this.loading.set(key, job);
    job.catch(() => this.loading.delete(key));
    return job;
  }

  #evict() {
    if (this.cache.size <= MAX_CACHE_ENTRIES) return;
    const list = [...this.cache.entries()].sort((a, b) => a[1].used - b[1].used);
    for (let i = 0; i < list.length - MAX_CACHE_ENTRIES; i++) this.cache.delete(list[i][0]);
  }

  /** Bitmaps for every page referenced by a whiteboard page. */
  async bitmapsFor(pdfPages, zoom, dpr) {
    const out = [];
    for (const pp of pdfPages) {
      const bounds = pp.bounds.split(',').map(Number);
      const target = Math.max(64, bounds[2] * zoom * dpr);
      let bitmap = null;
      try { bitmap = await this.getPageBitmap(pp.pageNumber, target); } catch (err) { console.warn('pdf render failed', pp.pageNumber, err); }
      out.push({ ...pp, bitmap });
    }
    return out;
  }
}

function roundBucket(v) {
  const steps = [0.5, 0.75, 1, 1.5, 2, 3, 4];
  let best = steps[0];
  for (const s of steps) if (Math.abs(s - v) < Math.abs(best - v)) best = s;
  return best;
}
