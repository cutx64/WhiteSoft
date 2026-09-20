/**
 * Document model + `.note` (Microsoft Whiteboard local) input/output.
 *
 * On-disk layout of a .note archive (a plain ZIP):
 *   manifest.json                       document metadata + page order
 *   Pages/page<N>.json                  one file per whiteboard page
 *   Resources/Images/<guid>.<ext>       every pasted / inserted bitmap
 *   Resources/Document/<name>.pdf       the imported PDF, if any
 */
import { uuid } from './util.js';

export const NOTE_VERSION = '1.0.0';
export const DEFAULT_SCREEN_W = 2880;
export const DEFAULT_SCREEN_H = 1920;
export const DEFAULT_SCREEN_SCALE = 2;

/** Canonical logical viewport width Microsoft Whiteboard lays PDF pages out in. */
export const LAYOUT_WIDTH = DEFAULT_SCREEN_W / DEFAULT_SCREEN_SCALE; // 1440

let pageCounter = 0;

export function createPage(overrides = {}) {
  return { elements: [], scale: 1, pdfPages: [], ...overrides };
}

export function createDocument(overrides = {}) {
  return {
    id: uuid(),
    version: NOTE_VERSION,
    screenWidthPixels: DEFAULT_SCREEN_W,
    screenHeightPixels: DEFAULT_SCREEN_H,
    screenScale: DEFAULT_SCREEN_SCALE,
    pages: [createPage()],
    currentPage: 0,
    backgroundColor: '#FFFFFFFF',
    createTime: nowStamp(),
    document: null,
    sourcePath: null,
    path: null,
    name: '未命名白板',
    ...overrides,
  };
}

export function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ------------------------------------------------------------------ *
 * manifest <-> in-memory document
 * ------------------------------------------------------------------ */
export function manifestFromDocument(doc) {
  return {
    id: doc.id,
    version: doc.version || NOTE_VERSION,
    screenWidthPixels: doc.screenWidthPixels,
    screenHeightPixels: doc.screenHeightPixels,
    screenScale: doc.screenScale,
    pages: doc.pages.map((_, i) => ({ fileName: `page${i + 1}.json` })),
    currentPage: doc.currentPage + 1,
    backgroundColor: doc.backgroundColor || '#FFFFFFFF',
    createTime: doc.createTime || nowStamp(),
    ...(doc.document ? { document: { fileName: doc.document.fileName } } : {}),
  };
}

export function documentFromManifest(manifest, pages) {
  return createDocument({
    id: manifest.id || uuid(),
    version: manifest.version || NOTE_VERSION,
    screenWidthPixels: manifest.screenWidthPixels || DEFAULT_SCREEN_W,
    screenHeightPixels: manifest.screenHeightPixels || DEFAULT_SCREEN_H,
    screenScale: manifest.screenScale || DEFAULT_SCREEN_SCALE,
    pages,
    currentPage: Math.max(0, Math.min((manifest.currentPage || 1) - 1, pages.length - 1)),
    backgroundColor: manifest.backgroundColor || '#FFFFFFFF',
    createTime: manifest.createTime || nowStamp(),
    document: manifest.document ? { fileName: manifest.document.fileName } : null,
  });
}

/** Every resource entry name an archive must keep in order to stay intact. */
export function referencedResources(doc) {
  const out = new Set();
  for (const page of doc.pages) {
    for (const e of page.elements) {
      if (e.fileName) out.add('Resources/Images/' + e.fileName);
    }
  }
  if (doc.document?.fileName) out.add('Resources/Document/' + doc.document.fileName);
  return [...out];
}

/* ------------------------------------------------------------------ *
 * Server-backed .note access
 * ------------------------------------------------------------------ */
async function api(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res;
}

export async function listWorkspaceFiles() {
  const res = await api('/api/files');
  return (await res.json()).files;
}

