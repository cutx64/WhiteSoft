/**
 * Tools — one object per toolbar entry.
 *
 * A tool receives world-space points and may mutate the editor's page.  Live
 * feedback is drawn through `editor.live` (a not-yet-committed element) and
 * `editor.overlayExtra`.
 */
import {
  Rect, rectFromPoints, simplify, smoothPoints, rotatePoint, distToSegment,
  handlePositions, rotateHandlePosition, handleAnchor, HANDLE_IS_HORIZONTAL, HANDLE_IS_VERTICAL,
} from './geometry.js';
import { clamp, clone } from './util.js';
import {
  T, makeInk, makePointsElement, makeText, makeSticky, makeTable, makeReaction,
  hitTest, elementBounds, localBounds, elementPoints, translateElement, scaleElement, rotateElement,
  ellipsePointsFromRect, polygonPointsFor, IS_OBJECT,
} from './elements.js';

const MIN_DRAW_DIST = 0.6;

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */
function replaceData(target, src) {
  for (const k of Object.keys(target)) if (!(k in src)) delete target[k];
  Object.assign(target, src);
}

function applyToSelection(ed, origins, fn) {
  const sel = [...ed.selection];
  origins.forEach((orig, i) => {
    const e = sel[i];
    if (!e) return;
    replaceData(e, clone(orig));
    fn(e, i);
  });
}

function snapPoint(ed, p) {
  const r = ed.ruler;
  if (!r.active) return p;
  const dx = Math.cos(r.angle), dy = Math.sin(r.angle);
  const vx = p.x - r.cx, vy = p.y - r.cy;
  let t = vx * dx + vy * dy;
  t = clamp(t, -r.length / 2, r.length / 2);
  return { x: r.cx + dx * t, y: r.cy + dy * t, pr: p.pr };
}

/* ------------------------------------------------------------------ *
 * Pan / hand
 * ------------------------------------------------------------------ */
export const panTool = {
  name: 'pan',
  cursor: 'grab',
  down() {},
  move() {},
  up() {},
};

/* ------------------------------------------------------------------ *
 * Pen
 * ------------------------------------------------------------------ */
function makePenTool(kind) {
  return {
    name: kind,
    cursor: 'crosshair',
    _pts: null,
    down(ed, p, ev) {
      this._pts = [snapPoint(ed, { x: p.x, y: p.y, pr: pressure(ev) })];
      // The ruler, the highlighter's "draw straight lines" switch and Shift all
      // collapse the stroke to a single segment between two endpoints.
      this._lineMode = ed.ruler.active || (kind === 'highlighter' && !!ed.highlighter.straight);
      this._shiftStraight = false;
    },
    move(ed, p, ev) {
      if (!this._pts) return;
      const last = this._pts[this._pts.length - 1];
      const q = snapPoint(ed, { x: p.x, y: p.y, pr: pressure(ev) });
      if (!this._lineMode && Math.hypot(q.x - last.x, q.y - last.y) < MIN_DRAW_DIST / ed.camera.zoom) return;
      if (this._lineMode || ev.shiftKey) {
        this._pts = [this._pts[0], q];
        this._shiftStraight = true;
      } else {
        if (this._shiftStraight) { this._pts = [this._pts[0]]; this._shiftStraight = false; }
        this._pts.push(q);
      }
      this._update(ed);
    },
    up(ed) {
      if (!this._pts) return;
      const pts = this._pts.length === 1
        ? [this._pts[0], { ...this._pts[0], x: this._pts[0].x + 0.01 }]
        : this._pts;
      const cfg = kind === 'pen' ? ed.pen : ed.highlighter;
      const width = (kind === 'pen' ? cfg.width : Math.max(cfg.width, 6)) / ed.camera.zoom;
      const stroke = withOpacity(cfg.color, cfg.opacity);
      let e;
      if (kind === 'pen') {
        const dense = this._lineMode || this._shiftStraight ? pts : smoothPoints(pts, 1);
        e = makeInk({ stroke, width, points: dense });
        if (cfg.inkGradient) e.inkGradient = cfg.inkGradient;
        if (cfg.arrow && cfg.arrow !== 'none') e.arrow = cfg.arrow;
      } else {
        e = makePointsElement(T.HIGHLIGHTER, { stroke, width, points: pts, closed: false });
        // "Draw straight lines" gives the highlight rounded (semicircular) ends.
        if (this._lineMode) e.cap = 'round';
      }
      ed.live = null;
      let final = e;
      if (kind === 'pen' && ed.enhanceInk && !this._lineMode) {
        const shaped = beautifyElement(e);
        if (shaped) final = shaped;
      }
      ed.addElement(final, { label: kind === 'pen' ? '书写' : '高亮' });
      this._pts = null;
      this._shiftStraight = false;
    },
    cancel(ed) { this._pts = null; this._shiftStraight = false; this._lineMode = false; ed.live = null; },
    _update(ed) {
      const cfg = kind === 'pen' ? ed.pen : ed.highlighter;
      const width = (kind === 'pen' ? cfg.width : Math.max(cfg.width, 6)) / ed.camera.zoom;
      const stroke = withOpacity(cfg.color, cfg.opacity);
      if (kind === 'pen') {
        ed.live = makeInk({ stroke, width, points: this._pts });
        if (cfg.inkGradient) ed.live.inkGradient = cfg.inkGradient;
        if (cfg.arrow && cfg.arrow !== 'none') ed.live.arrow = cfg.arrow;
      } else {
        ed.live = makePointsElement(T.HIGHLIGHTER, { stroke, width, points: this._pts, closed: false });
        if (this._lineMode) ed.live.cap = 'round';
      }
    },
  };
}

