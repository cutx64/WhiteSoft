/* Geometry primitives shared by the renderer, the tools and hit-testing. */

export class Rect {
  constructor(x = 0, y = 0, w = 0, h = 0) { this.x = x; this.y = y; this.w = w; this.h = h; }
  static fromLTRB(l, t, r, b) { return new Rect(l, t, r - l, b - t); }
  /** Parse Microsoft Whiteboard's "x,y,w,h" bound strings. */
  static parse(s) {
    if (!s) return new Rect();
    if (typeof s !== 'string') return new Rect(s.x, s.y, s.w, s.h);
    const [x, y, w, h] = s.split(',').map(Number);
    return new Rect(x, y, w, h);
  }
  get left() { return this.x; }
  get top() { return this.y; }
  get right() { return this.x + this.w; }
  get bottom() { return this.y + this.h; }
  get cx() { return this.x + this.w / 2; }
  get cy() { return this.y + this.h / 2; }
  get isEmpty() { return this.w === 0 && this.h === 0; }
  toString() { return `${fmt(this.x)},${fmt(this.y)},${fmt(this.w)},${fmt(this.h)}`; }
  clone() { return new Rect(this.x, this.y, this.w, this.h); }
  union(o) {
    if (!o || o.isEmpty) return this.clone();
    if (this.isEmpty) return o.clone();
    const l = Math.min(this.left, o.left), t = Math.min(this.top, o.top);
    const r = Math.max(this.right, o.right), b = Math.max(this.bottom, o.bottom);
    return Rect.fromLTRB(l, t, r, b);
  }
  expand(m) { return new Rect(this.x - m, this.y - m, this.w + 2 * m, this.h + 2 * m); }
  containsPoint(px, py) {
    return px >= this.left && px <= this.right && py >= this.top && py <= this.bottom;
  }
  containsRect(o) {
    return o.left >= this.left && o.right <= this.right && o.top >= this.top && o.bottom <= this.bottom;
  }
  intersects(o) {
    return !(o.left > this.right || o.right < this.left || o.top > this.bottom || o.bottom < this.top);
  }
  /** Normalise a rect that may have been dragged from any corner. */
  normalized() {
    return new Rect(this.w < 0 ? this.x + this.w : this.x, this.h < 0 ? this.y + this.h : this.y,
      Math.abs(this.w), Math.abs(this.h));
  }
}

const fmt = (v) => Number(Number(v).toFixed(4));

export function rectFromPoints(pts) {
  if (!pts || !pts.length) return new Rect();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return Rect.fromLTRB(minX, minY, maxX, maxY);
}

/** Distance from point p to segment ab. */
export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Shortest distance from a point to a polyline. */
export function distToPolyline(px, py, pts, closed = false) {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    best = Math.min(best, distToSegment(px, py, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y));
  }
  if (closed && pts.length > 2) {
    best = Math.min(best, distToSegment(px, py, pts[pts.length - 1].x, pts[pts.length - 1].y, pts[0].x, pts[0].y));
  }
  return best;
}

export function pointInPolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Does a polyline cross or sit inside the given rect (marquee test)? */
export function polylineIntersectsRect(pts, rect) {
  for (const p of pts) if (rect.containsPoint(p.x, p.y)) return true;
  for (let i = 0; i + 1 < pts.length; i++) {
    if (segmentIntersectsRect(pts[i], pts[i + 1], rect)) return true;
  }
  return false;
}

export function segmentIntersectsRect(a, b, rect) {
  const corners = [
    { x: rect.left, y: rect.top }, { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom }, { x: rect.left, y: rect.bottom },
  ];
  for (let i = 0; i < 4; i++) {
    if (segmentsIntersect(a, b, corners[i], corners[(i + 1) % 4])) return true;
  }
  return rect.containsPoint(a.x, a.y) || rect.containsPoint(b.x, b.y);
}

function ccw(a, b, c) { return (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x); }
export function segmentsIntersect(a, b, c, d) {
  return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
}

/* ------------------------------------------------------------------ *
 * Selection frame helpers (shared by the editor chrome and the tools)
 * ------------------------------------------------------------------ */

/**
 * The eight resize handles of a (possibly rotated) rectangle.
 * `localRect` is the un-rotated rectangle; handles are placed on it and then
 * rotated about its centre.
 */
