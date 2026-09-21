/**
 * Canvas renderer.
 *
 * Draws one whiteboard "page" (a PDF backdrop plus every element) into a
 * 2-D canvas.  A world-space cache keeps panning and live inking smooth even
 * on pages that carry thousands of pen strokes.
 */
import { Rect, rectFromPoints, distToSegment } from './geometry.js';
import { argbToRgba, clamp } from './util.js';
import {
  T, POLYGON_SHAPES, IS_OBJECT, elementPoints, localBounds,
  fontString, wrapText, LINE_HEIGHT, ellipsePointsFromRect, stickyCornerRadius,
} from './elements.js';
import { layoutRichText, drawRichLine } from './mathtext.js';

const HIGHLIGHTER_MIN_WIDTH = 6;

/**
 * Rendering options that are not part of the file format.
 * `roundStraightHighlights` also rounds the ends of highlights that were drawn
 * as a straight line in an existing .note (a two-point, or fully collinear,
 * highlighter stroke), which is how the sample boards were annotated.
 */
export const renderOptions = { roundStraightHighlights: true };

/** Is this highlighter stroke effectively a single straight segment? */
function isStraightStroke(pts) {
  if (!pts || pts.length < 2) return false;
  if (pts.length === 2) return true;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6) return false;
  const tol = Math.max(len * 0.004, 1e-3);
  for (const p of pts) {
    if (distToSegment(p.x, p.y, a.x, a.y, b.x, b.y) > tol) return false;
  }
  return true;
}

/** Should this highlighter be drawn as a stadium (band + two semicircles)? */
function highlighterIsRounded(e, pts) {
  if (e.cap === 'round') return true;
  if (e.cap === 'butt') return false;
  return renderOptions.roundStraightHighlights && isStraightStroke(pts);
}

/* ------------------------------------------------------------------ *
 * Ink
 * ------------------------------------------------------------------ */
function pressureScale(pr, maxPr) {
  if (maxPr < 0.05) return 1;
  const t = clamp(pr / maxPr, 0, 1);
  return 0.42 + 0.58 * t;
}

/** Multi-colour "Rainbow" / "Aurora" pen fills. */
export function makeInkGradient(ctx, pts, kind) {
  const stops = kind === 'aurora'
    ? ['#583D71', '#546C9D', '#739CBD', '#7BBAC7', '#97CDCF', '#8CD1B5']
    : ['#D09734', '#EFB73B', '#E6C245', '#82AE3E', '#3EA03D', '#23A46A', '#2F9794', '#40A3AD'];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  if (maxX - minX < 0.001 && maxY - minY < 0.001) { maxX = minX + 1; }
  const g = ctx.createLinearGradient(minX, minY, maxX, maxY);
  stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
  return g;
}

/* ------------------------------------------------------------------ *
 * Geometry cache
 *
 * Building a Path2D for a 1000-point pen stroke is expensive, but the geometry
 * only depends on the element's own coordinates — not on the zoom or the
 * camera.  Caching the built path per element turns a cache rebuild from
 * "rebuild every stroke" into "re-fill a ready-made path", which is what makes
 * panning and zooming a heavily annotated page smooth.
 * ------------------------------------------------------------------ */
function pathSignature(e, pts) {
  const n = pts.length;
  const a = pts[0], m = pts[(n / 2) | 0], b = pts[n - 1];
  return `${e.type}|${n}|${e.width || 0}|${e.stroke || ''}|${e.inkGradient || ''}|${e.closed ? 1 : 0}`
    + `|${a.x},${a.y}|${m.x},${m.y}|${b.x},${b.y}`;
}

function cachedPath(e, env, sig, build) {
  const store = env && env.pathCache;
  if (!store) return build();
  const rec = store.get(e);
  if (rec && rec.sig === sig) return rec.path;
  const path = build();
  store.set(e, { sig, path });
  return path;
}

function polylinePath(pts, closed = false) {
  const path = new Path2D();
  if (!pts.length) return path;
  path.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
  if (closed) path.closePath();
  return path;
}

