/*
 * 多人分帳：儲存與輸入處理（純邏輯，可在 Node 測試；碰到瀏覽器儲存的函式都接受「儲存物件」參數）
 */
import { parseImport, LIMITS } from './core.js?v=20261121222228';

export const STORAGE_KEY = 'lt_split_v1';
export const CORRUPT_KEY = 'lt_split_v1_corrupt';

function isObj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function emptyState() {
  return { version: 1, currentId: null, activities: [] };
}

export function newId(prefix, used) {
  const set = used instanceof Set ? used : new Set(used || []);
  for (let i = 0; i < 1000; i++) {
    const id = prefix + Math.random().toString(36).slice(2, 8);
    if (!set.has(id)) return id;
  }
  return prefix + Date.now().toString(36);
}

export function todayLocal(d) {
  const x = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
}

// 現場算錢的紀錄標題：YYYY/MM/DD HH:mm（手機當下時間）
export function formatStamp(d) {
  const x = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return x.getFullYear() + '/' + p(x.getMonth() + 1) + '/' + p(x.getDate()) + ' ' + p(x.getHours()) + ':' + p(x.getMinutes());
}

/* ---------- 輸入正規化 ---------- */

// 全形轉半形、去掉千分位逗號與空白、去掉前面的貨幣符號與後面的「元」
export function normalizeNumberText(raw) {
  let s = String(raw === null || raw === undefined ? '' : raw).normalize('NFKC');
  s = s.replace(/[−–—]/g, '-');
  s = s.replace(/[\s,_]/g, '');
  s = s.replace(/^(NT\$|NTD|\$)/i, '').replace(/元$/, '');
  return s;
}

function parseCount(raw, o) {
  const s = normalizeNumberText(raw);
  const label = o.label;
  if (s === '') return { ok: false, reason: o.blank || label + '還沒填' };
  if (s.includes('-')) return { ok: false, reason: label + '不能是負數' };
  if (s.includes('.')) return { ok: false, reason: label + '請輸入整數，不要有小數點' };
  if (!/^\d+$/.test(s)) return { ok: false, reason: label + '只能輸入數字' };
  const n = Number(s);
  if (!o.allowZero && n === 0) return { ok: false, reason: label + o.zeroText };
  if (n > o.max) return { ok: false, reason: label + '最多 ' + o.maxText };
  return { ok: true, value: n };
}

export function parseAmount(raw, label) {
  return parseCount(raw, {
    label: label || '金額', blank: '請輸入金額', allowZero: false, zeroText: '要大於 0',
    max: LIMITS.MAX_AMOUNT, maxText: '99,999,999 元',
  });
}

export function parseFixed(raw, label) {
  return parseCount(raw, {
    label: label || '固定金額', allowZero: true, max: LIMITS.MAX_AMOUNT, maxText: '99,999,999 元',
  });
}

/**
 * 金額欄：可以輸入「1000+500」這種加法。接受半形與全形加號、千分位逗號。
 * 回傳 { ok, blank, values, total, pending, reason }
 * - 空白：ok、blank，total 0（還沒填）
 * - 結尾多一個加號（例如「1000+」）：當成還在輸入，pending 為真，先算已輸入的部分
 * - 看不懂（字母、小數點、負數、連續兩個加號、開頭的加號、加總超過上限）：ok 為 false，附白話原因，total 0
 * values 只放大於 0 的項目
 */
export function parseMoneyExpr(raw, label) {
  const lb = label || '金額';
  const s = normalizeNumberText(raw);
  const fail = (reason) => ({ ok: false, blank: false, values: [], total: 0, pending: false, reason });
  if (s === '') return { ok: true, blank: true, values: [], total: 0, pending: false };
  const one = (t) => parseCount(t, { label: lb, allowZero: true, max: LIMITS.MAX_AMOUNT, maxText: '99,999,999 元' });
  if (!s.includes('+')) {
    const r = one(s);
    if (!r.ok) return fail(r.reason);
    return { ok: true, blank: false, values: r.value > 0 ? [r.value] : [], total: r.value, pending: false };
  }
  let body = s;
  let pending = false;
  if (body.endsWith('+')) { pending = true; body = body.slice(0, -1); }
  const terms = body.split('+');
  if (terms.some((t) => t === '')) return fail(lb + '的加號前後都要有數字');
  const values = [];
  let total = 0;
  for (const t of terms) {
    const r = one(t);
    if (!r.ok) return fail(r.reason);
    if (r.value > 0) values.push(r.value);
    total += r.value;
  }
  if (total > LIMITS.MAX_AMOUNT) return fail(lb + '加起來最多 99,999,999 元');
  return { ok: true, blank: false, values, total, pending };
}

export function parseShares(raw, label) {
  return parseCount(raw, {
    label: label || '份數', allowZero: false, zeroText: '至少要 1 份',
    max: LIMITS.MAX_SHARES, maxText: '1,000 份',
  });
}

/* ---------- 活動小工具 ---------- */

