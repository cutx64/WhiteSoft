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
