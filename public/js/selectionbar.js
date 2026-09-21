/**
 * Floating action bar for the current selection.
 *
 * Appears just below the selection's bounding box and carries the operations
 * that are useful once something is selected: opening a single text box or
 * sticky for editing, restyling sticky notes, recolouring, copying the
 * selection onto another page, clipboard actions and z-order.
 */
import { el, $, $$, argbToHex, argbToRgba, clamp } from './util.js';
import { T, PALETTE, IS_OBJECT } from './elements.js';

const ICON = {
  color: '<circle cx="12" cy="12" r="8"/><path d="M12 4v16"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  prev: '<path d="M15 5l-7 7 7 7"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  page: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14"/>',
  front: '<rect x="3" y="3" width="12" height="12" rx="1"/><path d="M9 21h12V9"/>',
  back: '<rect x="9" y="9" width="12" height="12" rx="1"/><path d="M15 3H3v12"/>',
  bottom: '<rect x="9" y="9" width="12" height="12" rx="1"/><path d="M15 3H3v12"/><path d="M3 21h18"/>',
  duplicate: '<rect x="3" y="3" width="12" height="12" rx="1"/><rect x="9" y="9" width="12" height="12" rx="1"/>',
  scissors: '<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><path d="M20 4L8.6 15.4M20 20L8.6 8.6"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  edit: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M15 6l3 3"/>',
  style: '<rect x="3.5" y="4.5" width="17" height="15" rx="4"/><path d="M7.5 10h9M7.5 14h5"/>',
};

const svg = (d, size = 16) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

export class SelectionBar {
  constructor(ui) {
    this.ui = ui;
    this.editor = ui.editor;
    this.node = null;
    this.popover = null;
    this.hidden = false;
  }

  get visible() { return !!this.node && !this.node.classList.contains('hidden'); }

  /** Called on every render; keeps the bar glued to the selection. */
  update() {
    const ed = this.editor;
    const rect = ed.selection.size ? ed.selectionScreenRect() : null;
    // Hidden while a drag/transform is in flight so it can never swallow the
    // gesture, and while text is being edited inline.
    const busy = ed.mode !== 'idle';
    if (!rect || this.hidden || busy || ed.inline?.isEditing) { this.remove(); return; }
    // The bar's contents depend on what is selected (a single text box can be
    // opened for editing, sticky notes can be restyled), so rebuild it only
    // when that shape changes.
    const shape = this.shape();
    if (!this.node || this.shapeKey !== shape) {
      this.shapeKey = shape;
      this.build();
    }
    this.position(rect);
  }

  /** Identity of the current selection as far as the bar's buttons are concerned. */
  shape() {
    const sel = [...this.editor.selection];
    const single = sel.length === 1 ? sel[0].type : 0;
    const sticky = sel.filter((e) => e.type === T.STICKY).length;
    return `${sel.length}|${single}|${sticky}`;
  }

  build() {
    const ed = this.editor;
    const sel = [...ed.selection];
    const only = sel.length === 1 ? sel[0] : null;
    const editable = only && (only.type === T.TEXT || only.type === T.STICKY) ? only : null;
    const stickies = sel.filter((e) => e.type === T.STICKY);

    // Rebuilding detaches the buttons a popover/flyout may be anchored to.
    if (this.node && this.ui.flyoutAnchor && this.node.contains(this.ui.flyoutAnchor)) this.ui.closeFlyout();
    this.closePopover();
    this.node?.remove();

    const b = (icon, title, fn, cls = '') => el('button', {
      class: `wb-selbtn ${cls}`, type: 'button', title,
      html: svg(ICON[icon]),
      onpointerdown: (e) => e.stopPropagation(),
      onclick: (e) => { e.stopPropagation(); fn(e.currentTarget); },
    });

    this.node = el('div', { class: 'wb-selbar' },
      // Editing a single text box / sticky straight from the bar saves the
      // double click that would otherwise be needed.
      editable ? b('edit', only.type === T.STICKY ? '编辑便签文字' : '编辑文字',
        () => ed.editElement(only, { selectAll: false })) : null,
      editable ? el('div', { class: 'wb-selbar-sep' }) : null,
      b('color', '改变颜色', (btn) => this.openColorPicker(btn)),
      stickies.length ? b('style', `便签样式（圆角 / 颜色 / 透明度）—— 已选 ${stickies.length} 张`,
        (btn) => this.ui.openStickyStyleFlyout(btn)) : null,
      el('div', { class: 'wb-selbar-sep' }),
      b('prev', '复制到上一页', () => this.copyTo(-1)),
      b('next', '复制到下一页', () => this.copyTo(1)),
      b('page', '复制到指定页…', () => this.openPagePrompt()),
      el('div', { class: 'wb-selbar-sep' }),
      b('copy', '复制 (Ctrl+C)', () => { ed.copySelection(false); this.ui.toast('已复制'); }),
      b('duplicate', '再制 (Ctrl+D)', () => ed.duplicateSelection()),
      b('trash', '删除 (Delete)', () => this.ui.app.deleteSelection(), 'danger'),
      el('div', { class: 'wb-selbar-sep' }),
      b('front', '置于顶层', () => ed.reorderSelection('front')),
      b('back', '置于底层', () => ed.reorderSelection('back')),
      b('bottom', '移到图层最底层', () => { ed.reorderSelection('back'); this.ui.toast('已移到最底层', 'ok', 1400); }),
      b('close', '隐藏操作栏（工具栏「操作栏」按钮可恢复）', () => {
        this.hidden = true;
        this.ui.showSelectionBar(true);
        this.remove();
      }),
    );
    this.node.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.editor.host.append(this.node);
  }