export function usedMemberIds(activity) {
  const used = new Set();
  for (const e of activity.expenses || []) {
    if (e.payerId) used.add(e.payerId);
    for (const p of e.participants || []) used.add(p.memberId);
    for (const f of e.fixed || []) used.add(f.memberId);
  }
  return used;
}

export function sampleActivity(today) {
  const all = ['m1', 'm2', 'm3', 'm4'];
  return {
    id: 'a_sample',
    title: '週五聚餐',
    createdAt: today || todayLocal(),
    members: [
      { id: 'm1', name: '小安' },
      { id: 'm2', name: '阿哲' },
      { id: 'm3', name: '佩佩' },
      { id: 'm4', name: '大毛' },
    ],
    expenses: [
      { id: 'e1', title: '晚餐', payerId: 'm1', amount: 2400, participants: all.map((m) => ({ memberId: m, shares: 1 })), fixed: [] },
      { id: 'e2', title: '飲料', payerId: 'm2', amount: 325, participants: ['m1', 'm2', 'm3'].map((m) => ({ memberId: m, shares: 1 })), fixed: [] },
      { id: 'e3', title: '計程車', payerId: 'm3', amount: 450, participants: ['m1', 'm2', 'm3'].map((m) => ({ memberId: m, shares: 1 })), fixed: [{ memberId: 'm4', amount: 100 }] },
    ],
  };
}

// 檔名：去掉不允許的字元
export function safeFileName(title, date, suffix, ext) {
  const clean = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim();
  let base = clean(title).slice(0, 40) || '分帳';
  if (date) base += '_' + clean(date);
  if (suffix) base += '_' + clean(suffix);
  return base + '.' + ext;
}

// 匯入的活動一律當新活動加入，換新的編號，避免蓋掉現有資料
export function addImported(state, activity) {
  const used = new Set(state.activities.map((a) => a.id));
  const a = JSON.parse(JSON.stringify(activity));
  a.id = newId('a', used);
  return { state: { version: 1, currentId: a.id, activities: state.activities.concat([a]) }, activity: a };
}

/* ---------- 序列化與讀取 ---------- */

export function serializeState(state) {
  return JSON.stringify({ version: 1, currentId: state.currentId, activities: state.activities });
}

/**
 * 解析儲存內容。壞掉的活動不會讓整體失敗，另外放進 bad；整份讀不懂放進 rawBad。
 * 回傳 { state, bad: [原始活動物件], rawBad: 文字或 null }
 */
export function parseState(text) {
  const res = { state: emptyState(), bad: [], rawBad: null };
  if (text === null || text === undefined) return res;
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    res.rawBad = String(text);
    return res;
  }
  if (!isObj(data) || data.version !== 1 || !Array.isArray(data.activities)) {
    res.rawBad = String(text);
    return res;
  }
  const ids = new Set();
  for (const a of data.activities) {
    let ok = false;
    try {
      const r = parseImport(JSON.stringify({ app: 'lifetoolbox-split', version: 1, activity: a }));
      if (r.ok && !ids.has(r.activity.id)) {
        ids.add(r.activity.id);
        res.state.activities.push(r.activity);
        ok = true;
      }
    } catch (e) { /* 當作壞資料 */ }
    if (!ok) res.bad.push(a);
  }
  const cur = typeof data.currentId === 'string' ? data.currentId : null;
  res.state.currentId = cur && ids.has(cur) ? cur : (res.state.activities[0] ? res.state.activities[0].id : null);
  return res;
}

/* ---------- 瀏覽器儲存（接受儲存物件，找不到或不能用就回 null / false） ---------- */

export function getStorage() {
  try {
    const s = globalThis.localStorage;
    const k = 'lt_probe';
    s.setItem(k, '1');
    s.removeItem(k);
    return s;
  } catch (e) {
    return null;
  }
}

export function loadState(storage) {
  if (!storage) return { state: emptyState(), bad: [], rawBad: null, available: false };
  let text = null;
  try {
    text = storage.getItem(STORAGE_KEY);
  } catch (e) {
    return { state: emptyState(), bad: [], rawBad: null, available: false };
  }
  return Object.assign(parseState(text), { available: true });
}

