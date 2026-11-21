/*
 * 多人分帳：計算核心（純函式，不碰畫面、不讀寫儲存、不載入任何東西）
 *
 * 計算規則（白話版，與審核單 01_split_bill.md 對照用）
 *  1. 所有金額一律用整數「元」計算，不用小數，避免電腦小數運算的誤差。
 *  2. 先從這筆支出扣掉所有「固定金額」，剩下的叫「剩餘金額」：
 *       剩餘金額 = 支出金額 - 固定金額加總。
 *  3. 剩餘金額依份數分給「分攤者」（平均分就是每人 1 份）：
 *       每位分攤者先付 = 剩餘金額 x 他的份數 / 全部份數，無條件捨去到整數元。
 *  4. 除不盡的「零頭」= 剩餘金額 - 所有分攤者先付的加總。
 *       零頭全部由這筆的付款人吸收（加到付款人這筆的該付金額；
 *       付款人不在分攤名單內也一樣，仍由他負擔）。
 *  5. 每位固定金額者，該付的就是他的固定金額。
 *  6. 一筆支出裡所有人的該付金額加總，必定等於這筆支出的金額。
 *  7. 每人差額 = 已付總額 - 該付總額。正數代表要收錢，負數代表要付錢，
 *     全部人的差額加總必為 0。
 *  8. 還款建議：每次讓「欠最多的人」付給「該收最多的人」，
 *       金額取兩人差額絕對值較小的那個，重複到全部清完。
 *       平手時，依成員在名單中的先後順序（排前面的先處理），所以同樣輸入永遠同樣輸出。
 *       筆數不會超過「人數 - 1」；這不保證是數學上最少的筆數。
 *  9. 同一位成員在同一筆支出中，只能出現在「分攤者」或「固定金額者」其中一邊，
 *       或都不出現（沒參與這筆）。付款人不必出現在名單內。
 * 10. 有錯的支出（見 ERRORS）整筆不計算，不計入任何人的已付與該付，
 *       其餘正確的支出照常計算；整個活動的 hasErrors 會是 true。
 *       同一筆有多種錯誤時，只回報先遇到的一個，檢查順序為：
 *       金額、付款人、沒有分攤者、不明成員、成員重複、份數、固定金額格式、
 *       固定金額超過、固定金額不等於總額。
 * 11. 上限：金額 99,999,999 元；每個份數最多 1,000；成員 50 人；支出 500 筆；
 *       成員名稱 40 字、活動與支出標題 60 字。
 */

export const LIMITS = Object.freeze({
  MAX_AMOUNT: 99999999,
  MAX_SHARES: 1000,
  MAX_MEMBERS: 50,
  MAX_EXPENSES: 500,
  MAX_LIST: 100, // 單筆支出分攤者／固定金額者清單長度上限
  MAX_NAME: 40,
  MAX_TITLE: 60,
  MAX_ID: 40,
  MAX_IMPORT_CHARS: 4000000,
});

export const ERRORS = Object.freeze({
  AMOUNT_INVALID: 'AMOUNT_INVALID',
  PAYER_MISSING: 'PAYER_MISSING',
  NO_SHARERS: 'NO_SHARERS',
  MEMBER_UNKNOWN: 'MEMBER_UNKNOWN',
  MEMBER_DUPLICATED: 'MEMBER_DUPLICATED',
  SHARES_INVALID: 'SHARES_INVALID',
  FIXED_INVALID: 'FIXED_INVALID',
  FIXED_EXCEEDS: 'FIXED_EXCEEDS',
  FIXED_NOT_EQUAL_TOTAL: 'FIXED_NOT_EQUAL_TOTAL',
});