export function handlePositions(aabb, rotation = 0, localRect = null) {
  const base = localRect || aabb;
  const pts = [
    { id: 'nw', x: base.left, y: base.top }, { id: 'n', x: base.cx, y: base.top }, { id: 'ne', x: base.right, y: base.top },
    { id: 'e', x: base.right, y: base.cy }, { id: 'se', x: base.right, y: base.bottom },
    { id: 's', x: base.cx, y: base.bottom }, { id: 'sw', x: base.left, y: base.bottom }, { id: 'w', x: base.left, y: base.cy },
  ];
  if (!rotation) return pts;
  return pts.map((p) => {
    const r = rotatePoint(p.x, p.y, base.cx, base.cy, rotation);
    return { id: p.id, x: r.x, y: r.y };
  });
}

/** World position of the round rotate grip, `offset` world units above the top edge. */
export function rotateHandlePosition(aabb, rotation = 0, localRect = null, offset = 26) {
  const base = localRect || aabb;
  const p = { x: base.cx, y: base.top - offset };
  if (!rotation) return p;
  return rotatePoint(p.x, p.y, base.cx, base.cy, rotation);
}

/** Which corner/edge is opposite to a handle id. */
export const OPPOSITE_HANDLE = {
  nw: 'se', n: 's', ne: 'sw', e: 'w', se: 'nw', s: 'n', sw: 'ne', w: 'e',
};

/** Anchor point (in the un-rotated frame) for a resize drag. */
export function handleAnchor(rect, id) {
  const map = {
    nw: { x: rect.right, y: rect.bottom }, n: { x: rect.cx, y: rect.bottom }, ne: { x: rect.left, y: rect.bottom },
    e: { x: rect.left, y: rect.cy }, se: { x: rect.left, y: rect.top },
    s: { x: rect.cx, y: rect.top }, sw: { x: rect.right, y: rect.top }, w: { x: rect.right, y: rect.cy },
  };
  return map[id] || { x: rect.cx, y: rect.cy };
}

export const HANDLE_IS_HORIZONTAL = (id) => ['nw', 'w', 'sw', 'ne', 'e', 'se'].includes(id);
export const HANDLE_IS_VERTICAL = (id) => ['nw', 'n', 'ne', 'sw', 's', 'se'].includes(id);

/** Affine matrix helpers, row-major [a,b,c,d,e,f] like CanvasRenderingContext2D. */
export const mat = {
  identity: () => [1, 0, 0, 1, 0, 0],
  mul(m, n) {
    return [
      m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
    ];
  },
  apply(m, x, y) { return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }; },
  invert(m) {
    const det = m[0] * m[3] - m[1] * m[2];
    if (!det) return mat.identity();
    return [
      m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
      (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det,
    ];
  },
  translate: (x, y) => [1, 0, 0, 1, x, y],
  scale: (x, y) => [x, 0, 0, y, 0, 0],
  rotate(rad) { const c = Math.cos(rad), s = Math.sin(rad); return [c, s, -s, c, 0, 0]; },
};

/** Rotate a point around a pivot. */
export function rotatePoint(x, y, cx, cy, rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  const dx = x - cx, dy = y - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

/** The four corners of a (possibly rotated) rect, clockwise from top-left. */
export function rectCorners(rect, rotation = 0) {
  const pts = [
    { x: rect.left, y: rect.top }, { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom }, { x: rect.left, y: rect.bottom },
  ];
  if (!rotation) return pts;
  return pts.map((p) => rotatePoint(p.x, p.y, rect.cx, rect.cy, rotation));
}

export function boundsOfRotatedRect(rect, rotation = 0) {
  if (!rotation) return rect.clone();
  return rectFromPoints(rectCorners(rect, rotation));
}

/**
 * Ramer–Douglas–Peucker simplification, used to keep freehand strokes compact.
 */
export function simplify(points, tolerance = 0.35) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distToSegment(points[i].x, points[i].y, points[s].x, points[s].y, points[e].x, points[e].y);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolerance && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Chaikin corner cutting — one or two passes gives the silky look Microsoft
 * Whiteboard uses for freehand ink without blowing up the point count.
 */
export function smoothPoints(points, passes = 1) {
  let pts = points;
  for (let p = 0; p < passes; p++) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25, pr: (a.pr ?? 1) * 0.75 + (b.pr ?? 1) * 0.25 });
      out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75, pr: (a.pr ?? 1) * 0.25 + (b.pr ?? 1) * 0.75 });
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}