/** Apply the pen's opacity slider to an '#AARRGGBB' colour. */
export function withOpacity(argb, opacity) {
  if (opacity == null || opacity >= 1) return argb;
  const s = String(argb).replace('#', '');
  const a = Math.round(Math.max(0, Math.min(1, opacity)) * 255);
  return '#' + a.toString(16).padStart(2, '0').toUpperCase() + s.slice(2);
}

function pressure(ev, fallback = 0.5) {
  if (ev && ev.pointerType === 'pen' && ev.pressure > 0) return ev.pressure;
  return fallback;
}

export const penTool = makePenTool('pen');
export const highlighterTool = makePenTool('highlighter');

/* ------------------------------------------------------------------ *
 * Laser pointer — temporary ink that fades away
 * ------------------------------------------------------------------ */
export const laserTool = {
  name: 'laser',
  cursor: 'crosshair',
  _pts: null,
  down(ed, p) {
    this._pts = [{ x: p.x, y: p.y }];
    ed.startLaser(this._pts);
  },
  move(ed, p) {
    if (!this._pts) return;
    const last = this._pts[this._pts.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) < 1.5 / ed.camera.zoom) return;
    this._pts.push({ x: p.x, y: p.y });
    if (this._pts.length > 240) this._pts.shift();
    ed.startLaser(this._pts);
  },
  up(ed) {
    ed.pulseLaser(this._pts);
    this._pts = null;
  },
  cancel(ed) { this._pts = null; ed.clearLaser(); },
};

/* ------------------------------------------------------------------ *
 * Reactions
 * ------------------------------------------------------------------ */
export const reactionTool = {
  name: 'reaction',
  cursor: 'copy',
  down(ed, p) {
    const size = 46 / ed.camera.zoom;
    const e = makeReaction({
      bounds: new Rect(p.x - size / 2, p.y - size / 2, size, size),
      emoji: ed.reactionEmoji || '⭐',
    });
    ed.addElement(e, { select: true, label: '添加反应' });
  },
  move() {},
  up() {},
};

/* ------------------------------------------------------------------ *
 * Eraser
 * ------------------------------------------------------------------ */