const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];
const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isObj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasOwn(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function getOwn(o, k) {
  return hasOwn(o, k) ? o[k] : undefined;
}

// 以「自有屬性」方式寫入，避免 __proto__ 之類的鍵污染物件
function setOwn(o, k, v) {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

function isPosInt(n) {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
}

// 整數除法取商（無條件捨去），a、b 皆為非負安全整數且 b > 0；以餘數校正避免浮點誤差
function floorDiv(a, b) {
  let q = Math.floor(a / b);
  let r = a - q * b;
  while (r < 0) { q -= 1; r += b; }
  while (r >= b) { q += 1; r -= b; }
  return q;
}

function fail(error) {
  return { ok: false, error };
}

function asList(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * 計算單筆支出。
 * 成功：{ ok:true, owed:{成員id:該付}, rest, totalShares, remainder }
 * 失敗：{ ok:false, error:錯誤代碼 }
 */
export function computeExpense(expense, memberIds) {
  if (!isObj(expense)) return fail(ERRORS.AMOUNT_INVALID);
  const ids = new Set(Array.isArray(memberIds) ? memberIds : []);

  const amount = expense.amount;
  if (!isPosInt(amount) || amount > LIMITS.MAX_AMOUNT) return fail(ERRORS.AMOUNT_INVALID);

  const payerId = expense.payerId;
  if (typeof payerId !== 'string' || !ids.has(payerId)) return fail(ERRORS.PAYER_MISSING);

  const participants = asList(expense.participants);
  const fixed = asList(expense.fixed);
  if (participants.length === 0 && fixed.length === 0) return fail(ERRORS.NO_SHARERS);

  // 不明成員（含項目本身不是物件、沒有成員 id）
  for (const p of participants) {
    if (!isObj(p) || typeof p.memberId !== 'string' || !ids.has(p.memberId)) return fail(ERRORS.MEMBER_UNKNOWN);
  }
  for (const f of fixed) {
    if (!isObj(f) || typeof f.memberId !== 'string' || !ids.has(f.memberId)) return fail(ERRORS.MEMBER_UNKNOWN);
  }

  // 成員重複（同一人在分攤者出現兩次、固定金額者出現兩次，或兩邊都出現）
  const seen = new Set();
  for (const p of participants) {
    if (seen.has(p.memberId)) return fail(ERRORS.MEMBER_DUPLICATED);
    seen.add(p.memberId);
  }
  for (const f of fixed) {
    if (seen.has(f.memberId)) return fail(ERRORS.MEMBER_DUPLICATED);
    seen.add(f.memberId);
  }

  // 份數
  let totalShares = 0;
  for (const p of participants) {
    if (!isPosInt(p.shares) || p.shares > LIMITS.MAX_SHARES) return fail(ERRORS.SHARES_INVALID);
    totalShares += p.shares;
  }

  // 固定金額格式
  for (const f of fixed) {
    if (typeof f.amount !== 'number' || !Number.isSafeInteger(f.amount) || f.amount < 0) return fail(ERRORS.FIXED_INVALID);
  }
  let fixedSum = 0;
  for (const f of fixed) fixedSum += f.amount;
  if (fixedSum > amount) return fail(ERRORS.FIXED_EXCEEDS);

  if (participants.length === 0 && fixedSum !== amount) return fail(ERRORS.FIXED_NOT_EQUAL_TOTAL);

  const rest = amount - fixedSum;
  const owed = {};
  let allocated = 0;
  for (const p of participants) {
    const share = floorDiv(rest * p.shares, totalShares);
    setOwn(owed, p.memberId, share);
    allocated += share;
  }
  for (const f of fixed) setOwn(owed, f.memberId, f.amount);

  const remainder = rest - allocated;
  if (remainder > 0 || hasOwn(owed, payerId)) {
    setOwn(owed, payerId, (getOwn(owed, payerId) || 0) + remainder);
  }

  return { ok: true, owed, rest, totalShares, remainder };
}

/**
 * 還款建議。balances: [{ memberId, balance }]，順序即平手時的優先順序。
 */
export function suggestTransfers(balances) {
  const list = (Array.isArray(balances) ? balances : []).map((b) => ({
    memberId: b.memberId,
    balance: b.balance,
  }));
  const transfers = [];
  for (;;) {
    let debtor = -1;
    let creditor = -1;
    for (let i = 0; i < list.length; i++) {
      const v = list[i].balance;
      if (v < 0 && (debtor === -1 || v < list[debtor].balance)) debtor = i;
      if (v > 0 && (creditor === -1 || v > list[creditor].balance)) creditor = i;
    }
    if (debtor === -1 || creditor === -1) break;
    const amount = Math.min(-list[debtor].balance, list[creditor].balance);
    transfers.push({ from: list[debtor].memberId, to: list[creditor].memberId, amount });
    list[debtor].balance += amount;
    list[creditor].balance -= amount;
  }
  return transfers;
}

/**
 * 計算整個活動。有錯的支出不計入任何人的已付與該付。
 */
export function computeActivity(activity) {
  const members = [];
  const idSet = new Set();
  if (isObj(activity)) {
    for (const m of asList(activity.members)) {
      if (isObj(m) && typeof m.id === 'string' && !idSet.has(m.id)) {
        idSet.add(m.id);
        members.push(m.id);
      }
    }
  }
  const paid = new Map(members.map((id) => [id, 0]));
  const owedTotal = new Map(members.map((id) => [id, 0]));
  const expenses = [];
  let total = 0;
  let hasErrors = false;

  for (const ex of isObj(activity) ? asList(activity.expenses) : []) {
    const id = isObj(ex) ? ex.id : undefined;
    const r = computeExpense(ex, members);
    if (!r.ok) {
      hasErrors = true;
      expenses.push({ id, ok: false, error: r.error });
      continue;
    }
    total += ex.amount;
    paid.set(ex.payerId, paid.get(ex.payerId) + ex.amount);
    for (const mid of Object.keys(r.owed)) owedTotal.set(mid, owedTotal.get(mid) + r.owed[mid]);
    expenses.push({
      id,
      ok: true,
      owed: r.owed,
      rest: r.rest,
      totalShares: r.totalShares,
      remainder: r.remainder,
    });
  }

  const perMember = members.map((memberId) => ({
    memberId,
    paid: paid.get(memberId),
    owed: owedTotal.get(memberId),
    balance: paid.get(memberId) - owedTotal.get(memberId),
  }));
  const transfers = suggestTransfers(perMember.map((p) => ({ memberId: p.memberId, balance: p.balance })));
  return { ok: !hasErrors, perMember, expenses, transfers, total, hasErrors };
}

function strLen(s) {
  return Array.from(s).length;
}

function checkText(label, v, max, allowEmpty, out) {
  if (typeof v !== 'string') { out.push(label + '必須是文字'); return; }
  if (CONTROL_CHARS.test(v)) { out.push(label + '含有不能使用的字元'); return; }
  if (!allowEmpty && v.trim() === '') { out.push(label + '不能是空白'); return; }
  if (strLen(v) > max) out.push(label + '不能超過 ' + max + ' 個字');
}

function checkId(label, v, out) {
  if (typeof v !== 'string' || !ID_PATTERN.test(v) || FORBIDDEN_KEYS.includes(v)) {
    out.push(label + '的編號格式不正確');
    return false;
  }
  return true;
}

function validDate(s) {
  const m = typeof s === 'string' ? DATE_PATTERN.exec(s) : null;
  if (!m) return false;
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const y = Number(m[1]);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
}

// 快速計算（quick）欄位的上限；quick.js 的 QUICK_LIMITS 數值必須與此一致
export const QUICK_CORE_LIMITS = Object.freeze({
  MAX_PEOPLE: 99,
  MAX_PARTS: 5,
  MAX_ITEMS: 30,
  MAX_BILLS: 10,
});

const QUICK_MODES = ['even', 'parts', 'free', 'fixed'];

function isIntIn(v, min, max) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
}

// 檢查 quick 欄位的結構（只管格式與型別，數值合不合理由 quick.js 的計算判定）
function checkQuick(q, out) {
  if (!isObj(q)) { out.push('快速計算資料格式不正確'); return; }
  const L = QUICK_CORE_LIMITS;
  if (!Array.isArray(q.bills) || q.bills.length < 1 || q.bills.length > L.MAX_BILLS) {
    out.push('快速計算的帳單必須是 1 到 ' + L.MAX_BILLS + ' 張');
    return;
  }
  const billIds = new Set();
  q.bills.forEach((b, i) => {
    const label = '第 ' + (i + 1) + ' 張帳單';
    if (!isObj(b)) { out.push(label + '格式不正確'); return; }
    if (checkId(label, b.id, out)) {
      if (billIds.has(b.id)) out.push(label + '的編號重複');
      billIds.add(b.id);
    }
    if (!isIntIn(b.people, 0, L.MAX_PEOPLE)) out.push(label + '的人數格式不正確');
    if (!isIntIn(b.total, 0, LIMITS.MAX_AMOUNT)) out.push(label + '的總額格式不正確');
    if (typeof b.mode !== 'string' || !QUICK_MODES.includes(b.mode)) out.push(label + '的算法格式不正確');
    if (typeof b.roundTens !== 'boolean') out.push(label + '的湊整設定格式不正確');

    if (hasOwn(b, 'parts')) {
      if (!Array.isArray(b.parts) || b.parts.length > L.MAX_PARTS) {
        out.push(label + '的另外算清單格式不正確或超過 ' + L.MAX_PARTS + ' 筆');
      } else {
        const partIds = new Set();
        b.parts.forEach((p, j) => {
          const pl = label + '的第 ' + (j + 1) + ' 筆另外算';
          if (!isObj(p)) { out.push(pl + '格式不正確'); return; }
          if (checkId(pl, p.id, out)) {
            if (partIds.has(p.id)) out.push(pl + '的編號重複');
            partIds.add(p.id);
          }
          checkText(pl + '的名稱', p.name, LIMITS.MAX_NAME, true, out);
          if (!Array.isArray(p.items) || p.items.length > L.MAX_ITEMS || !p.items.every((v) => isIntIn(v, 1, LIMITS.MAX_AMOUNT))) {
            out.push(pl + '的金額清單格式不正確');
          }
          if (typeof p.service !== 'boolean') out.push(pl + '的服務費設定格式不正確');
          if (!isIntIn(p.people, 0, L.MAX_PEOPLE)) out.push(pl + '的人數格式不正確');
        });
      }
    }
    if (hasOwn(b, 'free')) {
      const f = b.free;
      if (!isObj(f) || (f.by !== 'all' && f.by !== 'cover')
        || !isIntIn(f.count, 0, L.MAX_PEOPLE) || !isIntIn(f.coverers, 0, L.MAX_PEOPLE) || !isIntIn(f.each, 0, L.MAX_PEOPLE)) {
        out.push(label + '的「有人不用付」資料格式不正確');
      }
    }
    if (hasOwn(b, 'fixed')) {
      const f = b.fixed;
      if (!isObj(f) || !isIntIn(f.count, 0, L.MAX_PEOPLE) || !isIntIn(f.amount, 0, LIMITS.MAX_AMOUNT)) {
        out.push(label + '的「固定金額」資料格式不正確');
      }
    }
  });
}

// 依白名單重建 quick（呼叫前已通過 checkQuick）
function cleanQuick(q) {
  return {
    bills: q.bills.map((b) => {
      const x = { id: b.id, people: b.people, total: b.total, mode: b.mode, roundTens: b.roundTens };
      if (hasOwn(b, 'parts')) {
        x.parts = b.parts.map((p) => ({ id: p.id, name: p.name, items: p.items.slice(), service: p.service, people: p.people }));
      }
      if (hasOwn(b, 'free')) x.free = { by: b.free.by, count: b.free.count, coverers: b.free.coverers, each: b.free.each };
      if (hasOwn(b, 'fixed')) x.fixed = { count: b.fixed.count, amount: b.fixed.amount };
      return x;
    }),
  };
}

/**
 * 結構檢查，回傳錯誤訊息陣列（空陣列代表結構正確）。
 * 只檢查格式與型別；金額、份數等數值是否合理屬於「單筆計算錯誤」，由 computeExpense 判定。
 */
export function validateActivity(activity) {
  const out = [];
  if (!isObj(activity)) return ['活動資料格式不正確'];
  checkId('活動', activity.id, out);
  checkText('活動標題', activity.title, LIMITS.MAX_TITLE, false, out);
  if (!validDate(activity.createdAt)) out.push('建立日期格式不正確');

  if (!Array.isArray(activity.members)) {
    out.push('成員清單格式不正確');
  } else {
    if (activity.members.length > LIMITS.MAX_MEMBERS) out.push('成員不能超過 ' + LIMITS.MAX_MEMBERS + ' 人');
    const ids = new Set();
    activity.members.forEach((m, i) => {
      const label = '第 ' + (i + 1) + ' 位成員';
      if (!isObj(m)) { out.push(label + '格式不正確'); return; }
      if (checkId(label, m.id, out)) {
        if (ids.has(m.id)) out.push(label + '的編號重複');
        ids.add(m.id);
      }
      checkText(label + '的名稱', m.name, LIMITS.MAX_NAME, false, out);
    });
  }

  if (!Array.isArray(activity.expenses)) {
    out.push('支出清單格式不正確');
  } else {
    if (activity.expenses.length > LIMITS.MAX_EXPENSES) out.push('支出不能超過 ' + LIMITS.MAX_EXPENSES + ' 筆');
    const ids = new Set();
    activity.expenses.forEach((e, i) => {
      const label = '第 ' + (i + 1) + ' 筆支出';
      if (!isObj(e)) { out.push(label + '格式不正確'); return; }
      if (checkId(label, e.id, out)) {
        if (ids.has(e.id)) out.push(label + '的編號重複');
        ids.add(e.id);
      }
      checkText(label + '的標題', e.title, LIMITS.MAX_TITLE, true, out);
      if (typeof e.payerId !== 'string') out.push(label + '的付款人格式不正確');
      if (typeof e.amount !== 'number' || !Number.isFinite(e.amount)) out.push(label + '的金額格式不正確');
      for (const [key, field, name] of [['participants', 'shares', '份數'], ['fixed', 'amount', '固定金額']]) {
        if (!hasOwn(e, key)) continue;
        const arr = e[key];
        if (!Array.isArray(arr)) { out.push(label + '的' + (key === 'fixed' ? '固定金額名單' : '分攤名單') + '格式不正確'); continue; }
        if (arr.length > LIMITS.MAX_LIST) { out.push(label + '的名單太長'); continue; }
        for (const it of arr) {
          if (!isObj(it) || typeof it.memberId !== 'string' || typeof it[field] !== 'number' || !Number.isFinite(it[field])) {
            out.push(label + '的' + name + '資料格式不正確');
            break;
          }
        }
      }
    });
  }
  if (hasOwn(activity, 'quick')) checkQuick(activity.quick, out);
  return out;
}

// 依白名單重建乾淨物件：只保留合約欄位，其他一律丟棄
function cleanActivity(a) {
  const out = {
    id: a.id,
    title: a.title,
    createdAt: a.createdAt,
    members: a.members.map((m) => ({ id: m.id, name: m.name })),
    expenses: a.expenses.map((e) => {
      const x = { id: e.id, title: e.title, payerId: e.payerId, amount: e.amount };
      if (hasOwn(e, 'participants')) x.participants = e.participants.map((p) => ({ memberId: p.memberId, shares: p.shares }));
      if (hasOwn(e, 'fixed')) x.fixed = e.fixed.map((f) => ({ memberId: f.memberId, amount: f.amount }));
      return x;
    }),
  };
  if (hasOwn(a, 'quick')) out.quick = cleanQuick(a.quick);
  return out;
}

// 以迭代方式檢查整份資料中是否有危險鍵名
function hasForbiddenKey(root) {
  const stack = [root];
  let guard = 0;
  while (stack.length > 0) {
    const cur = stack.pop();
    if (typeof cur !== 'object' || cur === null) continue;
    if (++guard > 2000000) return true;
    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
    } else {
      for (const k of Object.keys(cur)) {
        if (FORBIDDEN_KEYS.includes(k)) return true;
        stack.push(cur[k]);
      }
    }
  }
  return false;
}

/**
 * 解析匯入檔文字。成功回 { ok:true, activity }（已重建為乾淨物件），
 * 失敗回 { ok:false, reason }（白話原因），不會部分載入。
 */
export function parseImport(text) {
  if (typeof text !== 'string') return { ok: false, reason: '檔案內容不是文字' };
  if (text.length > LIMITS.MAX_IMPORT_CHARS) return { ok: false, reason: '檔案太大，不是正確的備份檔' };
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: '這不是正確的備份檔（無法讀取內容）' };
  }
  if (!isObj(data)) return { ok: false, reason: '這不是正確的備份檔' };
  if (hasForbiddenKey(data)) return { ok: false, reason: '檔案含有不安全的內容，已拒絕載入' };
  if (data.app !== 'lifetoolbox-split') return { ok: false, reason: '這不是本工具產生的備份檔' };
  if (data.version !== 1) return { ok: false, reason: '備份檔的版本不支援' };
  if (!hasOwn(data, 'activity')) return { ok: false, reason: '備份檔裡找不到活動資料' };
  const problems = validateActivity(data.activity);
  if (problems.length > 0) return { ok: false, reason: '備份檔內容有誤：' + problems[0] };
  return { ok: true, activity: cleanActivity(data.activity) };
}

/**
 * 匯出為備份檔文字。活動結構不合法時丟出錯誤，確保匯出的檔案一定能再匯入。
 */
export function serializeExport(activity) {
  const problems = validateActivity(activity);
  if (problems.length > 0) throw new RangeError('活動資料有誤，無法匯出：' + problems[0]);
  return JSON.stringify({ app: 'lifetoolbox-split', version: 1, activity: cleanActivity(activity) }, null, 2);
}
