/**
 * Editor — application state, camera, input dispatch and element operations.
 */
import { Rect, rotatePoint, rectFromPoints, boundsOfRotatedRect, handlePositions, rotateHandlePosition } from './geometry.js';
import { clamp, clone, uid, argbToRgba, argbToHex, hexToArgb, argbAlpha } from './util.js';
import {
  T, elementBounds, localBounds, elementCenter, translateElement, scaleElement,
  rotateElement, hitTest, intersectsRect, insideLasso, IS_OBJECT, elementPoints,
  STICKY_RADIUS,
} from './elements.js';
import { SceneRenderer, screenToWorld, worldToScreen } from './render.js';
import { History } from './history.js';
import { ResourceStore } from './resources.js';
import { PdfManager } from './pdfmanager.js';
import { createDocument, createPage } from './document.js';
import { TOOLS } from './tools.js';
import { setRasterHandler } from './mathtext.js';

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 32;
/** The zoom every board starts at, and the value the view resets to. */
export const DEFAULT_ZOOM = 0.8;

export class Editor {
  constructor(canvas, host) {
    this.canvas = canvas;
    this.host = host;               // element that receives the DOM overlays
    this.renderer = new SceneRenderer(canvas);
    this.resources = new ResourceStore();
    this.pdf = new PdfManager();
    this.history = new History();
    // LaTeX bitmaps arrive asynchronously (MathJax typesets synchronously, the
    // SVG decode does not), so a late one must repaint the cached layer — the
    // same path a late image takes.
    setRasterHandler(() => this.#scheduleSoftInvalidate());
    // Any undo/redo (or a new entry) must repaint straight away: the history
    // closures mutate the page directly, so nothing else would invalidate the
    // render cache and the change would only appear on the next interaction.
    this.history.onChange = () => { this.invalidate(); this.onSelectionChange?.(); this.onChange?.(); };
    this.doc = createDocument();
    this.pageIndex = 0;
    // One camera for the whole document: the zoom is global, so changing it on
    // one page changes it on every page; only the scroll position moves.
    this.camera = { x: 0, y: 0, zoom: DEFAULT_ZOOM };
    this.defaultZoom = DEFAULT_ZOOM;
    this.version = 0;

    this.tool = 'pen';
    this.prevTool = 'pen';
    this.shapeKind = T.RECT;
    /** Which curve family the 'curve' shape kind draws (see curvePointsFor). */
    this.shapeCurve = 'parabola';
    this.selection = new Set();
    this.live = null;
    this.overlayExtra = null;
    this.clipboard = null;

    // Whiteboard keeps three independently customisable pens.
    const makePen = (color) => ({ color, width: 3, opacity: 1, arrow: 'none', inkGradient: null });
    this.pens = [makePen('#FF1F1F1F'), makePen('#FFE71125'), makePen('#FF0169BF')];
    this.activePen = 0;
    this.pen = this.pens[0];
    this.highlighter = { color: '#5AFED42F', width: 24, opacity: 1, straight: false };
    this.eraserSize = 12;
    this.textStyle = { fontSize: 20, color: '#FF000000', bold: false, italic: false, underline: false, align: 'left' };
    this.noteStyle = { color: '#FFFFE6A0', fontSize: 18, color2: '#FF000000', radius: STICKY_RADIUS };
    this.shapeStyle = { stroke: '#FF1F1F1F', width: 1.6, dash: false, filled: false, rounded: false };
    this.reactionEmoji = '⭐';
    this.toolbarLocation = 'bottom';
    this.enhanceInk = false;
    this.snapEnabled = true;
    this.laser = null;
    this.guides = null;

    this.ruler = { active: false, angle: 0, cx: 0, cy: 0, length: 900, dragging: false };
    this.background = { style: 'none', spacing: 25, lineColor: 'rgba(0,0,0,0.10)' };

    this.view = { w: 1, h: 1 };
    this.dpr = window.devicePixelRatio || 1;
    this._renderScheduled = false;
    this._pdfKey = null;
    this._loadingPdf = false;
    this.pointers = new Map();
    this.mode = 'idle';             // idle | draw | pan | pinch | handle
    this.onChange = null;
    this.onContentChange = null;
    this.onSelectionChange = null;
    this.onStatus = null;
    this.onCameraChange = null;
    this.onToolChange = null;
    this.inline = null;
    this._pendingResize = false;

    this.#bindEvents();
    this.resize();
    window.addEventListener('scroll', () => this.refreshCanvasRect(), true);
  }

  /* ---------------------------------------------------------------- *
   * Doc / page accessors
   * ---------------------------------------------------------------- */
  get page() { return this.doc.pages[this.pageIndex] || createPage(); }
  get pageCount() { return this.doc.pages.length; }

  setDocument(doc, { keepView = false } = {}) {
    this.doc = doc;
    this.pageIndex = clamp(doc.currentPage || 0, 0, doc.pages.length - 1);
    this.selection.clear();
    this.history.clear();
    this.version++;
    // The PDF layer is page state, exactly like `gotoPage` treats it: leaving it
    // in place painted the *previous* board's PDF page as the first frame of the
    // new document, and since `syncPdf()` only clears the cache after that frame
    // was drawn, the stale picture stayed on screen until the user touched
    // something (`Shift+N` on a PDF-backed board).
    this._pdfPages = null;
    this._pdfKey = null;
    this._loadingPdf = false;
    this._pdfKeyPending = null;
    // Whatever the renderer cached belongs to the document that was just closed.
    this.renderer?.invalidate?.();
    if (keepView) {
      this.camera.zoom = clamp(this.camera.zoom, MIN_ZOOM, MAX_ZOOM);
    } else {
      // A freshly opened board starts at the document-wide default zoom.
      this.camera.zoom = clamp(this.defaultZoom, MIN_ZOOM, MAX_ZOOM);
    }
    this.centerPage();
    this.onChange?.();
    this.requestRender();
    this.loadPageResources();
  }

  /**
   * Put the current page in view without touching the zoom, so the zoom the
   * user picked on one page carries over to every other page.
   */
  centerPage({ align = 'top' } = {}) {
    const target = this.boundsOfPage(this.pageIndex);
    if (!target || !target.w) return;
    const z = this.camera.zoom;
    this.camera.x = target.cx - this.view.w / 2 / z;
    this.camera.y = align === 'middle'
      ? target.cy - this.view.h / 2 / z
      : target.top - 12 / z;
    this.onCameraChange?.();
  }

  /**
   * Kick off loading of the bitmaps this page needs.  Each one that arrives
   * triggers a re-render, so a page fills in progressively instead of blocking.
   */
  loadPageResources() {
    // Several images can land in the same frame; coalesce them into a single
    // cache rebuild instead of one per image.
    const scheduleInvalidate = () => this.#scheduleSoftInvalidate();
    if (this.resources.onLoad == null) this.resources.onLoad = scheduleInvalidate;
    const page = this.page;
    if (!page || !page.elements) return;
    const missing = page.elements.some((e) => e.type === T.IMAGE && e.fileName && !this.resources.has(e.fileName));
    if (!missing) return;
    this.resources.loadForPage(page).then(scheduleInvalidate).catch(() => {});
  }

  /**
   * Coalesced soft invalidation for content that arrives asynchronously
   * (image bitmaps, MathJax rasters, sharper PDF pages).  Bumping `version`
   * makes the renderer treat the cached raster as stale, but the rebuild is
   * deferred while the user is mid-gesture so interactions never stall.
   */
  #scheduleSoftInvalidate() {
    if (this._resInvalidateScheduled) return;
    this._resInvalidateScheduled = true;
    requestAnimationFrame(() => {
      this._resInvalidateScheduled = false;
      this.version++;
      this.renderer.markStale();
      this.requestRender();
    });
  }