export const eraserTool = {
  name: 'eraser',
  cursor: 'cell',
  _snap: null,
  _removed: null,
  down(ed, p) {
    this._snap = ed.snapshot();
    this._removed = new Set();
    this._erase(ed, p);
  },
  move(ed, p) { this._erase(ed, p); },
  up(ed) {
    if (this._removed && this._removed.size) {
      ed.commitSnapshot(this._snap, '擦除');
    }
    this._snap = null; this._removed = null;
  },
  cancel(ed) { if (this._snap) ed.restore(this._snap); this._snap = null; this._removed = null; },
  _erase(ed, p) {
    const radius = ed.eraserSize / ed.camera.zoom;
    let hit = false;
    for (let i = ed.page.elements.length - 1; i >= 0; i--) {
      const e = ed.page.elements[i];
      if (this._removed.has(e)) continue;
      if (hitTest(e, p.x, p.y, radius)) {
        this._removed.add(e);
        ed.page.elements.splice(i, 1);
        ed.selection.delete(e);
        hit = true;
      }
    }
    if (hit) { ed.invalidate(); ed.onSelectionChange?.(); }
  },
  overlay(ed, ctx) {
    if (!this._removed) return;
    void ctx;
  },
};

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */
export const shapeTool = {
  name: 'shape',
  cursor: 'crosshair',
  _start: null,
  down(ed, p, ev) {
    this._start = { x: p.x, y: p.y };
    this._shift = ev.shiftKey;
    this._update(ed, p, ev);
  },
  move(ed, p, ev) { if (this._start) this._update(ed, p, ev); },
  up(ed, p, ev) {
    if (!this._start) return;
    const e = this._build(ed, p, ev);
    this._start = null;
    ed.live = null;
    if (e) {
      ed.addElement(e, { select: true, label: '绘制形状' });
      // Whiteboard drops back to the pointer after a shape is placed.
      ed.setTool('select');
    }
  },
  cancel(ed) { this._start = null; ed.live = null; },
  _update(ed, p, ev) { ed.live = this._build(ed, p, ev); },
  _build(ed, p, ev) {
    const s = this._start;
    if (!s) return null;
    let x1 = p.x, y1 = p.y;
    const shift = ev.shiftKey || this._shift;
    const kind = ed.shapeKind;
    const st = ed.shapeStyle;

    if (kind === T.LINE || kind === T.ARROW || kind === T.DOUBLE_ARROW) {
      if (shift) {
        const dx = x1 - s.x, dy = y1 - s.y;
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        x1 = s.x + Math.cos(ang) * len;
        y1 = s.y + Math.sin(ang) * len;
      }
      const pts = [{ x: s.x, y: s.y }, { x: x1, y: y1 }];
      if (kind === T.ARROW) {
        const ang = Math.atan2(y1 - s.y, x1 - s.x);
        const len = Math.hypot(x1 - s.x, y1 - s.y);
        const hl = Math.min(len * 0.3, Math.max(st.width, 1) * 8);
        const spread = 0.4;
        pts.push(
          { x: x1 - hl * Math.cos(ang - spread), y: y1 - hl * Math.sin(ang - spread) },
          { x: x1 - hl * Math.cos(ang + spread), y: y1 - hl * Math.sin(ang + spread) },
        );
      }
      return makePointsElement(kind, { stroke: st.stroke, width: st.width, points: pts, closed: false, dash: st.dash });
    }
    let rect = Rect.fromLTRB(s.x, s.y, x1, y1).normalized();
    if (shift || ed.shapeForce === 'square') {
      const side = Math.max(rect.w, rect.h);
      rect = new Rect(rect.x, rect.y, side, side);
      rect.x = x1 < s.x ? s.x - side : s.x;
      rect.y = y1 < s.y ? s.y - side : s.y;
    }
    if (rect.w < 0.5 && rect.h < 0.5) rect = new Rect(rect.x, rect.y, 1, 1);
    return buildShapeElement(kind, rect, st);
  },
};

export function buildShapeElement(kind, rect, style) {
  if (kind === T.ELLIPSE) {
    return makePointsElement(T.ELLIPSE, {
      stroke: style.stroke, width: style.width, points: ellipsePointsFromRect(rect), closed: true, dash: style.dash,
    });
  }
  if (kind === T.RECT) {
    const pts = [
      { x: rect.left, y: rect.top }, { x: rect.right, y: rect.top },
      { x: rect.right, y: rect.bottom }, { x: rect.left, y: rect.bottom },
    ];
    const e = makePointsElement(T.RECT, { stroke: style.stroke, width: style.width, points: pts, closed: true, dash: style.dash });
    if (style.rounded) e.rounded = true;
    if (style.filled) { e.filled = true; e.fill = style.fill || style.stroke; }
    return e;
  }
  const pts = polygonPointsFor(kind, rect);
  const e = makePointsElement(kind, { stroke: style.stroke, width: style.width, points: pts, closed: true, dash: style.dash });
  if (style.filled) { e.filled = true; e.fill = style.fill || style.stroke; }
  return e;
}

/* ------------------------------------------------------------------ *
 * Text / sticky / table placement
 * ------------------------------------------------------------------ */