export async function openNote(path, { onProgress } = {}) {
  onProgress?.('读取清单…');
  const meta = await (await api(`/api/note/meta?path=${encodeURIComponent(path)}`)).json();
  onProgress?.('读取页面…');
  const { pages: rawPages } = await (await api(`/api/note/pages?path=${encodeURIComponent(path)}`)).json();

  const order = (meta.manifest?.pages || []).map((p) => p.fileName);
  const names = order.length ? order : Object.keys(rawPages).sort(naturalPageOrder);
  // The archive stores pages as "Pages/pageN.json"; the manifest lists bare file
  // names. Accept either spelling when looking the payload up.
  const pick = (name) => rawPages[name] ?? rawPages['Pages/' + name] ?? rawPages[name.replace(/^Pages\//, '')];
  const pages = names.map((n) => normalizePage(pick(n) || { elements: [] }));

  const doc = documentFromManifest(meta.manifest || {}, pages);
  doc.sourcePath = path;
  doc.path = path;
  doc.name = path.split(/[\\/]/).pop().replace(/\.note$/i, '');
  doc.entryCount = meta.entryCount;
  doc.archiveBytes = meta.size;
  return doc;
}

function naturalPageOrder(a, b) {
  const na = Number((a.match(/(\d+)/) || [])[1] || 0);
  const nb = Number((b.match(/(\d+)/) || [])[1] || 0);
  return na - nb;
}

function normalizePage(p) {
  return {
    elements: Array.isArray(p.elements) ? p.elements : [],
    scale: typeof p.scale === 'number' ? p.scale : 1,
    pdfPages: Array.isArray(p.pdfPages) ? p.pdfPages : [],
    ...(p.bg ? { bg: p.bg } : {}),
    ...(p.background ? { background: p.background } : {}),
  };
}

/** Persist the document as a .note archive. */
export async function saveNote(doc, { target, resources, newFiles } = {}) {
  const manifest = manifestFromDocument(doc);
  const pages = {};
  doc.pages.forEach((p, i) => { pages[`Pages/page${i + 1}.json`] = serializePage(p); });
  const body = {
    target: target || doc.path,
    source: doc.sourcePath || null,
    manifest,
    pages,
    // keepAll: the server copies every entry of the source archive verbatim, so
    // saving can never drop a resource the original file happened to contain.
    keepAll: true,
    resources: resources || referencedResources(doc),
    newFiles: newFiles || {},
  };
  const res = await api('/api/note/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await res.json();
  doc.path = target || doc.path;
  doc.sourcePath = doc.path;
  return out;
}

function serializePage(p) {
  const out = { elements: p.elements, scale: p.scale };
  if (p.pdfPages && p.pdfPages.length) out.pdfPages = p.pdfPages.map((x) => ({ pageNumber: x.pageNumber, bounds: x.bounds }));
  if (p.bg) out.bg = p.bg;
  return out;
}

/* ------------------------------------------------------------------ *
 * PDF import
 * ------------------------------------------------------------------ */
/**
 * Lay a PDF page out the way Microsoft Whiteboard does: one whiteboard page
 * per PDF page, horizontally centred.
 *
 * The page body is one viewport width wide, so at 100 % zoom it exactly fills
 * the window.  `scale` — the value Microsoft Whiteboard stores per page — is
 * the dimensionless layout factor `pageWidth / LAYOUT_WIDTH` (1440 in the
 * original app), which is what makes the sample files come out at
 * `1152 / 1440 = 0.8` and `1436.74 / 1440 = 0.9977`.
 */
export function pdfPageBounds(pdfW, pdfH, { viewportWidth = LAYOUT_WIDTH, y = 0 } = {}) {
  const width = viewportWidth;
  const height = width * (pdfH / pdfW);
  const x = (viewportWidth - width) / 2;
  return { x, y, w: width, h: height, str: `${r4(x)},${r4(y)},${r4(width)},${r4(height)}` };
}

/** Microsoft Whiteboard's per-page `scale` field for a page of this width. */
export function layoutScale(viewportWidth = LAYOUT_WIDTH) {
  return r4(viewportWidth / LAYOUT_WIDTH);
}

const r4 = (v) => Number(Number(v).toFixed(4));

/**
 * @param {import('./pdfmanager.js').PdfManager} pdf
 */
export async function importPdfAsPages(pdf, { viewportWidth = LAYOUT_WIDTH, name = null, onProgress } = {}) {
  const count = pdf.pageCount;
  const scale = layoutScale(viewportWidth);
  const pages = [];
  for (let n = 1; n <= count; n++) {
    const size = await pdf.getPageSize(n);
    const b = pdfPageBounds(size.width, size.height, { viewportWidth, y: 0 });
    pages.push(createPage({
      elements: [],
      scale,
      pdfPages: [{ pageNumber: n, bounds: b.str }],
    }));
    if (n % 25 === 0) onProgress?.(`准备页面 ${n}/${count}`);
  }
  return createDocument({
    pages,
    currentPage: 0,
    document: name ? { fileName: name } : null,
    name: name ? name.replace(/\.pdf$/i, '') : '未命名白板',
    scale,
  });
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
export function clonePages(pages) {
  return pages.map((p) => normalizePage(JSON.parse(JSON.stringify(p))));
}

export function pageLabel(doc, index) {
  const p = doc.pages[index];
  if (p && p.pdfPages && p.pdfPages.length) return `第 ${p.pdfPages[0].pageNumber} 页`;
  return `画纸 ${index + 1}`;
}