  requestRender() {
    if (this._renderScheduled) return;
    this._renderScheduled = true;
    requestAnimationFrame(() => {
      this._renderScheduled = false;
      this.draw();
    });
  }

  /** Force the world-space cache to be rebuilt (content or zoom changed). */
  invalidate() { this.version++; this.renderer.invalidate(); this.requestRender(); }

  draw() {
    const s = {
      page: this.page,
      camera: this.camera,
      view: this.view,
      dpr: this.dpr,
      version: this.version,
      images: this.resources.images,
      backgroundColor: argbToRgba(this.doc.backgroundColor || '#FFFFFFFF'),
      background: { ...this.background, _zoom: this.camera.zoom },
      pdfPages: this._pdfPages || this.page.pdfPages.map((p) => ({ ...p })),
      // While a gesture is running the renderer blits a slightly stale raster
      // instead of rebuilding it, and rebuilds once everything settles.
      interacting: this.mode !== 'idle' || (performance.now() - (this._lastCameraChange || 0) < 120),
      live: this.live,
      // The element currently open in the DOM inline editor draws its raw text
      // on the canvas (the transparent textarea sits right on top of it).
      editing: this.inline?.current || null,
      overlay: (ctx, env) => {
        this.currentTool?.overlay?.(this, ctx, env);
        this.overlayExtra?.(ctx, env);
        this.#drawSnapGuides(ctx, env);
        this.#drawSelection(ctx, env);
        this.#drawRuler(ctx, env);
        this.#drawLaser(ctx, env);
      },
    };
    this.renderer.render(s);
    this.syncPdf();
  }

  /* ---------------------------------------------------------------- *
   * PDF backdrop
   * ---------------------------------------------------------------- */
  syncPdf() {
    const pages = this.page.pdfPages;
    if (!pages || !pages.length || !this.pdf.isOpen) { this._pdfPages = null; return; }
    // Whole-octave buckets: re-rasterising a PDF page is expensive, so only do
    // it when the zoom has changed by a factor of two.
    const key = pages.map((p) => p.pageNumber).join(',') + '@' + Math.round(Math.log2(Math.max(this.camera.zoom * this.dpr, 0.01)));
    if (this._pdfKey === key) return;
    if (this._loadingPdf) { this._pdfKeyPending = key; return; }
    this._loadingPdf = true;
    // Rasterising is asynchronous: if the user switches board in the meantime,
    // this result belongs to a document that is gone and must never be painted
    // onto the new one.
    const owner = this.doc;
    this.pdf.bitmapsFor(pages, this.camera.zoom, this.dpr)
      .then((list) => {
        if (this.doc !== owner) return;
        this._pdfPages = list;
        this._pdfKey = key;
        this._loadingPdf = false;
        // A sharper PDF bitmap means the cached layer is stale; rebuild when
        // the user pauses, not in the middle of a zoom gesture.
        this.renderer.markStale();
        this.requestRender();
        if (this._pdfKeyPending && this._pdfKeyPending !== key) {
          const next = this._pdfKeyPending;
          this._pdfKeyPending = null;
          this._pdfKey = next;
          this.syncPdf();
        } else {
          this._pdfKeyPending = null;
        }
      })
      .catch((err) => { console.warn(err); this._loadingPdf = false; });
  }

