/**
 * Inline editors.
 *
 * Text, sticky notes and table cells are edited with real DOM nodes layered
 * over the canvas.  Using DOM, rather than drawing a caret on the canvas, is
 * what makes IME composition work for Chinese / Japanese input.
 */
import { Rect } from './geometry.js';
import { T, fontString, fontFamilyCss, textPadding, LINE_HEIGHT } from './elements.js';
import { argbToRgba } from './util.js';
import { el } from './util.js';
import { layoutRichText, ensureMathJax, hasMathSyntax } from './mathtext.js';

export class InlineEditor {
  constructor(editor) {
    this.editor = editor;
    this.current = null;
    this.node = null;
    this.cells = null;
    this._unbind = [];
    this.onCommit = null;
  }

  get isEditing() { return !!this.current; }

  /**
   * @param {object} target element being edited
   * @param {{selectAll?: boolean}} opts
   */
  edit(target, opts = {}) {
    this.commit();
    const ed = this.editor;
    const page = ed.page;
    this.current = target;
    this.before = JSON.parse(JSON.stringify(target));
    // The canvas draws this element's raw source while it is being edited
    // instead of typeset math, so the cached raster has to be rebuilt.
    ed.invalidate();

    if (target.type === T.TABLE) return this.#editTable(target, opts);
    return this.#editTextLike(target, opts);
  }

  /* ---------------------------------------------------------------- */
  #editTextLike(target, opts) {
    const ed = this.editor;
    const wrap = el('div', { class: 'wb-inline-editor' });
    const ta = el('textarea', { class: 'wb-inline-textarea', spellcheck: 'false' });
    ta.value = target.text || '';
    wrap.append(ta);
    ed.host.append(wrap);
    this.node = wrap;

    this.#styleTextLike(wrap, ta, target);
    const reposition = () => this.#styleTextLike(wrap, ta, target);
    this.#listenCamera(reposition);

