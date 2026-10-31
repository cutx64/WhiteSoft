/**
 * LaTeX support for text boxes and sticky notes.
 *
 * MathJax typesets, vendored in `public/vendor/mathjax/` with no network access,
 * TeX into an SVG; we immediately rasterise that SVG and then draw the bitmap
 * like any other image.  Everything therefore flows through the renderer's
 * world-space cache: panning, zooming and page thumbnails never re-typeset
 * anything, and PNG / PDF export picks the math up for free.
 *
 * Supported delimiters, the standard TeX inline and display pairs:
 *
 *     $x^2$        \(x^2\)        inline
 *     $$x^2$$      \[x^2\]        display, gets its own line
 *
 * `\$` is an escaped dollar sign and stays literal text.  A lone `$` that does
 * not hug its content (`$5 and $6`) is also left alone, so ordinary prose is
 * not turned into math by accident.
 *
 * Every typeface MathJax ships is available, eleven of them.  They cannot share
 * one page, so each gets its own hidden frame, created the first time a box
 * asks for that typeface; a board written in one font never loads the others.
 */
import { fontString, LINE_HEIGHT } from './elements.js';
import { argbToRgba } from './util.js';

/** Where the vendored MathJax lives, resolved from this module's own URL. */
const MJ_BASE = new URL('../vendor/mathjax/', import.meta.url).href;
const MJ_ENGINE = MJ_BASE + 'tex-svg-nofont.js';
const MJ_FONTS = MJ_BASE + 'fonts';

/**
 * The typefaces MathJax 4 ships, all vendored.
 *
 * `id` is what an element stores in `mathFont`; `id` also names the font
 * package on disk, `mathjax-<id>-font`.  The first entry is the default for a
 * new text box, New Computer Modern being what MathJax 4 itself starts with.
 */
export const MATH_FONTS = [
  { id: 'newcm', label: 'New Computer Modern（默认）' },
  { id: 'tex', label: 'TeX' },
  { id: 'modern', label: 'Latin Modern' },
  { id: 'stix2', label: 'STIX 2' },
  { id: 'termes', label: 'Termes' },
  { id: 'pagella', label: 'Pagella' },
  { id: 'schola', label: 'Schola' },
  { id: 'bonum', label: 'Bonum' },
  { id: 'asana', label: 'Asana' },
  { id: 'dejavu', label: 'DejaVu' },
  { id: 'fira', label: 'Fira' },
];
export const DEFAULT_MATH_FONT = 'newcm';

/** Whether `id` is a typeface we ship. */
function knownFont(id) {
  return MATH_FONTS.some((f) => f.id === id);
}

/** The label of a font id, for the font panel. */
export function mathFontLabel(id) {
  const f = MATH_FONTS.find((m) => m.id === id);
  return f ? f.label : MATH_FONTS[0].label;
}

/** Raster heights, device px, we are willing to keep; snapped to a ladder so
 *  a continuous zoom reuses existing bitmaps instead of re-rasterising. */
const RASTER_LADDER = [12, 16, 24, 32, 48, 64, 96, 128, 192, 256];
const MAX_RASTERS = 240;

/* ------------------------------------------------------------------ *
 * MathJax bootstrap
 * ------------------------------------------------------------------ */
/** One record per typeface: idle, loading, ready or error. */
const engines = new Map();
let onRaster = null;

function engineRecord(font) {
  const id = knownFont(font) ? font : DEFAULT_MATH_FONT;
  let rec = engines.get(id);
  if (!rec) {
    rec = { id, state: 'idle', frame: null, MathJax: null, promise: null };
    engines.set(id, rec);
  }
  return rec;
}

/** Called, once per arrival, when a bitmap becomes drawable. */
export function setRasterHandler(fn) { onRaster = fn; }
function notifyRaster() { if (onRaster) onRaster(); }

/**
 * The page that lives inside a frame: the configuration, then the engine.
 *
 * The configuration has to be written by the frame's own document.  Assigning
 * `frame.contentWindow.MathJax` from here does not survive: the component
 * reads its configuration from the global it finds when it boots, and a
 * property set from the parent beforehand is not what it sees.
 */
