/**
 * Element model.
 *
 * The numeric type codes and the on-disk shape of every element mirror the
 * Microsoft Whiteboard local `.note` format exactly, so files written by this
 * application can be read back by Whiteboard (and vice-versa) for all the
 * standard element kinds.  Codes in the 4xxxxx range are clone extensions; they
 * are still stored as plain JSON in the same page files.
 */
import { Rect, rectFromPoints, distToPolyline, distToSegment, pointInPolygon, boundsOfRotatedRect, rotatePoint, polylineIntersectsRect } from './geometry.js';

export const T = {
  /* --- types observed in real .note archives ------------------------- */
  INK: 100001,          // freehand pen: { inks:[{x,y,pr}] }
  HIGHLIGHTER: 100005,  // translucent freehand: { points:[{point:"x,y"}] }
  LINE: 200002,
  RECT: 200003,
  ELLIPSE: 200004,
  ARROW: 200015,
  POLYLINE: 200017,
  IMAGE: 300001,        // { bounds, rotation, fileName }
  TEXT: 300002,         // { bounds, fontSize, text, textColor }

  /* --- clone extensions --------------------------------------------- */
  TRIANGLE: 200005,
  DIAMOND: 200006,
  PENTAGON: 200007,
  HEXAGON: 200008,
  STAR: 200009,
  PARALLELOGRAM: 200010,
  BLOCK_ARROW: 200011,
  DOUBLE_ARROW: 200016,
  STICKY: 400001,       // { bounds, color, text, textColor, fontSize }
  TABLE: 400002,        // { bounds, rows, cols, cells, ... }
  REACTION: 400003,     // { bounds, emoji }
};

export const POLYGON_SHAPES = new Set([
  T.TRIANGLE, T.DIAMOND, T.PENTAGON, T.HEXAGON, T.STAR, T.PARALLELOGRAM, T.BLOCK_ARROW,
]);

export const IS_SHAPE = new Set([
  T.LINE, T.RECT, T.ELLIPSE, T.ARROW, T.DOUBLE_ARROW, T.POLYLINE, T.HIGHLIGHTER,
  T.TRIANGLE, T.DIAMOND, T.PENTAGON, T.HEXAGON, T.STAR, T.PARALLELOGRAM, T.BLOCK_ARROW,
]);

export const IS_INK = new Set([T.INK]);
export const IS_OBJECT = new Set([T.IMAGE, T.TEXT, T.STICKY, T.TABLE, T.REACTION]);

/* ------------------------------------------------------------------ *
 * Palettes — sampled from Microsoft Whiteboard's own colour pickers.
 * ------------------------------------------------------------------ */
const pen = (hex, name) => ({ name, argb: '#FF' + hex });
const hl = (hex, name) => ({ name, argb: '#5A' + hex });
const solid = (hex, name) => ({ name, argb: '#FF' + hex });

export const PALETTE = {
  /* 15 ink colours + the two gradient pens Whiteboard ships */
  pen: [
    pen('1F1F1F', '黑'), pen('FED42F', '黄'), pen('FBAE16', '金'), pen('F36323', '橙'),
    pen('E71125', '红'), pen('C10051', '绛红'), pen('CF1178', '洋红'), pen('5B318D', '靛紫'),
    pen('914BB8', '紫'), pen('3ECCFD', '天蓝'), pen('0169BF', '蓝'), pen('7EC401', '黄绿'),
    pen('00A656', '绿'), pen('EBEBEB', '浅灰'), pen('FFFFFF', '白'),
  ],
  /* 15 highlighter colours, pre-multiplied with the 35 % highlighter alpha */
  highlighter: [
    hl('FED42F', '黄'), hl('FBAE16', '金'), hl('F36323', '橙'), hl('E71125', '红'),
    hl('C10051', '绛红'), hl('CF1178', '洋红'), hl('5B318D', '靛紫'), hl('914BB8', '紫'),
    hl('3ECCFD', '天蓝'), hl('0169BF', '蓝'), hl('7EC401', '黄绿'), hl('00A656', '绿'),
    hl('1F1F1F', '黑'), hl('EBEBEB', '浅灰'), hl('FFFFFF', '白'),
  ],
  /* 12 sticky-note colours */
  note: [
    solid('FFE6A0', '黄'), solid('FDCD7A', '橙'), solid('FBC19E', '杏'), solid('F18992', '红'), solid('ED99C9', '粉'),
    solid('CBE799', '嫩绿'), solid('9BE0BA', '绿'), solid('99D9EF', '天蓝'), solid('9FAFFA', '蓝'), solid('C9A3DD', '紫'),
    solid('EBEBEB', '浅灰'), solid('B6B6B6', '灰'),
  ],
  /* 15 text colours */
  text: [
    solid('E3E3E3', '浅灰'), solid('FFC012', '黄'), solid('FBAE16', '金'), solid('F7620D', '橙'), solid('E71125', '红'),
    solid('B7B7B7', '灰'), solid('5B2D90', '靛紫'), solid('914BB8', '紫'), solid('D10078', '洋红'), solid('C10051', '绛红'),
    solid('000000', '黑'), solid('0169BF', '蓝'), solid('31CCFF', '天蓝'), solid('7EC401', '黄绿'), solid('00A656', '绿'),
  ],
};

