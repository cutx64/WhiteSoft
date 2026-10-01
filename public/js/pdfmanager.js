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

/**
 * A ceiling for one PDF raster, so a request can never be absurd.
 *
 * Browsers do not fail loudly on an oversized canvas: they hand back a canvas
 * of the requested size that simply never received the drawing commands.  That
 * is how a PDF backdrop used to "disappear" when the page was zoomed in — the
 * raster came back as a blank white sheet.  The ceiling keeps the first attempt
 * sane, and `getPageBitmap` then halves the raster until the browser really
 * paints it, so the answer adapts to the machine instead of trusting a limit.
 */
const MAX_RASTER_AREA = 200 * 1024 * 1024;
const MAX_RASTER_DIM = 16384;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The largest scale whose whole-page raster stays under the ceiling. */
function ceilingScale(base) {
  const byDim = MAX_RASTER_DIM / Math.max(base.width, base.height);
  const byArea = Math.sqrt(MAX_RASTER_AREA / (base.width * base.height));
  return Math.min(byDim, byArea);
}

/** Is this canvas one the browser allocated but never actually drew into? */
function canvasIsBlank(canvas) {
  try {
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 32;
    const ctx = c.getContext('2d', { alpha: false });
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, 32, 32);
    ctx.drawImage(canvas, 0, 0, 32, 32);
    const d = ctx.getImageData(0, 0, 32, 32).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) dark++;
    }
    return dark <= 2;
  } catch {
    return false;
  }
}

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
    /** @type {Map<number, boolean>} pageNumber -> "this page is blank white" */
    this.blankPages = new Map();
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
    this.blankPages.clear();
  }

  /**
   * Is this PDF page just a blank white sheet?
   *
   * A scanned board can carry a PDF whose page is empty — the real drawings on
   * it are images pasted over the sheet — and such a page should be treated
   * like one without any backdrop at all.  The page is rasterised small once
   * and its pixels sampled; the answer is cached for the document's lifetime.
   */
  async pageIsBlank(pageNumber) {
    if (!this.doc) return true;
    if (this.blankPages.has(pageNumber)) return this.blankPages.get(pageNumber);
    let blank = true;
    try {
      const bitmap = await this.getPageBitmap(pageNumber, 96);
      if (bitmap) {
        const c = document.createElement('canvas');
        c.width = 32;
        c.height = 32;
        const ctx = c.getContext('2d', { alpha: false });
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(bitmap, 0, 0, c.width, c.height);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let dark = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) dark++;
        }
        // a couple of stray pixels are antialiasing, not content
        blank = dark <= Math.max(2, (d.length / 4) * 0.01);
      }
    } catch (err) {
      console.warn('pdf blank check failed', pageNumber, err);
    }
    this.blankPages.set(pageNumber, blank);
    return blank;
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

  /** The same size, for callers that cannot wait for it yet. */
  pageSizeSync(pageNumber) { return this.pageSizes.get(pageNumber) || null; }

  /**
   * Returns a canvas holding `pageNumber` rasterised at approximately
   * `targetWidth` device pixels.  Results are cached per resolution bucket.
   *
   * A canvas the browser silently refused to paint (too large for the machine)
   * is retried at half the resolution, so the backdrop may be softer than
   * asked but is never missing.
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
      let scale = Math.min((targetWidth * bucket) / base.width, ceilingScale(base));
      let canvas = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        const vp = page.getViewport({ scale });
        canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(vp.width));
        canvas.height = Math.max(1, Math.ceil(vp.height));
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        // eslint-disable-next-line no-await-in-loop
        await page.render({ canvasContext: ctx, viewport: vp, intent: 'display' }).promise;
        // A blank raster for a page that is not blank means the browser dropped
        // the drawing: that resolution is out of reach here.
        const knownBlank = this.blankPages.get(pageNumber) === true;
        if (knownBlank || scale <= 1 || !canvasIsBlank(canvas)) break;
        scale /= 2;
      }
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
