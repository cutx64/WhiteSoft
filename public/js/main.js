/**
 * Application entry point: wires the editor, the UI and all document-level
 * commands (open / save / import PDF / insert image / export).
 */
import { $, el, download, formatBytes, clamp, argbToRgba } from './util.js';
import { Editor } from './editor.js';
import { UI } from './ui.js';
import { InlineEditor } from './inlineeditor.js';
import { SceneRenderer } from './render.js';
import { Rect } from './geometry.js';
import { scaleElement, rotateElement } from './elements.js';
import {
  createDocument, createPage, openLocalNote, writeNoteToHandle, noteBlob,
  importPdfAsPages, referencedResources, manifestFromDocument, LAYOUT_WIDTH,
  planLocalCompaction,
} from './document.js';
import { T } from './elements.js';
import { beautifySelection, fitSelectionToCurves } from './tools.js';
import {
  getPref, setPref, autoSaveLabel, recentFiles, rememberFile, clearRecentFiles, relativeTime,
} from './prefs.js';
import { loadFflate, ZipReader } from './zipread.js';
import {
  handlesSupported, saveHandle, loadHandle, forgetHandle, forgetAllHandles, ensurePermission,
} from './filehandles.js';

class App {
  constructor() {
    const root = $('#wb-app');
    const canvas = el('canvas', { id: 'wb-canvas' });
    const overlay = el('div', { id: 'wb-overlay', class: 'wb-overlay' });
    const canvasWrap = el('div', { class: 'wb-canvas-wrap' }, canvas, overlay);
    root.append(canvasWrap);

    this.editor = new Editor(canvas, overlay);
    this.editor.inline = new InlineEditor(this.editor);
    this.ui = new UI(this, { canvas, overlay, canvasWrap });
    this.modified = false;
    this.saving = false;
    // Auto-save is a machine-level preference, so it survives a reload.
    this.autoSaveMinutes = Number(getPref('autoSaveMinutes', 0)) || 0;
    this.autoSaveTimer = null;
    this.editor.doc.name = '未命名白板';
    this.ui.titleInput.value = this.editor.doc.name;
    this.bindGlobal();
    this.ui.syncStatus();
    // A brand new board opens at the default zoom, not fitted.
    this.editor.setZoom(this.editor.defaultZoom);
    this.editor.centerPage();
    this.editor.requestRender();
    setTimeout(() => this.editor.resize(), 0);
    this.startAutoSave();
  }

  /* ---------------------------------------------------------------- *
   * Auto-save
   * ---------------------------------------------------------------- */

  /**
   * (Re)arm the auto-save timer.  The interval is in minutes; 0 turns it off.
   * Fractions are allowed so tests can drive the real timer.
   */
  startAutoSave() {
    if (this.autoSaveTimer) clearInterval(this.autoSaveTimer);
    this.autoSaveTimer = null;
    if (!this.autoSaveMinutes) return;
    const period = Math.max(200, this.autoSaveMinutes * 60 * 1000);
    this.autoSaveTimer = setInterval(() => { this.autoSaveTick(); }, period);
  }

  /** Change the interval and remember it for the next session. */
  setAutoSave(minutes) {
    this.autoSaveMinutes = Number(minutes) || 0;
    setPref('autoSaveMinutes', this.autoSaveMinutes);
    this.startAutoSave();
    this.ui.syncStatus();
    this.ui.toast(this.autoSaveMinutes
      ? `自动保存已开启：每 ${autoSaveLabel(this.autoSaveMinutes)}（仅对已保存过的文件生效）`
      : '自动保存已关闭', 'ok', 2200);
  }

  /**
   * One auto-save tick: writes the open file when it has unsaved changes.
   *
   * Skipped (until the next tick) when there is nothing to do, so the timer can
   * never annoy the user: no file on disk yet, no changes, or a save already in
   * flight.  Text being edited inline is saved as-is — the model already holds
   * every keystroke, so the editor stays open.
   */
  async autoSaveTick() {
    if (!this.autoSaveMinutes || this.saving) return false;
    if (!this.modified) return false;
    if (!this.#writableHandle()) return false;
    return this.save({ auto: true, keepEditing: true });
  }

  /**
   * The handle Ctrl+S writes into, if the browser gave us one.
   *
   * A board opened through `showOpenFilePicker` (or saved once through
   * `showSaveFilePicker`) owns a real file; a board dragged in from the desktop
   * has only a read-only snapshot, and asking it for permission would need a
   * user gesture, so autosave stays quiet in that case.
   */
  #writableHandle() {
    return this.editor.doc.fileHandle || null;
  }

  markModified() {
    if (this.modified) return;
    this.modified = true;
    this.ui.setSaveState('未保存的更改');
  }

  markSaved() {
    this.modified = false;
    this.ui.setSaveState('');
  }