/** Two-stop-plus gradients used by Whiteboard's Rainbow and Aurora pens. */
export const GRADIENT_PENS = [
  {
    name: '彩虹', stops: ['#D09734', '#EFB73B', '#E6C245', '#82AE3E', '#3EA03D', '#23A46A', '#2F9794', '#40A3AD'],
  },
  {
    name: '极光', stops: ['#583D71', '#546C9D', '#739CBD', '#7BBAC7', '#97CDCF', '#8CD1B5'],
  },
];

/** The eight reactions Whiteboard offers. */
export const REACTIONS = ['⭐', '❤️', '✅', '❌', '👍', '❓', '🙂', '👏'];

/* ------------------------------------------------------------------ *
 * Construction helpers
 * ------------------------------------------------------------------ */
export function makeInk({ stroke, width, points, closed = false }) {
  return {
    type: T.INK,
    stroke,
    width,
    inks: points.map((p) => ({ x: r4(p.x), y: r4(p.y), pr: r4(p.pr ?? 0, 4) })),
  };
}

export function makePointsElement(type, { stroke, width, points, closed = false, dash = false }) {
  const e = {
    type,
    stroke,
    width: r4(width),
    closed: !!closed,
    points: points.map((p) => ({ point: `${r4(p.x)},${r4(p.y)}` })),
  };
  if (dash) e.dash = true;
  return e;
}

export function makeImage({ bounds, fileName, rotation = 0 }) {
  return { type: T.IMAGE, bounds: bounds.toString(), rotation, fileName };
}

export function makeText({ bounds, text, fontSize, textColor = '#FF000000', extra = {} }) {
  return { type: T.TEXT, text, textColor, fontSize, bounds: bounds.toString(), ...extra };
}

export function makeSticky({
  bounds, text = '', color = PALETTE.note[0].argb, textColor = '#FF000000',
  fontSize = 18, radius = undefined,
}) {
  const e = { type: T.STICKY, bounds: bounds.toString(), color, text, textColor, fontSize };
  if (radius != null) e.radius = radius;
  return e;
}

/**
 * Corner rounding of a sticky note, in world units.
 *
 * `radius` is stored per element as a ratio of the note's shorter side, so a
 * note keeps its shape when it is resized.  Notes written by Microsoft
 * Whiteboard carry no such field and fall back to `STICKY_RADIUS`; the field
 * itself is a clone extension that Whiteboard simply ignores.
 */
export const STICKY_RADIUS = 0.12;
export const MAX_STICKY_RADIUS = 0.5;

export function stickyCornerRadius(e, w, h) {
  const r = e && e.radius != null ? e.radius : STICKY_RADIUS;
  const ratio = Math.min(Math.max(Number(r) || 0, 0), MAX_STICKY_RADIUS);
  return ratio * Math.min(w, h);
}

export function makeTable({ bounds, rows = 4, cols = 4, cellW = 120, cellH = 44 }) {  return {
    type: T.TABLE,
    bounds: bounds.toString(),
    rows, cols,
    cells: Array.from({ length: rows }, () => Array.from({ length: cols }, () => '')),
    colWidths: Array.from({ length: cols }, () => cellW),
    rowHeights: Array.from({ length: rows }, () => cellH),
    headerRow: false,
    stroke: '#FF808285',
    width: r4(1.6),
    textColor: '#FF000000',
    fontSize: 16,
  };
}

const r4 = (v, n = 4) => Number(Number(v).toFixed(n));

export function makeReaction({ bounds, emoji }) {
  return { type: T.REACTION, bounds: bounds.toString(), emoji, rotation: 0 };
}