function frameHtml(id) {
  return '<!doctype html><meta charset="utf-8"><script>\n'
    + 'window.MathJax = {\n'
    + '  startup: {\n'
    + '    typeset: false,\n'
    // `fontCache: local` keeps every SVG self-contained, with its glyph
    // outlines in its own <defs>, so one expression can be rasterised alone.
    // The font ranges are loaded up front so that typesetting stays
    // synchronous; a range that fails must not take the whole engine down.
    + '    pageReady() {\n'
    + '      return MathJax.startup.document.outputJax.font.loadDynamicFiles()\n'
    + '        .catch(() => {})\n'
    + '        .then(() => MathJax.startup.defaultPageReady());\n'
    + '    },\n'
    + '  },\n'
    + '  options: { enableMenu: false },\n'
    + '  svg: { fontCache: "local" },\n'
    + `  output: { font: "mathjax-${id}" },\n`
    + `  loader: { paths: { fonts: "${MJ_FONTS}" } },\n`
    + '};\n'
    + `</script><script src="${MJ_ENGINE}"><\/script>`;
}

/** A hidden same-origin frame, one MathJax instance per typeface. */
function createFrame(id) {
  const f = document.createElement('iframe');
  f.setAttribute('aria-hidden', 'true');
  f.tabIndex = -1;
  f.style.cssText = 'position:absolute;left:-10000px;top:0;width:16px;height:16px;border:0;visibility:hidden';
  f.srcdoc = frameHtml(id);
  (document.body || document.documentElement).append(f);
  return f;
}

const ENGINE_TIMEOUT = 30000;

/**
 * Load the engine for `font`, once.
 *
 * A board without math never pays for it, and a board written in one typeface
 * never loads another, which is the whole reason this is lazy.
 */
export function ensureMathJax(font = DEFAULT_MATH_FONT) {
  const rec = engineRecord(font);
  if (rec.state === 'ready') return Promise.resolve(rec.MathJax);
  if (rec.promise) return rec.promise;
  rec.state = 'loading';
  rec.promise = new Promise((resolve, reject) => {
    const fail = (err) => {
      rec.state = 'error';
      rec.promise = null;
      if (rec.frame) rec.frame.remove();
      rec.frame = null;
      reject(err instanceof Error ? err : new Error(String(err || 'MathJax 载入失败')));
    };
    try {
      rec.frame = createFrame(rec.id);
    } catch (err) {
      fail(err);
      return;
    }
    // The frame has no load event we can hook while it is being built from
    // `srcdoc`, so the engine is picked up as soon as it appears.
    const started = Date.now();
    const wait = () => {
      const win = rec.frame?.contentWindow;
      const MJ = win?.MathJax;
      if (!MJ || !MJ.startup || !MJ.startup.promise) {
        if (Date.now() - started > ENGINE_TIMEOUT) { fail(new Error('MathJax 载入超时')); return; }
        setTimeout(wait, 50);
        return;
      }
      Promise.resolve(MJ.startup.promise)
        .then(() => {
          rec.MathJax = MJ;
          rec.state = 'ready';
          notifyRaster();
          resolve(MJ);
        })
        .catch(fail);
    };
    setTimeout(wait, 0);
  });
  return rec.promise;
}

export function mathReady(font = DEFAULT_MATH_FONT) {
  return engineRecord(font).state === 'ready';
}

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
/** @type {Map<string, object>} `font|expression` -> metrics + serialised SVG */
const expressions = new Map();
/** @type {Map<string, object>} `${key}@${px}#${colour}` -> {img} */
const rasters = new Map();
const rasterizing = new Set();
/** How often one expression has asked for a font range that is still loading. */
const retries = new Map();
const MAX_RETRIES = 3;

const exprKey = (latex, display) => (display ? 'D|' : 'I|') + latex;

/**
 * Typeset one expression, or return null when the answer is not ready yet.
 *
 * The result is cached per typeface, so a box set in STIX 2 keeps its SVG even
 * after another box asks for the TeX engine: the cached string does not depend
 * on which engine happens to be loaded.
 */
