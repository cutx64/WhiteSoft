/**
 * Canvas renderer.
 *
 * Draws one whiteboard "page", a PDF backdrop plus every element, into a
 * 2-D canvas.  A world-space cache keeps panning and live inking smooth even
 * on pages that carry thousands of pen strokes.
 */
import { Rect, rectFromPoints, distToSegment } from './geometry.js';
import { argbToRgba, clamp } from './util.js';
import {
  T, POLYGON_SHAPES, IS_OBJECT, elementPoints, localBounds, gradientById,
  fontString, wrapText, LINE_HEIGHT, ellipsePointsFromRect, stickyCornerRadius,
  elementBounds, textPadding,
} from './elements.js';
import { layoutRichText, drawRichLine } from './mathtext.js';

const HIGHLIGHTER_MIN_WIDTH = 6;

/**
 * How far the cached raster may be blown up before the renderer stops using it.
 *
 * The cache is a bitmap of the page at a fixed resolution, so magnifying it
 * enough turns every edge into a staircase.  Twice its resolution is where that
 * becomes visible; past that the visible elements are drawn as vectors.
 */
const DIRECT_MAGNIFY = 2;

/** How far a stroke may paint outside its own bounds, in world units. */
const MAX_STROKE_REACH = 32;

/**
 * Rendering options that are not part of the file format.
 * `roundStraightHighlights` also rounds the ends of highlights that were
 * drawn as a straight line in an existing .note, that is a two-point or
 * fully collinear highlighter stroke, which is how the sample boards
 * were annotated.
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

/** Should this highlighter be drawn as a stadium, band + two semicircles? */
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
  const stops = gradientById(kind).stops;
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

/**
 * Build, reuse and store the drawable geometry of one element.
 *
 * A pressure stroke draws two paths, the ribbon and the round caps, and both
 * have to survive between frames.  The record carries one slot per kind: with a
 * single slot the second call evicted the first, so every frame rebuilt the
 * whole stroke and the cache never paid for itself.
 */
