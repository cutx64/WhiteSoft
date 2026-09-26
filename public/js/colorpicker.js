/**
 * Full-spectrum colour picker.
 *
 * Every place that asks for a colour (pen, highlighter, shape border/fill,
 * text, sticky notes, canvas background, the selection bar) shows the same
 * control: the context's palette plus a picker that unfolds underneath it —
 * a saturation/value square, a hue strip, an optional alpha strip, a hex field
 * and a live preview.
 *
 * Colours travel through the whole application as `#AARRGGBB` strings, which is
 * what `.note` elements store, so this module is the single place where they are
 * converted to and from HSV.  Callers only ever hand in and receive that one
 * format.
 */
import { el } from './util.js';
import { argbAlpha, argbToHex, hexToArgb } from './util.js';

/** `#AARRGGBB` / `#RRGGBB` → `{r, g, b, a}`, tolerant about what it is given. */
export function parseColor(value) {
  const hex = argbToHex(value || '#FF000000').replace('#', '');
  if (hex.length === 8) {
    return {
      a: parseInt(hex.slice(0, 2), 16),
      r: parseInt(hex.slice(2, 4), 16),
      g: parseInt(hex.slice(4, 6), 16),
      b: parseInt(hex.slice(6, 8), 16),
    };
  }
  return {
    a: 255,
    r: parseInt(hex.slice(0, 2), 16) || 0,
    g: parseInt(hex.slice(2, 4), 16) || 0,
    b: parseInt(hex.slice(4, 6), 16) || 0,
  };
}

/** `{r, g, b, a}` → `#AARRGGBB`. */
export function formatColor({ r, g, b, a = 255 }) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0').toUpperCase();
  return `#${h(a)}${h(r)}${h(g)}${h(b)}`;
}

/** RGB (0-255) → HSV (h 0-360, s/v 0-1). */
export function rgbToHsv(r, g, b) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

/** HSV → RGB (0-255). */
export function hsvToRgb(h, s, v) {
  const H = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((H / 60) % 2) - 1));
  const m = v - c;
  const seg = Math.floor(H / 60) % 6;
  const [r, g, b] = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ][seg];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

/**
 * The picker itself.
 *
 * @param {object} opts
 *   `color`       current `#AARRGGBB`
 *   `allowAlpha`  show the transparency strip (off where a separate opacity
 *                 slider already exists, e.g. the pen and highlighter)
 *   `onInput`     live value while dragging (may be omitted)
 *   `onCommit`    final value — where one undo step should be written
 * @returns {HTMLElement}
 */
