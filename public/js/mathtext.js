/**
 * LaTeX support for text boxes and sticky notes.
 *
 * MathJax (vendored in `public/vendor/mathjax/`, no network access) typesets
 * TeX into an SVG synchronously; we immediately rasterise that SVG and then
 * draw the bitmap like any other image.  Everything therefore flows through
 * the renderer's world-space cache: panning, zooming and page thumbnails never
 * re-typeset anything, and PNG / PDF export picks the math up for free.
 *
 * Supported delimiters (standard TeX inline/display pairs):
 *
 *     $x^2$        \(x^2\)        inline
 *     $$x^2$$      \[x^2\]        display (gets its own line)
 *
 * `\$` is an escaped dollar sign and stays literal text.  A lone `$` that does
 * not hug its content (`$5 and $6`) is also left alone, so ordinary prose is
 * not turned into math by accident.
 */
import { fontString, LINE_HEIGHT } from './elements.js';

const SCRIPT_URL = new URL('../vendor/mathjax/tex-svg.js', import.meta.url).href;

/** Raster heights (device px) we are willing to keep; snapped to a ladder so
 *  a continuous zoom reuses existing bitmaps instead of re-rasterising. */
const RASTER_LADDER = [12, 16, 24, 32, 48, 64, 96, 128, 192, 256];
const MAX_RASTERS = 240;

/* ------------------------------------------------------------------ *
 * MathJax bootstrap
 * ------------------------------------------------------------------ */
let mjPromise = null;

/** Load MathJax on first use — a board without math never pays for it. */
export function ensureMathJax() {
  if (mjPromise) return mjPromise;
  mjPromise = new Promise((resolve, reject) => {
    // MathJax reads this global before it boots.  `fontCache: 'local'` makes
    // every SVG self-contained (its glyph outlines live in its own <defs>),
    // which is what lets us rasterise one expression in isolation.
    window.MathJax = {
      startup: { typeset: false }, // we never typeset the page DOM
      options: { enableMenu: false },
      svg: { fontCache: 'local' },
      ...(window.MathJax || {}),
    };
    const s = document.createElement('script');
    s.src = SCRIPT_URL;
    s.async = true;
    s.onload = () => {
      Promise.resolve(window.MathJax?.startup?.promise)
        .then(() => { notifyRaster(); resolve(window.MathJax); })
        .catch(reject);
    };
    s.onerror = () => { mjPromise = null; reject(new Error('MathJax 载入失败')); };
    document.head.append(s);
  });
  return mjPromise;
}

export function mathReady() { return !!window.MathJax?.tex2svg; }

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */
/** Scan `text` for math, returning a flat list of text / math runs. */
export function parseMathRuns(text) {
  const src = String(text ?? '');
  const runs = [];
  let buf = '';
  let i = 0;
  const flush = () => { if (buf) { runs.push({ type: 'text', text: buf }); buf = ''; } };

  while (i < src.length) {
    const c = src[i];
    // Escaped characters: \$ is a literal dollar sign, \\ a literal backslash.
    if (c === '\\' && (src[i + 1] === '$' || src[i + 1] === '\\')) { buf += src[i + 1]; i += 2; continue; }

    let open = 0;
    let display = false;
    if (c === '$') { display = src[i + 1] === '$'; open = display ? 2 : 1; }
    else if (c === '\\' && src[i + 1] === '(') { open = 2; }
    else if (c === '\\' && src[i + 1] === '[') { open = 2; display = true; }

    if (open) {
      const closer = c === '$' ? (display ? '$$' : '$') : (display ? '\\]' : '\\)');
      const body = i + open;
      // Inline math must hug its content on both ends.
      const hugs = display || (body < src.length && !/\s/.test(src[body]) && src[body] !== '$');
      if (hugs) {
        const end = findCloser(src, body, closer, display);
        if (end > body) {
          flush();
          runs.push({ type: 'math', latex: src.slice(body, end), display });
          i = end + closer.length;
          continue;
        }
      }
    }
    buf += c;
    i++;
  }
  flush();
  return runs;
}

function findCloser(src, from, closer, display) {
  for (let j = from; j < src.length; j++) {
    const c = src[j];
    if (c === '\\' && src[j + 1] === '$') { j++; continue; } // \$ inside math
    if (!display && c === '\n') return -1;                   // inline math stays on one line
    if (src.startsWith(closer, j)) {
      if (display) return j;
      if (j > from && !/\s/.test(src[j - 1])) return j;      // "$x $" is not math
      return -1;
    }
  }
  return -1;
}