/** Filled variable-width ribbon that reproduces pen pressure. */
function strokeInk(ctx, pts, width, color, env, e) {
  const n = pts.length;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  if (n === 0) return;
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, Math.max(width / 2, 0.2), 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  let maxPr = 0;
  for (const p of pts) if ((p.pr || 0) > maxPr) maxPr = p.pr || 0;

  const sig = pathSignature(e, pts);
  if (maxPr < 0.05) {
    // No real pressure data recorded — a plain round-joined polyline is exact.
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke(cachedPath(e, env, sig, () => polylinePath(pts, false)));
    return;
  }

  const path = cachedPath(e, env, sig, () => {
    const radii = pts.map((p) => Math.max((width / 2) * pressureScale(p.pr || 0, maxPr), 0.15));
    const left = [], right = [];
    for (let i = 0; i < n; i++) {
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(n - 1, i + 1)];
      let dx = next.x - prev.x, dy = next.y - prev.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) { dx = 1; dy = 0; } else { dx /= len; dy /= len; }
      const nx = -dy, ny = dx;
      const r = radii[i];
      left.push({ x: pts[i].x + nx * r, y: pts[i].y + ny * r });
      right.push({ x: pts[i].x - nx * r, y: pts[i].y - ny * r });
    }
    const p = new Path2D();
    p.moveTo(left[0].x, left[0].y);
    for (let i = 1; i < n; i++) p.lineTo(left[i].x, left[i].y);
    for (let i = n - 1; i >= 0; i--) p.lineTo(right[i].x, right[i].y);
    p.closePath();
    return p;
  });
  ctx.fill(path);

  // Round the two ends and any joint sharper than the local radius.  These are
  // filled as a *separate* path: an arc always winds clockwise, so merging it
  // into the ribbon would cancel the overlap and punch holes in the stroke.
  const dots = cachedPath(e, env, sig + '|dots', () => {
    const radii = pts.map((p) => Math.max((width / 2) * pressureScale(p.pr || 0, maxPr), 0.15));
    const p = new Path2D();
    p.moveTo(pts[0].x + radii[0], pts[0].y);
    p.arc(pts[0].x, pts[0].y, radii[0], 0, Math.PI * 2);
    p.moveTo(pts[n - 1].x + radii[n - 1], pts[n - 1].y);
    p.arc(pts[n - 1].x, pts[n - 1].y, radii[n - 1], 0, Math.PI * 2);
    for (let i = 1; i + 1 < n; i++) {
      if (Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y) > radii[i]) {
        p.moveTo(pts[i].x + radii[i], pts[i].y);
        p.arc(pts[i].x, pts[i].y, radii[i], 0, Math.PI * 2);
      }
    }
    return p;
  });
  ctx.fill(dots);
}

function strokeHighlighter(ctx, pts, width, color, e, env) {
  const w = Math.max(width, HIGHLIGHTER_MIN_WIDTH);
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  // Straight-line highlights are drawn as a stadium: the rectangular band plus
  // a semicircle at each short end.
  ctx.lineCap = highlighterIsRounded(e, pts) ? 'round' : 'butt';
  ctx.lineJoin = 'round';
  const sig = pathSignature(e, pts);
  ctx.stroke(cachedPath(e, env, sig, () => {
    if (pts.length === 1) return polylinePath([pts[0], { x: pts[0].x + 0.01, y: pts[0].y }], false);
    return polylinePath(pts, false);
  }));
}

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */
function applyDash(ctx, e) {
  if (e.dash) {
    const w = Math.max(e.width || 1.6, 0.5);
    ctx.setLineDash([Math.max(w * 4, 5), Math.max(w * 3, 4)]);
  } else {
    ctx.setLineDash([]);
  }
}

function tracePolygon(ctx, pts, closed) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  if (closed) ctx.closePath();
}