export function colorPicker({
  color = '#FF000000', allowAlpha = true, onInput = null, onCommit = null, label = '自定义颜色',
} = {}) {
  let state = parseColor(color);
  let hsv = rgbToHsv(state.r, state.g, state.b);

  const preview = el('span', { class: 'wb-picker-preview' });
  const hexInput = el('input', { class: 'wb-picker-hex', type: 'text', spellcheck: 'false', maxlength: '7' });
  const alphaOut = el('span', { class: 'wb-picker-alpha-value' });

  const area = el('div', { class: 'wb-picker-area', tabindex: '0', title: '拖动选择饱和度与明度（方向键微调）' },
    el('span', { class: 'wb-picker-knob' }));
  const knob = area.firstChild;

  const hue = el('input', {
    class: 'wb-picker-hue', type: 'range', min: '0', max: '359', step: '1', value: String(Math.round(hsv.h)),
    title: '色相',
  });
  const alpha = el('input', {
    class: 'wb-picker-alpha', type: 'range', min: '0', max: '255', step: '1', value: String(state.a),
    title: '不透明度',
  });
  const alphaRow = el('div', { class: 'wb-picker-slider' }, alpha, alphaOut);

  /** Push the current state into the DOM and tell the caller. */
  const render = (commit) => {
    const { r, g, b } = hsvToRgb(hsv.h, hsv.s, hsv.v);
    state = { r, g, b, a: state.a };
    const argb = formatColor(state);
    const hueHex = formatColor({ ...hsvToRgb(hsv.h, 1, 1), a: 255 });
    area.style.setProperty('--wb-hue', `#${hueHex.slice(3)}`);
    knob.style.left = `${hsv.s * 100}%`;
    knob.style.top = `${(1 - hsv.v) * 100}%`;
    knob.style.background = `#${hueHex.slice(3)}`;
    preview.style.background = `#${argb.slice(3)}`;
    preview.style.opacity = String(Math.max(0.08, state.a / 255));
    hue.value = String(Math.round(hsv.h));
    alpha.value = String(state.a);
    alphaOut.textContent = `${Math.round((state.a / 255) * 100)}%`;
    if (document.activeElement !== hexInput) hexInput.value = `#${argb.slice(3)}`;
    (commit ? onCommit : onInput)?.(argb);
    return argb;
  };

  /** Where a pointer is inside the saturation/value square, in 0-1. */
  const fromPointer = (ev) => {
    const r = area.getBoundingClientRect();
    return {
      s: Math.max(0, Math.min(1, (ev.clientX - r.left) / Math.max(1, r.width))),
      v: 1 - Math.max(0, Math.min(1, (ev.clientY - r.top) / Math.max(1, r.height))),
    };
  };
  let dragging = false;
  area.addEventListener('pointerdown', (ev) => {
    dragging = true;
    // Capture keeps the drag alive outside the square, but it throws when there
    // is no live pointer (synthetic events, some input devices) — that must not
    // take the rest of the gesture down with it.
    try { area.setPointerCapture?.(ev.pointerId); } catch { /* no active pointer */ }
    hsv = { ...hsv, ...fromPointer(ev) };
    render(false);
    ev.preventDefault();
  });
  area.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    hsv = { ...hsv, ...fromPointer(ev) };
    render(false);
  });
  const drop = (ev) => {
    if (!dragging) return;
    dragging = false;
    try { area.releasePointerCapture?.(ev.pointerId); } catch { /* not captured */ }
    hsv = { ...hsv, ...fromPointer(ev) };
    render(true);
  };
  area.addEventListener('pointerup', drop);
  area.addEventListener('pointercancel', drop);

  area.addEventListener('keydown', (ev) => {
    const step = ev.shiftKey ? 0.1 : 0.02;
    let moved = true;
    if (ev.key === 'ArrowLeft') hsv.s = Math.max(0, hsv.s - step);
    else if (ev.key === 'ArrowRight') hsv.s = Math.min(1, hsv.s + step);
    else if (ev.key === 'ArrowUp') hsv.v = Math.min(1, hsv.v + step);
    else if (ev.key === 'ArrowDown') hsv.v = Math.max(0, hsv.v - step);
    else moved = false;
    if (!moved) return;
    ev.preventDefault();
    render(true);
  });

  hue.addEventListener('input', () => { hsv.h = Number(hue.value); render(false); });
  hue.addEventListener('change', () => { hsv.h = Number(hue.value); render(true); });
  alpha.addEventListener('input', () => { state.a = Number(alpha.value); render(false); });
  alpha.addEventListener('change', () => { state.a = Number(alpha.value); render(true); });

  const readHex = (commit) => {
    const text = hexInput.value.trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(text)) { render(false); return; }
    const { r, g, b } = parseColor(`#${text}`);
    hsv = rgbToHsv(r, g, b);
    render(commit);
  };
  hexInput.addEventListener('input', () => readHex(false));
  hexInput.addEventListener('change', () => readHex(true));
  hexInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); readHex(true); }
    ev.stopPropagation();                    // never let the canvas see typing
  });

  const node = el('div', { class: 'wb-picker' },
    el('div', { class: 'wb-flyout-label', text: label }),
    area,
    el('div', { class: 'wb-picker-slider' }, hue),
    allowAlpha ? alphaRow : null,
    el('div', { class: 'wb-picker-row' }, preview, hexInput, allowAlpha ? null : alphaOut),
  );
  render(false);
  return node;
}