  remove() {
    this.closePopover();
    this.node?.remove();
    this.node = null;
    this.shapeKey = null;
  }

  position(rect) {
    const host = this.editor.host.getBoundingClientRect();
    const w = this.node.offsetWidth || 300;
    const h = this.node.offsetHeight || 34;
    const left = rect.x + rect.w / 2 - w / 2;
    // Below the selection by default: the rotate grip lives directly above it.
    let top = rect.y + rect.h + 16;
    if (top + h > host.height - 6) top = rect.y - h - 40;
    this.node.style.left = clamp(left, 6, Math.max(6, host.width - w - 6)) + 'px';
    this.node.style.top = clamp(top, 6, Math.max(6, host.height - h - 6)) + 'px';
  }

  /* ---------------------------------------------------------------- */
  copyTo(delta) {
    const ed = this.editor;
    const target = ed.pageIndex + delta;
    if (target < 0 || target >= ed.pageCount) {
      this.ui.toast(delta < 0 ? '已经是第一页' : '已经是最后一页', 'warn', 1600);
      return;
    }
    const n = ed.copySelectionToPage(target);
    if (n) this.ui.toast(`已复制 ${n} 个对象到第 ${target + 1} 页`, 'ok');
  }

  copyToPage(index) {
    const ed = this.editor;
    const n = ed.copySelectionToPage(index);
    if (n) this.ui.toast(`已复制 ${n} 个对象到第 ${index + 1} 页`, 'ok');
    return n;
  }

  openPagePrompt() {
    const ed = this.editor;
    const input = el('input', {
      class: 'wb-input wb-selpage-input', type: 'text', inputmode: 'numeric',
      placeholder: `1 – ${ed.pageCount}`, value: String(ed.pageIndex + 1),
    });
    const hint = el('div', { class: 'wb-hint', text: `复制到第几页？（共 ${ed.pageCount} 页）` });
    const pop = el('div', { class: 'wb-selpopover' },
      hint,
      el('div', { class: 'wb-row' }, input,
        el('button', {
          class: 'wb-primary', type: 'button', text: '复制',
          onclick: () => {
            const n = parseInt(input.value, 10);
            if (!Number.isFinite(n) || n < 1 || n > ed.pageCount) { hint.textContent = `请输入 1 – ${ed.pageCount} 之间的页码`; return; }
            if (n - 1 === ed.pageIndex) { hint.textContent = '这就是当前页，请换一个页码'; return; }
            this.copyToPage(n - 1);
            this.closePopover();
          },
        }),
      ),
    );
    this.openPopover(pop);
    requestAnimationFrame(() => { input.focus(); input.select(); });
  }

  /* ---------------------------------------------------------------- */
  /** Which palette makes sense for what is selected right now. */
  paletteForSelection() {
    const sel = [...this.editor.selection];
    if (sel.length && sel.every((e) => e.type === T.STICKY)) return { colors: PALETTE.note, cols: 6, label: '便签颜色' };
    if (sel.length && sel.every((e) => e.type === T.TEXT)) return { colors: PALETTE.text, cols: 5, label: '文字颜色' };
    if (sel.length && sel.every((e) => e.type === T.HIGHLIGHTER)) return { colors: PALETTE.highlighter, cols: 5, label: '荧光笔颜色' };
    return { colors: PALETTE.pen, cols: 5, label: '颜色' };
  }

  currentColor() {
    const sel = [...this.editor.selection];
    if (!sel.length) return null;
    const e = sel[0];
    if (e.type === T.TEXT) return e.textColor;
    if (e.type === T.STICKY) return e.color;
    return e.stroke || null;
  }

  openColorPicker(anchor) {
    const ed = this.editor;
    const { colors, cols, label } = this.paletteForSelection();
    const cur = this.currentColor();
    const grid = el('div', { class: 'wb-swatches' });
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    for (const c of colors) {
      grid.append(el('button', {
        // Compare on RGB: a translucent sticky still shows its hue as active.
        class: 'wb-swatch' + (cur && argbToHex(c.argb).toUpperCase() === argbToHex(cur).toUpperCase() ? ' active' : ''),
        type: 'button', title: c.name, style: { background: argbToHex(c.argb) },
        onclick: () => {
          const n = ed.applySelectionColor(c.argb);
          this.ui.toast(`已修改 ${n} 个对象的颜色`, 'ok', 1400);
          this.closePopover();
        },
      }));
    }
    const sel = [...ed.selection];
    const noColor = sel.length > 0 && sel.every((e) => IS_OBJECT.has(e.type) && e.type !== T.TEXT && e.type !== T.STICKY && e.type !== T.TABLE);
    const pop = el('div', { class: 'wb-selpopover' },
      el('div', { class: 'wb-flyout-label', text: label }),
      grid,
      noColor ? el('p', { class: 'wb-hint', text: '所选对象（图片/反应）不支持改颜色。' }) : null,
    );
    this.openPopover(pop);
    void anchor;
  }

  openPopover(content) {
    this.closePopover();
    this.ui.flyoutLayer.append(content);
    const r = this.node.getBoundingClientRect();
    const w = content.offsetWidth, h = content.offsetHeight;
    content.style.left = clamp(r.left + r.width / 2 - w / 2, 8, window.innerWidth - w - 8) + 'px';
    const above = r.top - h - 10;
    content.style.top = clamp(above > 8 ? above : r.bottom + 10, 8, window.innerHeight - h - 8) + 'px';
    this.popover = content;
  }

  closePopover() {
    this.popover?.remove();
    this.popover = null;
  }
}