/** Cheap pre-check so plain text never pays for the scanner. */
export function hasMathSyntax(text) {
  const s = String(text ?? '');
  return s.includes('$') || s.includes('\\(') || s.includes('\\[');
}

/* ------------------------------------------------------------------ *
 * TeX -> SVG -> bitmap
 * ------------------------------------------------------------------ */
/** @type {Map<string, object>} expression key -> metrics + serialised SVG */
const expressions = new Map();
/** @type {Map<string, object>} `${key}@${px}` -> {img} */
const rasters = new Map();
const rasterizing = new Set();
let onRaster = null;

/** Called (once per arrival) when a bitmap becomes drawable. */
export function setRasterHandler(fn) { onRaster = fn; }
function notifyRaster() { if (onRaster) onRaster(); }

const exprKey = (latex, display) => (display ? 'D|' : 'I|') + latex;

function typeset(latex, display) {
  const key = exprKey(latex, display);
  const hit = expressions.get(key);
  if (hit) return hit;
  const MJ = window.MathJax;
  if (!MJ?.tex2svg) { ensureMathJax().catch(() => {}); return null; }
  let rec;
  try {
    const node = MJ.tex2svg(latex, { display });
    const svg = node.tagName?.toLowerCase() === 'svg' ? node : node.querySelector('svg');
    if (!svg) throw new Error('MathJax returned no <svg>');
    const wEx = parseFloat(svg.getAttribute('width')) || 0;
    const hEx = parseFloat(svg.getAttribute('height')) || 0;
    if (!wEx || !hEx) throw new Error('MathJax returned an empty box');
    const va = /vertical-align:\s*(-?[\d.]+)ex/.exec(svg.getAttribute('style') || '');
    rec = {
      wEx, hEx,
      dEx: va ? Math.abs(parseFloat(va[1])) : 0,
      viewBox: svg.getAttribute('viewBox') || `0 0 ${wEx} ${hEx}`,
      inner: svg.innerHTML,
      error: false,
    };
  } catch (err) {
    // Broken TeX never breaks the board: fall back to showing the source.
    rec = { error: true, message: String(err?.message || err) };
  }
  expressions.set(key, rec);
  return rec;
}

function svgUrl(rec, pxH) {
  const wPx = Math.max(1, Math.round((rec.wEx / rec.hEx) * pxH));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"`
    + ` width="${wPx}" height="${pxH}" viewBox="${rec.viewBox}">${rec.inner}</svg>`;
  return { url: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), wPx };
}

function bucketFor(pxH) {
  for (const b of RASTER_LADDER) if (b >= pxH) return b;
  return RASTER_LADDER[RASTER_LADDER.length - 1];
}

/** Bitmap for one expression at (at least) `pxH` device pixels tall. */
function raster(key, rec, pxH) {
  const bucket = bucketFor(pxH);
  const rk = key + '@' + bucket;
  const hit = rasters.get(rk);
  if (hit) return hit.img; // still null while decoding
  if (rasterizing.has(rk)) return null;
  rasterizing.add(rk);
  const { url } = svgUrl(rec, bucket);
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    rasterizing.delete(rk);
    rasters.set(rk, { img });
    evictRasters();
    notifyRaster();
  };
  img.onerror = () => { rasterizing.delete(rk); rasters.set(rk, { img: null }); };
  img.src = url;
  return null;
}

function evictRasters() {
  while (rasters.size > MAX_RASTERS) {
    const oldest = rasters.keys().next().value;
    rasters.delete(oldest);
  }
}

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */
const exCache = new Map();

/** x-height (and the font's ascent) of the canvas font at `size`. */
function fontMetrics(ctx, size, opts) {
  const key = fontString(size, opts);
  let m = exCache.get(key);
  if (!m) {
    ctx.font = key;
    const x = ctx.measureText('x');
    const h = ctx.measureText('H');
    m = {
      ex: x.actualBoundingBoxAscent || size * 0.5,
      ascent: h.fontBoundingBoxAscent || size * 0.88,
    };
    if (exCache.size > 64) exCache.clear();
    exCache.set(key, m);
  }
  return m;
}

/**
 * One math atom, sized in world units for the element's font.
 * @returns {{error:boolean, pending:boolean, w:number, h:number, depth:number, img:Image|null}}
 */
