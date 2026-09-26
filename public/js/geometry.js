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

/* ------------------------------------------------------------------ *
 * Curve fitting
 * ------------------------------------------------------------------ */
/**
 * Least-squares polynomial fit of `ys` against `xs`, highest degree last.
 *
 * Solved through the normal equations with Gaussian elimination and partial
 * pivoting.  Both axes are expected to be normalised by the caller (see
 * `fitParametricCurve`), which is what keeps a degree-9 system well behaved.
 *
 * @returns {number[]|null} coefficients `[a0, a1, … ad]`, or null when the
 *   system is singular (too few points, or a degenerate stroke)
 */
export function fitPolynomial(xs, ys, degree) {
  const n = degree + 1;
  const A = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  for (let i = 0; i < xs.length; i++) {
    const powers = new Array(2 * n).fill(1);
    for (let k = 1; k < 2 * n; k++) powers[k] = powers[k - 1] * xs[i];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) A[r][c] += powers[r + c];
      A[r][n] += powers[r] * ys[i];
    }
  }
  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    if (Math.abs(A[pivot][col]) < 1e-12) return null;
    if (pivot !== col) { const t = A[pivot]; A[pivot] = A[col]; A[col] = t; }
    const d = A[col][col];
    for (let c = col; c <= n; c++) A[col][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (!f) continue;
      for (let c = col; c <= n; c++) A[r][c] -= f * A[col][c];
    }
  }
  return A.map((row) => row[n]);
}

/** Evaluate `[a0, a1, … ]` at `x` (Horner). */
function evalPolynomial(coeffs, x) {
  let out = 0;
  for (let i = coeffs.length - 1; i >= 0; i--) out = out * x + coeffs[i];
  return out;
}

/**
 * Fit a smooth high-degree curve through a freehand stroke.
 *
 * The stroke is fitted **parametrically** — x(t) and y(t) against the arc
 * length — so an arbitrary drawing (vertical parts, loops, a signature) comes
 * out as one smooth curve, which a plain y(x) fit could never do.  Points are
 * normalised before fitting and the result is sampled uniformly in t, so the
 * caller gets a tidy polyline it can hand to the renderer.
 *
 * @param {{x: number, y: number}[]} points raw stroke
 * @param {{degree?: number, samples?: number}} opts
 * @returns {{x: number, y: number}[]} fitted samples (empty when unfittable)
 */
export function fitParametricCurve(points, { degree = 0, samples = 96 } = {}) {
  const pts = (points || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 3) return [];
  // Arc length gives a parameter that follows the stroke instead of the x axis.
  const t = [0];
  for (let i = 1; i < pts.length; i++) {
    t.push(t[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const total = t[t.length - 1];
  if (!(total > 0)) return [];
  const xs = t.map((v) => v / total);
  // Normalise y as well: absolute world coordinates are large, and a raw fit of
  // e.g. x ≈ 3000 would lose all its precision in a degree-9 system.
  const minX = Math.min(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const spanX = Math.max(1e-6, Math.max(...pts.map((p) => p.x)) - minX);
  const spanY = Math.max(1e-6, Math.max(...pts.map((p) => p.y)) - minY);
  const nx = pts.map((p) => (p.x - minX) / spanX);
  const ny = pts.map((p) => (p.y - minY) / spanY);
  // Enough freedom to follow a real drawing, few enough terms to stay stable.
  const want = degree > 0 ? degree : Math.max(2, Math.min(9, Math.floor(pts.length / 6)));
  const deg = Math.max(1, Math.min(want, pts.length - 1));
  const cx = fitPolynomial(xs, nx, deg) || fitPolynomial(xs, nx, Math.min(2, pts.length - 1));
  const cy = fitPolynomial(xs, ny, deg) || fitPolynomial(xs, ny, Math.min(2, pts.length - 1));
  if (!cx || !cy) return [];
  const out = [];
  for (let i = 0; i < samples; i++) {
    const u = i / (samples - 1);
    out.push({
      x: minX + evalPolynomial(cx, u) * spanX,
      y: minY + evalPolynomial(cy, u) * spanY,
    });
  }
  return out;
}

/** Longest distance between a stroke and the curve fitted through it. */
export function curveFitError(points, fitted) {
  if (!points?.length || !fitted?.length) return Infinity;
  let worst = 0;
  for (const p of points) {
    let best = Infinity;
    for (const q of fitted) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
    worst = Math.max(worst, best);
  }
  return worst;
}
