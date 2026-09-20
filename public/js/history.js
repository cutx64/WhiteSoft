/**
 * Undo / redo.
 *
 * Every operation is recorded as a pair of closures, which keeps memory
 * proportional to what actually changed rather than to the whole document
 * (important when a single page can hold several thousand strokes).
 */
import { clone } from './util.js';

export class History {
  constructor(limit = 300) {
    this.limit = limit;
    this.stack = [];
    this.index = -1;
    this.onChange = null;
  }

  get canUndo() { return this.index >= 0; }
  get canRedo() { return this.index < this.stack.length - 1; }
  get undoLabel() { return this.canUndo ? this.stack[this.index].label : null; }
  get redoLabel() { return this.canRedo ? this.stack[this.index + 1].label : null; }

  /**
   * @param {string} label   human readable name shown in the toolbar tooltip
   * @param {() => void} undo
   * @param {() => void} redo
   */
  push(label, undo, redo) {
    this.stack.length = this.index + 1;
    this.stack.push({ label, undo, redo });
    if (this.stack.length > this.limit) this.stack.shift();
    this.index = this.stack.length - 1;
    this.onChange?.();
  }

  undo() {
    if (!this.canUndo) return false;
    const e = this.stack[this.index--];
    e.undo();
    this.onChange?.();
    return e.label;
  }

  redo() {
    if (!this.canRedo) return false;
    const e = this.stack[++this.index];
    e.redo();
    this.onChange?.();
    return e.label;
  }

  clear() { this.stack = []; this.index = -1; this.onChange?.(); }
}

/** Snapshot helper for a whole page's element list. */
export function pageSnapshot(page) {
  return { elements: clone(page.elements), pdfPages: clone(page.pdfPages || []) };
}

export function restorePage(page, snap) {
  page.elements = clone(snap.elements);
  if (snap.pdfPages) page.pdfPages = clone(snap.pdfPages);
}