export const textTool = {
  name: 'text',
  cursor: 'text',
  down(ed, p, ev, sp) {
    const e = makeText({
      bounds: new Rect(p.x, p.y - ed.textStyle.fontSize, 240 / ed.camera.zoom, ed.textStyle.fontSize * 1.5),
      text: '',
      fontSize: ed.textStyle.fontSize / ed.camera.zoom,
      textColor: ed.textStyle.color,
      extra: { bold: ed.textStyle.bold, italic: ed.textStyle.italic, underline: ed.textStyle.underline, textAlign: ed.textStyle.align },
    });
    ed.addElement(e, { select: true, label: '添加文本' });
    ed.editElement?.(e, { selectAll: true, screen: sp });
    void ev;
  },
  move() {},
  up() {},
};

export const stickyTool = {
  name: 'sticky',
  cursor: 'copy',
  down(ed, p) {
    const w = 140 / ed.camera.zoom;
    const e = makeSticky({
      bounds: new Rect(p.x - w / 2, p.y - w / 2, w, w),
      color: ed.noteStyle.color,
      textColor: ed.noteStyle.color2,
      fontSize: ed.noteStyle.fontSize / ed.camera.zoom,
      radius: ed.noteStyle.radius,
    });
    ed.addElement(e, { select: true, label: '添加便签' });
    ed.editElement?.(e, { selectAll: false });
  },
  move() {},
  up() {},
};

export const tableTool = {
  name: 'table',
  cursor: 'crosshair',
  _start: null,
  down(ed, p) { this._start = { x: p.x, y: p.y }; },
  move(ed, p) {
    if (!this._start) return;
    const rect = Rect.fromLTRB(this._start.x, this._start.y, p.x, p.y).normalized();
    const cell = 90 / ed.camera.zoom;
    const cols = clamp(Math.round(rect.w / cell) || 3, 1, 12);
    const rows = clamp(Math.round(rect.h / cell) || 3, 1, 30);
    ed.live = makeTable({
      bounds: rect, rows, cols,
      cellW: rect.w / cols, cellH: rect.h / rows,
    });
  },
  up(ed) {
    if (!this._start) return;
    const live = ed.live;
    this._start = null;
    ed.live = null;
    const e = live && live.rows > 0 && live.bounds ? live : makeTable({ bounds: new Rect(ed.camera.x, ed.camera.y, 480 / ed.camera.zoom, 240 / ed.camera.zoom) });
    const b = Rect.parse(e.bounds);
    if (b.w < 20 || b.h < 20) {
      const cell = 90 / ed.camera.zoom;
      e.bounds = new Rect(b.x, b.y, cell * 3, cell * 3).toString();
    }
    ed.addElement(e, { select: true, label: '添加表格' });
    ed.setTool('select');
    // Drop straight into the first cell so the table can be filled in at once.
    ed.editElement(e, {});
  },
  cancel(ed) { this._start = null; ed.live = null; },
};

/* ------------------------------------------------------------------ *
 * Selection (lasso / marquee) + transform handles
 * ------------------------------------------------------------------ */