/* ------------------------------------------------------------------ *
 * Point accessors — normalise the three storage styles into {x,y,pr}
 * ------------------------------------------------------------------ */
export function elementPoints(e) {
  if (e.type === T.INK) return e.inks.map((p) => ({ x: p.x, y: p.y, pr: p.pr }));
  if (e.points) {
    return e.points.map((p) => {
      if (typeof p === 'string') { const [x, y] = p.split(',').map(Number); return { x, y, pr: 1 }; }
      if (p.point) { const [x, y] = p.point.split(',').map(Number); return { x, y, pr: 1 }; }
      return { x: p.x, y: p.y, pr: p.pr ?? 1 };
    });
  }
  return [];
}

export function setElementPoints(e, pts) {
  if (e.type === T.INK) e.inks = pts.map((p) => ({ x: r4(p.x), y: r4(p.y), pr: r4(p.pr ?? 0, 4) }));
  else e.points = pts.map((p) => ({ point: `${r4(p.x)},${r4(p.y)}` }));
}

/** The un-rotated bounding box of an element, in world units. */
export function localBounds(e) {
  if (e.bounds != null) return Rect.parse(e.bounds);
  const pts = elementPoints(e);
  const r = rectFromPoints(pts);
  // Shapes are stored as their outline; grow by half the stroke width so the
  // visual bounds match the geometry bounds.
  const pad = (e.width || 0) / 2 + (IS_INK.has(e.type) ? (e.width || 0) / 2 : 0);
  return pad ? r.expand(pad) : r;
}

/** Axis-aligned world bounds taking rotation into account. */
export function elementBounds(e) {
  const b = localBounds(e);
  if (e.rotation) return boundsOfRotatedRect(b, e.rotation);
  return b;
}

export function elementCenter(e) {
  const b = localBounds(e);
  return { x: b.cx, y: b.cy };
}

/* ------------------------------------------------------------------ *
 * Hit testing
 * ------------------------------------------------------------------ */
export function hitTest(e, px, py, tol) {
  if (e.hidden) return false;
  if (e.rotation) {
    const b = localBounds(e);
    const p = rotatePoint(px, py, b.cx, b.cy, -e.rotation);
    px = p.x; py = p.y;
  }
  switch (e.type) {
    case T.INK:
    case T.HIGHLIGHTER: {
      const pts = elementPoints(e);
      const w = e.type === T.HIGHLIGHTER ? Math.max(e.width, 6) : Math.max(e.width, tol * 2);
      return distToPolyline(px, py, pts, false) <= w / 2 + tol;
    }
    case T.LINE:
    case T.ARROW:
    case T.POLYLINE: {
      const pts = elementPoints(e);
      const closed = !!e.closed;
      const d = distToPolyline(px, py, pts, closed);
      if (d <= (e.width || 1) / 2 + tol) return true;
      if (closed && pointInPolygon(px, py, pts)) return true;
      return false;
    }
    case T.RECT:
    case T.TRIANGLE: case T.DIAMOND: case T.PENTAGON:
    case T.HEXAGON: case T.STAR: case T.PARALLELOGRAM: {
      const pts = elementPoints(e);
      const d = distToPolyline(px, py, pts, true);
      if (d <= (e.width || 1) / 2 + tol) return true;
      return e.filled && pointInPolygon(px, py, pts);
    }
    case T.ELLIPSE: {
      const b = localBounds(e);
      const rx = b.w / 2 + tol, ry = b.h / 2 + tol;
      const ix = rx > 0 ? (px - b.cx) / rx : 0;
      const iy = ry > 0 ? (py - b.cy) / ry : 0;
      const outer = ix * ix + iy * iy <= 1;
      if (!outer) return false;
      if (e.filled) return true;
      const irx = Math.max(rx - ((e.width || 1) + tol * 2), 0.0001);
      const iry = Math.max(ry - ((e.width || 1) + tol * 2), 0.0001);
      const ox = (px - b.cx) / irx, oy = (py - b.cy) / iry;
      return ox * ox + oy * oy >= 1;
    }
    default:
      return localBounds(e).expand(tol).containsPoint(px, py);
  }
}

