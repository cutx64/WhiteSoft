/**
 * Inline editors.
 *
 * Text, sticky notes and table cells are edited with real DOM nodes layered
 * over the canvas.  Using DOM (rather than drawing a caret on the canvas) is
 * what makes IME composition work for Chinese / Japanese input.
 */
import { Rect } from './geometry.js';
import { T, fontString, LINE_HEIGHT } from './elements.js';
import { argbToRgba } from './util.js';
import { el } from './util.js';

const FONT_STACK = '"Segoe UI","Microsoft YaHei","PingFang SC","Hiragino Sans GB","Source Han Sans SC",system-ui,sans-serif';

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
    if (target.type === T.TEXT) {
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
    const isNote = target.type === T.STICKY;
    const padX = isNote ? Math.min(10, b.w * 0.08) * zoom : 0;
    const padY = isNote ? Math.min(10, b.w * 0.08) * zoom : 0;

    Object.assign(wrap.style, {
      position: 'absolute',
      left: (s.x + padX) + 'px',
      top: (s.y + padY) + 'px',
      width: Math.max(20, b.w * zoom - padX * 2) + 'px',
      height: Math.max(size * LINE_HEIGHT, b.h * zoom - padY * 2) + 'px',
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
      fontFamily: FONT_STACK,
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
            fontFamily: FONT_STACK,
            color: argbToRgba(target.textColor || '#FF000000'),
            fontWeight: target.headerRow && r === 0 ? '700' : '400',
            background: target.headerRow && r === 0 ? 'rgba(0,0,0,0.05)' : 'transparent',
            overflow: 'hidden',
            outline: 'none',
          });
          cell.addEventListener('input', () => {
            if (!target.cells[r]) target.cells[r] = [];
            target.cells[r][c] = cell.textContent;
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
    const before = this.before;
    const after = JSON.parse(JSON.stringify(target));
    this.before = null;
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    if (!save || !changed) {
      // Revert wholly-empty creations handled by the caller.
      if (this.onCommit) this.onCommit(target, { changed: false, before, after });
      return;
    }
    // Text/notes shrink to fit the content they grew to.
    if (target.type === T.TEXT) fitTextBox(target);
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
  const lines = String(e.text || '').split('\n');
  let w = 0;
  for (const line of lines) w = Math.max(w, c.measureText(line).width);
  if (e.text === '') w = size * 2;
  e.bounds = new Rect(b.x, b.y, Math.max(w + size * 0.4, size), Math.max(lines.length, 1) * size * LINE_HEIGHT).toString();
}