function makeSelectTool(mode) {
  return {
    name: mode === 'lasso' ? 'select' : 'marquee',
    cursor: 'default',
    _lasso: null,
    _start: null,
    _handle: null,
    _origins: null,
    _frame: null,
    _moveOrigin: null,
    _rotStart: 0,

    down(ed, p, ev, sp) {
      const handle = ed.handleAt(sp);
      if (handle) {
        this._handle = handle;
        this._origins = [...ed.selection].map((e) => clone(e));
        this._frame = ed.selectionFrame();
        this._moveOrigin = { x: p.x, y: p.y };
        this._rotStart = Math.atan2(p.y - this._frame.local.cy, p.x - this._frame.local.cx);
        this._snap = ed.snapshot();
        return;
      }

      const hit = this._pick(ed, p, ev);
      // Pressing *inside the existing selection* moves it. Everything else —
      // including pressing straight onto an unselected object — starts a
      // marquee / lasso, and whatever sits under the cursor is ignored until
      // the region is settled on release.
      if (hit && ed.selection.has(hit) && !ev.shiftKey) {
        this._origins = [...ed.selection].map((e) => clone(e));
        this._frame = ed.selectionFrame();
        this._moveOrigin = { x: p.x, y: p.y };
        this._snap = ed.snapshot();
        this._moving = true;
        ed.requestRender();
        return;
      }

      this._pressHit = hit || null;
      this._moved = false;
      this._snap = ed.snapshot();
      if (mode === 'lasso') this._lasso = [{ x: p.x, y: p.y }];
      else this._start = { x: p.x, y: p.y };
      ed.requestRender();
    },

    move(ed, p, ev) {
      if (this._handle) return this._transform(ed, p, ev);
      if (this._moving) {
        let dx = p.x - this._moveOrigin.x, dy = p.y - this._moveOrigin.y;
        if (ed.snapEnabled && !ev.altKey && this._frame) {
          const s = snapDelta(ed, this._frame.aabb, dx, dy);
          dx = s.dx; dy = s.dy;
          ed.guides = s.guides;
        } else {
          ed.guides = null;
        }
        applyToSelection(ed, this._origins, (e) => translateElement(e, dx, dy));
        ed.renderer.invalidate();
        ed.requestRender();
        return;
      }
      if (this._lasso) {
        const last = this._lasso[this._lasso.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) > 1.5 / ed.camera.zoom) {
          this._lasso.push({ x: p.x, y: p.y });
          this._moved = true;
        }
        ed.requestRender();
      } else if (this._start) {
        this._marquee = Rect.fromLTRB(this._start.x, this._start.y, p.x, p.y).normalized();
        if (this._marquee.w > 2 / ed.camera.zoom || this._marquee.h > 2 / ed.camera.zoom) this._moved = true;
        ed.requestRender();
      }
    },

    up(ed, p, ev) {
      if (this._handle) {
        this._handle = null; this._origins = null; this._frame = null;
        if (this._snap) ed.commitSnapshot(this._snap, '变换');
        return;
      }
      if (this._moving) {
        this._moving = false;
        ed.guides = null;
        if (this._snap) ed.commitSnapshot(this._snap, '移动');
        this._origins = null; this._frame = null;
        return;
      }
      if (this._lasso) {
        const pts = this._lasso; this._lasso = null;
        if (this._moved && pts.length > 3) ed.selectInLasso(pts, ev.shiftKey);
        else this._settleClick(ed, ev);
        this._moved = false;
        ed.requestRender();
        return;
      }
      if (this._start) {
        const r = Rect.fromLTRB(this._start.x, this._start.y, p.x, p.y).normalized();
        const dragged = r.w > 2 / ed.camera.zoom || r.h > 2 / ed.camera.zoom;
        this._start = null; this._marquee = null;
        if (dragged) ed.selectInRect(r, ev.shiftKey);
        else this._settleClick(ed, ev);
        this._moved = false;
        ed.requestRender();
      }
    },

    /** A press that never turned into a drag behaves like a plain click. */
    _settleClick(ed, ev) {
      const hit = this._pressHit;
      this._pressHit = null;
      if (hit) {
        if (ev.shiftKey) ed.toggleSelection(hit, true);
        else { ed.selection.clear(); ed.selection.add(hit); ed.onSelectionChange?.(); }
      } else if (!ev.shiftKey) {
        ed.clearSelection();
      }
      ed.requestRender();
    },

    cancel(ed) {
      this._lasso = null; this._start = null; this._marquee = null;
      this._moving = false; this._handle = null; this._frame = null;
      this._pressHit = null; this._moved = false;
    },

    dblclick(ed, p) {
      const hit = this._pick(ed, p, {});
      if (hit && (hit.type === T.TEXT || hit.type === T.STICKY || hit.type === T.TABLE)) {
        ed.editElement?.(hit, {});
      }
    },

    _pick(ed, p, ev) {
      void ev;
      return ed.pickAt(p, 6 / ed.camera.zoom);
    },

    _transform(ed, p, ev) {
      const frame = this._frame;
      const b0 = frame.local;
      const rot = frame.rot;
      const h = this._handle;

      if (h === 'rotate') {
        const a = Math.atan2(p.y - b0.cy, p.x - b0.cx);
        let d = a - this._rotStart;
        if (ev.shiftKey) d = Math.round(d / (Math.PI / 12)) * (Math.PI / 12);
        const c = { x: b0.cx, y: b0.cy };
        applyToSelection(ed, this._origins, (e) => rotateElement(e, d, c));
        ed.renderer.invalidate();
        ed.requestRender();
        return;
      }

      // Convert the pointer into the selection's un-rotated frame.
      const local = rot ? rotatePoint(p.x, p.y, b0.cx, b0.cy, -rot) : { x: p.x, y: p.y };
      const anchor = handleAnchor(b0, h);

      let sx = 1, sy = 1;
      if (HANDLE_IS_HORIZONTAL(h)) {
        const startX = h.includes('w') ? b0.left : b0.right;
        const denom = anchor.x - startX;
        if (Math.abs(denom) > 1e-6) sx = (anchor.x - local.x) / denom;
      }
      if (HANDLE_IS_VERTICAL(h)) {
        const startY = h.includes('n') ? b0.top : b0.bottom;
        const denom = anchor.y - startY;
        if (Math.abs(denom) > 1e-6) sy = (anchor.y - local.y) / denom;
      }
      // Images (and reactions) always keep their aspect ratio: whichever axis
      // the handle drives sets a single factor for both.
      const sel = [...ed.selection];
      const proportional = sel.length > 0 && sel.every((e) => e.type === T.IMAGE || e.type === T.REACTION);
      if (proportional) {
        const horiz = HANDLE_IS_HORIZONTAL(h);
        const vert = HANDLE_IS_VERTICAL(h);
        let factor;
        if (horiz && vert) factor = Math.max(Math.abs(sx), Math.abs(sy));
        else if (horiz) factor = Math.abs(sx);
        else factor = Math.abs(sy);
        const sign = (horiz ? Math.sign(sx) : Math.sign(sy)) || 1;
        sx = sign * factor;
        sy = sign * factor;
      } else if (ev.shiftKey && HANDLE_IS_HORIZONTAL(h) && HANDLE_IS_VERTICAL(h)) {
        const s = Math.max(Math.abs(sx), Math.abs(sy));
        sx = (sx < 0 ? -1 : 1) * s;
        sy = (sy < 0 ? -1 : 1) * s;
      }
      if (Math.abs(sx) < 0.02) sx = sx < 0 ? -0.02 : 0.02;
      if (Math.abs(sy) < 0.02) sy = sy < 0 ? -0.02 : 0.02;

      applyToSelection(ed, this._origins, (e) => scaleElementRotated(e, sx, sy, anchor, rot, b0));
      ed.renderer.invalidate();
      ed.requestRender();
    },

    overlay(ed, ctx, env) {
      const k = env.zoom;
      if (this._lasso && this._lasso.length > 1) {
        ctx.save();
        ctx.setLineDash([6 / k, 4 / k]);
        ctx.strokeStyle = '#0F6CBD';
        ctx.lineWidth = 1.5 / k;
        ctx.fillStyle = 'rgba(15,108,189,0.08)';
        ctx.beginPath();
        ctx.moveTo(this._lasso[0].x, this._lasso[0].y);
        for (const p of this._lasso) ctx.lineTo(p.x, p.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
      if (this._marquee) {
        ctx.save();
        ctx.setLineDash([6 / k, 4 / k]);
        ctx.strokeStyle = '#0F6CBD';
        ctx.lineWidth = 1.5 / k;
        ctx.fillStyle = 'rgba(15,108,189,0.10)';
        ctx.fillRect(this._marquee.x, this._marquee.y, this._marquee.w, this._marquee.h);
        ctx.strokeRect(this._marquee.x, this._marquee.y, this._marquee.w, this._marquee.h);
        ctx.restore();
      }
    },
  };
}

/** Scale about a pivot that lives in a rotated frame. */
function scaleElementRotated(e, sx, sy, pivotLocal, rot, bounds) {
  const map = (x, y) => {
    const local = rotatePoint(x, y, bounds.cx, bounds.cy, -rot);
    const scaled = { x: pivotLocal.x + (local.x - pivotLocal.x) * sx, y: pivotLocal.y + (local.y - pivotLocal.y) * sy };
    return rotatePoint(scaled.x, scaled.y, bounds.cx, bounds.cy, rot);
  };
  if (e.type === T.INK) {
    e.inks = e.inks.map((p) => { const q = map(p.x, p.y); return { x: r4(q.x), y: r4(q.y), pr: p.pr }; });
  } else if (e.points) {
    e.points = e.points.map((p) => {
      const s = typeof p === 'string' ? p : p.point;
      const [x, y] = s.split(',').map(Number);
      const q = map(x, y);
      return { point: `${r4(q.x)},${r4(q.y)}` };
    });
  }
  if (e.bounds != null) {
    const b = Rect.parse(e.bounds);
    const corners = [
      { x: b.left, y: b.top }, { x: b.right, y: b.top },
      { x: b.right, y: b.bottom }, { x: b.left, y: b.bottom },
    ].map((c) => map(c.x, c.y));
    const nr = rectFromPoints(corners);
    e.bounds = nr.toString();
    if (!IS_OBJECT.has(e.type)) e.rotation = 0;
  }
  if ((e.type === T.INK || e.type === T.HIGHLIGHTER) && e.width) {
    const s = Math.sqrt(Math.abs(sx * sy)) || 1;
    if (Math.abs(s - 1) > 1e-3) e.width = r4(e.width * s);
  }
}

const r4 = (v) => Number(Number(v).toFixed(4));

export const selectTool = makeSelectTool('lasso');
export const marqueeTool = makeSelectTool('marquee');

/* ------------------------------------------------------------------ *
 * Ruler
 * ------------------------------------------------------------------ */
export const rulerTool = {
  name: 'ruler',
  cursor: 'grab',
  _drag: null,
  down(ed, p, sp) {
    const r = ed.ruler;
    r.active = true;
    const c = { x: r.cx, y: r.cy };
    // Grab the ruler body to move it; the small handle at its right end rotates.
    const rotating = Math.hypot(p.x - c.x, p.y - c.y) > r.length * 0.36;
    this._drag = { rotating, x: p.x, y: p.y, angle: r.angle, cx: r.cx, cy: r.cy };
    void sp;
  },
  move(ed, p, ev) {
    if (!this._drag) return;
    const r = ed.ruler;
    if (this._drag.rotating || ev.shiftKey) {
      let a = Math.atan2(p.y - r.cy, p.x - r.cx);
      if (ev.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
      r.angle = a;
    } else {
      r.cx = this._drag.cx + (p.x - this._drag.x);
      r.cy = this._drag.cy + (p.y - this._drag.y);
    }
    ed.requestRender();
  },
  up() { this._drag = null; },
  cancel() { this._drag = null; },
};

/* ------------------------------------------------------------------ *
 * Ink → shape ("Beautify", Alt+B) and "Enhance inked shapes"
 * ------------------------------------------------------------------ */
/**
 * Turn a freehand stroke into the shape it most resembles: a straight line, a
 * closed polygon (rectangle / triangle / diamond / pentagon / ellipse) or a
 * smoothed polyline.  Returns the replacement element, or null.
 */
export function beautifyElement(e) {
  if (e.type !== T.INK && e.type !== T.HIGHLIGHTER) return null;
  const pts = elementPoints(e);
  if (pts.length < 3) return null;
  const first = pts[0], last = pts[pts.length - 1];
  const b = rectFromPoints(pts);
  const diag = Math.hypot(b.w, b.h) || 1;
  const closedGap = Math.hypot(last.x - first.x, last.y - first.y) / diag;

  // Straight line?
  let maxDev = 0;
  for (const p of pts) maxDev = Math.max(maxDev, distToSegment(p.x, p.y, first.x, first.y, last.x, last.y));
  if (maxDev / diag < 0.035) {
    return makePointsElement(T.LINE, {
      stroke: e.stroke, width: e.width, points: [first, last], closed: false,
    });
  }

  if (closedGap > 0.22 || b.w < diag * 0.15 || b.h < diag * 0.15) {
    // Not a closed shape — keep it as smoothed ink.
    return null;
  }

  const corners = simplify(pts, diag * 0.055);
  const n = corners.length;
  const fill = Math.abs(polygonArea(corners)) / (b.w * b.h || 1);
  const ellipseFit = ellipseResidual(corners, b) / diag;
  const rectFit = rectResidual(corners, b) / diag;

  const mk = (type) => makePointsElement(type, {
    stroke: e.stroke, width: e.width, points: polygonPointsFor(type, b), closed: true,
  });
  if (ellipseFit < 0.09 && ellipseFit < rectFit) {
    return makePointsElement(T.ELLIPSE, {
      stroke: e.stroke, width: e.width, points: ellipsePointsFromRect(b), closed: true,
    });
  }
  if (rectFit < 0.08 && fill > 0.85) {
    return makePointsElement(T.RECT, {
      stroke: e.stroke, width: e.width,
      points: polygonPointsFor(T.DIAMOND, b) && [
        { x: b.left, y: b.top }, { x: b.right, y: b.top },
        { x: b.right, y: b.bottom }, { x: b.left, y: b.bottom },
      ],
      closed: true,
    });
  }
  if (n <= 4) return mk(T.TRIANGLE);
  if (n === 5) return mk(T.DIAMOND);
  if (n === 6) return mk(T.PENTAGON);
  if (n === 7) return mk(T.HEXAGON);
  return null;
}

function polygonArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  }
  return a / 2;
}