/** Shape outline as a reusable Path2D. */
function shapePath(e, pts, env, build) {
  const sig = pathSignature(e, pts);
  return cachedPath(e, env, sig, build);
}

export function drawShape(ctx, e, env) {
  const pts = elementPoints(e);
  if (!pts.length) return;
  const color = argbToRgba(e.stroke);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(e.width || 1.6, 0.35);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  applyDash(ctx, e);

  switch (e.type) {
    case T.LINE: {
      ctx.stroke(shapePath(e, pts, env, () => polylinePath([pts[0], pts[pts.length - 1]], false)));
      break;
    }
    case T.ARROW:
    case T.DOUBLE_ARROW: {
      const a = pts[0], b = pts[1] || pts[0];
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      const head = (from, to) => {
        const ang = Math.atan2(to.y - from.y, to.x - from.x);
        const len = Math.hypot(to.x - from.x, to.y - from.y);
        const hl = Math.min(len * 0.28, Math.max(e.width || 1.6, 1) * 6.5);
        const spread = 0.42;
        ctx.beginPath();
        ctx.moveTo(to.x, to.y);
        ctx.lineTo(to.x - hl * Math.cos(ang - spread), to.y - hl * Math.sin(ang - spread));
        ctx.lineTo(to.x - hl * Math.cos(ang + spread), to.y - hl * Math.sin(ang + spread));
        ctx.closePath();
        ctx.fill();
      };
      if (pts.length >= 4) {
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(pts[2].x, pts[2].y);
        ctx.lineTo(pts[3].x, pts[3].y);
        ctx.closePath();
        ctx.fill();
        if (e.type === T.DOUBLE_ARROW) {
          const ang = Math.atan2(a.y - b.y, a.x - b.x);
          const hl = Math.hypot(pts[2].x - b.x, pts[2].y - b.y);
          const spread = 0.42;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(a.x - hl * Math.cos(ang - spread), a.y - hl * Math.sin(ang - spread));
          ctx.lineTo(a.x - hl * Math.cos(ang + spread), a.y - hl * Math.sin(ang + spread));
          ctx.closePath();
          ctx.fill();
        }
      } else {
        head(a, b);
        if (e.type === T.DOUBLE_ARROW) head(b, a);
      }
      break;
    }
    case T.ELLIPSE: {
      const b = rectFromPoints(pts);
      const path = shapePath(e, pts, env, () => {
        const p = new Path2D();
        p.ellipse(b.cx, b.cy, Math.max(b.w / 2, 0.01), Math.max(b.h / 2, 0.01), 0, 0, Math.PI * 2);
        return p;
      });
      if (e.filled) { ctx.fillStyle = argbToRgba(e.fill); ctx.fill(path); }
      ctx.stroke(path);
      break;
    }
    case T.RECT: {
      const b = rectFromPoints(pts);
      const path = shapePath(e, pts, env, () => {
        const p = new Path2D();
        if (e.rounded) roundRectPath(p, b.left, b.top, b.w, b.h, Math.min(b.w, b.h) * 0.18);
        else p.rect(b.left, b.top, b.w, b.h);
        return p;
      });
      if (e.filled) { ctx.fillStyle = argbToRgba(e.fill); ctx.fill(path); }
      ctx.stroke(path);
      break;
    }
    case T.POLYLINE:
      ctx.stroke(shapePath(e, pts, env, () => polylinePath(pts, false)));
      break;
    default:
      if (POLYGON_SHAPES.has(e.type)) {
        const path = shapePath(e, pts, env, () => polylinePath(pts, true));
        if (e.filled) { ctx.fillStyle = argbToRgba(e.fill); ctx.fill(path); }
        ctx.stroke(path);
      } else {
        ctx.stroke(shapePath(e, pts, env, () => polylinePath(pts, !!e.closed)));
      }
  }
  ctx.setLineDash([]);
}

