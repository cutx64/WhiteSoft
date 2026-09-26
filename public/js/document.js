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
import { ZipReader } from './zipread.js';
import { ZipWriter } from './zipwrite.js';

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
 * Compaction (dropping resources nothing refers to)
 * ------------------------------------------------------------------ */
/** Directories a compaction may delete from; nothing else is ever touched. */
export const COMPACTABLE_DIRS = ['Resources/Images/', 'Resources/Document/'];

/**
 * Collect every resource the board mentions.
 *
 * Resources are stored by *bare* file name (`element.fileName`,
 * `manifest.document.fileName`), and only the archive knows which directory
 * each one lives in, so bare names are matched against the archive's entries.
 * Strings that already carry a `Resources/…` path count as-is.  Anything the
 * walk cannot make sense of is simply kept — collecting liberally can only
 * make a compaction delete less.
 */
function collectReferences(value, refs) {
  if (typeof value === 'string') {
    if (value.startsWith('Resources/') && !value.includes('..')) refs.paths.add(value);
    else if (value) refs.names.add(value);
    return;
  }
  if (Array.isArray(value)) { for (const v of value) collectReferences(v, refs); return; }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectReferences(v, refs);
  }
}

/** Which of `entryNames` are still in use (by full path or by bare name). */
export function referencedEntries(entryNames, refs) {
  const out = new Set();
  for (const name of entryNames) {
    if (refs.paths.has(name)) { out.add(name); continue; }
    const slash = name.lastIndexOf('/');
    if (refs.names.has(slash >= 0 ? name.slice(slash + 1) : name)) out.add(name);
  }
  return out;
}

/**
 * Which entries of an archive can be dropped, judged from the in-memory board.
 *
 * @param {object} doc
 * @param {string[]} entryNames entries of the archive being checked
 * @param {(name: string) => number} sizeOf compressed size of one entry
 * @param {(name: string) => object} entryOf archive entry record (method/usize)
 * @returns {{removable: {name: string, bytes: number}[], bytes: number,
 *   total: number, stored: {count: number, bytes: number}}}
 */
export function planLocalCompaction(doc, entryNames, sizeOf = () => 0, entryOf = null) {
  const refs = { names: new Set(), paths: new Set() };
  collectReferences(manifestFromDocument(doc), refs);
  for (const p of doc.pages) collectReferences(serializePage(p), refs);
  const referenced = referencedEntries(entryNames, refs);
  const removable = [];
  const stored = { count: 0, bytes: 0 };
  let bytes = 0;
  let total = 0;
  for (const name of entryNames) {
    const e = entryOf ? entryOf(name) : null;
    const size = sizeOf(name) || 0;
    const isResource = COMPACTABLE_DIRS.some((d) => name.startsWith(d));
    // An unreferenced resource goes, however it happens to be stored.
    if (isResource) {
      total++;
      if (!referenced.has(name)) {
        removable.push({ name, bytes: size });
        bytes += size;
        continue;
      }
    }
    // Entries written without compression can be deflated again: worth
    // reporting, because it explains a file that is fat for another reason.
    if (e && e.method === 0 && e.usize > 128) {
      stored.count++;
      stored.bytes += size;
    }
  }
  return { removable, bytes, total, stored };
}

/**
 * Open a `.note` that lives on the user's own disk.
 *
 * Nothing is copied anywhere: the archive is read in the browser (see
 * zipread.js), pages are parsed here, and the images stay where they are — the
 * document keeps the reader so the renderer can pull an entry only when it
 * draws it.  Saving writes back into this very file through its handle, or
 * asks for a new location when the browser cannot hand one out.
 */