function ellipseResidual(pts, b) {
  const rx = b.w / 2 || 1e-6, ry = b.h / 2 || 1e-6;
  let sum = 0;
  for (const p of pts) {
    const nx = (p.x - b.cx) / rx, ny = (p.y - b.cy) / ry;
    sum += Math.abs(Math.hypot(nx, ny) - 1);
  }
  return sum / pts.length;
}

function rectResidual(pts, b) {
  let sum = 0;
  for (const p of pts) {
    const d = Math.min(
      Math.abs(p.x - b.left), Math.abs(p.x - b.right),
      Math.abs(p.y - b.top), Math.abs(p.y - b.bottom),
    );
    sum += d;
  }
  return sum / pts.length;
}

/** Replace the selected ink strokes with their beautified equivalents. */
export function beautifySelection(ed) {
  const targets = [...ed.selection].filter((e) => e.type === T.INK || e.type === T.HIGHLIGHTER);
  if (!targets.length) return 0;
  const before = ed.snapshot();
  let n = 0;
  for (const e of targets) {
    const shaped = beautifyElement(e);
    if (!shaped) continue;
    const i = ed.page.elements.indexOf(e);
    if (i >= 0) ed.page.elements.splice(i, 1, shaped);
    ed.selection.delete(e);
    ed.selection.add(shaped);
    n++;
  }
  if (n) ed.commitSnapshot(before, '墨迹转形状');
  return n;
}