    const commit = (save) => this.commit(save);
    ta.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
      else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); commit(true); }
    });
    ta.addEventListener('input', () => {
      target.text = ta.value;
      // Typing is a content change like any other: mark the board dirty so the
      // save state, and the auto-save timer, sees it before the editor closes.
      ed.onContentChange?.();
      // Start fetching MathJax as soon as LaTeX shows up, so the formulas are
      // typeset the moment the editor closes.
      if (hasMathSyntax(ta.value)) ensureMathJax(target.mathFont).catch(() => {});
      ed.renderer.invalidate();
      ed.requestRender();
      this.#grow(wrap, ta, target);
    });
    ta.addEventListener('blur', () => { if (this.current === target) commit(true); });

    requestAnimationFrame(() => {
      ta.focus();
      if (opts.selectAll) ta.select();
      else ta.setSelectionRange(ta.value.length, ta.value.length);
    });
    return wrap;
  }

  #grow(wrap, ta, target) {
    const ed = this.editor;
    const zoom = ed.camera.zoom;
    const size = (target.fontSize || 20) * zoom;
    ta.style.height = 'auto';
    const h = Math.max(ta.scrollHeight, size * LINE_HEIGHT);
    ta.style.height = h + 'px';
    wrap.style.height = h + 'px';
    const w = Math.max(ta.scrollWidth, 30);
    // A plain text box widens with its text; a box with a background keeps the
    // width the user gave it and wraps inside, like a note.
    if (target.type === T.TEXT && !target.fill) {
      const minW = Math.max(w, 30);
      if (minW > parseFloat(wrap.style.width || '0')) wrap.style.width = minW + 'px';
    }
  }

  #styleTextLike(wrap, ta, target) {
    const ed = this.editor;
    const b = Rect.parse(target.bounds);
    const s = ed.worldToScreen(b.x, b.y);
    const zoom = ed.camera.zoom;
    const size = (target.fontSize || 20) * zoom;
    // Text boxes and notes both keep the text a padding away from their edge,
    // and the editor has to sit exactly where the canvas draws the text.
    const pad = textPadding(b) * zoom;

    Object.assign(wrap.style, {
      position: 'absolute',
      left: (s.x + pad) + 'px',
      top: (s.y + pad) + 'px',
      width: Math.max(20, b.w * zoom - pad * 2) + 'px',
      height: Math.max(size * LINE_HEIGHT, b.h * zoom - pad * 2) + 'px',
      transform: target.rotation ? `rotate(${target.rotation}rad)` : '',
      transformOrigin: 'center center',
      zIndex: 40,
    });
    Object.assign(ta.style, {
      width: '100%',
      height: '100%',
      minHeight: size * LINE_HEIGHT + 'px',
      font: fontString(size, target),
      lineHeight: LINE_HEIGHT,
      color: argbToRgba(target.textColor || '#FF000000'),
      background: 'transparent',
      border: 'none',
      outline: 'none',
      resize: 'none',
      overflow: 'hidden',
      padding: '0',
      margin: '0',
      textAlign: target.textAlign || 'left',
      caretColor: argbToRgba(target.textColor || '#FF000000'),
      fontFamily: fontFamilyCss(target.fontFamily),
    });
  }

  /* ---------------------------------------------------------------- */
  #editTable(target, opts) {
    const ed = this.editor;
    const wrap = el('div', { class: 'wb-inline-editor wb-table-editor' });
    ed.host.append(wrap);
    this.node = wrap;
    this.cells = [];
    const cellNodes = [];

    const build = () => {
      wrap.textContent = '';
      this.cells = [];
      const b = Rect.parse(target.bounds);
      const totalW = target.colWidths.reduce((a, c) => a + c, 0) || b.w;
      const totalH = target.rowHeights.reduce((a, c) => a + c, 0) || b.h;
      const sx = (b.w / totalW) * ed.camera.zoom;
      const sy = (b.h / totalH) * ed.camera.zoom;
      const origin = ed.worldToScreen(b.x, b.y);
      Object.assign(wrap.style, {
        position: 'absolute',
        left: origin.x + 'px',
        top: origin.y + 'px',
        width: b.w * ed.camera.zoom + 'px',
        height: b.h * ed.camera.zoom + 'px',
        transform: target.rotation ? `rotate(${target.rotation}rad)` : '',
        transformOrigin: 'center center',
        zIndex: 40,
      });
      let y = 0;
      for (let r = 0; r < target.rows; r++) {
        let x = 0;
        for (let c = 0; c < target.cols; c++) {
          const w = target.colWidths[c] * sx;
          const h = target.rowHeights[r] * sy;
          const cell = el('div', { class: 'wb-table-cell', contenteditable: 'true', spellcheck: 'false' });
          cell.textContent = target.cells?.[r]?.[c] || '';
          Object.assign(cell.style, {
            position: 'absolute', left: x + 'px', top: y + 'px',
            width: w + 'px', height: h + 'px',
            boxSizing: 'border-box',
            border: '1px solid ' + argbToRgba(target.stroke || '#FF808285'),
            padding: '4px 6px',
            fontSize: (target.fontSize || 16) * ed.camera.zoom + 'px',
            fontFamily: fontFamilyCss(null),
            color: argbToRgba(target.textColor || '#FF000000'),
            fontWeight: target.headerRow && r === 0 ? '700' : '400',
            background: target.headerRow && r === 0 ? 'rgba(0,0,0,0.05)' : 'transparent',
            overflow: 'hidden',
            outline: 'none',
          });
          cell.addEventListener('input', () => {
            if (!target.cells[r]) target.cells[r] = [];
            target.cells[r][c] = cell.textContent;
            ed.onContentChange?.(); // see the text editor above
            ed.renderer.invalidate();
            ed.requestRender();
          });
          cell.addEventListener('keydown', (ev) => {
            ev.stopPropagation();
            if (ev.key === 'Escape') { ev.preventDefault(); this.commit(true); }
            if (ev.key === 'Tab') {
              ev.preventDefault();
              const list = this.cells;
              const i = list.indexOf(cell);
              const next = list[i + (ev.shiftKey ? -1 : 1)];
              next?.focus();
            }
          });
          wrap.append(cell);
          this.cells.push(cell);
          cellNodes.push({ r, c, node: cell });
          x += w;
        }
        y += target.rowHeights[r] * sy;
      }
    };
    build();
    this._tableRebuild = build;
    this.#listenCamera(build);

    requestAnimationFrame(() => { this.cells[0]?.focus(); void opts; });
    return wrap;
  }

  #listenCamera(fn) {
    const ed = this.editor;
    const prev = ed.onCameraChange;
    const handler = () => fn();
    this._unbind.push(() => { ed.onCameraChange = prev; });
    ed.onCameraChange = () => { prev?.(); handler(); };
  }

  /* ---------------------------------------------------------------- */
  commit(save = true) {
    const target = this.current;
    if (!target) return;
    this.current = null;
    for (const u of this._unbind) u();
    this._unbind = [];
    this.node?.remove();
    this.node = null;
    this.cells = null;
    this._tableRebuild = null;

    const ed = this.editor;
    // Repaint without the plain-source override, so TeX comes back.
    ed.invalidate();
    const before = this.before;
    const after = JSON.parse(JSON.stringify(target));
    this.before = null;
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    if (!save || !changed) {
      // Revert wholly-empty creations handled by the caller.
      if (this.onCommit) this.onCommit(target, { changed: false, before, after });
      return;
    }
    // Text without a background shrinks to fit the content it grew to; a box
    // with a background keeps the shape the user gave it, like a note.
    if (target.type === T.TEXT && !target.fill) fitTextBox(target);
    ed.history.push('编辑内容',
      () => { Object.assign(target, before); ed.invalidate(); },
      () => { Object.assign(target, after); ed.invalidate(); });
    ed.invalidate();
    if (this.onCommit) this.onCommit(target, { changed: true, before, after });
  }
}

/** Grow/shrink a plain text box so the box matches the text it holds. */
export function fitTextBox(e) {
  const b = Rect.parse(e.bounds);
  const size = e.fontSize || 20;
  const c = fitTextBox._c || (fitTextBox._c = document.createElement('canvas').getContext('2d'));
  c.font = fontString(size, e);
  // Math-aware: a `$…$` atom counts as one unbreakable box, so the fitted
  // width has to come from the same layout the renderer uses.
  const lines = layoutRichText(c, e.text || '', size, Infinity, e);
  let w = 0;
  let h = 0;
  for (const line of lines) {
    w = Math.max(w, line.w);
    // A display formula is taller than a line box, and the box has to hold it.
    h += line.height;
  }
  if (e.text === '') w = size * 2;
  // The fitted box has to hold the padding on both sides as well as the text.
  let width = Math.max(w + size * 0.4, size);
  width += textPadding({ w: width }) * 2;
  const height = h || size * LINE_HEIGHT;
  e.bounds = new Rect(b.x, b.y, width, height + textPadding({ w: width }) * 2).toString();
}
