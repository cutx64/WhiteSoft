/**
 * Open documents.
 *
 * The app can hold several boards at once and shows one of them in the canvas.
 * Each entry keeps everything a board owns — the document model, its image
 * cache, its undo stack and where the camera was — so switching tabs is a swap
 * rather than a reload: images stay decoded and undo history survives.
 *
 * The editor is shared.  Swapping a board in means pointing its `doc`,
 * `resources` and `history` at that board's copies, which is the same public
 * surface the single-document app always used.
 */
import { createDocument } from './document.js';
import { ResourceStore } from './resources.js';
import { History } from './history.js';

let seq = 0;

/** A fresh, unsaved board. */
export function blankDocument() {
  const doc = createDocument();
  doc.name = '未命名白板';
  return doc;
}

/**
 * One open board.
 *
 * `view` holds what is not part of the document: page index and camera.  A
 * board that has never been shown keeps `view` null and starts centred.
 */
export class DocTab {
  constructor(doc, { id = null } = {}) {
    this.id = id || `tab${++seq}`;
    this.doc = doc;
    this.resources = new ResourceStore();
    this.history = new History();
    this.view = null;
    this.dirty = false;
    this.pristine = true;
  }

  get name() { return this.doc.name || '未命名白板'; }

  /** True when the board has no file behind it and was never edited. */
  get reusable() {
    return !this.doc.fileHandle && !this.dirty && this.pristine;
  }

  captureView(editor) {
    this.view = {
      pageIndex: editor.pageIndex,
      x: editor.camera.x,
      y: editor.camera.y,
      zoom: editor.camera.zoom,
    };
    this.doc.currentPage = editor.pageIndex;
  }
}

export class Workspace {
  /** @param {import('./editor.js').Editor} editor */
  constructor(editor) {
    this.editor = editor;
    this.tabs = [];
    this.activeId = null;
    this.onChange = null;
  }

  get active() {
    return this.tabs.find((t) => t.id === this.activeId) || null;
  }

  get count() { return this.tabs.length; }

  /** Open a board as a new tab and show it. */
  add(doc, { activate = true } = {}) {
    const tab = new DocTab(doc);
    this.tabs.push(tab);
    if (activate) this.activate(tab.id);
    else this.onChange?.();
    return tab;
  }

  /**
   * The tab a newly opened file should land in: the empty board the window
   * starts with, or a brand new tab when the current one holds real work.
   */
  slotForNewFile() {
    const current = this.active;
    if (current && current.reusable) return current;
    return null;
  }

  /** Show `id`. The currently shown board records its view first. */
  activate(id) {
    if (id === this.activeId) return;
    const next = this.tabs.find((t) => t.id === id);
    if (!next) return;
    const current = this.active;
    if (current) current.captureView(this.editor);
    this.activeId = id;
    this.show(next);
    this.onChange?.();
  }

  /** Point the editor at a tab without going through `activate`. */
  show(tab) {
    const ed = this.editor;
    ed.setDocument(tab.doc, { resources: tab.resources, history: tab.history });
    if (tab.view) {
      ed.gotoPage(tab.view.pageIndex, { fit: false });
      ed.camera.x = tab.view.x;
      ed.camera.y = tab.view.y;
      ed.camera.zoom = tab.view.zoom;
      ed.onCameraChange?.();
      ed.invalidate();
      ed.requestRender();
    }
  }

  /** Replace the board inside an existing tab, keeping the tab in place. */
  load(tab, doc) {
    tab.doc = doc;
    tab.dirty = false;
    tab.pristine = false;
    tab.view = null;
    if (tab.id === this.activeId) {
      this.editor.setDocument(doc, { resources: tab.resources, history: tab.history });
      tab.history.clear();
    }
    this.onChange?.();
  }

  /**
   * Close a tab. Returns the id that should be shown next, or null when the
   * last tab went away.
   */
  close(id) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return this.activeId;
    const [gone] = this.tabs.splice(i, 1);
    gone.resources.clear();
    if (this.activeId !== id) {
      this.onChange?.();
      return this.activeId;
    }
    const next = this.tabs[Math.min(i, this.tabs.length - 1)] || null;
    this.activeId = null;
    if (next) {
      this.activeId = next.id;
      this.show(next);
    }
    this.onChange?.();
    return this.activeId;
  }

  /** Every tab, oldest first, for the tab strip. */
  list() { return this.tabs.slice(); }

  /** The active board changed on disk state, repaint the strip. */
  touch() { this.onChange?.(); }
}