  /* ---------------------------------------------------------------- *
   * Global wiring
   * ---------------------------------------------------------------- */
  bindGlobal() {
    this.editor.onContentChange = () => this.markModified();
    window.addEventListener('resize', () => this.editor.resize());
    window.addEventListener('beforeunload', (e) => {
      if (!this.modified) return;
      e.preventDefault();
      e.returnValue = '';
    });
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') { this.editor.spaceDown = false; this.editor.refreshCursor(); }
    });
    const stage = $('.wb-stage');
    stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dropping'); });
    stage.addEventListener('dragleave', () => stage.classList.remove('dropping'));
    stage.addEventListener('drop', (e) => {
      e.preventDefault();
      stage.classList.remove('dropping');
      const f = e.dataTransfer.files?.[0];
      if (f) this.openLocalFile(f);
    });
    document.addEventListener('paste', (e) => this.onPaste(e));
  }

  onKeyDown(e) {
    const ed = this.editor;
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
    const mod = e.ctrlKey || e.metaKey;

    if (e.code === 'Space' && !typing) {
      ed.spaceDown = true;
      ed.refreshCursor();
      e.preventDefault();
      return;
    }
    if (typing && !(mod && ['s', 'o'].includes(e.key.toLowerCase()))) return;

    if (mod) {
      switch (e.key.toLowerCase()) {
        case 'z': e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return;
        case 'y': e.preventDefault(); this.redo(); return;
        case 'c': e.preventDefault(); ed.copySelection(false); this.ui.toast('已复制'); return;
        case 'x': e.preventDefault(); ed.copySelection(true); return;
        case 'v': return; // handled by the paste event
        case 'd': e.preventDefault(); ed.duplicateSelection(); return;
        case 'a': e.preventDefault(); ed.selectAll(); return;
        case 's': e.preventDefault(); if (e.shiftKey) this.saveAs(); else this.save(); return;
        case 'o': e.preventDefault(); this.showOpenDialog(); return;
        case 'i': if (e.shiftKey) { e.preventDefault(); this.pickPdf(); } return;
        case 'n': if (e.altKey) { e.preventDefault(); ed.addPageAfter(); this.ui.syncPages(); } return;
        case 'p':
          // Ctrl+Alt+P inserts a page before the current one; Ctrl+Shift+P toggles
          // the pages panel.  Both live under the same key, so they must share a
          // single case — a second `case 'p'` would be unreachable.
          if (e.altKey) { e.preventDefault(); ed.addPageBefore(); this.ui.syncPages(); return; }
          if (e.shiftKey) { e.preventDefault(); this.ui.togglePages(); }
          return;
        case '0': e.preventDefault(); e.shiftKey ? ed.fitPage() : ed.fitPageWidth(); return;
        case '[': if (e.shiftKey) { e.preventDefault(); ed.reorderSelection('back'); } return;
        case ']': if (e.shiftKey) { e.preventDefault(); ed.reorderSelection('front'); } return;
        case '=': case '+': e.preventDefault(); ed.zoomBy(1.25); return;
        case '-': e.preventDefault(); ed.zoomBy(1 / 1.25); return;
        default: break;
      }
      return;
    }

    switch (e.key) {
      case 'Delete': case 'Backspace':
        if (ed.selection.size) { e.preventDefault(); this.deleteSelection(); }
        return;
      case 'Escape':
        if (this.editor.inline?.isEditing) this.editor.inline.commit(true);
        else { ed.clearSelection(); ed.currentTool?.cancel?.(ed); ed.requestRender(); }
        return;
      case 'PageDown': e.preventDefault(); ed.nextPage(); return;
      case 'PageUp': e.preventDefault(); ed.prevPage(); return;
      case 'Enter': case ' ':
        if (e.altKey) return;
        if (ed.selection.size === 1) {
          const only = [...ed.selection][0];
          if (only.type === T.TEXT || only.type === T.STICKY || only.type === T.TABLE) {
            e.preventDefault();
            ed.editElement(only, {});
          }
        }
        return;
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
        if (!ed.selection.size) {
          const step = e.shiftKey ? 60 : 20;
          if (e.key === 'ArrowLeft') ed.panBy(step, 0);
          if (e.key === 'ArrowRight') ed.panBy(-step, 0);
          if (e.key === 'ArrowUp') ed.panBy(0, step);
          if (e.key === 'ArrowDown') ed.panBy(0, -step);
          e.preventDefault();
          return;
        }
        e.preventDefault();
        if (e.altKey) {
          // Alt + ←/→ rotates the selection, like Whiteboard.
          const before = ed.snapshot();
          const rad = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? Math.PI / 2 : Math.PI / 36);
          const c = ed.selectionBounds();
          const pivot = { x: c.cx, y: c.cy };
          for (const el2 of ed.selection) rotateElement(el2, rad, pivot);
          ed.commitSnapshot(before, '旋转');
          return;
        }
        const step = (e.shiftKey ? 10 : 1) / ed.camera.zoom;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        if (e.shiftKey && e.altKey) scaleSelection(ed, dx, dy);
        else ed.nudgeSelection(dx, dy);
        return;
      }
      case 'F1': e.preventDefault(); this.ui.showShortcuts(); return;
      case 'F11': e.preventDefault(); this.toggleFullscreen(); return;
      default: break;
    }

    if (e.altKey && ['1', '2', '3'].includes(e.key)) {
      e.preventDefault();
      ed.selectPen(Number(e.key) - 1);
      this.ui.syncTools();
      return;
    }

    if (e.altKey) {
      const alt = {
        s: () => this.ui.selectTool('select'),
        w: () => this.ui.selectTool('pen'),
        h: () => this.ui.selectTool('highlighter'),
        l: () => this.ui.selectTool('laser'),
        x: () => this.ui.selectTool('eraser'),
        q: () => this.ui.selectTool('select'),
        r: () => this.ui.selectTool('ruler'),
        b: () => this.beautify(),
        e: () => this.ui.selectTool('reaction'),
      }[e.key.toLowerCase()];
      if (alt) { e.preventDefault(); alt(); return; }
    }

    // --- digits select the nth toolbar tool (1 … 9, then 0 for the 10th) ---
    if (!e.shiftKey && /^[0-9]$/.test(e.key)) {
      const idx = e.key === '0' ? 9 : Number(e.key) - 1;
      const id = this.ui.toolOrder?.[idx];
      if (id) { e.preventDefault(); this.ui.selectTool(id); return; }
    }

    if (!/^[a-zA-Z]$/.test(e.key)) return;
    const isUpper = e.key === e.key.toUpperCase();

    // Shift + letter: only the explicit upper-case bindings fire, so e.g.
    // Shift+N can mean "new board" without also triggering the N(ote) tool.
    if (isUpper) {
      const shiftMap = {
        N: () => this.newDocument(),
      }[e.key];
      if (shiftMap) { e.preventDefault(); shiftMap(); }
      return;
    }

    const k = e.key;
    const map = {
      v: 'select', m: 'marquee', g: 'pan', p: 'pen', h: 'highlighter',
      l: 'laser', e: 'eraser', r: 'ruler', s: 'shape', t: 'text',
      n: 'sticky', b: 'table', o: 'reaction',
    };
    if (map[k]) { e.preventDefault(); this.ui.selectTool(map[k]); }
  }

  /* ---------------------------------------------------------------- *
   * Clipboard / images
   * ---------------------------------------------------------------- */
  async onPaste(e) {
    const items = [...(e.clipboardData?.items || [])];
    const img = items.find((i) => i.type.startsWith('image/'));
    if (img) {
      e.preventDefault();
      const file = img.getAsFile();
      if (file) await this.insertImageBlob(file);
      return;
    }
    if (this.editor.inline?.isEditing) return;
    this.editor.paste();
  }

  pickImage() {
    const input = el('input', { type: 'file', accept: 'image/*', multiple: true });
    input.onchange = async () => {
      for (const f of input.files) await this.insertImageBlob(f);
    };
    input.click();
    this.ui.syncTools();
  }

  async insertImageBlob(blob) {
    const ed = this.editor;
    const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const buf = new Uint8Array(await blob.arrayBuffer());
    const fileName = ed.resources.addBytes(buf, ext);
    await ed.resources.load(fileName);
    const img = ed.resources.get(fileName);
    const maxW = (ed.view.w * 0.5) / ed.camera.zoom;
    const ratio = img && img.naturalWidth ? img.naturalHeight / img.naturalWidth : 0.6;
    const w = Math.min(maxW, img?.naturalWidth ? img.naturalWidth / 2 : maxW);
    const h = w * ratio;
    const center = ed.screenToWorld(ed.view.w / 2, ed.view.h / 2);
    const e = {
      type: T.IMAGE,
      bounds: new Rect(center.x - w / 2, center.y - h / 2, w, h).toString(),
      rotation: 0,
      fileName,
    };
    ed.addElement(e, { select: true, label: '插入图片' });
    ed.setTool('select');
    this.ui.syncTools();
  }

  /* ---------------------------------------------------------------- *
   * Open
   * ---------------------------------------------------------------- */
  /* ---------------------------------------------------------------- *
   * Opening files: local picker or the recent list
   * ---------------------------------------------------------------- */

  /** A file row: icon, name, an optional tag and a detail line. */
  #fileRow({ icon, title, tag, desc, onclick }) {
    return el('button', { class: 'wb-filerow', type: 'button', onclick },
      el('span', { class: 'wb-fileicon', text: icon }),
      el('span', { class: 'wb-filename' },
        el('b', { text: title }),
        tag ? el('span', { class: 'wb-filetag', text: tag }) : null,
        desc ? el('div', { class: 'wb-pagedesc', text: desc }) : null,
      ),
    );
  }

  /** Ctrl+O / the 打开 button: pick a file from disk, or from recent files. */
  async showOpenDialog() {
    const pick = this.#fileRow({
      icon: '📂',
      title: '从本地文件选择',
      desc: '用系统文件对话框打开本机的 .note 白板，或导入 .pdf',
      onclick: () => { dlg.close(); this.pickLocalFile(); },
    });
    const recent = this.#fileRow({
      icon: '🕘',
      title: '最近使用的文件',
      desc: '这个浏览器打开过的文件，按时间倒序',
      onclick: () => { dlg.close(); this.showRecentDialog(); },
    });
    const body = el('div', {},
      el('p', { class: 'wb-hint', text: '从哪里打开？也可以直接把 .note 或 .pdf 拖到窗口里。' }),
      el('div', { class: 'wb-filelist' }, pick, recent),
    );
    const dlg = this.ui.dialog('打开白板', body, { wide: true });
  }

  /**
   * The "从本地文件选择" branch: a real OS file dialog.
   *
   * When the browser can hand out a file handle (Chrome/Edge) the pick is
   * remembered as a link to that location, so it can be reopened later without
   * asking again — and without ever copying the file.
   */
  async pickLocalFile({ pdfOnly = false } = {}) {
    const accept = pdfOnly ? '.pdf,application/pdf' : '.note,.whiteboard,.pdf,application/pdf';
    if (handlesSupported()) {
      try {
        const [handle] = await window.showOpenFilePicker({
          multiple: false,
          types: [{
            description: pdfOnly ? 'PDF 文档' : 'WhiteSoft 白板 / PDF',
            accept: pdfOnly ? { 'application/pdf': ['.pdf'] } : { 'application/x-note': ['.note', '.whiteboard'], 'application/pdf': ['.pdf'] },
          }],
        });
        if (!handle) return;
        const file = await handle.getFile();
        const id = await saveHandle(`f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, handle);
        if (/[.](pdf)$/i.test(file.name)) await this.importPdfFile(file, { handleId: id });
        else await this.openLocalFile(file, { handleId: id, handle });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;   // user cancelled the dialog
        console.warn('showOpenFilePicker 不可用，回退到 input[type=file]', err);
      }
    }
    const input = el('input', { type: 'file', accept });
    input.onchange = () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return;
      if (pdfOnly || /[.](pdf)$/i.test(f.name)) this.importPdfFile(f);
      else this.openLocalFile(f);
    };
    document.body.append(input);
    input.click();
  }

  /**
   * The "最近使用的文件" branch: what this browser opened before, newest first.
   * Only the *location* is remembered — a file handle when the browser hands
   * one out, otherwise nothing but the name to re-pick.
   */
  async showRecentDialog() {
    const remembered = recentFiles();

    const recentList = el('div', { class: 'wb-filelist' });
    if (!remembered.length) {
      recentList.append(el('p', { class: 'wb-hint', text: '这个浏览器还没有打开过文件。' }));
    }
    for (const r of remembered) {
      const where = r.handleId ? '已记住位置，可直接打开' : '需重新选择（浏览器不支持记住本地文件）';
      recentList.append(this.#fileRow({
        icon: r.kind === 'pdf' ? '📄' : '📝',
        title: r.name,
        desc: [where, r.size ? formatBytes(r.size) : '', relativeTime(r.at)].filter(Boolean).join(' · '),
        onclick: () => { dlg.close(); this.openRecent(r); },
      }));
    }

    const body = el('div', {},
      el('div', { class: 'wb-row' },
        el('b', { text: '最近打开' }),
        el('span', { class: 'wb-filesize', text: `${remembered.length} 个` }),
        remembered.length ? el('button', {
          class: 'wb-toggle', type: 'button', text: '清空记录',
          onclick: (e) => {
            clearRecentFiles();
            forgetAllHandles();
            e.currentTarget.disabled = true;
            for (const row of [...recentList.children]) row.remove();
            recentList.append(el('p', { class: 'wb-hint', text: '记录已清空。' }));
          },
        }) : null,
      ),
      recentList,
      el('p', {
        class: 'wb-hint', text: '记录只保存文件的位置，不会复制文件：Chrome / Edge 下用浏览器授权的'
          + '文件句柄记住（再次打开时就地读取原文件），其它浏览器只能请你重新选择一次。',
      }),
    );
    const dlg = this.ui.dialog('最近使用的文件', body, { wide: true });
  }

  /**
   * Open a remembered file through the handle stored for it.  Without one the
   * browser gives us no way back to the file, so the user is asked to point at
   * it again.
   */
  async openRecent(entry) {
    const handle = await loadHandle(entry.handleId);
    if (!handle) {
      this.ui.toast(`请重新选择 ${entry.name}（浏览器不会把本地文件路径交给网页）`, 'warn', 3600);
      return this.pickLocalFile({ pdfOnly: entry.kind === 'pdf' });
    }
    try {
      if (!(await ensurePermission(handle))) {
        this.ui.toast('没有获得该文件的读取权限', 'warn');
        return;
      }
      const file = await handle.getFile();
      this.ui.progress('正在打开 ' + file.name + ' …');
      if (entry.kind === 'pdf') await this.importPdfFile(file, { handleId: entry.handleId });
      else await this.openLocalFile(file, { handleId: entry.handleId, handle });
      this.ui.progress('');
    } catch (err) {
      this.ui.progress('');
      if (err?.name === 'NotFoundError') {
        await forgetHandle(entry.handleId);
        this.ui.toast(`${entry.name} 已被移动或删除，已从最近记录里移除`, 'error', 5000);
        return;
      }
      this.ui.toast('打开失败：' + err.message, 'error', 6000);
    }
  }

  /**
   * Open a file the user picked from their own disk.
   *
   * Nothing is copied: a `.note` is read straight from the file (the document
   * keeps the archive reader and pulls images from it as they are drawn), and
   * the location is remembered through `handleId` so the recent list can open
   * the very same file again.
   */
  async openLocalFile(file, { handleId = null, handle = null } = {}) {
    const name = file.name.toLowerCase();
    if (!(await this.confirmDiscard('打开其他文件'))) return;
    if (name.endsWith('.note') || name.endsWith('.whiteboard')) {
      const ui = this.ui;
      const ed = this.editor;
      try {
        ui.progress(`正在读取 ${file.name}（${formatBytes(file.size)}）…`);
        const doc = await openLocalNote(file, { onProgress: (m) => ui.progress(m) });
        ed.resources.setLocalArchive(doc.localArchive);
        if (doc.document?.fileName) {
          ui.progress('正在载入 PDF 背景…');
          const bytes = await doc.localArchive.read('Resources/Document/' + doc.document.fileName);
          if (bytes) {
            doc._pdfBytes = bytes;
            await ed.pdf.open(bytes, 'local:' + file.name);
          } else {
            await ed.pdf.close();
          }
        } else {
          await ed.pdf.close();
        }
        // Keep the handle: it is what lets Ctrl+S overwrite this very file
        // instead of asking for a new name.
        doc.fileHandle = handle || null;
        doc.fileHandleId = handleId || null;
        ed.setDocument(doc);
        this.#afterOpen(doc, {
          kind: 'note',
          source: 'local',
          name: file.name,
          size: file.size,
          lastModified: file.lastModified || 0,
          handleId,
        });
      } catch (err) {
        ui.progress('');
        ui.toast('打开失败：' + err.message, 'error', 6000);
        console.error(err);
      }
      return;
    }
    if (name.endsWith('.pdf')) return this.importPdfFile(file, { handleId });
    this.ui.toast('不支持的文件类型', 'warn');
  }

  /** Shared tail of "a document has been opened": title, status, recent list. */
  #afterOpen(doc, recent, { silent = false } = {}) {
    const ui = this.ui;
    ui.titleInput.value = doc.name;
    this.markSaved();
    ui.syncStatus();
    ui.pagesPanel.classList.add('hidden');
    ui.progress('');
    if (recent) rememberFile(recent);
    ui.toast(`已打开 ${doc.name}（${doc.pages.length} 张画纸${doc.document ? '，含 PDF 背景' : ''}）`, 'ok');
    if (!silent) ui.closeFlyout();
  }

  /* ---------------------------------------------------------------- *
   * PDF import
   * ---------------------------------------------------------------- */
  pickPdf() {
    return this.pickLocalFile({ pdfOnly: true });
  }

  /**
   * Import a PDF as one whiteboard page per PDF page.
   *
   * @param {File} file
   * @param {{handleId?: string}} opts identifies the picked file's location so
   *   the recent list can ask for it again (nothing is copied).
   */
  async importPdfFile(file, { handleId = null } = {}) {
    const ui = this.ui;
    const ed = this.editor;
    if (!(await this.confirmDiscard('导入 PDF'))) return;
    try {
      ui.progress('正在解析 PDF …');
      const bytes = new Uint8Array(await file.arrayBuffer());
      await ed.pdf.close();
      await ed.pdf.open(bytes, 'local:' + file.name);
      const doc = await importPdfAsPages(ed.pdf, {
        // The page is laid out one viewport width wide, so at 100 % zoom it
        // exactly fills the window; the board then opens at the default zoom.
        viewportWidth: Math.max(320, ed.view.w),
        name: file.name,
        onProgress: (m) => ui.progress(m),
      });
      // Keep the raw PDF so that "保存 .note" can embed it.
      doc._pdfBytes = bytes;
      doc.name = file.name.replace(/\.pdf$/i, '');
      ed.resources.setNote();
      ed.resources.clear();
      ed.pdf.docKey = 'local:' + file.name;
      ed.setDocument(doc);
      ui.titleInput.value = doc.name;
      this.markModified();
      ui.syncStatus();
      ui.progress('');
      // Remember *where* the PDF came from (a file handle when the browser
      // supports them) instead of keeping a second copy of it.
      rememberFile({
        name: file.name,
        kind: 'pdf',
        source: 'local',
        size: file.size || 0,
        lastModified: file.lastModified || 0,
        handleId,
      });
      ui.toast(`已导入 ${doc.pages.length} 页 PDF，每页对应一张画纸`, 'ok');
    } catch (err) {
      ui.progress('');
      ui.toast('PDF 导入失败：' + err.message, 'error', 6000);
      console.error(err);
    }
  }

  /* ---------------------------------------------------------------- *
   * Save / export
   * ---------------------------------------------------------------- */
  /**
   * Write the open board back to its file (Ctrl+S).
   *
   * The file is the one the user picked: a writable handle means we overwrite
   * it in place.  A board that only exists as a read-only snapshot (dragged in,
   * or a browser without the File System Access API) has nowhere to go, so the
   * user is asked for a location instead — never silently, and never on the
   * autosave timer.
   *
   * @param {{auto?: boolean, keepEditing?: boolean}} opts
   *   `auto` tags the toast as an automatic save; `keepEditing` leaves the
   *   inline text editor open (the auto-save timer must not pull it away).
   */
  async save({ auto = false, keepEditing = false } = {}) {
    const doc = this.editor.doc;
    if (doc.fileHandle && await ensurePermission(doc.fileHandle, 'readwrite')) {
      return this.#writeToHandle(doc.fileHandle, { auto, keepEditing });
    }
    if (auto) return false;
    if (doc.localFile) {
      this.ui.toast('这个浏览器不能写回本地文件，已改为「另存为」', 'warn', 4200);
    }
    return this.saveAs();
  }

  /**
   * Write the board into `handle` (Ctrl+S on a picked file, or the location
   * chosen in 另存为 — both are the same operation).
   */
  async #writeToHandle(handle, { auto = false, keepEditing = false, adopt = false } = {}) {
    const ed = this.editor;
    const doc = ed.doc;
    if (this.saving) return false;
    const ui = this.ui;
    this.saving = true;
    try {
      ui.progress('正在写回 ' + (handle.name || '文件') + ' …');
      if (ed.inline?.isEditing && !auto && !keepEditing) ed.inline.commit(true);
      const newFiles = ed.resources.newFilesBytes();
      if (doc._pdfBytes && doc.document?.fileName) {
        newFiles['Resources/Document/' + doc.document.fileName] = doc._pdfBytes;
      }
      const out = await writeNoteToHandle(doc, handle, { newFiles });
      // This handle now *is* the board: Ctrl+S, autosave and compaction keep
      // using it, and the archive snapshot is refreshed because the file on
      // disk just changed (a stale reader would resurrect dropped entries).
      doc.fileHandle = handle;
      try {
        const fresh = await ZipReader.open(await handle.getFile());
        doc.localArchive = fresh;
        ed.resources.swapArchive(fresh);
      } catch { /* keep the previous snapshot */ }
      if (adopt) {
        const name = handle.name || '未命名白板.note';
        doc.name = name.replace(/\.note$/i, '');
        doc.localFile = { name, size: out.bytes, lastModified: Date.now() };
        doc.fileHandleId = await saveHandle(`f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, handle);
        ui.titleInput.value = doc.name;
        rememberFile({
          kind: 'note', source: 'local', name, size: out.bytes,
          lastModified: Date.now(), handleId: doc.fileHandleId,
        });
      }
      this.markSaved();
      ui.progress('');
      ui.toast(`${auto ? '已自动保存到' : '已保存'} ${out.target}（${formatBytes(out.bytes)}${adopt ? '' : '，就地覆盖原文件'}）`, 'ok', auto ? 1800 : 2800);
      ui.syncStatus();
      return true;
    } catch (err) {
      ui.progress('');
      ui.toast((auto ? '自动保存失败：' : '保存失败：') + err.message, 'error', 6000);
      return false;
    } finally {
      this.saving = false;
    }
  }

  /**
   * 另存为: ask for a location with the system dialog when the browser has one,
   * otherwise hand the user a downloaded copy.  Both leave the open board
   * bound to whatever was written, so the next Ctrl+S behaves as expected.
   */
  async saveAs() {
    const ed = this.editor;
    const doc = ed.doc;
    const suggested = `${doc.name || '未命名白板'}.note`;
    if (typeof window.showSaveFilePicker === 'function') {
      let handle;
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: suggested,
          types: [{ description: 'WhiteSoft 白板', accept: { 'application/x-note': ['.note'] } }],
        });
      } catch (err) {
        if (err?.name === 'AbortError') return false;
        console.warn('showSaveFilePicker 不可用，改为下载副本', err);
      }
      if (handle) return this.#writeToHandle(handle, { adopt: true });
    }
    // No writable file system access: build the archive and download it.
    const ui = this.ui;
    if (this.saving) return false;
    this.saving = true;
    ui.progress('正在打包 ' + suggested + ' …');
    try {
      if (ed.inline?.isEditing) ed.inline.commit(true);
      const newFiles = ed.resources.newFilesBytes();
      if (doc._pdfBytes && doc.document?.fileName) {
        newFiles['Resources/Document/' + doc.document.fileName] = doc._pdfBytes;
      }
      const blob = await noteBlob(doc, { newFiles });
      download(blob, suggested, 'application/x-note');
      this.markSaved();
      ui.progress('');
      ui.toast(`已下载 ${suggested}（这个浏览器不能直接写回原文件）`, 'ok', 4200);
      return true;
    } catch (err) {
      ui.progress('');
      ui.toast('另存为失败：' + err.message, 'error', 6000);
      return false;
    } finally {
      this.saving = false;
    }
  }

  /* ---------------------------------------------------------------- *
   * 一键压缩：删掉文件里没有任何对象引用的图片 / PDF
   * ---------------------------------------------------------------- */
  /**
   * Rewrite the saved `.note` without the resources no page refers to.
   *
   * The archive is read and rewritten in this page (see zipread.js /
   * zipwrite.js): untouched entries are copied byte for byte and streamed
   * straight back into the same file, so a 300 MB board is never held in
   * memory.  The user sees exactly what would be dropped before anything is
   * written.
   *
   * @returns {Promise<boolean>} true once the preview dialog is up
   */
  async compactCurrentNote() {
    const ed = this.editor;
    const doc = ed.doc;
    const ui = this.ui;
    const file = doc.fileHandle?.name || doc.localFile?.name || `${doc.name || '未命名白板'}.note`;
    if (!(doc.fileHandle && await ensurePermission(doc.fileHandle, 'readwrite'))) {
      ui.toast('压缩需要能写回这个文件：请先用「另存为」把它保存到本机（Chrome / Edge 可直接覆盖原文件）', 'warn', 4600);
      return false;
    }
    // Compact what is on disk, so the preview matches the result: unsaved edits
    // would otherwise still be counted as references.
    if (this.modified && !(await this.save())) return false;

    ui.progress('正在检查可清理的资源 …');
    let plan;
    try {
      plan = this.#planLocalCompaction();
    } catch (err) {
      ui.progress('');
      ui.toast('检查失败：' + err.message, 'error', 5200);
      return false;
    }
    ui.progress('');
    const before = plan.size;
    const bytes = plan.removedBytes;
    const stored = plan.stored || { count: 0, bytes: 0 };
    if (!plan.removed.length && !stored.count) {
      ui.toast(`「${doc.name || file}」没有可清理的资源，已经是最小体积`, 'ok', 3200);
      return false;
    }

    const names = plan.removed.slice(0, 5).map((r) => `${r.name.split('/').pop()}（${formatBytes(r.bytes)}）`);
    const dlg = ui.dialog('一键压缩 .note', el('div', {},
      el('p', { class: 'wb-hint', text: '文件：' + file }),
      plan.removed.length
        ? el('p', {}, el('b', { text: `将删除 ${plan.removed.length} 个没有任何对象引用的资源，省下约 ${formatBytes(bytes)}` }))
        : null,
      stored.count
        ? el('p', {}, el('b', {
          text: `另有 ${stored.count} 个条目目前是未压缩存放的（${formatBytes(stored.bytes)}），会一并重新压缩`,
        }))
        : null,
      el('p', {
        class: 'wb-hint',
        text: (plan.removed.length
          ? `体积约 ${formatBytes(before)} → 至少 ${formatBytes(Math.max(0, before - bytes))}`
            + (stored.count ? '（重新压缩后还会更小）' : '')
          : `体积约 ${formatBytes(before)}，重新压缩后会更小`)
          + '。只删除 Resources/Images 与 Resources/Document 里没被用到的条目，内容本身不做任何修改。',
      }),
      names.length ? el('p', { class: 'wb-hint', text: '例如：' + names.join('、') + (plan.removed.length > names.length ? ` 等 ${plan.removed.length} 个` : '') }) : null,
      el('p', { class: 'wb-hint', text: '没有额外备份：压缩会直接改写这个文件（写入是原子的，失败不会留下半个文件）。' }),
      el('p', { class: 'wb-hint', text: '被删除的图片之后无法再从文件里找回，撤销也救不回来。' }),
    ), {
      actions: [
        el('button', { class: 'wb-toggle', type: 'button', text: '取消', onclick: () => dlg.close() }),
        el('button', {
          class: 'wb-primary', type: 'button', text: '开始压缩',
          onclick: async () => {
            dlg.close();
            await this.#runCompaction(plan);
          },
        }),
      ],
    });
    return true;
  }

  /**
   * What a compaction of the open board would drop, computed from the archive
   * the board was read from (its entry list and compressed sizes) and the
   * resources the pages still reference.
   */
  #planLocalCompaction() {
    const doc = this.editor.doc;
    const reader = doc.localArchive;
    const size = doc.archiveBytes || 0;
    if (!reader) {
      return { removed: [], removedBytes: 0, size, referencedCount: 0, stored: { count: 0, bytes: 0 } };
    }
    const sizeOf = (name) => {
      const e = reader.entry(name);
      return e ? (e.csize || e.usize || 0) : 0;
    };
    const plan = planLocalCompaction(doc, reader.list(), sizeOf, (name) => reader.entry(name));
    return {
      removed: plan.removable.map((r) => ({ name: r.name, bytes: r.bytes })),
      removedBytes: plan.bytes,
      size,
      referencedCount: plan.total - plan.removable.length,
      stored: plan.stored,
    };
  }

  async #runCompaction(plan) {
    const ed = this.editor;
    const doc = ed.doc;
    const ui = this.ui;
    const file = doc.fileHandle?.name || '本地文件';
    ui.progress('正在压缩 ' + file + ' …');
    try {
      const drop = new Set(plan.removed.map((r) => r.name));
      // Only resources the board still uses are written back: an image that was
      // pasted and then deleted must not be resurrected by a compaction.
      const keep = new Set(referencedResources(doc));
      const newFiles = {};
      for (const [name, bytes] of Object.entries(ed.resources.newFilesBytes())) {
        if (keep.has(name)) newFiles[name] = bytes;
      }
      const out = await writeNoteToHandle(doc, doc.fileHandle, { newFiles, drop, recompress: true });
      try {
        const fresh = await ZipReader.open(await doc.fileHandle.getFile());
        doc.localArchive = fresh;
        ed.resources.swapArchive(fresh);
      } catch { /* keep the previous snapshot */ }
      ui.progress('');
      ui.toast(`已压缩 ${file}：${plan.removed.length ? `删除 ${plan.removed.length} 个未引用的资源，` : ''}`
        + `${formatBytes(plan.size)} → ${formatBytes(out.bytes)}`
        + `（省下 ${formatBytes(Math.max(0, plan.size - out.bytes))}）`, 'ok', 4600);
      ui.syncStatus();
    } catch (err) {
      ui.progress('');
      ui.toast('压缩失败：' + err.message, 'error', 6000);
    }
  }

  async newDocument() {
    if (!(await this.confirmDiscard('新建白板'))) return;
    const ed = this.editor;
    ed.pdf.close();
    ed.resources.setNote();
    ed.resources.clear();
    const doc = createDocument();
    ed.setDocument(doc);
    this.ui.titleInput.value = doc.name;
    this.markSaved();
    this.ui.syncStatus();
  }

  /* ---- rendering a page to a bitmap (PNG export / PDF export) ---- */
  async renderPageBitmap(index, scale = 2) {
    const ed = this.editor;
    const page = ed.doc.pages[index];
    if (!page) return null;
    const b = pageBounds(ed, page);
    const pad = 24;
    const w = Math.ceil((b.w + pad * 2) * scale);
    const h = Math.ceil((b.h + pad * 2) * scale);
    if (w < 1 || h < 1 || w * h > 80e6) throw new Error('页面过大，无法导出');
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const renderer = new SceneRenderer(canvas);
    const camera = { x: b.x - pad, y: b.y - pad, zoom: scale };
    let pdfPages = page.pdfPages.map((p) => ({ ...p }));
    if (pdfPages.length && ed.pdf.isOpen) {
      pdfPages = await ed.pdf.bitmapsFor(pdfPages, scale, 1);
    }
    renderer.render({
      page, camera, view: { w: w / scale, h: h / scale }, dpr: 1, version: Math.random(),
      images: ed.resources.images,
      backgroundColor: argbToRgba(ed.doc.backgroundColor || '#FFFFFFFF'),
      background: { ...ed.background, _zoom: scale },
      pdfPages,
      live: null,
      overlay: null,
    });
    return canvas;
  }

  async exportPng() {
    const ui = this.ui;
    try {
      ui.progress('正在导出 PNG …');
      const canvas = await this.renderPageBitmap(this.editor.pageIndex, 2);
      canvas.toBlob((blob) => {
        download(blob, `${this.editor.doc.name}-p${this.editor.pageIndex + 1}.png`, 'image/png');
        ui.progress('');
        ui.toast('PNG 已导出', 'ok');
      }, 'image/png');
    } catch (err) {
      ui.progress('');
      ui.toast('导出失败：' + err.message, 'error');
    }
  }

  async exportPdf() {
    const ui = this.ui;
    const ed = this.editor;
    try {
      const pages = [];
      for (let i = 0; i < ed.doc.pages.length; i++) {
        ui.progress(`正在导出 PDF … ${i + 1}/${ed.doc.pages.length}`);
        const canvas = await this.renderPageBitmap(i, 1.6);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
        const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
        pages.push({ jpeg: b64, w: canvas.width, h: canvas.height });
        if (i > 400) { ui.toast('页面过多，已导出前 400 页', 'warn'); break; }
      }
      ui.progress('正在写出 PDF …');
      const bytes = buildPdf(pages);
      download(new Blob([bytes], { type: 'application/pdf' }), `${ed.doc.name}.pdf`);
      ui.progress('');
      ui.toast('PDF 已导出', 'ok');
    } catch (err) {
      ui.progress('');
      ui.toast('导出失败：' + err.message, 'error', 5000);
    }
  }

  undo() { const l = this.editor.history.undo(); if (l) this.ui.toast('撤销：' + l, 'info', 1200); this.ui.syncStatus(); }
  redo() { const l = this.editor.history.redo(); if (l) this.ui.toast('重做：' + l, 'info', 1200); this.ui.syncStatus(); }

  /* ---------------------------------------------------------------- *
   * Object commands
   * ---------------------------------------------------------------- */
  beautify() {
    const n = beautifySelection(this.editor);
    this.ui.toast(n ? `已将 ${n} 条墨迹转换为形状` : '请先选中近似直线或闭合图形的手绘墨迹', n ? 'ok' : 'warn');
    return n;
  }

  toggleLock() {
    const ed = this.editor;
    if (!ed.selection.size) {
      const locked = ed.page.elements.filter((e) => e.locked);
      if (locked.length) {
        const before = ed.snapshot();
        for (const e of locked) delete e.locked;
        ed.commitSnapshot(before, '解锁全部');
        this.ui.toast(`已解锁 ${locked.length} 个对象`, 'ok');
      } else this.ui.toast('请先选中对象', 'warn');
      return;
    }
    const before = ed.snapshot();
    const anyUnlocked = [...ed.selection].some((e) => !e.locked);
    for (const e of ed.selection) { if (anyUnlocked) e.locked = true; else delete e.locked; }
    ed.commitSnapshot(before, anyUnlocked ? '锁定' : '解锁');
    if (anyUnlocked) ed.clearSelection();
    this.ui.toast(anyUnlocked ? '已锁定所选对象' : '已解锁所选对象', 'ok');
  }

  /** Delete every selected object — ink, shapes, text, notes, tables, images. */
  /** 曲线拟合: replace the selected ink with the smooth curve through it. */
  fitSelectionCurves() {
    const ed = this.editor;
    const n = fitSelectionToCurves(ed);
    if (!n) {
      const hasInk = [...ed.selection].some((e) => e.type === T.INK || e.type === T.HIGHLIGHTER);
      this.ui.toast(hasInk ? '这些墨迹太短或太乱，拟合不出曲线' : '请先选中要拟合的墨迹', 'warn', 2600);
      return 0;
    }
    this.ui.toast(`已把 ${n} 条墨迹拟合成高次曲线（Ctrl+Z 可撤销）`, 'ok', 2200);
    return n;
  }

  deleteSelection() {
    const ed = this.editor;
    const n = ed.selection.size;
    if (!n) { this.ui.toast('请先选中要删除的对象', 'warn', 1600); return 0; }
    // Commit any in-progress text editing first so nothing is resurrected.
    if (ed.inline?.isEditing) ed.inline.commit(true);
    ed.deleteSelection();
    this.ui.toast(`已删除 ${n} 个对象（Ctrl+Z 可撤销）`, 'ok', 1600);
    return n;
  }

  unlockAll() {
    const ed = this.editor;
    const locked = ed.page.elements.filter((e) => e.locked);
    if (!locked.length) { this.ui.toast('当前画纸没有锁定的对象', 'info', 1600); return 0; }
    const before = ed.snapshot();
    for (const e of locked) delete e.locked;
    ed.commitSnapshot(before, '解锁全部');
    this.ui.toast(`已解锁 ${locked.length} 个对象`, 'ok');
    return locked.length;
  }

  /* ---------------------------------------------------------------- *
   * Unsaved-changes guard
   * ---------------------------------------------------------------- */
  /**
   * Ask before throwing away unsaved work.
   * Resolves true when it is safe to continue, false when the user cancels.
   */
  async confirmDiscard(action = '继续') {
    if (!this.modified) return true;
    const name = this.editor.doc.name || '未命名白板';
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (settled) return; settled = true; dlg.close(); resolve(v); };
      const dlg = this.ui.dialog('有未保存的更改', el('div', {},
        el('p', { class: 'wb-hint', text: `白板「${name}」有未保存的更改，${action}将会丢失这些更改。` }),
        el('p', {
          class: 'wb-hint',
          text: this.editor.doc.fileHandle?.name
            ? `当前文件：${this.editor.doc.fileHandle.name}（Ctrl+S 覆盖它）`
            : (this.editor.doc.localFile ? `当前文件：${this.editor.doc.localFile.name}（只能另存为）` : '当前白板还没有保存到文件。'),
        }),
      ), {
        actions: [
          el('button', { class: 'wb-toggle', type: 'button', text: '取消', onclick: () => finish(false) }),
          el('button', { class: 'wb-toggle', type: 'button', text: '放弃更改', onclick: () => finish(true) }),
          el('button', {
            class: 'wb-primary', type: 'button', text: '保存并继续',
            onclick: async () => {
              await this.save();
              finish(!this.modified);
            },
          }),
        ],
      });
    });
  }

  clearPage() {
    const ed = this.editor;
    if (!ed.page.elements.length) return;
    const before = ed.snapshot();
    ed.page.elements = [];
    ed.selection.clear();
    ed.commitSnapshot(before, '清空画纸');
    this.ui.toast('已清空当前画纸（可用 Ctrl+Z 撤销）', 'ok');
  }

  async toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (err) {
      this.ui.toast('无法进入全屏：' + err.message, 'warn');
    }
  }

  editAltText() {
    const ed = this.editor;
    const targets = ed.selection.size ? [...ed.selection] : [];
    if (!targets.length) { this.ui.toast('请先选中要添加替代文本的对象', 'warn'); return; }
    const first = targets[0];
    const input = el('input', { class: 'wb-input', value: first.altText || '', placeholder: '描述这个对象，供屏幕阅读器朗读' });
    const dlg = this.ui.dialog('编辑替代文本', el('div', {},
      el('p', { class: 'wb-hint', text: `将对选中的 ${targets.length} 个对象设置替代文本。` }),
      el('div', { class: 'wb-row' }, input),
    ), {
      actions: [el('button', {
        class: 'wb-primary', type: 'button', text: '保存',
        onclick: () => {
          const before = ed.snapshot();
          const v = input.value.trim();
          for (const t of targets) { if (v) t.altText = v; else delete t.altText; }
          ed.commitSnapshot(before, '替代文本');
          dlg.close();
          this.ui.toast('已保存替代文本', 'ok');
        },
      })],
    });
    input.focus();
  }

  async exportZip() {
    const ed = this.editor;
    const ui = this.ui;
    try {
      ui.progress('正在打包 …');
      const { zipSync, strToU8 } = await loadFflate();
      const files = {};
      files['manifest.json'] = strToU8(JSON.stringify(manifestFromDocument(ed.doc), null, 2));
      ed.doc.pages.forEach((p, i) => {
        files[`Pages/page${i + 1}.json`] = strToU8(JSON.stringify(p, null, 1));
      });
      const names = new Set();
      for (const p of ed.doc.pages) {
        for (const e of p.elements) if (e.fileName) names.add(e.fileName);
      }
      let done = 0;
      for (const name of names) {
        done++;
        if (done % 10 === 0) ui.progress(`正在打包资源 … ${done}/${names.size}`);
        const url = ed.resources.urlFor(name);
        if (!url) continue;
        const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
        files['Resources/Images/' + name] = buf;
      }
      if (ed.doc._pdfBytes && ed.doc.document?.fileName) {
        files['Resources/Document/' + ed.doc.document.fileName] = ed.doc._pdfBytes;
      }
      const altTexts = [];
      ed.doc.pages.forEach((p, i) => p.elements.forEach((e, j) => {
        if (e.altText) altTexts.push({ page: i + 1, index: j, type: e.type, altText: e.altText });
      }));
      files['alt-text.json'] = strToU8(JSON.stringify(altTexts, null, 2));
      files['whiteboard.json'] = strToU8(JSON.stringify({
        name: ed.doc.name, pages: ed.doc.pages.length,
        exported: new Date().toISOString(),
      }, null, 2));
      const zipped = zipSync(files, { level: 6 });
      download(new Blob([zipped], { type: 'application/zip' }), `${ed.doc.name}-export.zip`);
      ui.progress('');
      ui.toast('Zip 已导出', 'ok');
    } catch (err) {
      ui.progress('');
      ui.toast('导出失败：' + err.message, 'error', 5000);
      console.error(err);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
/** Shift+Alt+arrow resizes the selection along one axis, like Whiteboard. */
function scaleSelection(ed, dx, dy) {
  const b = ed.selectionBounds();
  if (!b || !b.w || !b.h) return;
  const sx = dx ? 1 + dx / (b.w / 2) : 1;
  const sy = dy ? 1 + dy / (b.h / 2) : 1;
  const before = ed.snapshot();
  const pivot = { x: dx ? b.left : b.cx, y: dy ? b.top : b.cy };
  for (const e of ed.selection) scaleElement(e, dx ? sx : 1, dy ? sy : 1, pivot);
  ed.commitSnapshot(before, '缩放');
}

function pageBounds(ed, page) {
  let r = new Rect(); let any = false;
  for (const pp of page.pdfPages || []) { const b = Rect.parse(pp.bounds); r = any ? r.union(b) : b; any = true; }
  for (const e of page.elements) {
    const b = elementBoundsSafe(e);
    r = any ? r.union(b) : b; any = true;
  }
  if (!any) return new Rect(0, 0, 1280, 720);
  return r;
}

function elementBoundsSafe(e) {
  // Imported lazily to avoid a hard dependency cycle at module top-level.
  const b = e.bounds != null ? Rect.parse(e.bounds) : null;
  if (b) return b;
  const pts = [];
  if (e.inks) for (const p of e.inks) pts.push({ x: p.x, y: p.y });
  if (e.points) for (const p of e.points) {
    const s = typeof p === 'string' ? p : p.point;
    const [x, y] = s.split(',').map(Number);
    pts.push({ x, y });
  }
  if (!pts.length) return new Rect();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const pad = (e.width || 0) / 2;
  return new Rect(minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2);
}

/** Minimal image-only PDF writer (one JPEG per page). */
function buildPdf(pages) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [0];
  let length = 0;
  const push = (data) => {
    const buf = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(buf);
    length += buf.length;
  };
  const startObj = () => { offsets.push(length); };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const objCount = 2 + pages.length * 3;
  const kids = [];
  for (let i = 0; i < pages.length; i++) kids.push(`${3 + i * 3} 0 R`);

  startObj(); push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  startObj(); push(`2 0 obj\n<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(' ')}] >>\nendobj\n`);

  const jpegBytes = pages.map((p) => {
    const bin = atob(p.jpeg);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  });

  pages.forEach((p, i) => {
    const pageObj = 3 + i * 3;
    const contentObj = pageObj + 1;
    const imageObj = pageObj + 2;
    const w = Math.round(p.w), h = Math.round(p.h);
    startObj();
    push(`${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
      `/Resources << /XObject << /Im0 ${imageObj} 0 R >> >> /Contents ${contentObj} 0 R >>\nendobj\n`);
    const content = `q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`;
    startObj();
    push(`${contentObj} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
    startObj();
    push(`${imageObj} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes[i].length} >>\nstream\n`);
    push(jpegBytes[i]);
    push('\nendstream\nendobj\n');
  });

  const xrefStart = length;
  let xref = `xref\n0 ${objCount + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objCount; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  push(xref);
  push(`trailer\n<< /Size ${objCount + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