export function mathAtom(latex, display, ctx, size, opts = {}, pxScale = 1) {
  const rec = typeset(latex, display);
  if (!rec || rec.error) {
    ctx.font = fontString(size, opts);
    return { error: true, pending: !rec, latex, display, w: ctx.measureText(latex).width + size * 0.2, h: size, depth: size * 0.2, img: null };
  }
  const fm = fontMetrics(ctx, size, opts);
  const w = rec.wEx * fm.ex;
  const h = rec.hEx * fm.ex;
  const depth = rec.dEx * fm.ex;
  const img = raster(exprKey(latex, display), rec, h * pxScale);
  return { error: false, pending: false, latex, display, w, h, depth, ascent: fm.ascent, img };
}

/* ------------------------------------------------------------------ *
 * Rich-text layout
 * ------------------------------------------------------------------ */
/**
 * Lay `text` out into lines of text / math items.
 *
 * Wrapping mirrors the plain-text wrapper in elements.js (character based, so
 * CJK breaks anywhere), except that a math atom is indivisible and display
 * math always starts a new line.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} size   font size in world units
 * @param {number} maxWidth
 * @param {object} opts   font options (bold / italic)
 * @param {number} pxScale world units -> device pixels, for raster sharpness
 * @returns {Array<{items:Array<object>, w:number}>}
 */
export function layoutRichText(ctx, text, size, maxWidth, opts = {}, pxScale = 1) {
  ctx.font = fontString(size, opts);
  const rich = hasMathSyntax(text);
  const lines = [];
  let items = [];
  let lineW = 0;
  // Display math closes its own line, which must not also leave an empty
  // trailing line behind (a plain '\n' still does, like the text wrapper).
  let autoBroken = false;
  const pushLine = () => { lines.push({ items, w: lineW }); items = []; lineW = 0; autoBroken = false; };

  const runs = rich ? parseMathRuns(text) : [{ type: 'text', text: String(text ?? '') }];
  for (const run of runs) {
    if (run.type === 'math') {
      const atom = mathAtom(run.latex, run.display, ctx, size, opts, pxScale);
      if (atom.display && lineW > 0) pushLine();
      if (lineW + atom.w > maxWidth && lineW > 0) pushLine();
      items.push({ kind: 'math', atom, w: atom.w });
      lineW += atom.w;
      if (atom.display) { pushLine(); autoBroken = true; }
      continue;
    }
    for (const ch of run.text) {
      if (ch === '\n') { pushLine(); continue; }
      const w = ctx.measureText(ch).width;
      if (lineW + w > maxWidth && lineW > 0) pushLine();
      const last = items[items.length - 1];
      if (last && last.kind === 'text') { last.text += ch; last.w += w; }
      else items.push({ kind: 'text', text: ch, w });
      lineW += w;
    }
  }
  if (items.length || !autoBroken) pushLine();
  return lines;
}

/**
 * Draw one laid-out line.  `y` is the top of the line box and `x` the left
 * edge, matching the plain renderer (which draws with textBaseline = 'top').
 */
export function drawRichLine(ctx, line, x, y, size, opts = {}) {
  ctx.font = fontString(size, opts);
  const baseline = y + fontMetrics(ctx, size, opts).ascent;
  let cx = x;
  for (const it of line.items) {
    if (it.kind === 'text') {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(it.text, cx, y);
      cx += it.w;
      continue;
    }
    const a = it.atom;
    if (a.img) {
      // Top of the box sits (height - depth) above the baseline.
      ctx.drawImage(a.img, cx, baseline - (a.h - a.depth), a.w, a.h);
    } else {
      // Placeholder until the bitmap decodes (or when the TeX is broken):
      // show the source, clipped to the atom's box.
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx, y, Math.max(a.w, 1), size * LINE_HEIGHT);
      ctx.clip();
      ctx.globalAlpha *= 0.55;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('$' + a.latex + '$', cx, y);
      ctx.restore();
    }
    cx += a.w;
  }
  return cx - x;
}

/** Width of a laid-out line (used for centre / right alignment). */
export function lineWidth(line) { return line.w; }

/** Debug / test hook: what has been typeset and rasterised so far. */
export function mathStats() {
  return {
    loaded: mathReady(),
    version: window.MathJax?.version || null,
    expressions: expressions.size,
    rasters: rasters.size,
    pending: rasterizing.size,
  };
}