function typeset(latex, display, font) {
  const rec = engineRecord(font);
  const key = rec.id + '|' + exprKey(latex, display);
  const hit = expressions.get(key);
  if (hit) return hit;
  if (rec.state === 'error') {
    // The engine itself failed to come up; say so once instead of retrying on
    // every frame of every render.
    const out = { error: true, message: '公式引擎没有加载起来' };
    expressions.set(key, out);
    return out;
  }
  if (rec.state !== 'ready') {
    if (rec.state === 'idle') ensureMathJax(rec.id).catch(() => {});
    return null;
  }
  let out;
  try {
    const node = rec.MathJax.tex2svg(latex, { display });
    const svg = node.tagName?.toLowerCase() === 'svg' ? node : node.querySelector('svg');
    if (!svg) throw new Error('MathJax returned no <svg>');
    const wEx = parseFloat(svg.getAttribute('width')) || 0;
    const hEx = parseFloat(svg.getAttribute('height')) || 0;
    if (!wEx || !hEx) throw new Error('MathJax returned an empty box');
    const va = /vertical-align:\s*(-?[\d.]+)ex/.exec(svg.getAttribute('style') || '');
    out = {
      wEx, hEx,
      dEx: va ? Math.abs(parseFloat(va[1])) : 0,
      viewBox: svg.getAttribute('viewBox') || `0 0 ${wEx} ${hEx}`,
      inner: svg.innerHTML,
      error: false,
    };
  } catch (err) {
    // MathJax 4 fetches ranges of a font on demand and signals that with a
    // "retry": it is the engine asking to be called again, not broken TeX.
    // A range that never arrives would otherwise spin forever, so after a few
    // attempts the expression shows its own source instead.
    if (err && err.promise) {
      const tries = (retries.get(key) || 0) + 1;
      retries.set(key, tries);
      if (tries <= MAX_RETRIES) {
        Promise.resolve(err.promise).then(() => notifyRaster()).catch(() => notifyRaster());
        return null;
      }
      out = { error: true, message: '公式字体数据没有加载完整' };
    } else {
      // Broken TeX never breaks the board: fall back to showing the source.
      out = { error: true, message: String(err?.message || err) };
    }
  }
  expressions.set(key, out);
  return out;
}

/** The SVG for one expression, painted in `color`. */
function svgUrl(rec, pxH, color) {
  const wPx = Math.max(1, Math.round((rec.wEx / rec.hEx) * pxH));
  // MathJax leaves the glyph colour to `currentColor`, which an <img> cannot
  // see, so the colour is written into the markup instead.  The raster cache
  // is keyed by it, and one expression in two colours is two entries.
  const tint = color || '#000000';
  const inner = String(rec.inner).replace(/currentColor/g, tint);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"`
    + ` width="${wPx}" height="${pxH}" viewBox="${rec.viewBox}" style="color:${tint}">${inner}</svg>`;
  return { url: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), wPx };
}

function bucketFor(pxH) {
  for (const b of RASTER_LADDER) if (b >= pxH) return b;
  return RASTER_LADDER[RASTER_LADDER.length - 1];
}