/** Arrow heads appended to an inked stroke when the pen's arrow mode is on. */
function drawInkArrow(ctx, pts, e, color) {
  const w = Math.max(e.width || 1.6, 0.4);
  const head = (tip, prev) => {
    const ang = Math.atan2(tip.y - prev.y, tip.x - prev.x);
    const hl = w * 7;
    const spread = 0.42;
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x - hl * Math.cos(ang - spread), tip.y - hl * Math.sin(ang - spread));
    ctx.lineTo(tip.x - hl * Math.cos(ang + spread), tip.y - hl * Math.sin(ang + spread));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };
  const n = pts.length;
  head(pts[n - 1], pts[Math.max(0, n - 4)]);
  if (e.arrow === 'both') head(pts[0], pts[Math.min(n - 1, 3)]);
}

/* ------------------------------------------------------------------ *
 * Objects
 * ------------------------------------------------------------------ */
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  if (!(ctx instanceof Path2D)) ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawSticky(ctx, e, env) {
  const b = Rect.parse(e.bounds);
  // Rounded corners: the radius is a ratio of the shorter side, so a note
  // keeps its shape when it is resized (see stickyCornerRadius in elements.js).
  const r = stickyCornerRadius(e, b.w, b.h);
  const shape = new Path2D();
  roundRectPath(shape, b.x, b.y, b.w, b.h, r);

  // Drop shadow, painted only in the ring around the note.  A shadow cast under
  // the note itself would show through a translucent paper and darken it.
  const halo = Math.max(14, r + 8);
  const ring = new Path2D();
  roundRectPath(ring, b.x - halo, b.y - halo, b.w + halo * 2, b.h + halo * 2, r + halo);
  roundRectPath(ring, b.x, b.y, b.w, b.h, r);
  ctx.save();
  ctx.clip(ring, 'evenodd');
  ctx.shadowColor = 'rgba(0,0,0,0.20)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = 'rgba(0,0,0,0.20)';
  ctx.fill(shape); // clipped out inside the note; only the blurred spill lands
  ctx.restore();

  ctx.fillStyle = argbToRgba(e.color || '#FFFFF275');
  ctx.fill(shape);

  const pad = Math.min(10, b.w * 0.08);
  const size = e.fontSize || 18;
  // The sticky keeps its paper while it is edited (the textarea is
  // transparent), but its text belongs to the DOM editor then.
  if (env?.editing === e) return;
  ctx.fillStyle = argbToRgba(e.textColor || '#FF000000');
  ctx.font = fontString(size, e);
  const lines = layoutRichText(ctx, e.text || '', size, Math.max(b.w - pad * 2, 4), e, textScale(env));
  const align = e.textAlign || 'left';
  let y = b.y + pad;
  const maxY = b.bottom - pad + size * 0.35;
  for (const line of lines) {
    if (y > maxY) break;
    drawRichLine(ctx, line, alignX(align, b.x + pad, b.cx, b.right - pad, line.w), y, size, e);
    y += size * LINE_HEIGHT;
  }
}

function drawTextObject(ctx, e, env) {
  // While this element is open in the DOM inline editor, the textarea is the
  // only thing that may draw its text: painting it here as well shows a
  // slightly offset second copy (ghosting), because DOM and canvas text are
  // rasterised differently and the box only re-fits when the editor closes.
  if (env?.editing === e) return;
  const b = Rect.parse(e.bounds);
  const size = e.fontSize || 20;
  ctx.fillStyle = argbToRgba(e.textColor || '#FF000000');
  ctx.font = fontString(size, e);
  const lines = layoutRichText(ctx, e.text || '', size, Math.max(b.w, 4), e, textScale(env));
  const align = e.textAlign || 'left';
  let y = b.y;
  for (const line of lines) {
    drawRichLine(ctx, line, alignX(align, b.x, b.cx, b.right, line.w), y, size, e);
    y += size * LINE_HEIGHT;
  }
}

/** Left edge of a line given the element's alignment. */
function alignX(align, left, center, right, lineW) {
  if (align === 'center') return center - lineW / 2;
  if (align === 'right') return right - lineW;
  return left;
}