  /* ---------------------------------------------------------------- *
   * Camera
   * ---------------------------------------------------------------- */
  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    this.view = { w: Math.max(1, r.width), h: Math.max(1, r.height) };
    this.dpr = window.devicePixelRatio || 1;
    this.refreshCanvasRect();
    this.requestRender();
  }

  zoomAt(newZoom, sx, sy) {
    newZoom = clamp(newZoom, MIN_ZOOM, MAX_ZOOM);
    const w = screenToWorld(this.camera, sx, sy);
    this.camera.zoom = newZoom;
    this.camera.x = w.x - sx / newZoom;
    this.camera.y = w.y - sy / newZoom;
    this._lastCameraChange = performance.now();
    this.onCameraChange?.();
    this.onChange?.();
    this.requestRender();
  }

  panBy(dxScreen, dyScreen) {
    this.camera.x -= dxScreen / this.camera.zoom;
    this.camera.y -= dyScreen / this.camera.zoom;
    this._lastCameraChange = performance.now();
    this.onCameraChange?.();
    this.requestRender();
  }

  zoomBy(factor, anchor) {
    const a = anchor || { x: this.view.w / 2, y: this.view.h / 2 };
    this.zoomAt(this.camera.zoom * factor, a.x, a.y);
  }

  /** World rect that should be framed for the current page. */
  contentBounds() {
    return this.boundsOfPage(this.pageIndex);
  }

  /** World rect worth framing for an arbitrary page (PDF backdrop wins). */
  boundsOfPage(index) {
    const p = this.doc.pages[index];
    if (!p) return new Rect(0, 0, 1280, 720);
    let r = new Rect();
    let any = false;
    for (const pp of p.pdfPages || []) { const b = Rect.parse(pp.bounds); r = any ? r.union(b) : b; any = true; }
    if (any && r.w > 0 && r.h > 0) return r;
    for (const e of p.elements) { const b = elementBounds(e); r = any ? r.union(b) : b; any = true; }
    if (!any) return new Rect(-this.view.w / 2, -this.view.h / 2, this.view.w, this.view.h);
    return r;
  }

  fitPageWidth() {
    const target = this.boundsOfPage(this.pageIndex);
    if (!target.w) return;
    this.setZoom((this.view.w * 0.98) / target.w);
    this.centerPage();
    this.requestRender();
  }

  fitPage() {
    const target = this.boundsOfPage(this.pageIndex);
    if (!target.w || !target.h) return;
    this.setZoom(Math.min(this.view.w / target.w, this.view.h / target.h) * 0.94);
    this.centerPage({ align: 'middle' });
    this.requestRender();
  }

  /** Set the document-wide zoom, keeping the viewport centre fixed. */
  setZoom(z) {
    this.camera.zoom = clamp(z, MIN_ZOOM, MAX_ZOOM);
    const c = this.screenToWorld(this.view.w / 2, this.view.h / 2);
    this.camera.x = c.x - this.view.w / 2 / this.camera.zoom;
    this.camera.y = c.y - this.view.h / 2 / this.camera.zoom;
    this.onCameraChange?.();
    this.onChange?.();
    return this.camera.zoom;
  }

  zoomTo100() {
    const cx = this.camera.x + this.view.w / 2 / this.camera.zoom;
    const cy = this.camera.y + this.view.h / 2 / this.camera.zoom;
    this.camera.zoom = 1;
    this.camera.x = cx - this.view.w / 2;
    this.camera.y = cy - this.view.h / 2;
    this.onCameraChange?.();
    this.onChange?.();
    this.requestRender();
  }

  /* ---------------------------------------------------------------- *
   * Pages
   * ---------------------------------------------------------------- */
  gotoPage(i, { fit = false, align = 'top' } = {}) {
    i = clamp(i, 0, this.pageCount - 1);
    if (i === this.pageIndex && this._visited) return;
    this.pageIndex = i;
    this.doc.currentPage = i;
    this._visited = true;
    this.selection.clear();
    this.live = null;
    this._pdfPages = null;
    this._pdfKey = null;
    this.version++;
    if (fit) this.fitPageWidth(); else { this.centerPage({ align }); this.requestRender(); }
    this.onSelectionChange?.();
    this.onChange?.();
    this.loadPageResources();
  }
  nextPage() { this.gotoPage(this.pageIndex + 1); }
  prevPage() { this.gotoPage(this.pageIndex - 1); }

  addPage(after = this.pageIndex) {
    const p = createPage({ scale: 1 });
    this.doc.pages.splice(after + 1, 0, p);
    this.history.push('添加画纸',
      () => { this.doc.pages.splice(after + 1, 1); this.gotoPage(Math.max(0, after), { fit: false }); },
      () => { this.doc.pages.splice(after + 1, 0, p); this.gotoPage(after + 1, { fit: false }); });
    this.gotoPage(after + 1);
    this.onContentChange?.();
    this.onChange?.();
  }

  /** Insert a blank page immediately before the current one. */
  addPageBefore(index = this.pageIndex) {
    const at = Math.max(0, index);
    const p = createPage({ scale: 1 });
    this.doc.pages.splice(at, 0, p);
    this.history.push('在之前插入画纸',
      () => { const i = this.doc.pages.indexOf(p); if (i >= 0) this.doc.pages.splice(i, 1); this.gotoPage(Math.min(at, this.pageCount - 1), { fit: false }); },
      () => { this.doc.pages.splice(at, 0, p); this.gotoPage(at, { fit: false }); });
    this.gotoPage(at);
    this.onContentChange?.();
    this.onChange?.();
  }

  /** Insert a blank page immediately after the current one. */
  addPageAfter(index = this.pageIndex) {
    const at = Math.min(this.pageCount, index + 1);
    const p = createPage({ scale: 1 });
    this.doc.pages.splice(at, 0, p);
    this.history.push('在之后插入画纸',
      () => { const i = this.doc.pages.indexOf(p); if (i >= 0) this.doc.pages.splice(i, 1); this.gotoPage(Math.min(at - 1, this.pageCount - 1), { fit: false }); },
      () => { this.doc.pages.splice(at, 0, p); this.gotoPage(at, { fit: false }); });
    this.gotoPage(at);
    this.onContentChange?.();
    this.onChange?.();
  }

  duplicatePage(index = this.pageIndex) {
    const copy = JSON.parse(JSON.stringify(this.doc.pages[index]));
    this.doc.pages.splice(index + 1, 0, copy);
    this.history.push('复制画纸',
      () => { this.doc.pages.splice(index + 1, 1); this.gotoPage(index, { fit: false }); },
      () => { this.doc.pages.splice(index + 1, 0, copy); this.gotoPage(index + 1, { fit: false }); });
    this.gotoPage(index + 1, { fit: false });
    this.onContentChange?.();
    this.onChange?.();
  }

  deletePage(index = this.pageIndex) {
    if (this.pageCount <= 1) return;
    const [removed] = this.doc.pages.splice(index, 1);
    this.history.push('删除画纸',
      () => { this.doc.pages.splice(index, 0, removed); this.gotoPage(index, { fit: false }); },
      () => { this.doc.pages.splice(index, 1); this.gotoPage(Math.min(index, this.pageCount - 1), { fit: false }); });
    this.gotoPage(Math.min(index, this.pageCount - 1), { fit: false });
    this.onContentChange?.();
    this.onChange?.();
  }

  movePage(from, to) {
    if (from === to) return;
    const [p] = this.doc.pages.splice(from, 1);
    this.doc.pages.splice(to, 0, p);
    this.history.push('移动画纸', () => this.movePage(to, from), () => this.movePage(from, to));
    this.gotoPage(to, { fit: false });
    this.onContentChange?.();
    this.onChange?.();
  }

  /* ---------------------------------------------------------------- *
   * Elements
   * ---------------------------------------------------------------- */
  addElement(e, { select = false, record = true, label = '添加' } = {}) {
    this.page.elements.push(e);
    if (record) {
      this.history.push(label,
        () => { const i = this.page.elements.indexOf(e); if (i >= 0) this.page.elements.splice(i, 1); this.selection.delete(e); },
        () => { this.page.elements.push(e); });
    }
    if (select) { this.selection.clear(); this.selection.add(e); this.onSelectionChange?.(); }
    this.invalidate();
    this.onContentChange?.();
    this.onChange?.();
    return e;
  }

  /**
   * Add several elements as one shape (a hyperbola is two branches): a single
   * history entry, one undo, and all of them selected together.
   */
  addElements(list, { select = false, record = true, label = '添加' } = {}) {
    const items = (list || []).filter(Boolean);
    if (!items.length) return [];
    if (items.length === 1) return [this.addElement(items[0], { select, record, label })];
    for (const e of items) this.page.elements.push(e);
    if (record) {
      this.history.push(label,
        () => {
          for (const e of items) {
            const i = this.page.elements.indexOf(e);
            if (i >= 0) this.page.elements.splice(i, 1);
            this.selection.delete(e);
          }
        },
        () => { for (const e of items) this.page.elements.push(e); });
    }
    if (select) {
      this.selection.clear();
      for (const e of items) this.selection.add(e);
      this.onSelectionChange?.();
    }
    this.invalidate();
    this.onContentChange?.();
    this.onChange?.();
    return items;
  }

  removeElements(list, label = '删除') {
    const items = list.filter((e) => this.page.elements.includes(e));
    if (!items.length) return;

    // Remember where each element sat so undo can restore the z-order.
    const indexed = items
      .map((e) => ({ e, i: this.page.elements.indexOf(e) }))
      .sort((a, b) => a.i - b.i);
    const selectionBefore = new Set(this.selection);

    const detach = () => {
      for (const e of items) {
        const i = this.page.elements.indexOf(e);
        if (i >= 0) this.page.elements.splice(i, 1);
        this.selection.delete(e);
      }
    };
    const reattach = () => {
      for (const { e, i } of indexed) {
        if (this.page.elements.includes(e)) continue;
        this.page.elements.splice(Math.min(i, this.page.elements.length), 0, e);
      }
      this.selection = new Set([...selectionBefore].filter((e) => this.page.elements.includes(e)));
    };

    detach();
    this.history.push(label, reattach, detach);
    this.invalidate();
    this.onContentChange?.();
    this.onSelectionChange?.();
    this.onChange?.();
  }

  deleteSelection() {
    if (!this.selection.size) return;
    this.removeElements([...this.selection]);
  }

  /**
   * Put a copy of the current selection onto another page, keeping the world
   * coordinates so it lands in the same place on the target page.
   */
  copySelectionToPage(target, { move = false } = {}) {
    target = clamp(target, 0, this.pageCount - 1);
    if (target === this.pageIndex) return 0;
    const items = clone([...this.selection]);
    if (!items.length) return 0;
    const dst = this.doc.pages[target];
    if (!dst) return 0;
    const src = this.page;
    const sourceItems = [...this.selection];

    const add = () => { dst.elements.push(...items); };
    const remove = () => {
      for (const e of items) {
        const i = dst.elements.indexOf(e);
        if (i >= 0) dst.elements.splice(i, 1);
      }
    };
    const detachSource = () => {
      for (const e of sourceItems) {
        const i = src.elements.indexOf(e);
        if (i >= 0) src.elements.splice(i, 1);
        this.selection.delete(e);
      }
    };
    const reattachSource = () => {
      for (const e of sourceItems) if (!src.elements.includes(e)) src.elements.push(e);
      this.selection = new Set(sourceItems);
    };

    add();
    if (move) detachSource();
    const label = move ? `移动到第 ${target + 1} 页` : `复制到第 ${target + 1} 页`;
    this.history.push(label,
      () => { remove(); if (move) reattachSource(); this.selection = new Set(); this.invalidate(); },
      () => { add(); if (move) detachSource(); this.invalidate(); });
    if (move) this.selection.clear();
    this.invalidate();
    this.onSelectionChange?.();
    this.onContentChange?.();
    this.onChange?.();
    return items.length;
  }

  /**
   * Change the primary colour of every selected element.
   *
   * `snapshot: false` paints without writing a history entry, which is what a
   * live colour-picker drag needs: the caller keeps the "before" snapshot and
   * commits it once when the value settles.
   */
  applySelectionColor(argb, { snapshot = true } = {}) {
    if (!this.selection.size) return 0;
    const before = snapshot ? this.snapshot() : null;
    let n = 0;
    for (const e of this.selection) {
      switch (e.type) {
        case T.INK:
        case T.HIGHLIGHTER:
        case T.LINE: case T.RECT: case T.ELLIPSE: case T.ARROW: case T.DOUBLE_ARROW:
        case T.POLYLINE: case T.TRIANGLE: case T.DIAMOND: case T.PENTAGON:
        case T.HEXAGON: case T.STAR: case T.PARALLELOGRAM: case T.BLOCK_ARROW:
          e.stroke = argb;
          if (e.filled) e.fill = argb;
          if (e.inkGradient) delete e.inkGradient;
          n++;
          break;
        case T.TEXT:
          e.textColor = argb;
          n++;
          break;
        case T.STICKY:
          // The palette picks a hue; the note keeps its own transparency.
          e.color = hexToArgb(argbToHex(argb), argbAlpha(e.color));
          n++;
          break;
        case T.TABLE:
          e.stroke = argb;
          n++;
          break;
        default:
          break;
      }
    }
    if (n && before) this.commitSnapshot(before, '修改颜色');
    return n;
  }

  /** The selection's bounding box in CSS pixels relative to the canvas. */
  selectionScreenRect() {
    const b = this.selectionBounds();
    if (!b) return null;
    const tl = this.worldToScreen(b.left, b.top);
    const br = this.worldToScreen(b.right, b.bottom);
    return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
  }

  /** Snapshot the current page elements for a compound edit. */
  snapshot() { return clone({ elements: this.page.elements, pdfPages: this.page.pdfPages }); }

  /** Push a history entry that restores a snapshot taken before an edit. */
  commitSnapshot(before, label) {
    const after = this.snapshot();
    this.history.push(label,
      () => { this.restore(before); },
      () => { this.restore(after); });
    this.invalidate();
    this.onContentChange?.();
    this.onChange?.();
  }

  restore(snap) {
    // Undo replaces element objects wholesale, so the selection has to be
    // re-pointed at the restored copies (by index) or it would keep referring
    // to detached objects.
    const cur = this.page.elements;
    const keepIdx = new Set();
    for (const e of this.selection) {
      const i = cur.indexOf(e);
      if (i >= 0) keepIdx.add(i);
    }
    this.page.elements = clone(snap.elements);
    this.page.pdfPages = clone(snap.pdfPages);
    this.selection = new Set([...keepIdx].map((i) => this.page.elements[i]).filter(Boolean));
    this.loadPageResources();
    this.invalidate();
  }

  /* ---- selection helpers ---- */
  selectAll() {
    this.selection = new Set(this.page.elements.filter((e) => !e.locked && !e.hidden));
    this.onSelectionChange?.();
    this.requestRender();
  }
  clearSelection() {
    if (!this.selection.size) return;
    this.selection.clear();
    this.onSelectionChange?.();
    this.requestRender();
  }
  toggleSelection(e, add) {
    if (!add) this.selection.clear();
    if (this.selection.has(e)) this.selection.delete(e); else this.selection.add(e);
    this.onSelectionChange?.();
    this.requestRender();
  }
  selectionBounds() {
    let r = new Rect(); let any = false;
    for (const e of this.selection) { const b = elementBounds(e); r = any ? r.union(b) : b; any = true; }
    return any ? r : null;
  }

  /**
   * The frame the selection handles live in: for a single rotated object the
   * un-rotated box plus its rotation; for a multi-selection the plain AABB.
   */
  selectionFrame() {
    const sel = [...this.selection];
    const single = sel.length === 1 ? sel[0] : null;
    const rot = single ? (single.rotation || 0) : 0;
    const local = single ? localBounds(single) : this.selectionBounds();
    return {
      sel, rot, local,
      aabb: rot && local ? boundsOfRotatedRect(local, rot) : local,
    };
  }
  selectInRect(rect, add) {
    if (!add) this.selection.clear();
    for (const e of this.page.elements) {
      if (e.locked || e.hidden) continue;
      if (intersectsRect(e, rect, 2 / this.camera.zoom)) this.selection.add(e);
    }
    this.onSelectionChange?.();
    this.requestRender();
  }
  selectInLasso(pts, add) {
    if (!add) this.selection.clear();
    if (pts.length < 3) return;
    for (const e of this.page.elements) {
      if (e.locked || e.hidden) continue;
      if (insideLasso(e, pts)) this.selection.add(e);
    }
    this.onSelectionChange?.();
    this.requestRender();
  }

  /* ---- z-order ---- */
  reorderSelection(mode) {
    const list = this.page.elements;
    const sel = list.filter((e) => this.selection.has(e));
    if (!sel.length) return;
    const before = list.slice();
    let rest = list.filter((e) => !this.selection.has(e));
    if (mode === 'front') rest = [...rest, ...sel];
    else if (mode === 'back') rest = [...sel, ...rest];
    else if (mode === 'forward') {
      rest = list.slice();
      for (let i = rest.length - 2; i >= 0; i--) {
        if (this.selection.has(rest[i]) && !this.selection.has(rest[i + 1])) {
          [rest[i], rest[i + 1]] = [rest[i + 1], rest[i]];
        }
      }
    } else if (mode === 'backward') {
      rest = list.slice();
      for (let i = 1; i < rest.length; i++) {
        if (this.selection.has(rest[i]) && !this.selection.has(rest[i - 1])) {
          [rest[i], rest[i - 1]] = [rest[i - 1], rest[i]];
        }
      }
    }
    this.page.elements = rest;
    this.history.push('调整顺序', () => { this.page.elements = before.slice(); this.invalidate(); }, () => { this.page.elements = rest.slice(); this.invalidate(); });
    this.invalidate();
    this.onContentChange?.();
    this.onChange?.();
  }

  /* ---- clipboard ---- */
  copySelection(cut = false) {
    if (!this.selection.size) return;
    this.clipboard = { elements: clone([...this.selection]), files: new Map() };
    for (const e of this.clipboard.elements) {
      if (e.fileName && this.resources.isNew(e.fileName)) this.clipboard.files.set(e.fileName, this.resources.local.get(e.fileName).blob);
    }
    if (cut) this.deleteSelection();
  }

  paste(offset = 16) {
    if (!this.clipboard || !this.clipboard.elements.length) return;
    const d = offset / this.camera.zoom;
    const copies = [];
    for (const src of clone(this.clipboard.elements)) {
      if (src.fileName && this.clipboard.files.has(src.fileName)) {
        const rec = this.resources.local.get(src.fileName);
        // Re-register so the copy owns its own resource entry.
        const blob = this.clipboard.files.get(src.fileName);
        void rec;
        blob.arrayBuffer().then((buf) => this.resources.addBytes(new Uint8Array(buf), src.fileName.split('.').pop()));
      }
      translateElement(src, d, d);
      src._id = uid();
      this.page.elements.push(src);
      copies.push(src);
    }
    const before = this.page.elements.slice(0, this.page.elements.length - copies.length);
    this.history.push('粘贴',
      () => { for (const c of copies) { const i = this.page.elements.indexOf(c); if (i >= 0) this.page.elements.splice(i, 1); } this.invalidate(); },
      () => { this.page.elements = [...before, ...copies]; this.invalidate(); });
    this.selection = new Set(copies);
    this.onSelectionChange?.();
    this.invalidate();
    this.onContentChange?.();
    this.onChange?.();
  }

  duplicateSelection() {
    if (!this.selection.size) return;
    this.copySelection(false);
    this.paste();
  }

  /* ---- transforms on the current selection ---- */
  nudgeSelection(dx, dy) {
    if (!this.selection.size) return;
    const before = this.snapshot();
    for (const e of this.selection) translateElement(e, dx, dy);
    this.commitSnapshot(before, '移动');
  }

  /* ---------------------------------------------------------------- *
   * Tools
   * ---------------------------------------------------------------- */
  /** Switch between the three pen slots (Alt+1/2/3 in Whiteboard). */
  selectPen(i) {
    if (i < 0 || i >= this.pens.length) return;
    this.activePen = i;
    this.pen = this.pens[i];
    this.setTool('pen');
    this.refreshCursor();
    this.onToolChange?.('pen');
    this.onChange?.();
  }

  setTool(name) {
    if (name === this.tool) return;
    this.currentTool?.cancel?.(this);
    this.prevTool = this.tool;
    this.tool = name;
    this.live = null;
    this.cursor = null;
    this.onToolChange?.(name);
    this.requestRender();
  }

  get currentTool() { return TOOLS[this.tool]; }

  /* ---------------------------------------------------------------- *
   * Pointer / keyboard plumbing
   * ---------------------------------------------------------------- */
  #bindEvents() {
    const c = this.canvas;
    c.style.touchAction = 'none';

    c.addEventListener('pointerdown', (ev) => this.#onPointerDown(ev));
    c.addEventListener('pointermove', (ev) => this.#onPointerMove(ev));
    c.addEventListener('pointerup', (ev) => this.#onPointerUp(ev));
    c.addEventListener('pointercancel', (ev) => this.#onPointerUp(ev));
    c.addEventListener('pointerleave', (ev) => this.#onPointerUp(ev));
    c.addEventListener('dblclick', (ev) => this.#onDblClick(ev));
    c.addEventListener('contextmenu', (ev) => ev.preventDefault());
    c.addEventListener('wheel', (ev) => this.#onWheel(ev), { passive: false });
  }

  #localPoint(ev) {
    const r = this._canvasRect || this.refreshCanvasRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  /** Re-measure the canvas position; cached because pointermove fires often. */
  refreshCanvasRect() {
    this._canvasRect = this.canvas.getBoundingClientRect();
    return this._canvasRect;
  }

  #onPointerDown(ev) {
    if (this.host.querySelector('.wb-inline-editor')) this.commitInlineEditor();
    this.canvas.setPointerCapture?.(ev.pointerId);
    const sp = this.#localPoint(ev);
    const wp = screenToWorld(this.camera, sp.x, sp.y);
    this.pointers.set(ev.pointerId, sp);
    if (this.pointers.size === 2) {
      this.currentTool?.cancel?.(this);
      this.mode = 'pinch';
      this.live = null;
      this._pinch = pinchState(this.pointers);
      return;
    }
    const wantsPan = ev.button === 1 || this.spaceDown || this.tool === 'pan';
    if (wantsPan) {
      this.mode = 'pan';
      this._panLast = sp;
      this.canvas.classList.add('panning');
      return;
    }
    if (ev.button === 2) return;
    const rHit = this.rulerAt(sp);
    if (rHit) {
      this.mode = 'ruler';
      this._rulerDrag = { part: rHit, from: sp, cx: this.ruler.cx, cy: this.ruler.cy };
      this.canvas.style.cursor = rHit === 'rotate' ? 'grab' : 'move';
      return;
    }
    this.mode = 'draw';
    this.currentTool?.down?.(this, wp, ev, sp);
    this.requestRender();
  }

  #onPointerMove(ev) {
    const sp = this.#localPoint(ev);
    if (!this.pointers.has(ev.pointerId) && this.mode === 'idle') {
      this.currentTool?.hover?.(this, screenToWorld(this.camera, sp.x, sp.y), ev, sp);
      this.#updateCursor(sp);
      this.requestRender();
      return;
    }
    this.pointers.set(ev.pointerId, sp);

    if (this.mode === 'pinch' && this.pointers.size >= 2) {
      const next = pinchState(this.pointers);
      if (this._pinch) {
        const factor = next.dist / (this._pinch.dist || 1);
        this.zoomAt(this.camera.zoom * factor, next.cx, next.cy);
        this.panBy(next.cx - this._pinch.cx, next.cy - this._pinch.cy);
      }
      this._pinch = next;
      return;
    }
    if (this.mode === 'pan') {
      this.panBy(sp.x - this._panLast.x, sp.y - this._panLast.y);
      this._panLast = sp;
      return;
    }
    if (this.mode === 'ruler' && this._rulerDrag) {
      const d = this._rulerDrag;
      const w1 = screenToWorld(this.camera, sp.x, sp.y);
      if (d.part === 'rotate') {
        let a = Math.atan2(w1.y - this.ruler.cy, w1.x - this.ruler.cx);
        if (ev.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
        this.ruler.angle = a;
      } else {
        const w0 = screenToWorld(this.camera, d.from.x, d.from.y);
        this.ruler.cx = d.cx + (w1.x - w0.x);
        this.ruler.cy = d.cy + (w1.y - w0.y);
      }
      this.requestRender();
      return;
    }
    const wp = screenToWorld(this.camera, sp.x, sp.y);
    this.currentTool?.move?.(this, wp, ev, sp);
    this.requestRender();
  }

  #onPointerUp(ev) {
    const sp = this.#localPoint(ev);
    const wp = screenToWorld(this.camera, sp.x, sp.y);
    this.pointers.delete(ev.pointerId);
    this.canvas.releasePointerCapture?.(ev.pointerId);
    if (this.mode === 'pinch') {
      if (this.pointers.size < 2) { this.mode = 'idle'; this._pinch = null; }
      return;
    }
    if (this.mode === 'pan') { this.canvas.classList.remove('panning'); this.mode = 'idle'; return; }
    if (this.mode === 'ruler') {
      this.mode = 'idle';
      this._rulerDrag = null;
      this.#updateCursor(sp);
      return;
    }
    if (this.mode === 'draw') {
      this.currentTool?.up?.(this, wp, ev, sp);
      this.mode = 'idle';
    }
    this.requestRender();
  }

  /**
   * Topmost element under a world point.  Objects (text, notes, tables,
   * images, reactions) are picked anywhere inside their box; strokes and
   * shapes need the pointer to be near their outline.
   */
  pickAt(p, tol) {
    const t = tol == null ? 6 / this.camera.zoom : tol;
    const list = [...this.page.elements].reverse();
    for (const e of list) {
      if (e.locked || e.hidden) continue;
      if (IS_OBJECT.has(e.type)) {
        const b = localBounds(e);
        let px = p.x, py = p.y;
        if (e.rotation) { const q = rotatePoint(px, py, b.cx, b.cy, -e.rotation); px = q.x; py = q.y; }
        if (b.containsPoint(px, py)) return e;
        continue;
      }
      if (hitTest(e, p.x, p.y, t)) return e;
    }
    return null;
  }

  /** Elements whose contents can be edited in place. */
  static isEditable(e) {
    return !!e && (e.type === T.TEXT || e.type === T.STICKY || e.type === T.TABLE);
  }

  /**
   * Where a screen point falls on the ruler, if it is showing:
   * 'rotate' (the grip at the right end), 'body', or null.
   * The ruler lives above the drawing surface, so it is grabbed before the
   * active tool ever sees the event — exactly like Whiteboard.
   */
  rulerAt(screenPt) {
    const r = this.ruler;
    if (!r.active) return null;
    const w = screenToWorld(this.camera, screenPt.x, screenPt.y);
    const dx = w.x - r.cx, dy = w.y - r.cy;
    const cos = Math.cos(-r.angle), sin = Math.sin(-r.angle);
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    const k = this.camera.zoom;
    const h = 46 / k;
    const halfW = r.length / 2;
    const grab = 12 / k;
    if (lx < -halfW - grab || lx > halfW + grab) return null;
    if (ly > grab || ly < -h - grab) return null;
    if (lx > halfW - 46 / k) return 'rotate';
    return 'body';
  }

  #onDblClick(ev) {
    const sp = this.#localPoint(ev);
    const wp = screenToWorld(this.camera, sp.x, sp.y);
    const tool = this.currentTool;
    // Tools may handle double-click themselves; otherwise fall back to opening
    // the inline editor for whatever editable object is under the pointer, so
    // double-click works no matter which tool happens to be active.
    if (tool?.dblclick) { tool.dblclick(this, wp, ev, sp); return; }
    const hit = this.pickAt(wp);
    if (Editor.isEditable(hit)) {
      this.selection.clear();
      this.selection.add(hit);
      this.onSelectionChange?.();
      this.editElement(hit, {});
    }
  }

  #onWheel(ev) {
    ev.preventDefault();
    const sp = this.#localPoint(ev);
    if (this.rulerAt(sp)) {
      // Hovering the ruler and scrolling rotates it.
      this.ruler.angle += (ev.deltaY > 0 ? 1 : -1) * (ev.shiftKey ? 0.002 : 0.01);
      this.requestRender();
      return;
    }
    if (ev.ctrlKey || ev.metaKey) {
      const factor = Math.exp(-ev.deltaY * 0.0022);
      this.zoomAt(this.camera.zoom * factor, sp.x, sp.y);
      return;
    }
    if (ev.shiftKey) this.panBy(-ev.deltaY - ev.deltaX, 0);
    else this.panBy(-ev.deltaX, -ev.deltaY);
  }

  /* ---------------------------------------------------------------- *
   * Selection chrome
   * ---------------------------------------------------------------- */
  #drawSelection(ctx, env) {
    if (!this.selection.size) return;
    const k = env.zoom;
    const frame = this.selectionFrame();
    if (!frame.local) return;
    ctx.save();
    ctx.strokeStyle = '#0F6CBD';
    ctx.lineWidth = 1.4 / k;
    for (const e of this.selection) {
      const b = localBounds(e);
      if (e.rotation && IS_OBJECT.has(e.type)) {
        ctx.save();
        ctx.translate(b.cx, b.cy);
        ctx.rotate(e.rotation);
        ctx.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h);
        ctx.restore();
      } else {
        ctx.strokeRect(b.x, b.y, b.w, b.h);
      }
    }
    if (!this._hideHandles) {
      const s = 7 / k;
      ctx.fillStyle = '#FFFFFF';
      ctx.lineWidth = 1.4 / k;
      ctx.strokeStyle = '#0F6CBD';
      for (const h of handlePositions(frame.aabb, frame.rot, frame.local)) {
        ctx.beginPath();
        ctx.rect(h.x - s / 2, h.y - s / 2, s, s);
        ctx.fill();
        ctx.stroke();
      }
      const rh = rotateHandlePosition(frame.aabb, frame.rot, frame.local, 26 / k);
      ctx.beginPath();
      ctx.arc(rh.x, rh.y, s * 0.62, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(
        frame.rot ? rotatePoint(frame.local.cx, frame.local.top, frame.local.cx, frame.local.cy, frame.rot).x : frame.local.cx,
        frame.rot ? rotatePoint(frame.local.cx, frame.local.top, frame.local.cx, frame.local.cy, frame.rot).y : frame.local.top,
      );
      ctx.lineTo(rh.x, rh.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------------- *
   * Laser pointer
   * ---------------------------------------------------------------- */
  startLaser(pts) {
    this.laser = { pts: pts ? pts.slice() : [], t: performance.now() };
    this.#laserTick();
  }

  pulseLaser(pts) {
    if (pts && pts.length) this.laser = { pts: pts.slice(), t: performance.now() };
    this.#laserTick();
  }

  clearLaser() { this.laser = null; this.requestRender(); }

  #laserTick() {
    if (this._laserRunning) return;
    this._laserRunning = true;
    const step = () => {
      if (!this.laser) { this._laserRunning = false; this.requestRender(); return; }
      const age = performance.now() - this.laser.t;
      if (age > 1800) { this.laser = null; this._laserRunning = false; this.requestRender(); return; }
      this.requestRender();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  #drawLaser(ctx, env) {
    if (!this.laser || this.laser.pts.length < 2) return;
    const age = performance.now() - this.laser.t;
    const alpha = clamp(1 - age / 1800, 0, 1);
    const k = env.zoom;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(232,17,37,0.30)';
    ctx.lineWidth = 12 / k;
    ctx.beginPath();
    ctx.moveTo(this.laser.pts[0].x, this.laser.pts[0].y);
    for (const p of this.laser.pts) ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,60,80,0.95)';
    ctx.lineWidth = 4 / k;
    ctx.stroke();
    const tip = this.laser.pts[this.laser.pts.length - 1];
    const g = ctx.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, 16 / k);
    g.addColorStop(0, 'rgba(255,120,130,0.95)');
    g.addColorStop(1, 'rgba(255,60,80,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 16 / k, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /* ---------------------------------------------------------------- *
   * Snap guides
   * ---------------------------------------------------------------- */
  #drawSnapGuides(ctx, env) {
    if (!this.guides || !this.guides.length) return;
    const k = env.zoom;
    const pad = 40 / k;
    ctx.save();
    ctx.strokeStyle = '#E71125';
    ctx.lineWidth = 1 / k;
    ctx.setLineDash([5 / k, 4 / k]);
    for (const g of this.guides) {
      ctx.beginPath();
      if (g.axis === 'x') { ctx.moveTo(g.at, g.from - pad); ctx.lineTo(g.at, g.to + pad); }
      else { ctx.moveTo(g.from - pad, g.at); ctx.lineTo(g.to + pad, g.at); }
      ctx.stroke();
    }
    ctx.restore();
  }

  #drawRuler(ctx, env) {    const r = this.ruler;
    if (!r.active && !this._showRulerGhost) return;
    const k = env.zoom;
    ctx.save();
    ctx.translate(r.cx, r.cy);
    ctx.rotate(r.angle);
    const h = 46, w = r.length;
    const grd = ctx.createLinearGradient(0, -h, 0, 0);
    grd.addColorStop(0, 'rgba(250,250,250,0.97)');
    grd.addColorStop(1, 'rgba(214,222,232,0.97)');
    ctx.fillStyle = grd;
    ctx.strokeStyle = 'rgba(90,100,115,0.85)';
    ctx.lineWidth = 1 / k;
    ctx.beginPath();
    ctx.rect(-w / 2, -h, w, h);
    ctx.fill();
    ctx.stroke();
    // ticks
    ctx.strokeStyle = 'rgba(70,80,95,0.75)';
    ctx.beginPath();
    for (let x = -w / 2; x <= w / 2; x += 5) {
      const big = Math.round(x) % 25 === 0;
      ctx.moveTo(x, -h);
      ctx.lineTo(x, -h + (big ? 12 : 6));
    }
    ctx.stroke();
    ctx.restore();
  }

  handleAt(screenPt) {
    if (!this.selection.size || this._hideHandles) return null;
    const frame = this.selectionFrame();
    if (!frame.local) return null;
    const s = 9;
    for (const h of handlePositions(frame.aabb, frame.rot, frame.local)) {
      const sp = worldToScreen(this.camera, h.x, h.y);
      if (Math.abs(sp.x - screenPt.x) <= s && Math.abs(sp.y - screenPt.y) <= s) return h.id;
    }
    const rh = rotateHandlePosition(frame.aabb, frame.rot, frame.local, 26 / this.camera.zoom);
    const sp = worldToScreen(this.camera, rh.x, rh.y);
    if (Math.hypot(sp.x - screenPt.x, sp.y - screenPt.y) <= s) return 'rotate';
    return null;
  }

  /** Which cursor to show for a hovered handle id. */
  static handleCursor(id) {
    return { nw: 'nwse-resize', n: 'ns-resize', ne: 'nesw-resize', e: 'ew-resize', se: 'nwse-resize', s: 'ns-resize', sw: 'nesw-resize', w: 'ew-resize', rotate: 'grab' }[id] || 'default';
  }

  /* ---------------------------------------------------------------- *
   * Inline editors are provided by the UI layer
   * ---------------------------------------------------------------- */
  commitInlineEditor() { this.inline?.commit(true); }

  /** Open the inline DOM editor for a text box, sticky note or table. */
  editElement(e, opts = {}) {
    if (!this.inline) return;
    this.inline.onCommit = (target, info) => {
      if (info.changed) return;
      // A brand-new, still-empty object is discarded instead of left behind.
      const empty = (target.type === T.TEXT || target.type === T.STICKY) && !String(target.text || '').trim();
      if (empty) this.removeElements([target], '取消添加');
    };
    this.inline.edit(e, opts);
  }

  screenToWorld(sx, sy) { return screenToWorld(this.camera, sx, sy); }
  worldToScreen(wx, wy) { return worldToScreen(this.camera, wx, wy); }

  #updateCursor(sp) {
    const h = this.handleAt(sp);
    if (h) { this.canvas.style.cursor = Editor.handleCursor(h); return; }
    if (this.spaceDown) { this.canvas.style.cursor = 'grab'; return; }
    const r = this.rulerAt(sp);
    if (r) { this.canvas.style.cursor = r === 'rotate' ? 'grab' : 'move'; return; }
    this.canvas.style.cursor = this.currentTool?.cursor || 'default';
  }

  refreshCursor() { this.canvas.style.cursor = this.currentTool?.cursor || 'default'; }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
function bucket(z) {
  return Math.round(Math.log2(Math.max(z, 0.01)) * 2) / 2;
}

function pinchState(pointers) {
  const [a, b] = [...pointers.values()];
  return {
    dist: Math.hypot(a.x - b.x, a.y - b.y),
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
  };
}

export { screenToWorld, worldToScreen, rotatePoint, rectFromPoints, boundsOfRotatedRect, hitTest, elementPoints, elementBounds, elementCenter, translateElement, scaleElement, rotateElement };
export { handlePositions, rotateHandlePosition };