/** Marquee (rubber-band) selection test. */
export function intersectsRect(e, rect, tol = 0) {
  if (e.hidden) return false;
  if (IS_INK.has(e.type) || e.points) {
    const pts = elementPoints(e);
    if (e.type === T.ELLIPSE || e.type === T.RECT || POLYGON_SHAPES.has(e.type)) {
      // closed shapes: use their AABB plus outline test
      if (elementBounds(e).intersects(rect)) {
        if (rect.containsRect(elementBounds(e))) return true;
        const corners = [
          { x: rect.left, y: rect.top }, { x: rect.right, y: rect.top },
          { x: rect.right, y: rect.bottom }, { x: rect.left, y: rect.bottom },
        ];
        for (const c of corners) if (hitTest(e, c.x, c.y, tol)) return true;
        return polylineIntersectsRect(elementPoints(e), rect);
      }
      return false;
    }
    return polylineIntersectsRect(pts, rect);
  }
  return elementBounds(e).intersects(rect);
}

/** Lasso test: element is picked when any sample point falls inside the loop. */
export function insideLasso(e, lassoPts) {
  if (e.hidden) return false;
  const b = elementBounds(e);
  const samples = IS_INK.has(e.type) || e.points ? elementPoints(e) : [
    { x: b.left, y: b.top }, { x: b.right, y: b.top },
    { x: b.right, y: b.bottom }, { x: b.left, y: b.bottom }, { x: b.cx, y: b.cy },
  ];
  for (const p of samples) if (pointInPolygon(p.x, p.y, lassoPts)) return true;
  // Also catch big elements that fully enclose the lasso.
  if (samples.length > 2 && pointInPolygon(lassoPts[0].x, lassoPts[0].y, samples)) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * Transforms
 * ------------------------------------------------------------------ */
export function translateElement(e, dx, dy) {
  if (e.bounds != null) {
    const b = Rect.parse(e.bounds);
    e.bounds = new Rect(b.x + dx, b.y + dy, b.w, b.h).toString();
  }
  if (e.type === T.INK) {
    e.inks = e.inks.map((p) => ({ x: r4(p.x + dx), y: r4(p.y + dy), pr: p.pr }));
  } else if (e.points) {
    e.points = e.points.map((p) => {
      const s = typeof p === 'string' ? p : p.point;
      const [x, y] = s.split(',').map(Number);
      return { point: `${r4(x + dx)},${r4(y + dy)}` };
    });
  }
}

/**
 * Scale an element about `origin`.
 * `sx`/`sy` may be negative when a selection is flipped.
 */
export function scaleElement(e, sx, sy, origin, { flipStroke = true } = {}) {
  const f = (x, y) => ({ x: origin.x + (x - origin.x) * sx, y: origin.y + (y - origin.y) * sy });
  if (e.bounds != null) {
    const b = Rect.parse(e.bounds);
    const p1 = f(b.left, b.top), p2 = f(b.right, b.bottom);
    const nr = Rect.fromLTRB(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.max(p1.x, p2.x), Math.max(p1.y, p2.y));
    e.bounds = nr.toString();
  }
  if (e.type === T.INK) {
    e.inks = e.inks.map((p) => { const q = f(p.x, p.y); return { x: r4(q.x), y: r4(q.y), pr: p.pr }; });
  } else if (e.points) {
    e.points = e.points.map((p) => {
      const s = typeof p === 'string' ? p : p.point;
      const [x, y] = s.split(',').map(Number);
      const q = f(x, y);
      return { point: `${r4(q.x)},${r4(q.y)}` };
    });
  }
  if (flipStroke && e.width != null && (e.type === T.INK || e.type === T.HIGHLIGHTER)) {
    const s = Math.sqrt(Math.abs(sx * sy)) || 1;
    if (Math.abs(s - 1) > 0.001) e.width = r4(e.width * s);
  }
}

export function rotateElement(e, rad, pivot) {
  const p = pivot || elementCenter(e);
  const rot = (x, y) => rotatePoint(x, y, p.x, p.y, rad);
  if (e.type === T.INK) {
    e.inks = e.inks.map((q) => { const r = rot(q.x, q.y); return { x: r4(r.x), y: r4(r.y), pr: q.pr }; });
  } else if (e.points) {
    e.points = e.points.map((q) => {
      const s = typeof q === 'string' ? q : q.point;
      const [x, y] = s.split(',').map(Number);
      const r = rot(x, y);
      return { point: `${r4(r.x)},${r4(r.y)}` };
    });
  }
  if (e.bounds != null) {
    if (IS_OBJECT.has(e.type)) {
      e.rotation = (e.rotation || 0) + rad;
    } else {
      const b = Rect.parse(e.bounds);
      const c = rectCornersOf(b).map((q) => rot(q.x, q.y));
      const nr = rectFromPoints(c);
      e.bounds = nr.toString();
      e._rotated = true;
    }
  }
}

function rectCornersOf(b) {
  return [{ x: b.left, y: b.top }, { x: b.right, y: b.top }, { x: b.right, y: b.bottom }, { x: b.left, y: b.bottom }];
}

/** Circle/ellipse from a drag rectangle. */
export function ellipsePointsFromRect(rect, segments = 0) {
  const b = rect.normalized();
  // Microsoft Whiteboard stores ellipses as a 4-point outline.
  const k = 0.5522847498;
  void k; void segments;
  return [
    { x: b.cx, y: b.top },
    { x: b.right, y: b.cy },
    { x: b.cx, y: b.bottom },
    { x: b.left, y: b.cy },
  ];
}

/** Vertices for the extra polygon shapes we support beyond the MSW core set. */
export function polygonPointsFor(type, rect) {
  const b = rect.normalized();
  const cx = b.cx, cy = b.cy, rx = b.w / 2, ry = b.h / 2;
  if (type === T.BLOCK_ARROW) {
    // Right-pointing block arrow, like Whiteboard's shape.
    const headW = Math.min(b.w * 0.38, b.w);
    const shaftH = b.h * 0.46;
    const y0 = cy - shaftH / 2, y1 = cy + shaftH / 2;
    return [
      { x: b.left, y: y0 }, { x: b.right - headW, y: y0 },
      { x: b.right - headW, y: b.top }, { x: b.right, y: cy },
      { x: b.right - headW, y: b.bottom }, { x: b.right - headW, y: y1 },
      { x: b.left, y: y1 },
    ];
  }
  const N = { [T.TRIANGLE]: 3, [T.DIAMOND]: 4, [T.PENTAGON]: 5, [T.HEXAGON]: 6, [T.STAR]: 5 }[type] || 4;
  if (type === T.PARALLELOGRAM) {
    const k = b.w * 0.22;
    return [
      { x: b.left + k, y: b.top }, { x: b.right, y: b.top },
      { x: b.right - k, y: b.bottom }, { x: b.left, y: b.bottom },
    ];
  }
  if (type === T.RECT && rect.rounded) return null;
  const pts = [];
  for (let i = 0; i < N; i++) {
    let ang = -Math.PI / 2 + (i * 2 * Math.PI) / N;
    if (type === T.DIAMOND) ang = -Math.PI / 2 + (i * Math.PI) / 2;
    pts.push({ x: cx + rx * Math.cos(ang), y: cy + ry * Math.sin(ang) });
    if (type === T.STAR) {
      const a2 = ang + Math.PI / N;
      pts.push({ x: cx + rx * 0.42 * Math.cos(a2), y: cy + ry * 0.42 * Math.sin(a2) });
    }
  }
  return pts;
}

export function shapeToRect(e) {
  if (e.bounds != null) return Rect.parse(e.bounds);
  return rectFromPoints(elementPoints(e));
}

/** Text metrics helper shared by the renderer and the caret logic. */
export function fontString(size, { bold, italic } = {}) {
  return `${italic ? 'italic ' : ''}${bold ? '700 ' : '400 '}${size}px "Segoe UI","Microsoft YaHei","PingFang SC","Hiragino Sans GB","Source Han Sans SC",system-ui,sans-serif`;
}

export function measureText(text, size, opts = {}) {
  const c = measureText._c || (measureText._c = document.createElement('canvas').getContext('2d'));
  c.font = fontString(size, opts);
  return c.measureText(text).width;
}

export const LINE_HEIGHT = 1.35;

/** Word-wrap `text` to `maxWidth`; returns an array of lines. */
export function wrapText(text, size, maxWidth, opts = {}) {
  const c = measureText._c || (measureText._c = document.createElement('canvas').getContext('2d'));
  c.font = fontString(size, opts);
  const out = [];
  for (const para of String(text).split('\n')) {
    if (para === '') { out.push(''); continue; }
    let line = '';
    for (const ch of para) {
      const test = line + ch;
      if (c.measureText(test).width > maxWidth && line !== '') { out.push(line); line = ch; }
      else line = test;
    }
    out.push(line);
  }
  return out;
}

export { distToSegment, distToPolyline };