export async function openLocalNote(file, { onProgress } = {}) {
  const zip = await ZipReader.open(file);
  onProgress?.('读取清单…');
  const manifest = (await zip.json('manifest.json')) || {};
  const order = (manifest.pages || []).map((p) => p.fileName).filter(Boolean);
  const names = order.length
    ? order.map((n) => (n.startsWith('Pages/') ? n : 'Pages/' + n))
    : zip.list().filter((n) => /^Pages\/.*\.json$/.test(n)).sort(naturalPageOrder);
  const pages = [];
  for (let i = 0; i < names.length; i++) {
    const raw = await zip.json(names[i]);
    pages.push(normalizePage(raw || { elements: [] }));
    if (i % 8 === 0 || i === names.length - 1) onProgress?.(`读取页面… ${i + 1}/${names.length}`);
  }
  const doc = documentFromManifest(manifest, pages);
  doc.name = file.name.replace(/\.note$/i, '');
  doc.entryCount = zip.list().length;
  doc.archiveBytes = file.size;
  doc.localArchive = zip;
  doc.localFile = { name: file.name, size: file.size, lastModified: file.lastModified || 0 };
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
export function serializePage(p) {
  const out = { elements: p.elements, scale: p.scale };
  if (p.pdfPages && p.pdfPages.length) out.pdfPages = p.pdfPages.map((x) => ({ pageNumber: x.pageNumber, bounds: x.bounds }));
  if (p.bg) out.bg = p.bg;
  return out;
}

/**
 * Write the document back into the file it was opened from.
 *
 * A board opened from disk is saved *in place* through its
 * `FileSystemFileHandle`, so Ctrl+S overwrites the file the user picked
 * instead of asking for a new name.  The archive is streamed entry by entry —
 * pages and the manifest are recompressed, every other entry is carried over
 * byte for byte (inflated on the fly, stored verbatim) so nothing a `.note`
 * contained is lost, and a 300 MB board never has to fit in memory twice.
 *
 * @param {object} doc
 * @param {FileSystemFileHandle} handle
 * @param {{newFiles?: Object<string, Uint8Array>, drop?: Set<string>, recompress?: boolean}} opts
 *   `newFiles` are freshly added resources; `drop` names entries the caller has
 *   decided to discard (compaction) — they are skipped instead of copied;
 *   `recompress` deflates entries that are currently stored uncompressed.
 */
const strToU8 = (text) => new TextEncoder().encode(text);

export async function writeNoteToHandle(doc, handle, { newFiles = {}, drop = null, recompress = false } = {}) {
  const writable = await handle.createWritable();
  const zip = new ZipWriter(writable);
  // Entries are copied from the archive as they were; that snapshot goes stale
  // as soon as anything writes to the file (including our own previous save),
  // so a failed read is retried against a fresh read of the file.
  let reader = doc.localArchive;
  try {
    await zip.add('manifest.json', strToU8(JSON.stringify(manifestFromDocument(doc), null, 1)));
    for (let i = 0; i < doc.pages.length; i++) {
      await zip.add(`Pages/page${i + 1}.json`, strToU8(JSON.stringify(serializePage(doc.pages[i]), null, 1)));
    }
    const written = new Set(['manifest.json', ...doc.pages.map((_, i) => `Pages/page${i + 1}.json`)]);

    for (const [name, bytes] of Object.entries(newFiles)) {
      if (!bytes || written.has(name)) continue;
      if (drop && drop.has(name)) continue;
      await zip.add(name, bytes);
      written.add(name);
    }

    if (reader) {
      const names = reader.list();
      for (const name of names) {
        if (written.has(name)) continue;
        if (drop && drop.has(name)) continue;
        let rawEntry = null;
        try {
          rawEntry = await reader.raw(name);
        } catch {
          reader = await ZipReader.open(await handle.getFile());
          doc.localArchive = reader;
          if (!reader.has(name)) continue;
          rawEntry = await reader.raw(name);
        }
        if (!rawEntry) continue;
        if (recompress && rawEntry.entry.method === 0 && rawEntry.entry.usize > 128) {
          // Stored entry: re-add it so the writer can deflate it (it keeps the
          // stored form when that turns out to be smaller).
          const bytes = await reader.read(name);
          if (bytes) {
            await zip.add(name, bytes);
            written.add(name);
            continue;
          }
        }
        // Unchanged data keeps its original bytes: no recompression, no growth.
        zip.addRaw(name, {
          method: rawEntry.entry.method,
          crc: rawEntry.entry.crc,
          usize: rawEntry.entry.usize,
          data: rawEntry.data,
        });
        written.add(name);
      }
    } else if (doc._pdfBytes && doc.document?.fileName) {
      // A board whose archive is gone (should not normally happen): keep the
      // embedded PDF at least.
      const name = 'Resources/Document/' + doc.document.fileName;
      if (!written.has(name)) await zip.add(name, doc._pdfBytes);
    }

    const written_bytes = await zip.finish();
    doc.archiveBytes = written_bytes;
    doc.localArchive = reader;      // the reader the next save should start from
    return { bytes: written_bytes, target: handle.name || '本地文件' };
  } catch (err) {
    await zip.abort();
    throw err;
  }
}

/**
 * Build the whole `.note` archive in memory and return it as a Blob.
 *
 * Only used by 另存为 on browsers without writable file system access (Firefox,
 * Safari): everywhere else the archive is streamed straight into the file, so a
 * 300 MB board never has to fit in memory.
 */
export async function noteBlob(doc, { newFiles = {}, drop = null } = {}) {
  const chunks = [];
  const sink = {
    write: async (bytes) => { chunks.push(bytes); },
    close: async () => {},
    abort: async () => {},
  };
  const zip = new ZipWriter(sink);
  try {
    await zip.add('manifest.json', strToU8(JSON.stringify(manifestFromDocument(doc), null, 1)));
    for (let i = 0; i < doc.pages.length; i++) {
      await zip.add(`Pages/page${i + 1}.json`, strToU8(JSON.stringify(serializePage(doc.pages[i]), null, 1)));
    }
    const written = new Set(['manifest.json', ...doc.pages.map((_, i) => `Pages/page${i + 1}.json`)]);
    for (const [name, bytes] of Object.entries(newFiles)) {
      if (!bytes || written.has(name) || (drop && drop.has(name))) continue;
      await zip.add(name, bytes);
      written.add(name);
    }
    const reader = doc.localArchive;
    if (reader) {
      for (const name of reader.list()) {
        if (written.has(name) || (drop && drop.has(name))) continue;
        const raw = await reader.raw(name);
        if (!raw) continue;
        zip.addRaw(name, {
          method: raw.entry.method,
          crc: raw.entry.crc,
          usize: raw.entry.usize,
          data: raw.data,
        });
        written.add(name);
      }
    } else if (doc._pdfBytes && doc.document?.fileName) {
      const name = 'Resources/Document/' + doc.document.fileName;
      if (!written.has(name)) await zip.add(name, doc._pdfBytes);
    }
    await zip.finish();
    return new Blob(chunks, { type: 'application/x-note' });
  } catch (err) {
    await zip.abort();
    throw err;
  }
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