/* ------------------------------------------------------------------ *
 * Object snapping guides
 * ------------------------------------------------------------------ */
/** Snap a moving selection's bounds to nearby objects; returns adjusted delta. */
export function snapDelta(ed, moving, dx, dy) {
  const threshold = 7 / ed.camera.zoom;
  const probe = new Rect(moving.x + dx, moving.y + dy, moving.w, moving.h);
  const targets = ed.page.elements.filter((e) => !ed.selection.has(e) && !e.hidden);
  let bestX = null, bestY = null;
  const guides = [];
  const xs = [], ys = [];
  for (const t of targets) {
    const b = elementBounds(t);
    xs.push(b.left, b.cx, b.right);
    ys.push(b.top, b.cy, b.bottom);
  }
  const mine = [probe.left, probe.cx, probe.right];
  const mineY = [probe.top, probe.cy, probe.bottom];

  for (const mx of mine) {
    for (const tx of xs) {
      const d = tx - mx;
      if (Math.abs(d) <= threshold && (bestX == null || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, at: tx };
    }
  }
  for (const my of mineY) {
    for (const ty of ys) {
      const d = ty - my;
      if (Math.abs(d) <= threshold && (bestY == null || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, at: ty };
    }
  }
  if (bestX) guides.push({ axis: 'x', at: bestX.at, from: probe.top + (bestY ? bestY.d : 0), to: probe.bottom + (bestY ? bestY.d : 0) });
  if (bestY) guides.push({ axis: 'y', at: bestY.at, from: probe.left + (bestX ? bestX.d : 0), to: probe.right + (bestX ? bestX.d : 0) });
  return {
    dx: dx + (bestX ? bestX.d : 0),
    dy: dy + (bestY ? bestY.d : 0),
    guides,
  };
}

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */
export const TOOLS = {
  select: selectTool,
  marquee: marqueeTool,
  pen: penTool,
  highlighter: highlighterTool,
  laser: laserTool,
  eraser: eraserTool,
  shape: shapeTool,
  text: textTool,
  sticky: stickyTool,
  table: tableTool,
  reaction: reactionTool,
  image: { name: 'image', cursor: 'copy', down() {}, move() {}, up() {} },
  ruler: rulerTool,
  pan: panTool,
};

export { handlePositions, rotateHandlePosition, elementBounds, elementPoints, localBounds, distToSegment };