/** Bitmap for one expression at, at least, `pxH` device pixels tall. */
function raster(key, rec, pxH, color) {
  const bucket = bucketFor(pxH);
  const rk = key + '@' + bucket + '#' + (color || '#000000');
  const hit = rasters.get(rk);
  if (hit) return hit.img; // still null while decoding
  if (rasterizing.has(rk)) return null;
  rasterizing.add(rk);
  const { url } = svgUrl(rec, bucket, color);
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

/** x-height, and the font's ascent, of the canvas font at `size`. */
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
 *
 * `font` picks the typeface of the formulas, `color` the ink they are painted
 * in, and both are part of what gets cached.
 *
 * @returns {{error:boolean, pending:boolean, w:number, h:number, depth:number, img:Image|null}}
 */
export function mathAtom(latex, display, ctx, size, opts = {}, pxScale = 1, font = DEFAULT_MATH_FONT, color = null) {
  const rec = typeset(latex, display, font);
  if (!rec || rec.error) {
    ctx.font = fontString(size, opts);
    return { error: true, pending: !rec, latex, display, w: ctx.measureText(latex).width + size * 0.2, h: size, depth: size * 0.2, img: null };
  }
  const fm = fontMetrics(ctx, size, opts);
  const w = rec.wEx * fm.ex;
  const h = rec.hEx * fm.ex;
  const depth = rec.dEx * fm.ex;
  const key = engineRecord(font).id + '|' + exprKey(latex, display);
  const img = raster(key, rec, h * pxScale, color);
  return { error: false, pending: false, latex, display, w, h, depth, ascent: fm.ascent, img };
}

/* ------------------------------------------------------------------ *
 * Rich-text layout
 * ------------------------------------------------------------------ */
/**
 * Lay `text` out into lines of text / math items.
 *
 * Wrapping mirrors the plain-text wrapper in elements.js, which is
 * character based so CJK breaks anywhere, except that a math atom is
 * indivisible and display math always starts a new line.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} size   font size in world units
 * @param {number} maxWidth
 * @param {object} opts   font options, bold and italic
 * @param {number} pxScale world units -> device pixels, for raster sharpness
 * @returns {Array<{items:Array<object>, w:number, rise:number, height:number}>}
 */
export function layoutRichText(ctx, text, size, maxWidth, opts = {}, pxScale = 1) {
  ctx.font = fontString(size, opts);
  const rich = hasMathSyntax(text);
  const lines = [];
  let items = [];
  let lineW = 0;
  // A line is normally exactly one line box tall, but a display formula can be
  // taller than that, and it must push the lines around it away instead of
  // growing over them.  `rise` is how much lower the line starts for that, and
  // `height` its full height from there.
  const fm = fontMetrics(ctx, size, opts);
  const textDescent = size * LINE_HEIGHT - fm.ascent;
  // Display math closes its own line, which must not also leave an empty
  // trailing line behind, which a plain '\n' still does, like the text wrapper.
  let autoBroken = false;
  const pushLine = () => {
    let ascent = fm.ascent;
    let descent = textDescent;
    for (const it of items) {
      if (it.kind !== 'math') continue;
      ascent = Math.max(ascent, it.atom.h - it.atom.depth);
      descent = Math.max(descent, it.atom.depth);
    }
    lines.push({ items, w: lineW, rise: ascent - fm.ascent, height: ascent + descent });
    items = [];
    lineW = 0;
    autoBroken = false;
  };
  const mathFont = opts.mathFont || DEFAULT_MATH_FONT;
  const ink = argbToRgba(opts.textColor || '#FF000000');

  const runs = rich ? parseMathRuns(text) : [{ type: 'text', text: String(text ?? '') }];
  for (const run of runs) {
    if (run.type === 'math') {
      const atom = mathAtom(run.latex, run.display, ctx, size, opts, pxScale, mathFont, ink);
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
 * edge.
 *
 * Both halves of a mixed line are positioned from the same baseline: text is
 * drawn with textBaseline "alphabetic" at that baseline, and a formula is
 * placed so its own baseline, which MathJax reports as a depth below the box,
 * lands on the same line.  Drawing the text from the top of its box instead is
 * what used to leave the formulas floating a few pixels higher.
 */
export function drawRichLine(ctx, line, x, y, size, opts = {}) {
  ctx.font = fontString(size, opts);
  const baseline = y + fontMetrics(ctx, size, opts).ascent;
  let cx = x;
  for (const it of line.items) {
    if (it.kind === 'text') {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(it.text, cx, baseline);
      cx += it.w;
      continue;
    }
    const a = it.atom;
    if (a.img) {
      // Top of the box sits, height - depth, above the baseline.
      ctx.drawImage(a.img, cx, baseline - (a.h - a.depth), a.w, a.h);
    } else {
      // Placeholder until the bitmap decodes, or when the TeX is broken:
      // show the source, clipped to the atom's box.
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx, y, Math.max(a.w, 1), size * LINE_HEIGHT);
      ctx.clip();
      ctx.globalAlpha *= 0.55;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('$' + a.latex + '$', cx, baseline);
      ctx.restore();
    }
    cx += a.w;
  }
  return cx - x;
}

/** Width of a laid-out line, used for centre and right alignment. */
export function lineWidth(line) { return line.w; }

/** Debug / test hook: what has been typeset and rasterised so far. */
export function mathStats() {
  const loaded = {};
  const failed = {};
  const version = {};
  for (const f of MATH_FONTS) {
    const rec = engineRecord(f.id);
    loaded[f.id] = rec.state === 'ready';
    failed[f.id] = rec.state === 'error';
    version[f.id] = rec.MathJax?.version || null;
  }
  return {
    loaded,
    failed,
    version,
    expressions: expressions.size,
    rasters: rasters.size,
    pending: rasterizing.size,
  };
}
