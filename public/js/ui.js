/**
 * User interface.
 *
 * Layout follows Microsoft Whiteboard for Windows: a slim title bar, an
 * infinite canvas, a floating toolbar (bottom-centre by default, and movable to
 * any edge like the local app's "toolbar location" setting), and a status strip
 * whose right-hand side carries the zoom control and the page navigator with
 * its page-number box.
 */
import { el, $, $$, argbToHex, hexToArgb, argbAlpha, formatBytes, clamp, argbToRgba } from './util.js';
import { SceneRenderer, renderOptions } from './render.js';
import { SelectionBar } from './selectionbar.js';
import { T, PALETTE, GRADIENT_PENS, REACTIONS } from './elements.js';
import { AUTO_SAVE_CHOICES, autoSaveLabel } from './prefs.js';

const ICONS = {
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  select: '<path d="M4 3l7 17 2.2-6.8L20 11z"/>',
  marquee: '<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><path d="M9 9h6v6H9z"/>',
  pen: '<path d="M3 21l3.5-1 11-11a2.5 2.5 0 0 0-3.5-3.5l-11 11z"/><path d="M14 6l4 4"/>',
  highlighter: '<path d="M4 20h5"/><path d="M13 3l7 7-6.5 6.5H8L6.5 15z"/><path d="M9 20h11"/>',
  laser: '<path d="M10 3h4l1 9-3 2-3-2z"/><path d="M12 14v3"/><path d="M12 20l-3 2M12 20l3 2M12 20v2"/>',
  eraser: '<path d="M8 20H4l-1-1 12-12 6 6-6.5 6.5z"/><path d="M10 11l6 6"/>',
  hand: '<path d="M9 11.5V5.6a1.55 1.55 0 0 1 3.1 0v5.4"/><path d="M12.1 11V4.6a1.55 1.55 0 0 1 3.1 0V11"/><path d="M15.2 11.4V7.6a1.55 1.55 0 0 1 3.1 0V15a7 7 0 0 1-7 7h-.9a7 7 0 0 1-7-7v-2.4a1.55 1.55 0 0 1 3.1 0"/>',
  scissors: '<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><path d="M20 4L8.6 15.4M20 20L8.6 8.6"/>',
  ruler: '<path d="M3 15L15 3l6 6L9 21z"/><path d="M8 10l2 2M11 7l2 2M5 13l2 2"/>',
  shape: '<rect x="3" y="4" width="8" height="8" rx="1"/><circle cx="17" cy="8" r="4"/><path d="M8 21l3.5-7 3.5 7z"/>',
  text: '<path d="M5 5h14M12 5v14M9 19h6"/>',
  sticky: '<path d="M5 3h14v11l-5 5H5z"/><path d="M19 14h-5v5"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16M15 4v16"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-6 6-3-3-4 4"/>',
  reaction: '<path d="M12 21s-7-4.4-7-9.5A3.9 3.9 0 0 1 12 8.6a3.9 3.9 0 0 1 7 2.9C19 16.6 12 21 12 21z"/>',
  pages: '<rect x="3" y="3" width="7" height="8" rx="1"/><rect x="14" y="3" width="7" height="8" rx="1"/><rect x="3" y="13" width="7" height="8" rx="1"/><rect x="14" y="13" width="7" height="8" rx="1"/>',
  background: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a1.7 1.7 0 0 0-1.6-1H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 3 8.6a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 7 4.2h.1A1.7 1.7 0 0 0 8.6 3V3a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4M11 8v6M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4M8 11h6"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  fitPage: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 8h8v8H8z"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/>',
  open: '<path d="M3 6h6l2 2h10v11H3z"/>',
  pdf: '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v4h4"/><path d="M9 13h6M9 17h6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevronL: '<path d="M15 5l-7 7 7 7"/>',
  chevronR: '<path d="M9 5l7 7-7 7"/>',
  chevronU: '<path d="M5 15l7-7 7 7"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  front: '<rect x="3" y="3" width="12" height="12" rx="1"/><path d="M9 21h12V9"/>',
  back: '<rect x="9" y="9" width="12" height="12" rx="1"/><path d="M15 3H3v12"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.5-2"/>',
  wand: '<path d="M4 20L16 8"/><path d="M14 3l1 3 3 1-3 1-1 3-1-3-3-1 3-1z"/><path d="M19 13l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/>',
  dots: '<circle cx="6" cy="6" r="1.4"/><circle cx="12" cy="6" r="1.4"/><circle cx="18" cy="6" r="1.4"/><circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/><circle cx="6" cy="18" r="1.4"/><circle cx="12" cy="18" r="1.4"/><circle cx="18" cy="18" r="1.4"/>',
  lines: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  none: '<rect x="3" y="3" width="18" height="18" rx="2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.4v.6"/><circle cx="12" cy="17" r=".6"/>',
  export: '<path d="M12 3v12"/><path d="M8 11l4 4 4-4"/><path d="M4 17v3h16v-3"/>',
  eraserSm: '<path d="M8 20H4l-1-1 12-12 6 6-6.5 6.5z"/>',
};

function svg(paths, size = 20) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

const btn = (icon, title, onClick, cls = '') =>
  el('button', { class: `wb-btn ${cls}`, title, html: svg(ICONS[icon] || icon), onclick: onClick, type: 'button' });

export class UI {
  constructor(app, shell) {
    this.app = app;
    this.editor = app.editor;
    this.shell = shell;
    this.flyout = null;
    this.flyoutAnchor = null;
    this.build();
    this.editor.onToolChange = () => this.syncTools();
    this.editor.onSelectionChange = () => this.syncSelection();
    this.editor.onChange = () => this.syncStatus();
    this.editor.onCameraChange = () => this.syncZoom();
  }