function cachedPath(e, env, sig, kind, build) {
  const store = env && env.pathCache;
  if (!store) return build();
  let rec = store.get(e);
  if (!rec || rec.sig !== sig) {
    rec = { sig, body: null, dots: null };
    store.set(e, rec);
  }
  const hit = rec[kind];
  if (hit) return hit;
  const path = build();
  rec[kind] = path;
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

/**
 * The same points, joined by curves instead of straight segments.
 *
 * Samples arrive a few units apart, which is invisible at 100% and is a row of
 * corners once the canvas is magnified.  A quadratic through the midpoints
 * passes smoothly through the whole run, and it is what turns a fast drag into
 * a curve instead of a faceted line.
 */
function smoothPath(pts, closed = false) {
  const path = new Path2D();
  const n = pts.length;
  if (!n) return path;
  path.moveTo(pts[0].x, pts[0].y);
  if (n === 2) { path.lineTo(pts[1].x, pts[1].y); return path; }
  for (let i = 1; i < n - 1; i++) {
    path.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
  }
  path.lineTo(pts[n - 1].x, pts[n - 1].y);
  if (closed) path.closePath();
  return path;
}

/** Radii of a pressure stroke, never thinner than a hairline. */
function strokeRadii(pts, width, maxPr) {
  return pts.map((p) => Math.max((width / 2) * pressureScale(p.pr || 0, maxPr), 0.2));
}

/**
 * The ink of a pressure stroke, as one path.
 *
 * The stroke is the union of a quad per segment and a disc per sample.  Every
 * piece is convex and they are all wound the same way, so filling them together
 * cannot punch a hole no matter how the pressure jumps; a joint is round by
 * construction; and the disc at each end is an exact semicircle that meets the
 * last quad along its own diameter, so there is no step where the cap joins the
 * body.  Building an outline instead means finding a perpendicular at each
 * point, and near a sharp turn or a sudden change of width those perpendiculars
 * cross and the fill folds over itself.
 */
function pressureStrokePath(pts, width, maxPr) {
  const n = pts.length;
  const radii = strokeRadii(pts, width, maxPr);
  const p = new Path2D();
  for (let i = 0; i + 1 < n; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const nx = -dy / len;
    const ny = dx / len;
    const ra = radii[i];
    const rb = radii[i + 1];
    // Wound the same way as the discs below: with the opposite winding the
    // overlap would cancel and leave a seam through the middle of the stroke.
    p.moveTo(a.x - nx * ra, a.y - ny * ra);
    p.lineTo(b.x - nx * rb, b.y - ny * rb);
    p.lineTo(b.x + nx * rb, b.y + ny * rb);
    p.lineTo(a.x + nx * ra, a.y + ny * ra);
    p.closePath();
  }
  for (let i = 0; i < n; i++) {
    p.moveTo(pts[i].x + radii[i], pts[i].y);
    p.arc(pts[i].x, pts[i].y, radii[i], 0, Math.PI * 2);
  }
  return p;
}

/**
 * A pen stroke.
 *
 * Mouse and touch report the same pressure for every sample, so the stroke is
 * a band of one width: it is drawn as a stroked curve, which gives an exact
 * semicircle at each end and smooth joins at any magnification.  A pen that
 * reports pressure needs a shape of its own, see `pressureStrokePath`.
 */
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
  let minPr = Infinity;
  for (const p of pts) {
    const pr = p.pr || 0;
    if (pr > maxPr) maxPr = pr;
    if (pr < minPr) minPr = pr;
  }

  // A band is a stroke; a varying stroke is a shape.  The signature says which
  // one built the cached geometry.
  const band = maxPr < 0.05 || maxPr - minPr <= maxPr * 0.02;
  const sig = pathSignature(e, pts) + (band ? '|band' : '|press');

  if (band) {
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke(cachedPath(e, env, sig, 'body', () => smoothPath(pts, false)));
    return;
  }
  ctx.fill(cachedPath(e, env, sig, 'body', () => pressureStrokePath(pts, width, maxPr)));
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
  ctx.stroke(cachedPath(e, env, sig, 'body', () => {
    if (pts.length === 1) return polylinePath([pts[0], { x: pts[0].x + 0.01, y: pts[0].y }], false);
    return smoothPath(pts, false);
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
  return cachedPath(e, env, sig, 'body', build);
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

/**
 * The paper of a note, or of a text box that carries a background.
 *
 * The shadow is painted only in the ring around the card: a shadow cast under
 * the card itself would show through a translucent fill and darken it.
 */
function drawCard(ctx, b, r, fill) {
  const shape = new Path2D();
  roundRectPath(shape, b.x, b.y, b.w, b.h, r);
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
  ctx.fill(shape); // clipped out inside the card; only the blurred spill lands
  ctx.restore();

  ctx.fillStyle = fill;
  ctx.fill(shape);
  return shape;
}

function drawSticky(ctx, e, env) {
  const b = Rect.parse(e.bounds);
  // Rounded corners: the radius is a ratio of the shorter side, so a note
  // keeps its shape when it is resized, see stickyCornerRadius in elements.js.
  const r = stickyCornerRadius(e, b.w, b.h);
  drawCard(ctx, b, r, argbToRgba(e.color || '#FFFFF275'));

  const pad = Math.min(10, b.w * 0.08);
  const size = e.fontSize || 18;
  // The sticky keeps its paper while it is edited, since the textarea is
  // transparent, but its text belongs to the DOM editor then.
  if (env?.editing === e) return;
  ctx.fillStyle = argbToRgba(e.textColor || '#FF000000');
  ctx.font = fontString(size, e);
  const lines = layoutRichText(ctx, e.text || '', size, Math.max(b.w - pad * 2, 4), e, textScale(env));
  const align = e.textAlign || 'left';
  let y = b.y + pad;
  const maxY = b.bottom - pad + size * 0.35;
  for (const line of lines) {
    if (y > maxY) break;
    const ly = y + line.rise;
    const left = alignX(lineAlign(line, align), b.x + pad, b.cx, b.right - pad, line.w);
    drawRichLine(ctx, line, left, ly, size, e);
    y = ly + line.height;
  }
}

function drawTextObject(ctx, e, env) {
  const b = Rect.parse(e.bounds);
  // A text box may carry a background, in which case it looks like a note
  // with the text a fixed distance inside its edge.  The card is drawn even
  // while the box is open in the DOM editor, which paints only the text.
  const pad = textPadding(b);
  let clip = null;
  if (e.fill) {
    const r = stickyCornerRadius(e, b.w, b.h);
    clip = drawCard(ctx, b, r, argbToRgba(e.fill));
  }
  if (env?.editing === e) return;
  const size = e.fontSize || 20;
  ctx.save();
  if (clip) ctx.clip(clip);
  ctx.fillStyle = argbToRgba(e.textColor || '#FF000000');
  ctx.font = fontString(size, e);
  const innerW = Math.max(b.w - pad * 2, 4);
  const lines = layoutRichText(ctx, e.text || '', size, innerW, e, textScale(env));
  const align = e.textAlign || 'left';
  let y = b.y + pad;
  for (const line of lines) {
    const ly = y + line.rise;
    const left = alignX(lineAlign(line, align), b.x + pad, b.cx, b.right - pad, line.w);
    drawRichLine(ctx, line, left, ly, size, e);
    y = ly + line.height;
  }
  ctx.restore();
}

/**
 * Alignment for one line.
 *
 * A display formula, one written `$$…$$`, owns its line, and that line is
 * centred in the box whatever alignment the rest of the text uses: a display
 * formula is a block of its own, and hanging it off the left edge is what the
 * panel's "centre" would otherwise have to be set to by hand.
 */
function lineAlign(line, align) {
  for (const it of line.items) {
    if (it.kind === 'math' && it.atom.display) return 'center';
  }
  return align;
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
        const stops = e.inkGradient ? gradientById(e.inkGradient).stops : null;
        drawInkArrow(ctx, pts, e, stops ? stops[stops.length - 1] : argbToRgba(e.stroke));
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
    this.lastStats = { ms: 0, rebuildMs: 0, rebuilt: false, direct: false };
    /** WeakMap<element, {sig: string, body: Path2D, dots: Path2D}> */
    this.pathCache = new WeakMap();
    /**
     * Parts of the cached raster that changed, in world units.
     *
     * A single committed stroke only touches a small area, so redrawing the
     * whole page for it is wasted work that grows with the number of elements.
     * Those changes are collected here and patched back in place. Anything that
     * cannot be expressed as a box falls back to `invalidate`, which throws
     * this away and rebuilds the raster from scratch.
     */
    this.dirty = [];
  }

  /** Hard invalidation: the content changed, rebuild before the next paint. */
  invalidate() {
    this.cacheValid = false;
    this.dirty.length = 0;
  }

  /**
   * Only this part of the raster changed.
   *
   * Merged with any earlier region and patched into the cached raster on the
   * next paint. Callers that move or reshape elements must pass the union of
   * the old and the new box. Anything global, such as a new page, a new
   * background or a reordered element list, must use `invalidate` instead.
   */
  invalidateRegion(rect) {
    if (!rect || !(rect.w > 0) || !(rect.h > 0)) { this.invalidate(); return; }
    this.dirty.push(rect);
    // A pile of regions costs more to merge and patch than one clean rebuild.
    if (this.dirty.length > 24) this.invalidate();
  }

  /** The merged dirty region, or null when there is nothing to patch. */
  #dirtyRect() {
    if (!this.dirty.length) return null;
    const first = this.dirty[0];
    let r = first.clone ? first.clone() : new Rect(first.x, first.y, first.w, first.h);
    for (const d of this.dirty.slice(1)) {
      const left = Math.min(r.x, d.x);
      const top = Math.min(r.y, d.y);
      const right = Math.max(r.right, d.right);
      const bottom = Math.max(r.bottom, d.bottom);
      r = new Rect(left, top, right - left, bottom - top);
    }
    return r;
  }

  /**
   * Soft invalidation: something the cache embeds changed, such as a sharper
   * PDF bitmap arriving, but the cached raster is still usable. The rebuild is
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
   *   live        element currently being drawn, drawn on top, not cached
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

    // Past a couple of times the cache's own resolution the raster is the wrong
    // tool: every edge would be a staircase of cache pixels, and the more the
    // canvas is magnified the worse it looks.  There the visible elements are
    // drawn again as vectors instead, which is exact at any magnification and
    // cheap because a view that magnified holds almost nothing.
    // A cache that is about to be rebuilt counts with the scale it would be
    // built at, so the first frame at a deep zoom does not pay for a rebuild
    // that is never used.
    const cacheScale = this.cacheValid ? this.cacheScaleUsed : SceneRenderer.snapScale(k);
    const magnify = k / Math.max(cacheScale, 1e-6);
    if (magnify > DIRECT_MAGNIFY) {
      this.#drawDirect(s, dpr, k, viewWorld);
      this.lastStats.rebuilt = false;
      this.lastStats.direct = true;
      this.lastStats.ms = performance.now() - t0;
      return;
    }
    this.lastStats.direct = false;

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
    // The live layer is normally one element, but a shape can be a group of
    // the two branches of a hyperbola, so accept both.
    if (Array.isArray(s.live)) { for (const e of s.live) drawElement(ctx, e, env); }
    else if (s.live) drawElement(ctx, s.live, env);
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

  /**
   * Draw the visible part of the page straight to the canvas.
   *
   * Used instead of the cached raster when that raster would have to be blown
   * up too far to stay sharp.  Everything the cache holds is drawn again in the
   * same order, with the elements culled to the viewport, so the picture is the
   * one the cache would have held at that magnification, minus the pixels.
   */
  #drawDirect(s, dpr, k, viewWorld) {
    const ctx = this.ctx;
    const t0 = performance.now();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = s.backgroundColor || '#FFFFFF';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(k, 0, 0, k, -s.camera.x * k, -s.camera.y * k);

    drawGridBackground(ctx, viewWorld, s.background);

    // The backdrop is a bitmap and stays one; a smoother filter is the most
    // that can be done for it at this magnification.
    ctx.imageSmoothingQuality = 'high';
    for (const pp of s.pdfPages || []) {
      const b = Rect.parse(pp.bounds);
      if (pp.bitmap) {
        ctx.drawImage(pp.bitmap, b.x, b.y, b.w, b.h);
      } else {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.strokeStyle = 'rgba(0,0,0,0.12)';
        ctx.lineWidth = 1 / s.camera.zoom;
        ctx.strokeRect(b.x, b.y, b.w, b.h);
      }
    }
    ctx.imageSmoothingQuality = 'low';

    const env = {
      images: s.images, zoom: s.camera.zoom, dpr, pathCache: this.pathCache,
      scale: k, editing: s.editing || null,
    };
    // A stroke paints half its width outside its bounds, so the culling box is
    // grown before anything is picked.
    const reach = viewWorld.expand(MAX_STROKE_REACH);
    for (const e of s.page.elements) {
      if (e.hidden) continue;
      if (elementBounds(e).intersects(reach)) drawElement(ctx, e, env);
    }

    if (Array.isArray(s.live)) { for (const e of s.live) drawElement(ctx, e, env); }
    else if (s.live) drawElement(ctx, s.live, env);
    if (s.overlay) { ctx.save(); s.overlay(ctx, env); ctx.restore(); }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.lastStats.rebuildMs = performance.now() - t0;
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
    const samePage = this.cacheValid && this.cachePage === s.page;
    const sameContent = samePage && this.cacheVersion === s.version;
    const covers = this.cacheRect.containsRect(viewWorld);
    const needs =
      !sameContent ||
      !covers ||
      this.needsRebuild ||
      Math.abs(this.cacheScale - scale) > 1e-6;

    if (!needs) return false;

    // While a gesture is running the raster is left as it is and rebuilt once
    // the user stops. A pending patch is exempt: it is cheap and it has to land
    // on the frame the change is committed on. A different page is never
    // deferred, because a stale frame of the same board is not the same thing
    // as the previous board's picture.
    const canPatch = samePage && covers && this.dirty.length && this.cacheValid
      && Math.abs(this.cacheScale - scale) <= 1e-6;
    if (s.interacting && samePage && covers && this.cacheValid && !canPatch
      && Math.abs(this.cacheScale - scale) <= 1e-6) {
      this.needsRebuild = true;
      return false;
    }

    // A small change to the same page is patched in place instead of redrawing
    // every element. The dirty box is grown a little so a stroke that merely
    // crosses its boundary is not cut off, then everything that touches the box
    // is drawn again, in page order.
    const patch = canPatch ? this.#dirtyRect() : null;
    // The patch can only store what the raster has room for. A change outside
    // it would be marked as current while missing from the cache, and the
    // element would stay invisible until something else forced a rebuild.
    if (patch && this.cacheRect.containsRect(patch)) {
      // The box that is cleared, clipped and redrawn is one and the same, so
      // every element that reaches into it is drawn completely. Clearing one
      // box and clipping to another leaves an antialiased seam at the edge.
      const pad = 12 / Math.max(0.01, s.camera.zoom) + 24;
      const area = new Rect(patch.x - pad, patch.y - pad, patch.w + pad * 2, patch.h + pad * 2);
      const t0 = performance.now();
      const c = this.cacheCtx;
      const k2 = this.cacheScaleUsed;
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      const cx = (area.x - this.cacheRect.x) * k2;
      const cy = (area.y - this.cacheRect.y) * k2;
      c.clearRect(cx, cy, area.w * k2, area.h * k2);
      c.beginPath();
      c.rect(cx, cy, area.w * k2, area.h * k2);
      c.clip();
      c.setTransform(k2, 0, 0, k2, -this.cacheRect.x * k2, -this.cacheRect.y * k2);
      const env = {
        images: s.images, zoom: s.camera.zoom, dpr, pathCache: this.pathCache,
        scale: this.cacheScaleUsed, editing: s.editing || null,
      };
      // An element is drawn whole once it is picked, and cleared only inside the
      // same box. The pick box is therefore larger than the box that is cleared:
      // a stroke paints up to half its width outside the bounds an element
      // reports, and an element just outside the cleared box would otherwise
      // lose the sliver that reaches into it.
      const reach = area.expand(MAX_STROKE_REACH);
      for (const e of s.page.elements) {
        if (elementBounds(e).intersects(reach)) drawElement(c, e, env);
      }
      c.restore();
      this.dirty.length = 0;
      this.cacheVersion = s.version;
      this.lastStats.rebuildMs = performance.now() - t0;
      this.lastStats.patched = true;
      return true;
    }
    this.dirty.length = 0;
    this.lastStats.patched = false;

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
