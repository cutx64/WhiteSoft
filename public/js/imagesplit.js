/**
 * Cutting one image element into two.
 *
 * A `.note` image element is just `{ bounds, rotation, fileName }`, so a split
 * is a real crop: the source bitmap is divided in two and each half is written
 * back as a new resource.  That keeps the two pieces pixel-identical to what the
 * original looked like — same scale, same quality, no stretching — and it is
 * what makes the pair line up seamlessly afterwards.
 *
 * The original element is replaced *in place* by the two halves, so the pair
 * inherits its z-order exactly.
 *
 * Everything works in the element's own local space, which is what makes a
 * rotated picture split along its own axes rather than along the screen's: the
 * half whose local box is the left half is centred half a width to the left of
 * the original centre, and rotating that centre by the element's rotation puts
 * it in the right world position.
 */
import { Rect, rotatePoint } from './geometry.js';
import { T, localBounds } from './elements.js';

/** Largest bitmap stored for one half, per side. */
const MAX_HALF_PX = 4096;

/** How close to an edge a cut is allowed to land (fractions of the element). */
export const MIN_SPLIT_FRACTION = 0.02;

/** Clamp a cut position so neither piece can end up empty. */
export function clampSplitFraction(f) {
  const n = Number(f);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1 - MIN_SPLIT_FRACTION, Math.max(MIN_SPLIT_FRACTION, n));
}

/**
 * The split position expressed as a fraction of the element's own box, for a
 * world point.  Values outside the picture are clamped, so a click that misses
 * the picture still cuts at its nearest edge instead of failing.
 */
export function splitFractionAt(img, world, axis) {
  const b = localBounds(img);
  const rot = img.rotation || 0;
  const p = rot ? rotatePoint(world.x, world.y, b.cx, b.cy, -rot) : world;
  return clampSplitFraction(axis === 'horizontal' ? (p.y - b.y) / b.h : (p.x - b.x) / b.w);
}

/**
 * Where each piece sits inside the original, as fractions of its width/height.
 *
 * `vertical` cuts along a vertical line → left / right halves;
 * `horizontal` cuts along a horizontal line → top / bottom halves.
 *
 * `at` is how far along the cut axis the line sits: 0.5 is the middle, 0 and 1
 * are the two edges.
 */
function piecesFor(axis, at) {
  const t = clampSplitFraction(at);
  return axis === 'horizontal'
    ? [
      { left: 0, top: 0, right: 1, bottom: t },
      { left: 0, top: t, right: 1, bottom: 1 },
    ]
    : [
      { left: 0, top: 0, right: t, bottom: 1 },
      { left: t, top: 0, right: 1, bottom: 1 },
    ];
}

/**
 * Cut `img` in two and put the halves on the page in its place.
 *
 * @param {object} ed   the editor (page, resources, history, selection)
 * @param {object} img  the image element to cut
 * @param {'vertical'|'horizontal'} axis  which way the cut line runs
 * @param {number} [at] where along that axis to cut, 0..1 (default: the middle)
 * @returns {Promise<{ok: boolean, error?: string, halves?: object[]}>}
 */
