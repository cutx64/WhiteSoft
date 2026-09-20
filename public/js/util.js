/* Small shared helpers. */
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
export const round = (v, n = 4) => Number(v.toFixed(n));

let _uid = 0;
export const uid = (p = 'e') => `${p}${Date.now().toString(36)}${(_uid++).toString(36)}`;

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Deep clone that survives plain JSON data only (our whole model is JSON-safe). */
export const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** requestAnimationFrame-coalesced caller. */
export function rafThrottle(fn) {
  let scheduled = false;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn(...lastArgs);
    });
  };
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** '#AARRGGBB' (Microsoft Whiteboard / .NET ARGB) -> 'rgba(r,g,b,a)' */
export function argbToRgba(argb, alphaOverride) {
  if (!argb || typeof argb !== 'string') return 'rgba(0,0,0,1)';
  let s = argb.trim();
  if (s[0] === '#') s = s.slice(1);
  let a = 255, r = 0, g = 0, b = 0;
  if (s.length === 8) {
    a = parseInt(s.slice(0, 2), 16); r = parseInt(s.slice(2, 4), 16);
    g = parseInt(s.slice(4, 6), 16); b = parseInt(s.slice(6, 8), 16);
  } else if (s.length === 6) {
    r = parseInt(s.slice(0, 2), 16); g = parseInt(s.slice(2, 4), 16); b = parseInt(s.slice(4, 6), 16);
  } else if (s.length === 3) {
    r = parseInt(s[0] + s[0], 16); g = parseInt(s[1] + s[1], 16); b = parseInt(s[2] + s[2], 16);
  }
  const alpha = alphaOverride != null ? alphaOverride : a / 255;
  return `rgba(${r},${g},${b},${Number(alpha.toFixed(4))})`;
}

/** '#AARRGGBB' -> '#RRGGBB' (for <input type=color>) */
export function argbToHex(argb) {
  if (!argb) return '#000000';
  const s = argb.replace('#', '');
  return '#' + (s.length === 8 ? s.slice(2) : s).toUpperCase();
}

/** '#RRGGBB' + alpha -> '#AARRGGBB' */
export function hexToArgb(hex, alpha = 255) {
  const h = hex.replace('#', '').padStart(6, '0');
  return '#' + alpha.toString(16).padStart(2, '0').toUpperCase() + h.toUpperCase();
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/** Download a Blob/ArrayBuffer as a file. */
export function download(data, filename, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function base64FromBytes(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}