/** Device pixels per world unit, for deciding how sharply to rasterise math. */
function textScale(env) {
  return (env && env.scale) || (env ? env.zoom * (env.dpr || 1) : 1);
}

function drawTable(ctx, e, env) {
  const b = Rect.parse(e.bounds);
  const colW = e.colWidths || [];
  const rowH = e.rowHeights || [];
  const totalW = colW.reduce((a, c) => a + c, 0) || b.w;
  const totalH = rowH.reduce((a, c) => a + c, 0) || b.h;
  const sx = totalW ? b.w / totalW : 1;
  const sy = totalH ? b.h / totalH : 1;

  ctx.save();
  ctx.fillStyle = e.background ? argbToRgba(e.background) : 'rgba(255,255,255,0.92)';
  ctx.fillRect(b.x, b.y, b.w, b.h);
  ctx.strokeStyle = argbToRgba(e.stroke || '#FF808285');
  ctx.lineWidth = Math.max(e.width || 1.6, 0.3);
  ctx.setLineDash([]);

  let y = b.y;
  const rowY = [y];
  for (let r = 0; r < rowH.length; r++) { y += rowH[r] * sy; rowY.push(y); }
  let x = b.x;
  const colX = [x];
  for (let c = 0; c < colW.length; c++) { x += colW[c] * sx; colX.push(x); }

  for (let r = 0; r < e.rows; r++) {
    for (let c = 0; c < e.cols; c++) {
      const w = colX[c + 1] - colX[c];
      const h = rowY[r + 1] - rowY[r];
      if (e.headerRow && r === 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.06)';
        ctx.fillRect(colX[c], rowY[r], w, h);
      }
      ctx.strokeRect(colX[c], rowY[r], w, h);
      // Cell text is drawn by the DOM contenteditable cells while the table is
      // being edited; drawing it here too would ghost underneath them.
      const txt = env?.editing === e ? '' : ((e.cells?.[r]?.[c]) || '');
      if (txt) {
        const size = e.fontSize || 16;
        ctx.fillStyle = argbToRgba(e.textColor || '#FF000000');
        ctx.font = fontString(size, r === 0 && e.headerRow ? { bold: true } : {});
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        const pad = 6;
        const lines = wrapText(txt, size, Math.max(w - pad * 2, 4), e);
        let ty = rowY[r] + h / 2 - ((lines.length - 1) * size * LINE_HEIGHT) / 2;
        for (const line of lines) {
          if (ty > rowY[r + 1] + size) break;
          ctx.fillText(line, colX[c] + pad, ty, w - pad);
          ty += size * LINE_HEIGHT;
        }
      }
    }
  }
  ctx.restore();
}

function drawImageElement(ctx, e, images) {
  const src = images && images.get(e.fileName);
  const b = Rect.parse(e.bounds);
  if (e.rotation) {
    ctx.save();
    ctx.translate(b.cx, b.cy);
    ctx.rotate(e.rotation);
    const x = -b.w / 2, y = -b.h / 2;
    if (src) ctx.drawImage(src, x, y, b.w, b.h);
    else placeholder(ctx, x, y, b.w, b.h);
    ctx.restore();
    return;
  }
  if (src) ctx.drawImage(src, b.x, b.y, b.w, b.h);
  else placeholder(ctx, b.x, b.y, b.w, b.h);
}

function placeholder(ctx, x, y, w, h) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.05)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * Element dispatch
 * ------------------------------------------------------------------ */
