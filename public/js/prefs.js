/**
 * Preferences that are not part of a board.
 *
 * The board format holds what a whiteboard *contains*; how the app behaves on
 * this machine (the auto-save interval today) belongs to the browser, so it
 * lives in `localStorage`.  Every access is defensive: a browser with storage
 * disabled must never break the app.
 */

const KEY = 'whitesoft.prefs.v1';

/** Auto-save choices offered in 设置, in minutes (0 = off). */
export const AUTO_SAVE_CHOICES = [
  { minutes: 0, label: '关闭' },
  { minutes: 1, label: '1 分钟' },
  { minutes: 2, label: '2 分钟' },
  { minutes: 5, label: '5 分钟' },
  { minutes: 10, label: '10 分钟' },
  { minutes: 30, label: '30 分钟' },
  { minutes: 60, label: '1 小时' },
];

/** Human label for an interval in minutes. */
export function autoSaveLabel(minutes) {
  if (!minutes) return '关闭';
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} 小时`;
  if (minutes < 1) return `${Math.round(minutes * 60)} 秒`;
  return `${minutes} 分钟`;
}

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function write(all) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* private mode / storage disabled: settings simply do not persist */
  }
}

/** Read one preference, falling back to `dflt`. */
export function getPref(key, dflt = null) {
  const all = read();
  const v = all[key];
  return v === undefined ? dflt : v;
}

/** Store one preference. */
export function setPref(key, value) {
  const all = read();
  all[key] = value;
  write(all);
  return value;
}

/* ------------------------------------------------------------------ *
 * Recently used files
 * ------------------------------------------------------------------ */

/** How many files the recent list keeps. */
export const RECENT_LIMIT = 16;

/**
 * Files opened in this browser, most recent first, one line per file.
 *
 * A browser never reveals a path, so the *name* identifies a file: the same
 * board opened twice — even after an edit changed its size — must not fill the
 * list with copies of itself.  Entries written before this rule existed (or by
 * an older version) are merged here, newest first, borrowing a handle from the
 * older entry when the newer one has none.
 */
export function recentFiles() {
  const list = getPref('recentFiles', []);
  if (!Array.isArray(list)) return [];
  const out = [];
  const byKey = new Map();
  for (const raw of list) {
    // Older versions also remembered boards living inside a server-side
    // workspace; those entries carry a `path` and are of no use any more.
    if (!raw || !raw.name || raw.path) continue;
    const key = fileKey(raw);
    const seen = byKey.get(key);
    if (seen) {
      if (!seen.handleId && raw.handleId) seen.handleId = raw.handleId;
      continue;
    }
    const entry = { ...raw };
    byKey.set(key, entry);
    out.push(entry);
  }
  return out;
}

/**
 * Remember a file, newest first, replacing whatever was known about it.
 *
 * A remembered file is a *location*, never a copy: the browser file handle is
 * what makes it reachable again (or, when the browser has no such API, just
 * enough to recognise it and ask for it another time).
 */
export function rememberFile(entry) {
  if (!entry || !entry.name) return recentFiles();
  const key = fileKey(entry);
  const previous = recentFiles().find((r) => fileKey(r) === key);
  const list = recentFiles().filter((r) => fileKey(r) !== key);
  list.unshift({
    at: Date.now(),
    kind: 'note',
    source: 'local',
    // Opening without a handle (drag & drop) must not forget where the file
    // lives for the next time.
    ...(previous?.handleId && !entry.handleId ? { handleId: previous.handleId } : {}),
    ...entry,
  });
  const trimmed = list.slice(0, RECENT_LIMIT);
  setPref('recentFiles', trimmed);
  return trimmed;
}

/** Identity of a remembered file: its name (a browser never gives us a path). */
export function fileKey(entry) {
  if (!entry || !entry.name) return '';
  return `name:${String(entry.name).normalize('NFC').toLowerCase()}`;
}

/** Forget every remembered file. */
export function clearRecentFiles() {
  setPref('recentFiles', []);
  return [];
}

/** "刚刚" / "5 分钟前" / "昨天" … for the recent list. */
export function relativeTime(ts) {
  const secs = Math.max(0, (Date.now() - Number(ts || 0)) / 1000);
  if (secs < 60) return '刚刚';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return new Date(Number(ts)).toLocaleDateString();
}