export async function splitImage(ed, img, axis, at = 0.5) {
  if (!img || img.type !== T.IMAGE) return { ok: false, error: '只能切割图片。' };
  const pieces = piecesFor(axis, at);
  const index = ed.page.elements.indexOf(img);
  if (index < 0) return { ok: false, error: '这张图片已经不在当前画纸上了。' };

  const src = ed.resources.get(img.fileName) || await ed.resources.load(img.fileName);
  if (!src || !src.naturalWidth || !src.naturalHeight) {
    return { ok: false, error: '图片还没加载好，稍后再试。' };
  }

  const b = localBounds(img);
  const rot = img.rotation || 0;
  if (!(b.w > 0) || !(b.h > 0)) return { ok: false, error: '图片太小，无法切割。' };
  const sw = src.naturalWidth;
  const sh = src.naturalHeight;

  const halves = [];
  for (const piece of pieces) {
    // Where this half sits inside the element, in element units.
    const lw = b.w * (piece.right - piece.left);
    const lh = b.h * (piece.bottom - piece.top);
    if (!(lw > 0) || !(lh > 0)) return { ok: false, error: '图片太小，无法切割。' };

    // The same box in source pixels: the whole bitmap is stretched over the
    // element's box, so the fractions map straight across.
    const sx = Math.round(sw * piece.left);
    const sy = Math.round(sh * piece.top);
    const cw = Math.max(1, Math.round(sw * piece.right) - sx);
    const ch = Math.max(1, Math.round(sh * piece.bottom) - sy);

    // Stored at native resolution, only shrunk when a half is larger than the
    // sanity cap — so nothing is ever upscaled or softened.
    const shrink = Math.min(1, MAX_HALF_PX / Math.max(cw, ch));
    const outW = Math.max(1, Math.round(cw * shrink));
    const outH = Math.max(1, Math.round(ch * shrink));

    let bytes;
    try {
      bytes = await cropToPng(src, sx, sy, cw, ch, outW, outH);
    } catch (err) {
      return { ok: false, error: '切割失败：' + (err?.message || err) };
    }
    const fileName = ed.resources.addBytes(bytes, 'png');
    await ed.resources.load(fileName);

    // Local centre of this half, rotated into world space around the original
    // centre — the element's own rotation is kept, its box is what changes.
    const localCx = b.x + b.w * ((piece.left + piece.right) / 2);
    const localCy = b.y + b.h * ((piece.top + piece.bottom) / 2);
    const c = rotatePoint(localCx, localCy, b.cx, b.cy, rot);

    halves.push({
      type: T.IMAGE,
      bounds: new Rect(c.x - lw / 2, c.y - lh / 2, lw, lh).toString(),
      rotation: rot,
      fileName,
    });
  }

  // Replace in place: same slot, so the pair keeps the picture's z-order.
  ed.page.elements.splice(index, 1, ...halves);
  ed.history.push('切割图片',
    () => {
      for (const h of halves) {
        const i = ed.page.elements.indexOf(h);
        if (i >= 0) ed.page.elements.splice(i, 1);
        ed.selection.delete(h);
      }
      if (!ed.page.elements.includes(img)) {
        ed.page.elements.splice(Math.min(index, ed.page.elements.length), 0, img);
      }
    },
    () => {
      const i = ed.page.elements.indexOf(img);
      if (i >= 0) ed.page.elements.splice(i, 1);
      let at = Math.min(index, ed.page.elements.length);
      for (const h of halves) {
        if (!ed.page.elements.includes(h)) ed.page.elements.splice(Math.min(at++, ed.page.elements.length), 0, h);
      }
    });

  ed.selection.clear();
  for (const h of halves) ed.selection.add(h);
  ed.invalidate();
  ed.onSelectionChange?.();
  ed.onContentChange?.();
  ed.onChange?.();
  return { ok: true, halves };
}

/**
 * Draw the "where should the cut go?" guide for the picture being picked.
 *
 * Called from the editor's overlay hook, so the context is already in world
 * space.  The line is drawn in the element's own frame, which is what makes a
 * rotated picture show a cut along its own axis.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{img: object, axis: string, at: number}} pick
 */
export function drawSplitPreview(ctx, pick) {
  if (!pick || !pick.img) return;
  const b = localBounds(pick.img);
  if (!(b.w > 0) || !(b.h > 0)) return;
  const rot = pick.img.rotation || 0;
  const at = clampSplitFraction(pick.at);

  ctx.save();
  if (rot) {
    ctx.translate(b.cx, b.cy);
    ctx.rotate(rot);
    ctx.translate(-b.cx, -b.cy);
  }
  // A dark wide halo under a bright thin line stays visible over any picture.
  ctx.lineCap = 'butt';
  for (const [width, colour] of [[4, 'rgba(0,0,0,0.55)'], [1.6, '#FFD400']]) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    if (pick.axis === 'horizontal') {
      const y = b.y + b.h * at;
      ctx.moveTo(b.x, y);
      ctx.lineTo(b.right, y);
    } else {
      const x = b.x + b.w * at;
      ctx.moveTo(x, b.y);
      ctx.lineTo(x, b.bottom);
    }
    ctx.stroke();
  }
  // A grab handle at the middle of the line, so the guide reads as "move me".
  const hx = pick.axis === 'horizontal' ? b.cx : b.x + b.w * at;
  const hy = pick.axis === 'horizontal' ? b.y + b.h * at : b.cy;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(hx, hy, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#FFD400';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.stroke();
  ctx.restore();
}

/** Draw one rectangle of `src` into a fresh canvas and return PNG bytes. */
function cropToPng(src, sx, sy, sw, sh, outW, outH) {
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, outW, outH);
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) { reject(new Error('图片编码失败')); return; }
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, 'image/png');
  });
}