export function drawElement(ctx, e, env) {
  if (e.hidden) return;
  ctx.save();
  if (e.opacity != null && e.opacity !== 1) ctx.globalAlpha = e.opacity;
  switch (e.type) {
    case T.INK: {
      const pts = elementPoints(e);
      const paint = e.inkGradient ? makeInkGradient(ctx, pts, e.inkGradient) : argbToRgba(e.stroke);
      strokeInk(ctx, pts, e.width || 1.6, paint, env, e);
      if (e.arrow && pts.length > 1) {
        drawInkArrow(ctx, pts, e, e.inkGradient ? '#D09734' : argbToRgba(e.stroke));
      }
      break;
    }
    case T.HIGHLIGHTER: {
      const pts = elementPoints(e);
      strokeHighlighter(ctx, pts, e.width || 24, argbToRgba(e.stroke), e, env);
      break;
    }
    case T.IMAGE: drawImageElement(ctx, e, env.images); break;
    case T.TEXT: drawTextObject(ctx, e, env); break;
    case T.REACTION: {
      const b = Rect.parse(e.bounds);
      ctx.font = `${b.h}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'center';
      ctx.fillText(e.emoji || '⭐', b.cx, b.y);
      break;
    }
    case T.STICKY:
      if (e.rotation) {
        const b = Rect.parse(e.bounds);
        ctx.translate(b.cx, b.cy); ctx.rotate(e.rotation); ctx.translate(-b.cx, -b.cy);
      }
      drawSticky(ctx, e, env);
      break;
    case T.TABLE:
      if (e.rotation) {
        const b = Rect.parse(e.bounds);
        ctx.translate(b.cx, b.cy); ctx.rotate(e.rotation); ctx.translate(-b.cx, -b.cy);
      }
      drawTable(ctx, e, env);
      break;
    default:
      drawShape(ctx, e, env);
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * Backgrounds
 * ------------------------------------------------------------------ */
export function drawGridBackground(ctx, rect, bg) {
  if (!bg || !bg.style || bg.style === 'none') return;
  const step = bg.spacing || 25;
  ctx.save();
  ctx.strokeStyle = bg.lineColor || 'rgba(0,0,0,0.10)';
  ctx.fillStyle = bg.lineColor || 'rgba(0,0,0,0.10)';
  ctx.lineWidth = 1 / (bg._zoom || 1);
  const x0 = Math.floor(rect.left / step) * step;
  const y0 = Math.floor(rect.top / step) * step;
  if (bg.style === 'dots') {
    const r = Math.max(1, step * 0.045);
    for (let x = x0; x <= rect.right; x += step) {
      for (let y = y0; y <= rect.bottom; y += step) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (bg.style === 'lines') {
    ctx.beginPath();
    for (let y = y0; y <= rect.bottom; y += step) { ctx.moveTo(rect.left, y); ctx.lineTo(rect.right, y); }
    ctx.stroke();
  } else {
    ctx.beginPath();
    for (let x = x0; x <= rect.right; x += step) { ctx.moveTo(x, rect.top); ctx.lineTo(x, rect.bottom); }
    for (let y = y0; y <= rect.bottom; y += step) { ctx.moveTo(rect.left, y); ctx.lineTo(rect.right, y); }
    ctx.stroke();
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * Scene renderer with a world-space cache
 * ------------------------------------------------------------------ */
export class SceneRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    // The cache holds *elements only*, as a transparent world-space raster.
    // The page colour, background pattern and PDF backdrop are cheap enough to
    // draw every frame, which keeps them out of the expensive rebuild path.
    this.cache = document.createElement('canvas');
    this.cacheCtx = this.cache.getContext('2d');
    this.cacheValid = false;
    this.cacheScale = 0;
    this.cacheScaleUsed = 1;
    this.cacheRect = new Rect();
    this.cacheVersion = -1;
    this.cachePage = null;
    this.needsRebuild = false;
    this.rebuilds = 0;
    this.dpr = 1;
    this.lastStats = { ms: 0, rebuildMs: 0, rebuilt: false };
    /** WeakMap<element, {sig: string, path: Path2D, kind: string}> */
    this.pathCache = new WeakMap();
  }

  /** Hard invalidation: the content changed, rebuild before the next paint. */
  invalidate() { this.cacheValid = false; }

  /**
   * Soft invalidation: something the cache embeds changed (a sharper PDF
   * bitmap arrived) but the cached raster is still usable.  The rebuild is
   * postponed until the user stops interacting.
   */
  markStale() { this.needsRebuild = true; }

  /**
   * @param {object} s  scene state
   *   page        current page object
   *   camera      {x, y, zoom}   x/y = world point at the top-left of the view
   *   view        {w, h}         CSS pixel size of the viewport
   *   images      Map<fileName, drawable>
   *   pdfPages    [{pageNumber, bounds, bitmap}]
   *   background  page background pattern
   *   live        element currently being drawn (drawn on top, not cached)
   *   overlay     callback(ctx, env) executed in world space after the scene
   *   version     bumps whenever page content changes
   *   interacting true while a drag/zoom gesture is in flight
   */
  render(s) {
    const t0 = performance.now();
    const { view, camera } = s;
    const dpr = s.dpr || window.devicePixelRatio || 1;
    const pw = Math.max(1, Math.round(view.w * dpr));
    const ph = Math.max(1, Math.round(view.h * dpr));
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    const ctx = this.ctx;
    const k = camera.zoom * dpr;
    const viewWorld = new Rect(camera.x, camera.y, view.w / camera.zoom, view.h / camera.zoom);

    // 1. everything static goes through the world-space cache: the page colour,
    //    the background pattern, the PDF backdrop and every element.  Compositing
    //    a full-page PDF bitmap costs ~15 ms per frame, so it must not happen on
    //    every frame — only when the cache is rebuilt.
    const rebuilt = this.#ensureCache(s, dpr, viewWorld);
    this.rebuilds += rebuilt ? 1 : 0;
    this.lastStats.rebuilt = rebuilt;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = s.backgroundColor || '#FFFFFF';
    ctx.fillRect(0, 0, pw, ph);
    if (this.cacheValid) {
      // Blit only the visible slice of the cache: the cost then depends on the
      // viewport, not on how much margin the cache carries.
      const cr = this.cacheRect;
      const vx0 = Math.max(viewWorld.left, cr.left);
      const vy0 = Math.max(viewWorld.top, cr.top);
      const vx1 = Math.min(viewWorld.right, cr.right);
      const vy1 = Math.min(viewWorld.bottom, cr.bottom);
      if (vx1 > vx0 && vy1 > vy0) {
        const cs = this.cacheScaleUsed;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'low';
        ctx.drawImage(
          this.cache,
          (vx0 - cr.x) * cs, (vy0 - cr.y) * cs, (vx1 - vx0) * cs, (vy1 - vy0) * cs,
          (vx0 - camera.x) * k, (vy0 - camera.y) * k, (vx1 - vx0) * k, (vy1 - vy0) * k,
        );
      }
    }

    // 2. live layer + overlays in world space
    ctx.setTransform(k, 0, 0, k, -camera.x * k, -camera.y * k);
    const env = { images: s.images, zoom: camera.zoom, dpr, scale: k, editing: s.editing || null };
    if (s.live) drawElement(ctx, s.live, env);
    if (s.overlay) { ctx.save(); s.overlay(ctx, env); ctx.restore(); }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.lastStats.ms = performance.now() - t0;
  }

  /**
   * Cache scale: snapped to a power of two so that a continuous zoom only
   * rebuilds when it crosses an octave, instead of on every wheel tick.
   */
  static snapScale(k) {
    const snapped = Math.pow(2, Math.round(Math.log2(Math.max(k, 1e-4))));
    return clamp(snapped, 0.25, 4);
  }

  #ensureCache(s, dpr, viewWorld) {
    const k = s.camera.zoom * dpr;
    // Margin trades cache memory for how far you can pan before a rebuild.
    const margin = 0.3;
    const want = new Rect(
      viewWorld.x - viewWorld.w * margin,
      viewWorld.y - viewWorld.h * margin,
      viewWorld.w * (1 + margin * 2),
      viewWorld.h * (1 + margin * 2),
    );
    const scale = SceneRenderer.snapScale(k);
    const sameContent = this.cacheValid && this.cachePage === s.page && this.cacheVersion === s.version;
    const covers = this.cacheRect.containsRect(viewWorld);
    const needs =
      !sameContent ||
      !covers ||
      this.needsRebuild ||
      Math.abs(this.cacheScale - scale) > 1e-6;

    if (!needs) return false;

    // While a gesture is running, keep blitting the existing raster (it is
    // merely rescaled) and rebuild once the user stops.
    if (s.interacting && sameContent && covers && this.cacheValid) {
      this.needsRebuild = true;
      return false;
    }

    // Keep the raster inside a sane memory budget.  16 MP is enough for a
    // crisp cache on a 2x display while staying well under browser limits.
    const MAX_PIXELS = 16e6;
    let cw = Math.max(1, Math.round(want.w * scale));
    let ch = Math.max(1, Math.round(want.h * scale));
    let usedScale = scale;
    if (cw * ch > MAX_PIXELS) {
      const f = Math.sqrt(MAX_PIXELS / (cw * ch));
      usedScale = Math.max(0.05, scale * f);
      cw = Math.max(1, Math.round(want.w * usedScale));
      ch = Math.max(1, Math.round(want.h * usedScale));
    }
    const t0 = performance.now();
    if (this.cache.width !== cw || this.cache.height !== ch) {
      this.cache.width = cw;
      this.cache.height = ch;
    }
    const c = this.cacheCtx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cw, ch);
    c.setTransform(usedScale, 0, 0, usedScale, -want.x * usedScale, -want.y * usedScale);

    // page colour
    c.fillStyle = s.backgroundColor || '#FFFFFF';
    c.fillRect(want.x, want.y, want.w, want.h);

    // tiled background pattern
    drawGridBackground(c, want, s.background);

    // PDF backdrop
    for (const pp of s.pdfPages || []) {
      const b = Rect.parse(pp.bounds);
      if (pp.bitmap) {
        c.imageSmoothingEnabled = true;
        c.imageSmoothingQuality = 'low';
        c.drawImage(pp.bitmap, b.x, b.y, b.w, b.h);
      } else {
        c.fillStyle = '#FFFFFF';
        c.fillRect(b.x, b.y, b.w, b.h);
        c.strokeStyle = 'rgba(0,0,0,0.12)';
        c.lineWidth = 1 / s.camera.zoom;
        c.strokeRect(b.x, b.y, b.w, b.h);
      }
    }

    // elements
    const env = {
      images: s.images, zoom: s.camera.zoom, dpr, pathCache: this.pathCache,
      // `scale` is world units -> device pixels of this raster, which is what
      // decides how sharply math bitmaps are rasterised; `editing` lets a text
      // box under the inline editor draw its raw source instead of TeX.
      scale: usedScale, editing: s.editing || null,
    };
    for (const e of s.page.elements) drawElement(c, e, env);

    this.cacheValid = true;
    this.cacheScale = scale;
    this.cacheScaleUsed = usedScale;
    this.cacheRect = want;
    this.cacheVersion = s.version;
    this.cachePage = s.page;
    this.needsRebuild = false;
    this.lastStats.rebuildMs = performance.now() - t0;
    return true;
  }
}

/* ------------------------------------------------------------------ *
 * Helpers used by tools / overlays
 * ------------------------------------------------------------------ */
export { isStraightStroke, highlighterIsRounded };

export function applyViewTransform(ctx, camera, dpr = 1) {
  const k = camera.zoom * dpr;
  ctx.setTransform(k, 0, 0, k, -camera.x * k, -camera.y * k);
}

export function screenToWorld(camera, sx, sy) {
  return { x: camera.x + sx / camera.zoom, y: camera.y + sy / camera.zoom };
}
export function worldToScreen(camera, wx, wy) {
  return { x: (wx - camera.x) * camera.zoom, y: (wy - camera.y) * camera.zoom };
}

export { ellipsePointsFromRect, IS_OBJECT, localBounds };