  /* ---------------------------------------------------------------- */
  build() {
    const app = this.app;
    const root = $('#wb-app');

    /* ---- title bar ---- */
    this.titleInput = el('input', {
      class: 'wb-title', value: app.editor.doc.name, spellcheck: 'false',
      onchange: (e) => { app.editor.doc.name = e.target.value || '未命名白板'; },
    });
    this.saveState = el('span', { class: 'wb-savestate', text: '' });

    const titlebar = el('header', { class: 'wb-titlebar' },
      el('div', { class: 'wb-brand' },
        el('span', { class: 'wb-logo', html: svg('<path d="M3 4h18v13H3z"/><path d="M7 21l3-4M17 21l-3-4"/>', 22) }),
        el('span', { class: 'wb-brandname', text: 'WhiteSoft' }),
      ),
      el('div', { class: 'wb-titlewrap' }, this.titleInput, this.saveState),
      el('div', { class: 'wb-titleactions' },
        btn('open', '打开 .note 白板文件 (Ctrl+O)', () => app.showOpenDialog()),
        btn('save', '保存 .note (Ctrl+S) — 覆盖当前文件', () => app.save()),
        btn('copy', '另存为新的 .note 文件 (Ctrl+Shift+S)', () => app.saveAs()),
        btn('export', '导出 (PNG / PDF / Zip)', () => this.openExportDialog()),
        btn('pdf', '导入 PDF (Ctrl+Shift+I)', () => app.pickPdf()),
        btn('help', '键盘快捷键 (F1)', () => this.showShortcuts()),
      ),
    );

    /* ---- toolbar ---- */
    this.toolButtons = {};
    const defs = [
      ['select', 'select', '套索选择 (V / Alt+Q)'],
      ['marquee', 'marquee', '矩形框选 (M)'],
      ['pan', 'hand', '移动画布 (G) — 拖动平移；任何工具下也可按住空格拖动'],
      ['pen', 'pen', '笔 (P / Alt+W)'],
      ['highlighter', 'highlighter', '荧光笔 (H / Alt+H)'],
      ['laser', 'laser', '激光笔 (L / Alt+L)'],
      ['eraser', 'eraser', '橡皮擦 (E / Alt+X)'],
      ['ruler', 'ruler', '直尺 (R / Alt+R) — 沿尺边画直线'],
      ['shape', 'shape', '形状 (S)'],
      ['text', 'text', '文本框 (T)'],
      ['sticky', 'sticky', '便签 (N)'],
      ['reaction', 'reaction', '反应 (Alt+E)'],
    ];
    const toolEls = defs.map(([id, icon, title], i) => {
      const shortcut = i < 9 ? String(i + 1) : i === 9 ? '0' : null;
      const label = shortcut ? `${title.split(' — ')[0]} (${shortcut})${title.includes(' — ') ? ' — ' + title.split(' — ')[1] : ''}` : title;
      const b = btn(icon, label, () => this.selectTool(id), id === 'pen' || id === 'shape' ? 'has-caret' : '');
      b.dataset.tool = id;
      if (shortcut) {
        b.dataset.shortcut = shortcut;
        b.append(el('span', { class: 'wb-keybadge', text: shortcut }));
      }
      this.toolButtons[id] = b;
      return b;
    });
    this.toolOrder = defs.map(([id]) => id);

    this.undoBtn = btn('undo', '撤销 (Ctrl+Z)', () => app.undo());
    this.redoBtn = btn('redo', '重做 (Ctrl+Y)', () => app.redo());
    this.beautifyBtn = btn('wand', '墨迹转形状 (Alt+B)', () => this.app.beautify());
    this.deleteBtn = btn('trash', '删除所选 (Delete)', () => this.app.deleteSelection());
    this.selbarBtn = btn('select', '显示 / 隐藏所选操作栏', () => this.showSelectionBar());

    this.moreBtn = btn('more', '更多', (e) => this.openMoreFlyout(e.currentTarget));
    this.settingsBtn = btn('settings', '设置', (e) => this.openSettingsFlyout(e.currentTarget));

    this.toolbar = el('div', { class: 'wb-toolbar loc-bottom' },
      el('div', { class: 'wb-group' }, this.undoBtn, this.redoBtn),
      el('div', { class: 'wb-sep' }),
      el('div', { class: 'wb-group' }, toolEls),
      el('div', { class: 'wb-sep' }),
      el('div', { class: 'wb-group' }, this.beautifyBtn, this.deleteBtn, this.selbarBtn, this.moreBtn),
      el('div', { class: 'wb-sep' }),
      el('div', { class: 'wb-group' },
        btn('table', '插入表格 (B)', () => { this.editor.setTool('table'); this.syncTools(); }),
        btn('image', '插入图片 (Ctrl+V 粘贴)', () => this.app.pickImage()),
        btn('background', '画布背景', (e) => this.openBackgroundFlyout(e.currentTarget)),
        btn('pages', '页面面板 (Ctrl+Shift+P)', () => this.togglePages()),
        this.settingsBtn,
      ),
    );

    /* ---- canvas ---- */
    this.canvas = this.shell.canvas;
    this.overlay = this.shell.overlay;
    this.canvasWrap = this.shell.canvasWrap;

    /* ---- zoom control ---- */
    this.zoomInput = el('input', {
      class: 'wb-zoominput', type: 'text', inputmode: 'decimal', value: '100%',
      title: '输入任意缩放比例后回车（例如 137 或 42.5）；留空回车恢复 100%',
      onkeydown: (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { this.applyZoomInput(); e.target.blur(); }
        if (e.key === 'Escape') { this.syncZoom(); e.target.blur(); }
      },
      onfocus: (e) => e.target.select(),
      onblur: () => this.syncZoom(),
    });
    this.zoomBar = el('div', { class: 'wb-zoom' },
      btn('zoomOut', '缩小 (Ctrl+−)', () => this.editor.zoomBy(1 / 1.25), 'sm'),
      this.zoomInput,
      btn('zoomIn', '放大 (Ctrl++)', () => this.editor.zoomBy(1.25), 'sm'),
      btn('fit', '适应页面宽度 (Ctrl+0)', () => this.editor.fitPageWidth(), 'sm'),
      btn('fitPage', '显示整页 (Ctrl+Shift+0)', () => this.editor.fitPage(), 'sm'),
      btn('fullscreen', '全屏 (F11)', () => this.app.toggleFullscreen(), 'sm'),
    );

    /* ---- page navigation (bottom-right corner) ---- */
    this.pageInput = el('input', {
      class: 'wb-pageinput', type: 'text', inputmode: 'numeric', value: '1',
      title: '输入页码后回车跳转到该画纸',
      onkeydown: (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { this.jumpToInput(); e.target.blur(); }
        if (e.key === 'Escape') { this.syncPageNav(); e.target.blur(); }
      },
      onblur: () => this.syncPageNav(),
      onfocus: (e) => e.target.select(),
    });
    this.pageTotal = el('span', { class: 'wb-pagetotal', text: '/ 1' });
    this.pageNav = el('div', { class: 'wb-pagenav', title: '页面导航' },
      btn('chevronL', '上一页 (Page Up)', () => this.editor.prevPage(), 'sm'),
      el('div', { class: 'wb-pagebox' }, this.pageInput, this.pageTotal),
      btn('chevronR', '下一页 (Page Down)', () => this.editor.nextPage(), 'sm'),
    );

    /* ---- pages panel ---- */
    this.pagesPanel = el('aside', { class: 'wb-pages hidden' });
    this.pagesList = el('div', { class: 'wb-pageslist' });
    this.pagesPanel.append(
      el('div', { class: 'wb-panelhead' },
        el('span', { text: '页面' }),
        el('div', { class: 'wb-panelactions' },
          btn('plus', '新建画纸 (Ctrl+Alt+N)', () => this.editor.addPage(), 'sm'),
          btn('close', '关闭面板', () => this.togglePages(false), 'sm'),
        ),
      ),
      this.pagesList,
    );

    /* ---- status bar ---- */
    this.statusLeft = el('div', { class: 'wb-status-left' });
    this.statusRight = el('div', { class: 'wb-status-right', text: '' });

    root.append(
      titlebar,
      el('div', { class: 'wb-stage' },
        this.canvasWrap,
        this.pagesPanel,
        this.toolbar,
        el('div', { class: 'wb-statusbar' },
          this.zoomBar,
          el('div', { class: 'wb-status-mid' }, this.statusLeft, this.statusRight),
          this.pageNav,
        ),
      ),
    );

    this.flyoutLayer = el('div', { class: 'wb-flyout-layer' });
    root.append(this.flyoutLayer);

    document.addEventListener('pointerdown', (e) => {
      if (this.menu && !this.menu.contains(e.target)) this.closeContextMenu();
      if (!this.flyout) return;
      if (this.flyoutLayer.contains(e.target) || this.flyoutAnchor?.contains(e.target)) return;
      this.closeFlyout();
    }, true);

    this.canvas.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      this.openContextMenu(ev.clientX - rect.left, ev.clientY - rect.top, ev.clientX, ev.clientY);
    });

    this.selectionBar = new SelectionBar(this);
    this.editor.overlayExtra = () => this.selectionBar.update();
    this.editor.onSelectionChange = () => { this.syncSelection(); this.selectionBar.update(); };

    this.applyToolbarLocation('bottom');
    this.selectTool('pen');
  }

  applyToolbarLocation(loc) {
    this.editor.toolbarLocation = loc;
    this.toolbar.className = 'wb-toolbar loc-' + loc;
  }

  /* ---------------------------------------------------------------- *
   * Tools
   * ---------------------------------------------------------------- */
  selectTool(id) {
    const ed = this.editor;
    if (id === 'image') return this.app.pickImage();
    if (id === 'ruler') {
      ed.ruler.active = !ed.ruler.active;
      if (ed.ruler.active && ed.ruler.cx === 0 && ed.ruler.cy === 0) {
        const c = ed.screenToWorld(ed.view.w / 2, ed.view.h * 0.6);
        ed.ruler.cx = c.x; ed.ruler.cy = c.y;
      }
      this.syncTools();
      ed.requestRender();
      return;
    }
    ed.setTool(id);
    ed.refreshCursor();
    this.syncTools();
    const anchor = this.toolButtons[id];
    if (id === 'pen') this.openPenFlyout(anchor, false);
    else if (id === 'highlighter') this.openHighlighterFlyout(anchor, false);
    else if (id === 'eraser') this.openEraserFlyout(anchor, false);
    else if (id === 'laser') this.closeFlyout();
    else if (id === 'shape') this.openShapeFlyout(anchor);
    else if (id === 'text') this.openTextFlyout(anchor);
    else if (id === 'sticky') this.openStickyFlyout(anchor);
    else if (id === 'reaction') this.openReactionFlyout(anchor);
    else this.closeFlyout();
  }

  syncTools() {
    const ed = this.editor;
    for (const [id, node] of Object.entries(this.toolButtons)) {
      let on = ed.tool === id;
      if (id === 'ruler') on = ed.ruler.active;
      node.classList.toggle('active', on);
    }
    const hasInk = [...ed.selection].some((e) => e.type === T.INK || e.type === T.HIGHLIGHTER);
    this.beautifyBtn.disabled = !hasInk;
    this.deleteBtn.disabled = ed.selection.size === 0;
  }

  syncSelection() {
    const n = this.editor.selection.size;
    this.statusLeft.textContent = n ? `已选择 ${n} 个对象` : '';
    this.syncTools();
  }

  syncStatus() {
    this.undoBtn.disabled = !this.editor.history.canUndo;
    this.redoBtn.disabled = !this.editor.history.canRedo;
    this.undoBtn.title = this.editor.history.canUndo ? `撤销：${this.editor.history.undoLabel} (Ctrl+Z)` : '撤销 (Ctrl+Z)';
    this.redoBtn.title = this.editor.history.canRedo ? `重做：${this.editor.history.redoLabel} (Ctrl+Y)` : '重做 (Ctrl+Y)';
    this.syncPageNav();
    this.syncZoom();
    this.syncPages();
  }

  /** Show or hide the floating selection action bar. */
  showSelectionBar(force) {
    const bar = this.selectionBar;
    if (!bar) return;
    bar.hidden = force != null ? !force : !bar.hidden;
    this.selbarBtn.classList.toggle('active', !bar.hidden);
    if (bar.hidden) bar.remove(); else bar.update();
  }

  setSaveState(text) {
    this.saveState.textContent = text || '';
    this.saveState.classList.toggle('dirty', !!text);
  }

  syncZoom() {
    if (document.activeElement === this.zoomInput) return;
    const z = this.editor.camera.zoom;
    this.zoomInput.value = (z < 0.1 ? z.toFixed(1) : Math.round(z * 100)) + '%';
  }

  /** Apply whatever percentage the user typed into the zoom box. */
  applyZoomInput() {
    const raw = String(this.zoomInput.value).trim().replace('%', '').replace('％', '');
    if (raw === '') { this.editor.zoomTo100(); this.syncZoom(); return; }
    const pct = Number(raw);
    if (!Number.isFinite(pct) || pct <= 0) {
      this.toast('请输入一个大于 0 的比例，例如 150', 'warn');
      this.syncZoom();
      return;
    }
    const ed = this.editor;
    ed.zoomAt(
      clamp(pct / 100, 0.05, 32),
      ed.view.w / 2,
      ed.view.h / 2,
    );
    this.syncZoom();
  }

  syncPageNav() {
    const ed = this.editor;
    this.pageInput.value = String(ed.pageIndex + 1);
    this.pageTotal.textContent = `/ ${ed.pageCount}`;
    const p = ed.page;
    const pdfPage = p.pdfPages && p.pdfPages.length ? ` · PDF 第 ${p.pdfPages[0].pageNumber} 页` : '';
    const auto = this.app?.autoSaveMinutes ? ` · 自动保存 ${autoSaveLabel(this.app.autoSaveMinutes)}` : '';
    this.statusRight.textContent =
      `画纸 ${ed.pageIndex + 1}/${ed.pageCount}${pdfPage} · ${p.elements.length} 个元素 · ${Math.round(ed.camera.zoom * 100)}%${auto}`;
  }

  jumpToInput() {
    const n = parseInt(this.pageInput.value, 10);
    if (!Number.isFinite(n)) return this.syncPageNav();
    this.editor.gotoPage(clamp(n - 1, 0, this.editor.pageCount - 1));
  }

  /* ---------------------------------------------------------------- *
   * Pages panel
   * ---------------------------------------------------------------- */
  togglePages(force) {
    const show = force != null ? force : this.pagesPanel.classList.contains('hidden');
    this.pagesPanel.classList.toggle('hidden', !show);
    if (show) { this.invalidateThumbs(); this._pagesSig = null; this.syncPages(); }
  }

  #pagesSignature() {
    const ed = this.editor;
    let s = ed.doc.id + '|' + ed.doc.pages.length;
    for (const p of ed.doc.pages) s += '|' + p.elements.length + ':' + ((p.pdfPages && p.pdfPages.length) || 0);
    return s;
  }

  #markActivePage() {
    const items = this.pagesList.children;
    for (let i = 0; i < items.length; i++) items[i].classList.toggle('active', i === this.editor.pageIndex);
    this.pagesList.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }

  syncPages() {
    if (this.pagesPanel.classList.contains('hidden')) return;
    const ed = this.editor;
    const sig = this.#pagesSignature();
    if (sig === this._pagesSig) { this.#markActivePage(); return; }
    this._pagesSig = sig;

    const frag = document.createDocumentFragment();
    this.thumbObserver?.disconnect();
    if (!this._thumbObs) {
      this._thumbObs = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          const i = Number(en.target.dataset.index);
          this._thumbObs.unobserve(en.target);
          this.queueThumb(i, en.target);
        }
      }, { root: this.pagesList, rootMargin: '160px' });
    }
    this.thumbObserver = this._thumbObs;

    ed.doc.pages.forEach((page, i) => {
      const thumb = el('canvas', { class: 'wb-thumbcanvas', dataset: { index: String(i) } });
      thumb.width = 112; thumb.height = 148;
      const item = el('div', {
        class: 'wb-pageitem' + (i === ed.pageIndex ? ' active' : ''),
        draggable: 'true',
        onclick: () => ed.gotoPage(i),
        ondragstart: (e) => { e.dataTransfer.setData('text/wb-page', String(i)); },
        ondragover: (e) => { e.preventDefault(); item.classList.add('dragover'); },
        ondragleave: () => item.classList.remove('dragover'),
        ondrop: (e) => {
          e.preventDefault(); item.classList.remove('dragover');
          const from = Number(e.dataTransfer.getData('text/wb-page'));
          if (Number.isFinite(from)) ed.movePage(from, i);
          this.syncPages();
        },
      },
        thumb,
        el('div', { class: 'wb-pagethumb' },
          el('span', { class: 'wb-pagenum', text: String(i + 1) }),
          el('span', {
            class: 'wb-pagedesc',
            text: page.pdfPages && page.pdfPages.length
              ? `PDF p${page.pdfPages[0].pageNumber}`
              : (page.elements.length ? `${page.elements.length} 项` : '空白'),
          }),
        ),
        el('div', { class: 'wb-pageitemactions' },
          btn('copy', '复制此页', (e) => { e.stopPropagation(); ed.duplicatePage(i); this.syncPages(); }, 'xs'),
          btn('trash', '删除此页', (e) => { e.stopPropagation(); ed.deletePage(i); this.syncPages(); }, 'xs'),
        ),
      );
      frag.append(item);
      this.thumbObserver.observe(thumb);
    });
    this.pagesList.textContent = '';
    this.pagesList.append(frag);
    this.pagesList.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }

  /* ---- lazy thumbnail rendering ---- */
  queueThumb(index, canvas) {
    const key = index;
    const cached = this.thumbCache?.get(key);
    if (cached) { canvas.getContext('2d').drawImage(cached, 0, 0, canvas.width, canvas.height); return; }
    if (!this.thumbCache) this.thumbCache = new Map();
    this.thumbQueue = this.thumbQueue || [];
    this.thumbQueue.push({ index, canvas: new WeakRef(canvas) });
    this.pumpThumbs();
  }

  async pumpThumbs() {
    if (this.thumbRunning) return;
    this.thumbRunning = true;
    while (this.thumbQueue && this.thumbQueue.length) {
      const job = this.thumbQueue.shift();
      const canvas = job.canvas.deref();
      if (!canvas) continue;
      try { await this.renderThumb(job.index, canvas); } catch (err) { console.warn('thumb failed', job.index, err); }
      await new Promise((r) => setTimeout(r, 0));
    }
    this.thumbRunning = false;
  }

  async renderThumb(index, canvas) {
    const ed = this.editor;
    const page = ed.doc.pages[index];
    if (!page) return;
    const b = ed.boundsOfPage(index);
    if (!b.w || !b.h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const scale = Math.min((112 * dpr) / b.w, (148 * dpr) / b.h);
    const cw = Math.max(16, Math.round(b.w * scale));
    const ch = Math.max(16, Math.round(b.h * scale));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    let pdfPages = (page.pdfPages || []).map((p) => ({ ...p }));
    if (pdfPages.length && ed.pdf.isOpen) {
      try { pdfPages = await ed.pdf.bitmapsFor(pdfPages, scale, 1); } catch { /* keep frames */ }
    }
    try { await ed.resources.loadForPage(page); } catch { /* ignore */ }
    const renderer = this._thumbRenderer || (this._thumbRenderer = new SceneRenderer(canvas));
    renderer.render({
      page, camera: { x: b.x, y: b.y, zoom: scale }, view: { w: b.w, h: b.h }, dpr: 1,
      version: Math.random(),
      images: ed.resources.images,
      backgroundColor: argbToRgba(ed.doc.backgroundColor || '#FFFFFFFF'),
      background: null,
      pdfPages, live: null, overlay: null,
    });
    const snap = document.createElement('canvas');
    snap.width = cw; snap.height = ch;
    snap.getContext('2d').drawImage(canvas, 0, 0);
    this.thumbCache.set(index, snap);
  }

  invalidateThumbs() { this.thumbCache?.clear(); }

  /* ---------------------------------------------------------------- *
   * Fly-outs
   * ---------------------------------------------------------------- */
  openFlyout(anchor, content, { title = '', width = 0 } = {}) {
    this.closeFlyout();
    const box = el('div', { class: 'wb-flyout' });
    if (title) box.append(el('div', { class: 'wb-flyout-title', text: title }));
    box.append(content);
    if (width) box.style.minWidth = width + 'px';
    this.flyoutLayer.append(box);
    const r = anchor.getBoundingClientRect();
    const bw = box.offsetWidth, bh = box.offsetHeight;
    let left = r.left + r.width / 2 - bw / 2;
    let top;
    const loc = this.editor.toolbarLocation;
    if (loc === 'bottom') top = r.top - bh - 10;
    else if (loc === 'top') top = r.bottom + 10;
    else top = Math.min(r.top, window.innerHeight - bh - 60);
    if (loc === 'left') left = r.right + 10;
    if (loc === 'right') left = r.left - bw - 10;
    box.style.left = clamp(left, 8, window.innerWidth - bw - 8) + 'px';
    box.style.top = clamp(top, 60, window.innerHeight - bh - 50) + 'px';
    this.flyout = box;
    this.flyoutAnchor = anchor;
    return box;
  }

  closeFlyout() {
    this.flyout?.remove();
    this.flyout = null;
    this.flyoutAnchor = null;
  }

  swatches(colors, current, onPick, { alpha = 255, cols = 5 } = {}) {
    const grid = el('div', { class: 'wb-swatches' });
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    // The palette only expresses a hue, so "current" is matched on RGB: a
    // sticky note that has been made translucent still shows its colour here.
    const curHex = current ? argbToHex(current).toUpperCase() : '';
    for (const c of colors) {
      const hex = argbToHex(c.argb);
      const b = el('button', {
        class: 'wb-swatch' + (c.argb && argbToHex(c.argb).toUpperCase() === curHex ? ' active' : ''),
        title: c.name, type: 'button',
        style: { background: hex },
        onclick: () => {
          onPick(alpha === 255 ? c.argb : hexToArgb(hex, alpha));
          $$('.wb-swatch', grid).forEach((n) => n.classList.remove('active'));
          b.classList.add('active');
        },
      });
      grid.append(b);
    }
    return grid;
  }

  /**
   * Labelled range slider.  `onInput` fires continuously while dragging;
   * `onCommit` fires once when the value settles (pointer release / keyboard),
   * which is where an edit should be written to the undo history.
   */
  slider(label, value, min, max, step, onInput, format = (v) => String(Math.round(v)), onCommit = null) {
    const out = el('span', { class: 'wb-slider-value', text: format(value) });
    const input = el('input', {
      type: 'range', min: String(min), max: String(max), step: String(step), value: String(value),
      oninput: (e) => { const v = Number(e.target.value); out.textContent = format(v); onInput(v); },
      onchange: () => { out.textContent = format(Number(input.value)); onCommit?.(); },
    });
    return el('div', { class: 'wb-sliderrow' },
      el('span', { class: 'wb-slider-label', text: label }), input, out);
  }

  openPenFlyout(anchor, toggle = true) {
    if (toggle && this.flyoutAnchor === anchor) return this.closeFlyout();
    const ed = this.editor;
    const cur = ed.pen.color.replace(/^#..(.{6})$/, '#FF$1');
    const penRow = el('div', { class: 'wb-row wb-penslots' });
    ed.pens.forEach((p, i) => {
      penRow.append(el('button', {
        class: 'wb-penslot' + (i === ed.activePen ? ' active' : ''), type: 'button',
        title: `笔 ${i + 1}（Alt+${i + 1}）`,
        onclick: (e) => {
          ed.selectPen(i);
          $$('.wb-penslot', penRow).forEach((n) => n.classList.remove('active'));
          e.currentTarget.classList.add('active');
          this.closeFlyout();
          this.openPenFlyout(anchor, false);
        },
      },
        el('span', { class: 'wb-penslot-num', text: String(i + 1) }),
        el('span', {
          class: 'wb-penslot-dot',
          style: { background: p.inkGradient ? 'linear-gradient(90deg,#D09734,#3EA03D,#40A3AD)' : argbToHex(p.color) },
        }),
      ));
    });
    const content = el('div', { class: 'wb-flyout-body' },
      el('div', { class: 'wb-flyout-label', text: '笔（3 支可分别自定义）' }), penRow,
      this.slider('粗细', ed.pen.width, 1, 20, 1, (v) => { ed.pen.width = v; }, (v) => String(Math.round(v))),
      this.slider('不透明度', ed.pen.opacity * 100, 0, 100, 5, (v) => { ed.pen.opacity = v / 100; }, (v) => String(Math.round(v))),
      el('div', { class: 'wb-flyout-label', text: '颜色' }),
      this.swatches(PALETTE.pen, ed.pen.color.toUpperCase(), (c) => {
        ed.pen.color = c; ed.pen.inkGradient = null; ed.setTool('pen');
      }, { cols: 5 }),
      el('div', { class: 'wb-flyout-label', text: '渐变笔' }),
      el('div', { class: 'wb-row' }, GRADIENT_PENS.map((g) => el('button', {
        class: 'wb-gradient' + (ed.pen.inkGradient === (g.name === '彩虹' ? 'rainbow' : 'aurora') ? ' active' : ''),
        type: 'button', title: g.name,
        style: { background: `linear-gradient(90deg, ${g.stops.join(',')})` },
        onclick: (e) => {
          ed.pen.inkGradient = g.name === '彩虹' ? 'rainbow' : 'aurora';
          ed.pen.color = '#FF1F1F1F';
          ed.setTool('pen');
          $$('.wb-gradient', e.currentTarget.parentElement).forEach((n) => n.classList.remove('active'));
          e.currentTarget.classList.add('active');
        },
      }))),
      el('div', { class: 'wb-flyout-label', text: '箭头' }),
      el('div', { class: 'wb-row' }, [
        ['none', '无', '🚫'], ['end', '单箭头', '↗'], ['both', '双箭头', '↔'],
      ].map(([v, label, glyph]) => el('button', {
        class: 'wb-toggle' + (ed.pen.arrow === v ? ' active' : ''), type: 'button', title: label, text: glyph,
        onclick: (e) => {
          ed.pen.arrow = v;
          $$('.wb-toggle', e.currentTarget.parentElement).forEach((n) => n.classList.remove('active'));
          e.currentTarget.classList.add('active');
        },
      }))),
      el('div', { class: 'wb-row wb-swatchrow' },
        el('input', {
          type: 'color', value: cur, title: '自定义颜色 (拾色器)',
          oninput: (e) => { ed.pen.color = hexToArgb(e.target.value.toUpperCase(), 0xFF); ed.pen.inkGradient = null; },
        }),
        el('span', { class: 'wb-hint', text: '自定义拾色器' }),
      ),
      el('p', { class: 'wb-hint', text: '按住 Shift 可画出直线；打开直尺后沿尺边画线也能得到直线。' }),
    );
    this.openFlyout(anchor, content, { title: '笔' });
  }

  openHighlighterFlyout(anchor, toggle = true) {
    if (toggle && this.flyoutAnchor === anchor) return this.closeFlyout();
    const ed = this.editor;
    const content = el('div', { class: 'wb-flyout-body' },
      this.slider('粗细', ed.highlighter.width, 8, 60, 2, (v) => { ed.highlighter.width = v; }),
      this.slider('不透明度', ed.highlighter.opacity * 100, 10, 100, 5, (v) => { ed.highlighter.opacity = v / 100; }),
      el('div', { class: 'wb-flyout-label', text: '绘制方式' }),
      el('div', { class: 'wb-row' }, el('button', {
        class: 'wb-toggle' + (ed.highlighter.straight ? ' active' : ''),
        type: 'button',
        title: '开启后像直线工具一样拉出笔直的高亮，两端为半圆形',
        text: '直线绘制',
        onclick: (e) => {
          ed.highlighter.straight = !ed.highlighter.straight;
          e.currentTarget.classList.toggle('active', ed.highlighter.straight);
          if (ed.highlighter.straight) ed.setTool('highlighter');
        },
      })),
      el('p', { class: 'wb-hint', text: '关闭时为自由手绘（平头）；开启后拉出直线高亮，两端自动补成半圆。' }),
      el('div', { class: 'wb-flyout-label', text: '颜色' }),
      this.swatches(PALETTE.highlighter, ed.highlighter.color.toUpperCase(), (c) => {
        ed.highlighter.color = c; ed.setTool('highlighter');
      }, { cols: 5 }),
      el('p', { class: 'wb-hint', text: '荧光笔半透明，用来描出下方的文字或图形。' }),
    );
    this.openFlyout(anchor, content, { title: '荧光笔' });
  }

  openEraserFlyout(anchor, toggle = true) {
    if (toggle && this.flyoutAnchor === anchor) return this.closeFlyout();
    const ed = this.editor;
    const content = el('div', { class: 'wb-flyout-body' },
      this.slider('橡皮大小', ed.eraserSize, 6, 60, 2, (v) => { ed.eraserSize = v; }),
      el('p', { class: 'wb-hint', text: '橡皮按整笔擦除：划过笔画即可删除该笔。形状、文本、图片请选中后按 Delete 删除。' }),
    );
    this.openFlyout(anchor, content, { title: '橡皮擦' });
  }

  openShapeFlyout(anchor) {
    const ed = this.editor;
    const shapes = [
      [T.RECT, '正方形', { force: 'square' }],
      [T.ELLIPSE, '圆形/椭圆', {}],
      [T.TRIANGLE, '三角形', {}],
      [T.PENTAGON, '五边形', {}],
      [T.BLOCK_ARROW, '块状箭头', {}],
      [T.PARALLELOGRAM, '平行四边形', {}],
      [T.DIAMOND, '菱形', {}],
      [T.RECT, '圆角矩形', { rounded: true }],
      [T.LINE, '虚线', { dash: true }],
      [T.LINE, '直线', {}],
      [T.ARROW, '单箭头', {}],
      [T.DOUBLE_ARROW, '双箭头', {}],
      [T.HEXAGON, '六边形', {}],
      [T.STAR, '五角星', {}],
    ];
    const grid = el('div', { class: 'wb-shapegrid' });
    const apply = (kind, opts) => {
      ed.shapeKind = kind;
      ed.shapeForce = opts.force || null;
      ed.shapeStyle.rounded = !!opts.rounded;
      ed.shapeStyle.dash = !!opts.dash;
      ed.setTool('shape');
      ed.refreshCursor();
      this.syncTools();
    };
    for (const [kind, label, opts] of shapes) {
      const active = ed.shapeKind === kind && !!ed.shapeStyle.rounded === !!opts.rounded && !!ed.shapeStyle.dash === !!opts.dash;
      const b = el('button', {
        class: 'wb-shapebtn' + (active ? ' active' : ''), title: label, type: 'button',
        html: shapeIcon(kind, opts),
        onclick: () => {
          apply(kind, opts);
          $$('.wb-shapebtn', grid).forEach((n) => n.classList.remove('active'));
          b.classList.add('active');
        },
      });
      grid.append(b);
    }
    const dashToggle = el('button', {
      class: 'wb-toggle' + (ed.shapeStyle.dash ? ' active' : ''), type: 'button', text: '虚线',
      onclick: (e) => { ed.shapeStyle.dash = !ed.shapeStyle.dash; e.currentTarget.classList.toggle('active', ed.shapeStyle.dash); },
    });
    const fillToggle = el('button', {
      class: 'wb-toggle' + (ed.shapeStyle.filled ? ' active' : ''), type: 'button', text: '填充',
      onclick: (e) => { ed.shapeStyle.filled = !ed.shapeStyle.filled; e.currentTarget.classList.toggle('active', ed.shapeStyle.filled); },
    });
    const content = el('div', { class: 'wb-flyout-body' },
      el('div', { class: 'wb-flyout-label', text: '形状与线条' }), grid,
      el('div', { class: 'wb-flyout-label', text: '边框颜色' }),
      this.swatches(PALETTE.pen.slice(0, 15), ed.shapeStyle.stroke, (c) => { ed.shapeStyle.stroke = c; }, { cols: 5 }),
      this.slider('边框粗细', ed.shapeStyle.width, 0.8, 12, 0.2, (v) => { ed.shapeStyle.width = v; }, (v) => v.toFixed(1)),
      el('div', { class: 'wb-row' }, dashToggle, fillToggle),
      el('p', { class: 'wb-hint', text: '拖动绘制；按住 Shift 可画正方形 / 正圆 / 45° 直线。' }),
    );
    this.openFlyout(anchor, content, { title: '形状' });
  }

  openTextFlyout(anchor) {
    const ed = this.editor;
    const sizes = [12, 16, 20, 28, 40, 60, 96];
    const sizeRow = el('div', { class: 'wb-chiprow' });
    for (const s of sizes) {
      const b = el('button', {
        class: 'wb-chip' + (ed.textStyle.fontSize === s ? ' active' : ''), type: 'button', text: String(s),
        onclick: () => {
          ed.textStyle.fontSize = s;
          applyToSelectionUI(ed, (e) => { e.fontSize = s / ed.camera.zoom; });
          $$('.wb-chip', sizeRow).forEach((n) => n.classList.remove('active'));
          b.classList.add('active');
        },
      });
      sizeRow.append(b);
    }
    const styleToggle = (key, label, glyph) => el('button', {
      class: 'wb-toggle' + (ed.textStyle[key] ? ' active' : ''), type: 'button', title: label,
      html: `<b style="font-style:${key === 'italic' ? 'italic' : 'normal'};text-decoration:${key === 'underline' ? 'underline' : 'none'}">${glyph}</b>`,
      onclick: (e) => {
        ed.textStyle[key] = !ed.textStyle[key];
        e.currentTarget.classList.toggle('active', ed.textStyle[key]);
        applyToSelectionUI(ed, (el2) => { el2[key] = ed.textStyle[key]; });
      },
    });
    const alignRow = el('div', { class: 'wb-row' });
    for (const [a, glyph] of [['left', '⯇'], ['center', '≡'], ['right', '⯈']]) {
      alignRow.append(el('button', {
        class: 'wb-toggle' + (ed.textStyle.align === a ? ' active' : ''), type: 'button', text: glyph, title: a,
        onclick: (e) => {
          ed.textStyle.align = a;
          applyToSelectionUI(ed, (el2) => { el2.textAlign = a; });
          $$('.wb-toggle', alignRow).forEach((n) => n.classList.remove('active'));
          e.currentTarget.classList.add('active');
        },
      }));
    }
    const content = el('div', { class: 'wb-flyout-body' },
      el('div', { class: 'wb-flyout-label', text: '颜色' }),
      this.swatches(PALETTE.text, ed.textStyle.color, (c) => {
        ed.textStyle.color = c;
        applyToSelectionUI(ed, (el2) => { el2.textColor = c; });
      }, { cols: 5 }),
      el('div', { class: 'wb-flyout-label', text: '字号' }), sizeRow,
      el('div', { class: 'wb-flyout-label', text: '样式' }),
      el('div', { class: 'wb-row' },
        styleToggle('bold', '加粗', 'B'),
        styleToggle('italic', '斜体', 'I'),
        styleToggle('underline', '下划线', 'U'),
      ),
      el('div', { class: 'wb-flyout-label', text: '对齐' }), alignRow,
      el('p', { class: 'wb-hint', text: '在画布上单击即可输入文字，支持中文输入法。' }),
      el('p', { class: 'wb-hint', text: '支持 LaTeX：$x^2$ 行内公式，$$\\int_0^1 x\\,dx$$ 独立公式（MathJax 渲染）。' }),
    );
    this.openFlyout(anchor, content, { title: '文本' });
  }

  openStickyFlyout(anchor) {
    this.openFlyout(anchor, this.#stickyStyleBody(), { title: '便签' });
  }

  /** The same panel, opened from the selection's action bar. */
  openStickyStyleFlyout(anchor) {
    this.openFlyout(anchor, this.#stickyStyleBody(), { title: '便签样式' });
  }

  /**
   * Sticky-note appearance: colour, transparency and corner rounding.
   *
   * Everything here does double duty, like the text flyout does: the values
   * become the defaults for the next note *and* are applied to the sticky
   * notes that are selected right now.
   */
  #stickyStyleBody() {
    const ed = this.editor;
    // The targets are resolved on every change rather than captured here:
    // undo replaces the element objects wholesale and re-points the selection,
    // so a list taken when the panel opened would go stale.
    const targets = () => [...ed.selection].filter((e) => e.type === T.STICKY);
    const sample = targets()[0];
    const curColor = sample ? sample.color : ed.noteStyle.color;
    const curAlpha = Math.round((argbAlpha(curColor) / 255) * 100);
    const curRadius = sample && sample.radius != null ? sample.radius : ed.noteStyle.radius;

    /** One undo step per gesture: the snapshot is taken on the first change
     *  of a drag and pushed when the slider settles. */
    let pending = null;
    const apply = (fn) => {
      const list = targets();
      if (!list.length) return;
      const before = ed.snapshot();
      for (const e of list) fn(e);
      ed.commitSnapshot(before, '便签样式');
    };
    const applyLive = (fn) => {
      const list = targets();
      if (!list.length) return;
      if (!pending || pending.elements !== ed.page.elements) {
        pending = { snap: ed.snapshot(), elements: ed.page.elements };
      }
      for (const e of list) fn(e);
      ed.invalidate();
    };
    const commitPending = () => {
      if (!pending) return;
      const { snap, elements } = pending;
      pending = null;
      // An undo in the middle of the gesture already replaced the page.
      if (elements !== ed.page.elements) return;
      ed.commitSnapshot(snap, '便签样式');
    };

    // The palette expresses a hue only: each note keeps the transparency it
    // already had (the same rule the action bar's colour picker uses).
    const colorRow = this.swatches(PALETTE.note, curColor, (color) => {
      const hex = argbToHex(color);
      ed.noteStyle.color = hexToArgb(hex, argbAlpha(ed.noteStyle.color));
      apply((e) => { e.color = hexToArgb(hex, argbAlpha(e.color)); });
    }, { cols: 6 });

    return el('div', { class: 'wb-flyout-body' },
      el('div', { class: 'wb-flyout-label', text: '便签颜色' }),
      colorRow,
      el('div', { class: 'wb-flyout-label', text: '不透明度' }),
      this.slider('透明度', curAlpha, 10, 100, 5, (v) => {
        // Transparency lives in the ARGB alpha of the note's colour, so it
        // travels with the file and Whiteboard understands it too.
        const alpha = Math.round((v / 100) * 255);
        ed.noteStyle.color = hexToArgb(argbToHex(ed.noteStyle.color), alpha);
        applyLive((e) => { e.color = hexToArgb(argbToHex(e.color), alpha); });
      }, (v) => `${Math.round(v)}%`, commitPending),
      el('div', { class: 'wb-flyout-label', text: '圆角' }),
      this.slider('圆角', Math.round(curRadius * 100), 0, 50, 1, (v) => {
        const r = v / 100;
        ed.noteStyle.radius = r;
        applyLive((e) => { e.radius = r; });
      }, (v) => `${Math.round(v)}%`, commitPending),
      el('p', { class: 'wb-hint', text: sample
        ? `修改所选 ${targets().length} 张便签；同样的样式也会用于新建的便签。`
        : '在画布上单击放置便签，直接输入文字。' }),
      el('p', { class: 'wb-hint', text: '支持 LaTeX：$E=mc^2$，独立公式写成 $$…$$（MathJax 渲染）。' }),
    );
  }

  openReactionFlyout(anchor) {
    const ed = this.editor;
    const row = el('div', { class: 'wb-reactions' });
    for (const r of REACTIONS) {
      row.append(el('button', {
        class: 'wb-reaction' + (ed.reactionEmoji === r ? ' active' : ''), type: 'button', text: r,
        onclick: () => {
          ed.reactionEmoji = r;
          ed.setTool('reaction');
          this.syncTools();
          $$('.wb-reaction', row).forEach((n) => n.classList.remove('active'));
        },
      }));
    }
    this.openFlyout(anchor, el('div', { class: 'wb-flyout-body' },
      el('div', { class: 'wb-flyout-label', text: '选择反应，然后在画布上点击放置' }), row), { title: '反应' });
  }

  openMoreFlyout(anchor) {
    const ed = this.editor;
    const row = (icon, label, fn) => el('button', {
      class: 'wb-morerow', type: 'button', onclick: () => { this.closeFlyout(); fn(); },
    }, el('span', { class: 'wb-moreicon', html: svg(ICONS[icon], 18) }), el('span', { text: label }));

    const content = el('div', { class: 'wb-flyout-body wb-more' },
      row('trash', '删除所选 (Delete)', () => this.app.deleteSelection()),
      row('scissors', '剪切所选 (Ctrl+X)', () => ed.copySelection(true)),
      row('copy', '复制所选 (Ctrl+C)', () => { ed.copySelection(false); this.toast('已复制'); }),
      row('table', '插入表格', () => { ed.setTool('table'); this.syncTools(); }),
      row('image', '插入图片', () => this.app.pickImage()),
      row('reaction', '反应', () => { ed.setTool('reaction'); this.syncTools(); }),
      row('wand', '墨迹转形状 (Alt+B)', () => this.app.beautify()),
      row('pages', '页面面板', () => this.togglePages(true)),
      row('plus', '在当前页之前新建画纸 (Ctrl+Alt+P)', () => { ed.addPageBefore(); this.syncPages(); }),
      row('plus', '在当前页之后新建画纸 (Ctrl+Alt+N)', () => { ed.addPageAfter(); this.syncPages(); }),
      row('copy', '复制当前画纸', () => { ed.duplicatePage(); this.syncPages(); }),
      row('front', '置于顶层 (Ctrl+Shift+])', () => ed.reorderSelection('front')),
      row('back', '置于底层 (Ctrl+Shift+[)', () => ed.reorderSelection('back')),
      row('lock', '锁定 / 解锁所选', () => this.app.toggleLock()),
      row('help', '编辑替代文本 (Alt text)', () => this.app.editAltText()),
      row('trash', '清空当前画纸', () => this.app.clearPage()),
      row('plus', '新建白板', () => this.app.newDocument()),
      row('save', '另存为 .note 文件…', () => this.app.saveAs()),
    );
    this.openFlyout(anchor, content, { title: '更多' });
  }

  openBackgroundFlyout(anchor) {
    if (this.flyoutAnchor === anchor) return this.closeFlyout();
    const ed = this.editor;
    const styles = [['none', '无', 'none'], ['grid', '方格', 'grid'], ['lines', '横线', 'lines'], ['dots', '点阵', 'dots']];
    const row = el('div', { class: 'wb-bgrow' });
    for (const [id, label, icon] of styles) {
      const b = el('button', {
        class: 'wb-bgbtn' + (ed.background.style === id ? ' active' : ''), type: 'button', title: label,
        html: svg(ICONS[icon], 22) + `<span>${label}</span>`,
        onclick: () => {
          ed.background.style = id;
          ed.invalidate();
          $$('.wb-bgbtn', row).forEach((n) => n.classList.remove('active'));
          b.classList.add('active');
        },
      });
      row.append(b);
    }
    const colors = ['#FFFFFF', '#FAF9F8', '#F3F2F1', '#FFF8E7', '#EAF3FB', '#1B1A19'];
    const colorRow = el('div', { class: 'wb-row' });
    for (const c of colors) {
      colorRow.append(el('button', {
        class: 'wb-swatch' + (argbToHex(ed.doc.backgroundColor).toUpperCase() === c ? ' active' : ''),
        type: 'button', style: { background: c },
        onclick: () => {
          ed.doc.backgroundColor = hexToArgb(c.slice(1), 0xFF);
          ed.invalidate();
          $$('.wb-swatch', colorRow).forEach((n) => n.classList.remove('active'));
        },
      }));
    }
    const content = el('div', { class: 'wb-flyout-body' },
      el('div', { class: 'wb-flyout-label', text: '背景样式' }), row,
      this.slider('网格间距', ed.background.spacing, 10, 80, 5, (v) => { ed.background.spacing = v; ed.invalidate(); }),
      el('div', { class: 'wb-flyout-label', text: '画布颜色' }), colorRow,
      el('div', { class: 'wb-row' }, el('input', {
        type: 'color', value: argbToHex(ed.doc.backgroundColor),
        oninput: (e) => { ed.doc.backgroundColor = hexToArgb(e.target.value.slice(1).toUpperCase(), 0xFF); ed.invalidate(); },
      })),
    );
    this.openFlyout(anchor, content, { title: '画布背景' });
  }

  openSettingsFlyout(anchor) {
    if (this.flyoutAnchor === anchor) return this.closeFlyout();
    const ed = this.editor;
    const locRow = el('div', { class: 'wb-chiprow' });
    for (const [id, label] of [['bottom', '底部'], ['top', '顶部'], ['left', '左侧'], ['right', '右侧']]) {
      const b = el('button', {
        class: 'wb-chip' + (ed.toolbarLocation === id ? ' active' : ''), type: 'button', text: label,
        onclick: () => {
          this.applyToolbarLocation(id);
          $$('.wb-chip', locRow).forEach((n) => n.classList.remove('active'));
          b.classList.add('active');
          this.closeFlyout();
        },
      });
      locRow.append(b);
    }
    const toggle = (label, value, fn) => el('button', {
      class: 'wb-toggle' + (value ? ' active' : ''), type: 'button', text: label,
      onclick: (e) => { const v = !e.currentTarget.classList.contains('active'); e.currentTarget.classList.toggle('active', v); fn(v); },
    });
    const defaultRow = el('div', { class: 'wb-chiprow' });
    for (const [pct, label] of [[50, '50%'], [80, '80%'], [100, '100%'], [125, '125%'], [150, '150%']]) {
      defaultRow.append(el('button', {
        class: 'wb-chip' + (Math.abs(ed.defaultZoom * 100 - pct) < 0.5 ? ' active' : ''), type: 'button', text: label,
        title: `新建 / 打开白板时的默认比例（当前 ${Math.round(ed.camera.zoom * 100)}%）`,
        onclick: (e) => {
          ed.defaultZoom = pct / 100;
          $$('.wb-chip', defaultRow).forEach((n) => n.classList.remove('active'));
          e.currentTarget.classList.add('active');
          this.toast(`默认比例已设为 ${pct}%（新建或打开白板时生效）`, 'ok');
        },
      }));
    }
    const autoRow = el('div', { class: 'wb-chiprow' });
    for (const c of AUTO_SAVE_CHOICES) {
      autoRow.append(el('button', {
        class: 'wb-chip' + (this.app.autoSaveMinutes === c.minutes ? ' active' : ''), type: 'button', text: c.label,
        title: c.minutes ? `每 ${c.label}自动保存当前打开的文件` : '关闭自动保存',
        onclick: (e) => {
          this.app.setAutoSave(c.minutes);
          $$('.wb-chip', autoRow).forEach((n) => n.classList.remove('active'));
          e.currentTarget.classList.add('active');
        },
      }));
    }

    const content = el('div', { class: 'wb-flyout-body' },
      el('div', { class: 'wb-flyout-label', text: '工具栏位置' }), locRow,
      el('div', { class: 'wb-flyout-label', text: '新建 / 打开白板时的默认比例' }), defaultRow,
      el('div', { class: 'wb-flyout-label', text: '自动保存' }), autoRow,
      el('p', { class: 'wb-hint', text: '只对已经保存过文件的白板生效（新白板先按 Ctrl+S 存一次）；'
        + '有改动才会写盘，正在输入文字时也不会打断你。设置会记住。' }),
      el('div', { class: 'wb-flyout-label', text: '绘制' }),
      el('div', { class: 'wb-row' },
        toggle('对象吸附对齐', ed.snapEnabled, (v) => { ed.snapEnabled = v; }),
        toggle('自动增强墨迹形状', ed.enhanceInk, (v) => { ed.enhanceInk = v; }),
        toggle('高亮直线显示半圆端点', renderOptions.roundStraightHighlights, (v) => {
          renderOptions.roundStraightHighlights = v;
          ed.invalidate();
        }),
      ),
      el('div', { class: 'wb-flyout-label', text: '画布' }),
      el('div', { class: 'wb-row' },
        el('button', { class: 'wb-toggle', type: 'button', text: '背景…', onclick: () => this.openBackgroundFlyout(this.toolButtons.select) }),
        el('button', { class: 'wb-toggle', type: 'button', text: '导出…', onclick: () => { this.closeFlyout(); this.openExportDialog(); } }),
      ),
      el('p', { class: 'wb-hint', text: '“自动增强墨迹形状”开启后，画出的近似直线与闭合图形会自动吸附为精确形状。' }),
    );
    this.openFlyout(anchor, content, { title: '设置' });
  }

  /* ---------------------------------------------------------------- *
   * Context menu (right click)
   * ---------------------------------------------------------------- */
  closeContextMenu() {
    this.menu?.remove();
    this.menu = null;
  }

  openContextMenu(localX, localY, pageX, pageY) {
    this.closeFlyout();
    const ed = this.editor;
    const world = ed.screenToWorld(localX, localY);
    const hit = ed.pickAt(world);
    if (hit && !ed.selection.has(hit)) {
      ed.selection.clear();
      ed.selection.add(hit);
      ed.onSelectionChange?.();
      ed.requestRender();
    }
    if (!hit) ed.clearSelection();

    const hasSel = ed.selection.size > 0;
    const n = ed.selection.size;
    const items = hasSel ? [
      { label: `剪切${n > 1 ? ` ${n} 项` : ''}`, hint: 'Ctrl+X', icon: 'scissors', run: () => ed.copySelection(true) },
      { label: '复制', hint: 'Ctrl+C', icon: 'copy', run: () => { ed.copySelection(false); this.toast('已复制'); } },
      { label: '再制', hint: 'Ctrl+D', icon: 'copy', run: () => ed.duplicateSelection() },
      { separator: true },
      { label: '置于顶层', hint: 'Ctrl+Shift+]', icon: 'front', run: () => ed.reorderSelection('front') },
      { label: '置于底层', hint: 'Ctrl+Shift+[', icon: 'back', run: () => ed.reorderSelection('back') },
      { label: [...ed.selection].some((e) => e.locked) ? '解锁' : '锁定', icon: 'lock', run: () => this.app.toggleLock() },
      { label: '编辑替代文本…', icon: 'help', run: () => this.app.editAltText() },
      { separator: true },
      { label: `删除${n > 1 ? ` ${n} 项` : ''}`, hint: 'Delete', icon: 'trash', danger: true, run: () => this.app.deleteSelection() },
    ] : [
      { label: '粘贴', hint: 'Ctrl+V', icon: 'copy', disabled: !ed.clipboard, run: () => ed.paste() },
      { label: '全选', hint: 'Ctrl+A', icon: 'marquee', run: () => ed.selectAll() },
      { label: '解锁全部', icon: 'unlock', run: () => this.app.unlockAll() },
      { separator: true },
      { label: '在此页之前新建画纸', hint: 'Ctrl+Alt+P', icon: 'plus', run: () => ed.addPageBefore() },
      { label: '在此页之后新建画纸', hint: 'Ctrl+Alt+N', icon: 'plus', run: () => ed.addPageAfter() },
      { separator: true },
      { label: '适应页面宽度', hint: 'Ctrl+0', icon: 'fit', run: () => ed.fitPageWidth() },
      { label: '显示整页', hint: 'Ctrl+Shift+0', icon: 'fitPage', run: () => ed.fitPage() },
      { separator: true },
      { label: '清空当前画纸', icon: 'trash', danger: true, run: () => this.app.clearPage() },
    ];

    const menu = el('div', { class: 'wb-menu' });
    for (const it of items) {
      if (it.separator) { menu.append(el('div', { class: 'wb-menu-sep' })); continue; }
      const row = el('button', {
        class: 'wb-menuitem' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : ''),
        type: 'button', disabled: it.disabled || false,
        onclick: () => { this.closeContextMenu(); it.run(); },
      },
        el('span', { class: 'wb-menuicon', html: svg(ICONS[it.icon] || ICONS.more, 16) }),
        el('span', { class: 'wb-menulabel', text: it.label }),
        it.hint ? el('span', { class: 'wb-menu-hint', text: it.hint }) : null,
      );
      menu.append(row);
    }
    this.flyoutLayer.append(menu);
    // flyoutLayer is position:fixed, so client coordinates are what we want
    menu.style.left = clamp(pageX, 8, Math.max(8, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = clamp(pageY, 8, Math.max(8, window.innerHeight - menu.offsetHeight - 8)) + 'px';
    this.menu = menu;
  }

  /* ---------------------------------------------------------------- *
   * Dialogs
   * ---------------------------------------------------------------- */
  dialog(title, body, { wide = false, actions = [] } = {}) {
    const back = el('div', { class: 'wb-modal' });
    const close = () => back.remove();
    const dlg = el('div', { class: 'wb-dialog' + (wide ? ' wide' : '') },
      el('div', { class: 'wb-dialog-head' }, el('h3', { text: title }), btn('close', '关闭', close, 'sm')),
      el('div', { class: 'wb-dialog-body' }, body),
      actions.length ? el('div', { class: 'wb-dialog-foot' }, actions) : null,
    );
    back.append(dlg);
    document.body.append(back);
    back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
    return { close, node: dlg };
  }

  openExportDialog() {
    const app = this.app;
    const ed = this.editor;
    const mk = (title, desc, fn) => el('button', {
      class: 'wb-filerow', type: 'button', onclick: () => { dlg.close(); fn(); },
    },
      el('span', { class: 'wb-fileicon', text: '⬇' }),
      el('span', { class: 'wb-filename' }, el('b', { text: title }), el('div', { class: 'wb-pagedesc', text: desc })),
    );
    const body = el('div', {},
      el('p', { class: 'wb-hint', text: '快速导出当前画纸为图片，或把全部画纸导出为一个 PDF。' }),
      el('div', { class: 'wb-filelist' },
        mk('PNG 图片', '导出当前画纸为 PNG（2 倍分辨率）', () => app.exportPng()),
        mk('PDF 文档', `导出全部 ${ed.pageCount} 张画纸为一个 PDF`, () => app.exportPdf()),
        mk('Zip (HTML + JSON)', '导出白板数据与资源，便于二次处理', () => app.exportZip()),
        mk('另存为 .note', '保存成一个新的 .note 文件，不动原文件', () => app.saveAs()),
      ),
      el('p', { class: 'wb-hint', text: '提示：Ctrl+S 保存会覆盖当前打开的 .note；想保留原件请用「另存为」。保存后的文件可直接用 Microsoft Whiteboard 打开。' }),
    );
    const dlg = this.dialog('导出白板', body, { wide: true });
  }

  toast(message, kind = 'info', ms = 2600) {
    const t = el('div', { class: `wb-toast ${kind}`, text: message });
    let host = $('.wb-toasts');
    if (!host) { host = el('div', { class: 'wb-toasts' }); document.body.append(host); }
    host.append(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, ms);
  }

  progress(message) {
    let host = $('.wb-progress');
    if (!host) { host = el('div', { class: 'wb-progress' }); document.body.append(host); }
    host.textContent = message || '';
    host.classList.toggle('hidden', !message);
  }

  showShortcuts() {
    const rows = [
      ['Ctrl + Z / Ctrl + Y', '撤销 / 重做'],
      ['Ctrl + C / Ctrl + X / Ctrl + V', '复制 / 剪切 / 粘贴'],
      ['Ctrl + D', '再制所选'],
      ['Ctrl + A', '全选当前画纸'],
      ['Delete / Backspace', '删除所选'],
      ['方向键（Shift 加速）', '微移所选 / 平移画布'],
      ['Alt + ← / →', '旋转所选对象'],
      ['Ctrl + Shift + ] / [', '置于顶层 / 置于底层'],
      ['Alt + B', '墨迹转形状（Beautify）'],
      ['Ctrl + 滚轮 / 滚轮', '缩放 / 平移（Shift 横向）'],
      ['空格 + 拖动，或中键拖动', '平移画布'],
      ['1 – 9 / 0', '按工具栏顺序选择工具（1 套索、2 矩形框选、3 移动画布…0 文本）'],
      ['V / M / G', '套索选择 / 矩形框选 / 移动画布'],
      ['P / H / L / E', '笔 / 荧光笔 / 激光笔 / 橡皮擦'],
      ['R', '尺子开关（沿尺边画直线）'],
      ['S / T / N / B / O', '形状 / 文本 / 便签 / 表格 / 反应'],
      ['Shift + N', '新建白板（大写字母是独立的快捷键）'],
      ['Shift + 绘制', '直线 / 正方形 / 正圆'],
      ['Ctrl + 0 / Ctrl + Shift + 0', '适应宽度 / 显示整页'],
      ['Ctrl + + / Ctrl + −', '放大 / 缩小'],
      ['Page Up / Page Down', '上一页 / 下一页'],
      ['Ctrl + Alt + N / Ctrl + Alt + P', '在当前页之后 / 之前新建画纸'],
      ['Ctrl + Shift + P', '显示 / 隐藏页面面板'],
      ['Ctrl + S / Ctrl + Shift + S', '保存 .note / 另存为新 .note'],
      ['Ctrl + Shift + I', '导入 PDF'],
      ['双击文本 / 便签 / 表格', '编辑内容'],
      ['Esc', '取消当前操作 / 取消选择'],
      ['F1', '显示本帮助'],
    ];
    const table = el('table', { class: 'wb-shortcuts' });
    for (const [k, v] of rows) table.append(el('tr', {}, el('td', {}, el('kbd', { text: k })), el('td', { text: v })));
    this.dialog('键盘快捷键', table, { wide: true });
  }
}

function shapeIcon(kind, opts = {}) {
  const s = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">';
  let body;
  if (opts.dash) body = '<path d="M3 19L21 5" stroke-dasharray="3 2.5"/>';
  else {
    const map = {
      [T.LINE]: '<path d="M4 20L20 4"/>',
      [T.ARROW]: '<path d="M4 20L20 4"/><path d="M13 4h7v7"/>',
      [T.DOUBLE_ARROW]: '<path d="M4 20L20 4"/><path d="M4 14v6h6"/><path d="M13 4h7v7"/>',
      [T.RECT]: opts.rounded ? '<rect x="3.5" y="6" width="17" height="12" rx="4"/>' : '<rect x="3.5" y="6" width="17" height="12"/>',
      [T.ELLIPSE]: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>',
      [T.TRIANGLE]: '<path d="M12 5l8 14H4z"/>',
      [T.DIAMOND]: '<path d="M12 4l8 8-8 8-8-8z"/>',
      [T.PENTAGON]: '<path d="M12 4l8 6-3 9H7l-3-9z"/>',
      [T.HEXAGON]: '<path d="M8 5h8l4 7-4 7H8l-4-7z"/>',
      [T.STAR]: '<path d="M12 4l2.4 5 5.6.8-4 3.9 1 5.5-5-2.6-5 2.6 1-5.5-4-3.9 5.6-.8z"/>',
      [T.PARALLELOGRAM]: '<path d="M7 6h13l-3 12H4z"/>',
      [T.BLOCK_ARROW]: '<path d="M3 9h9V6l9 6-9 6v-3H3z"/>',
    };
    body = map[kind] || map[T.RECT];
  }
  return s + body + '</svg>';
}

function applyToSelectionUI(ed, fn) {
  if (!ed.selection.size) return;
  const before = ed.snapshot();
  for (const e of ed.selection) fn(e);
  ed.commitSnapshot(before, '修改样式');
}