export function saveState(storage, state) {
  if (!storage) return false;
  try {
    storage.setItem(STORAGE_KEY, serializeState(state));
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 把讀不出來的資料全部另外留存（不限筆數，包含先前已留存的）。
 * 空間不夠時盡量多存，回傳 { kept, lost }：lost 是這次無法留存的筆數。
 */
export function stashCorruptItems(storage, items) {
  const all = Array.isArray(items) ? items : [];
  if (!storage) return { kept: 0, lost: all.length };
  let prev = [];
  try {
    const old = storage.getItem(CORRUPT_KEY);
    if (old) {
      let p = null;
      try { p = JSON.parse(old); } catch (e) { p = null; }
      if (p && Array.isArray(p.items)) prev = p.items;
      else prev = [old]; // 先前的留存內容本身讀不懂，也原文保留
    }
  } catch (e) {
    return { kept: 0, lost: all.length };
  }
  // 已經留存過的同一份資料不重複存（例如反覆重新整理）
  const have = new Set(prev.map(stable));
  const list = all.filter((x) => !have.has(stable(x)));
  const already = all.length - list.length;
  if (list.length === 0) return { kept: already, lost: 0 };
  const tryWrite = (k) => {
    try {
      storage.setItem(CORRUPT_KEY, JSON.stringify({ savedAt: todayLocal(), items: prev.concat(list.slice(0, k)) }));
      return true;
    } catch (e) {
      return false;
    }
  };
  if (tryWrite(list.length)) return { kept: all.length, lost: 0 };
  let lo = 1;
  let hi = list.length - 1;
  let best = 0;
  while (lo <= hi) { // 找出寫得進去的最大筆數（成功的寫入只會越來越大）
    const mid = (lo + hi) >> 1;
    if (tryWrite(mid)) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return { kept: already + best, lost: list.length - best };
}

export function stashCorrupt(storage, items) {
  if (!storage) return false;
  return stashCorruptItems(storage, items).lost === 0;
}

/* ---------- 多個分頁：以活動為單位合併 ---------- */

function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

// 記下「這個分頁上次與儲存內容同步時」每個活動的樣子（編號 → 指紋）
export function makeBaseline(state) {
  const m = new Map();
  for (const a of state.activities) m.set(a.id, stable(a));
  return m;
}

/**
 * 合併：以 stored（目前儲存中的最新內容）為底，只套用 mem 這個分頁自上次同步（baseline）以來
 * 新增、修改或刪除的活動。回傳 { state, conflicts }：conflicts 是「另一個分頁也動過同一個活動」的編號；
 * deletedElsewhere 是「別處已刪掉、這邊又改過」的活動編號，不會寫進 state，要由使用者決定。
 * modifiedElsewhere 是「這邊刪掉、別處在這之後又改過」的活動編號：先保留別處的版本留在 state 裡，由使用者決定要不要還是刪除。
 */
export function mergeState(stored, mem, baseline) {
  const base = baseline instanceof Map ? baseline : new Map(Object.entries(baseline || {}));
  const acts = stored.activities.slice();
  const conflicts = [];
  const deletedElsewhere = [];
  const modifiedElsewhere = [];
  const memIds = new Set(mem.activities.map((a) => a.id));
  for (const a of mem.activities) {
    const fp = stable(a);
    if (base.get(a.id) === fp) continue; // 這個分頁沒動過，以儲存中的版本為準
    const i = acts.findIndex((x) => x.id === a.id);
    if (i >= 0) {
      if (!base.has(a.id) || stable(acts[i]) !== base.get(a.id)) conflicts.push(a.id);
      acts[i] = a;
    } else if (base.has(a.id)) {
      deletedElsewhere.push(a.id); // 另一個分頁已把它刪掉，這邊又改了：先不寫回，交給使用者決定
    } else {
      acts.push(a);
    }
  }
  for (const id of base.keys()) {
    if (memIds.has(id)) continue;
    const i = acts.findIndex((x) => x.id === id);
    if (i < 0) continue;
    if (stable(acts[i]) !== base.get(id)) { modifiedElsewhere.push(id); continue; } // 我刪了，但別處在這之後改過：先保留，交給使用者決定
    acts.splice(i, 1);
  }
  const ids = new Set(acts.map((a) => a.id));
  let currentId = null;
  if (mem.currentId && ids.has(mem.currentId)) currentId = mem.currentId;
  else if (stored.currentId && ids.has(stored.currentId)) currentId = stored.currentId;
  else if (acts[0]) currentId = acts[0].id;
  return { state: { version: 1, currentId, activities: acts }, conflicts, deletedElsewhere, modifiedElsewhere };
}

/**
 * 儲存：先讀出目前儲存的最新內容，合併這個分頁動過的活動後再寫回。
 * 回傳 { ok, state?, conflicts?, lost?, stashed? }
 * 儲存中若有讀不出來的資料，會先全部另外留存；留存不了就整個不寫（lost > 0），保留原樣。
 */
export function saveMerged(storage, mem, baseline) {
  if (!storage) return { ok: false };
  let text = null;
  try {
    text = storage.getItem(STORAGE_KEY);
  } catch (e) {
    return { ok: false };
  }
  const p = parseState(text);
  let stashed = 0;
  if (p.rawBad !== null || p.bad.length > 0) {
    const items = p.rawBad !== null ? [p.rawBad] : p.bad;
    const s = stashCorruptItems(storage, items);
    if (s.lost > 0) return { ok: false, lost: s.lost };
    stashed = items.length;
  }
  const m = mergeState(p.state, mem, baseline);
  try {
    storage.setItem(STORAGE_KEY, serializeState(m.state));
  } catch (e) {
    return { ok: false };
  }
  return { ok: true, state: m.state, conflicts: m.conflicts, deletedElsewhere: m.deletedElsewhere, modifiedElsewhere: m.modifiedElsewhere, stashed };
}

export function clearAll(storage) {
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
    storage.removeItem(CORRUPT_KEY);
  } catch (e) { /* 忽略 */ }
}
