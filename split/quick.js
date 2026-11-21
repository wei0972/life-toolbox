/*
 * 多人分帳（現場算錢）：計算模組與顯示用文字（純函式，不碰畫面與儲存）
 *
 * 所有「分錢的除法」一律交給 core.js 的 computeExpense：
 * 用虛擬成員 p1…pN，加一位不在分攤名單內的虛擬付款人，除不盡的零頭自然落在付款人身上，
 * 不算進任何一列。服務費、湊成整十、加總是本模組自己的整數運算。
 * 規則出處：PLAN_v3.md 第 2 節；review/01_split_bill_v3.md、01_split_bill_v2.md「標準答案」。
 *
 * 兩條計算路徑：
 *  - 匿名（沒有名單）：只看人數，一次只開一種情況（bill.mode）。
 *  - 有名單（roster 非空）：看 who／on，三種情況可同時開著。
 */

import { LIMITS, QUICK_CORE_LIMITS, computeExpense } from './core.js?v=20261121222228';
import { formatMoney } from './explain.js?v=20261121222228';

// 數值必須與 core.js 的 QUICK_CORE_LIMITS 一致
export const QUICK_LIMITS = Object.freeze({
  MAX_PEOPLE: QUICK_CORE_LIMITS.MAX_PEOPLE,
  MAX_PARTS: QUICK_CORE_LIMITS.MAX_PARTS,
  MAX_ITEMS: QUICK_CORE_LIMITS.MAX_ITEMS,
  MAX_BILLS: QUICK_CORE_LIMITS.MAX_BILLS,
});

export const QUICK_ERRORS = Object.freeze({
  EMPTY: 'EMPTY',
  PEOPLE_INVALID: 'PEOPLE_INVALID',
  TOTAL_INVALID: 'TOTAL_INVALID',
  MODE_INVALID: 'MODE_INVALID',
  PART_PEOPLE_INVALID: 'PART_PEOPLE_INVALID',
  PART_AMOUNT_INVALID: 'PART_AMOUNT_INVALID',
  PARTS_EXCEED_TOTAL: 'PARTS_EXCEED_TOTAL',
  FREE_COUNT_INVALID: 'FREE_COUNT_INVALID',
  COVER_EXCEEDS: 'COVER_EXCEEDS',
  FIXED_COUNT_INVALID: 'FIXED_COUNT_INVALID',
  FIXED_EXCEEDS: 'FIXED_EXCEEDS',
  NO_PAYERS: 'NO_PAYERS',
  SUM_EXCEEDS: 'SUM_EXCEEDS',
});

const MODES = ['even', 'parts', 'free', 'fixed'];
const ON_ORDER = ['parts', 'free', 'fixed'];
const PAYER = 'payer';

function isInt(v) {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

function isIntIn(v, min, max) {
  return isInt(v) && v >= min && v <= max;
}

function isObj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(error, partId) {
  const r = { ok: false, error };
  if (partId !== undefined) r.partId = partId;
  return r;
}

const money = (n) => formatMoney(n);

/** 這一筆各項金額加總；service 為真時加一成並四捨五入到整數元 */
export function partAmount(part) {
  const items = part && Array.isArray(part.items) ? part.items : [];
  let sum = 0;
  for (const v of items) sum += v;
  if (part && part.service) return Math.floor((sum * 11 + 5) / 10);
  return sum;
}

/** 四捨五入到十位（個位 5 以上進位） */
export function roundTens(n) {
  return Math.floor((n + 5) / 10) * 10;
}

/**
 * 呼叫核心做除法。groups: [{count, shares}]，count 為 0 的組略過；
 * fixed: { count, amount } 固定金額組（可省略）。
 * 回傳每一組每人金額（依 groups 順序；count 為 0 的組回 0），及固定金額組不另回傳。
 * 零頭落在虛擬付款人，不算進任何一組。
 */
function splitByCore(total, people, groups, fixed) {
  const memberIds = [];
  for (let i = 1; i <= people; i++) memberIds.push('p' + i);
  memberIds.push(PAYER);
  let next = 1;
  const participants = [];
  const firstOf = [];
  for (const g of groups) {
    if (g.count > 0) {
      firstOf.push('p' + next);
      for (let i = 0; i < g.count; i++) {
        participants.push({ memberId: 'p' + next, shares: g.shares });
        next += 1;
      }
    } else {
      firstOf.push(null);
    }
  }
  const fixedList = [];
  if (fixed && fixed.count > 0) {
    for (let i = 0; i < fixed.count; i++) {
      fixedList.push({ memberId: 'p' + next, amount: fixed.amount });
      next += 1;
    }
  }
  const r = computeExpense({ amount: total, payerId: PAYER, participants, fixed: fixedList }, memberIds);
  if (!r.ok) throw new RangeError('快速計算的核心呼叫失敗：' + r.error);
  return firstOf.map((id) => (id === null ? 0 : r.owed[id]));
}

function evenAmount(total, people) {
  return splitByCore(total, people, [{ count: people, shares: 1 }])[0];
}

function finish(res) {
  let collected = 0;
  for (const row of res.rows) collected += row.count * row.amount;
  res.collected = collected;
  res.diff = res.total - collected;
  return res;
}

/**
 * 計算一張帳單，回傳格式見 PLAN_v3.md 第 2 節。
 * roster 省略或空陣列 = 匿名計算；非空 = 有名單計算。
 */
export function computeBill(bill, roster) {
  if (!bill || typeof bill !== 'object') return fail(QUICK_ERRORS.EMPTY);
  if (Array.isArray(roster) && roster.length > 0) return computeNamed(bill, roster);
  return computeAnonymous(bill);
}

function computeAnonymous(bill) {
  const { people, total } = bill;
  if (!isIntIn(people, 0, QUICK_LIMITS.MAX_PEOPLE)) return fail(QUICK_ERRORS.PEOPLE_INVALID);
  if (!isIntIn(total, 0, LIMITS.MAX_AMOUNT)) return fail(QUICK_ERRORS.TOTAL_INVALID);
  if (people === 0 || total === 0) return fail(QUICK_ERRORS.EMPTY);
  const mode = bill.mode;
  if (!MODES.includes(mode)) return fail(QUICK_ERRORS.MODE_INVALID);

  const N = people;
  const T = total;
  const round = bill.roundTens === true;
  const res = {
    ok: true, mode, people: N, total: T, rows: [], combined: null, skipped: [], incomplete: false,
  };
  const evenRows = () => {
    const each = evenAmount(T, N);
    res.rows.push({ role: 'each', count: N, amount: round ? roundTens(each) : each });
  };

  if (mode === 'even') {
    evenRows();
    return finish(res);
  }

  if (mode === 'parts') {
    const list = Array.isArray(bill.parts) ? bill.parts : [];
    const active = [];
    for (const p of list) {
      const pid = p && p.id;
      const items = p && p.items;
      if (!Array.isArray(items) || !items.every((v) => isIntIn(v, 1, LIMITS.MAX_AMOUNT))) {
        return fail(QUICK_ERRORS.PART_AMOUNT_INVALID, pid);
      }
      if (!isIntIn(p.people, 0, QUICK_LIMITS.MAX_PEOPLE)) return fail(QUICK_ERRORS.PART_PEOPLE_INVALID, pid);
      const amount = partAmount(p);
      if (amount === 0 || p.people === 0) {
        res.skipped.push(pid);
        continue;
      }
      if (p.people > N) return fail(QUICK_ERRORS.PART_PEOPLE_INVALID, pid);
      active.push({ id: pid, amount, people: p.people });
    }
    let partsSum = 0;
    for (const a of active) partsSum += a.amount;
    if (partsSum > T) return fail(QUICK_ERRORS.PARTS_EXCEED_TOTAL);

    const rest = T - partsSum;
    let base = rest === 0 ? 0 : evenAmount(rest, N);
    if (round) base = roundTens(base);
    res.rows.push({ role: 'base', count: N, amount: base });
    res.parts = [];
    for (const a of active) {
      let add = evenAmount(a.amount, a.people);
      if (round) add = roundTens(add);
      res.parts.push({ id: a.id, amount: a.amount, people: a.people, add });
      res.rows.push({ role: 'add', count: a.people, amount: add, partId: a.id });
    }
    if (active.length === 1) {
      const only = res.parts[0];
      res.combined = {
        withCount: only.people,
        withAmount: base + only.add,
        withoutCount: N - only.people,
        withoutAmount: base,
      };
    }
    return finish(res);
  }

  if (mode === 'free') {
    const f = bill.free && typeof bill.free === 'object' ? bill.free : {};
    const by = f.by === 'cover' ? 'cover' : 'all';
    if (by === 'all') {
      const c = f.count;
      if (!isIntIn(c, 0, QUICK_LIMITS.MAX_PEOPLE)) return fail(QUICK_ERRORS.FREE_COUNT_INVALID);
      if (c === 0) {
        res.incomplete = true;
        evenRows();
        return finish(res);
      }
      if (c >= N) return fail(QUICK_ERRORS.FREE_COUNT_INVALID);
      const each = evenAmount(T, N - c);
      res.rows.push({ role: 'each', count: N - c, amount: round ? roundTens(each) : each });
      res.rows.push({ role: 'free', count: c, amount: 0 });
      return finish(res);
    }
    // 幫忙付：F 人不用付，M 人幫忙付。幫忙的人每人 = ⌊T×(M+F)÷(M×N)⌋，其餘每人 = ⌊T÷N⌋
    const F = f.count;
    const M = f.coverers;
    if (!isIntIn(F, 0, QUICK_LIMITS.MAX_PEOPLE) || !isIntIn(M, 0, QUICK_LIMITS.MAX_PEOPLE)) {
      return fail(QUICK_ERRORS.COVER_EXCEEDS);
    }
    if (F === 0 || M === 0) {
      res.incomplete = true;
      evenRows();
      return finish(res);
    }
    if (F + M > N) return fail(QUICK_ERRORS.COVER_EXCEEDS);
    const restCount = N - F - M;
    const [cover, each] = splitByCore(T, N, [{ count: M, shares: M + F }, { count: restCount, shares: M }]);
    res.rows.push({ role: 'cover', count: M, amount: round ? roundTens(cover) : cover });
    if (restCount > 0) res.rows.push({ role: 'each', count: restCount, amount: round ? roundTens(each) : each });
    res.rows.push({ role: 'free', count: F, amount: 0 });
    return finish(res);
  }

  // fixed
  const fx = bill.fixed && typeof bill.fixed === 'object' ? bill.fixed : {};
  const c = fx.count;
  const m = fx.amount;
  if (!isIntIn(c, 0, QUICK_LIMITS.MAX_PEOPLE)) return fail(QUICK_ERRORS.FIXED_COUNT_INVALID);
  if (c === 0) {
    res.incomplete = true;
    evenRows();
    return finish(res);
  }
  if (c >= N) return fail(QUICK_ERRORS.FIXED_COUNT_INVALID);
  if (!isIntIn(m, 0, LIMITS.MAX_AMOUNT) || c * m > T) return fail(QUICK_ERRORS.FIXED_EXCEEDS);
  const [each] = splitByCore(T, N, [{ count: N - c, shares: 1 }], { count: c, amount: m });
  res.rows.push({ role: 'fixed', count: c, amount: m });
  res.rows.push({ role: 'each', count: N - c, amount: round ? roundTens(each) : each });
  return finish(res);
}

// 有名單的計算（PLAN_v3.md 2.2）
function computeNamed(bill, roster) {
  const rosterIds = new Set();
  for (const m of roster) if (m && typeof m.id === 'string') rosterIds.add(m.id);
  // 依 bill.who 的順序，去掉重複與不在名單內的 id
  const P = [];
  {
    const seen = new Set();
    for (const id of Array.isArray(bill.who) ? bill.who : []) {
      if (typeof id === 'string' && rosterIds.has(id) && !seen.has(id)) {
        seen.add(id);
        P.push(id);
      }
    }
  }
  const T = bill.total;
  if (P.length > QUICK_LIMITS.MAX_PEOPLE) return fail(QUICK_ERRORS.PEOPLE_INVALID);
  if (!isIntIn(T, 0, LIMITS.MAX_AMOUNT)) return fail(QUICK_ERRORS.TOTAL_INVALID);
  const n = P.length;
  if (n === 0 || T === 0) return fail(QUICK_ERRORS.EMPTY);

  const onSet = new Set(Array.isArray(bill.on) ? bill.on : []);
  const on = ON_ORDER.filter((k) => onSet.has(k));
  const round = bill.roundTens === true;
  const inP = new Set(P);
  // list 與 P 的交集，依 P 的順序
  const sel = (list, allowed) => {
    const have = new Set(Array.isArray(list) ? list : []);
    return P.filter((id) => have.has(id) && (!allowed || allowed.has(id)));
  };

  const freeOn = onSet.has('free');
  const fixedOn = onSet.has('fixed');
  const partsOn = onSet.has('parts');
  const f = isObj(bill.free) ? bill.free : {};
  const fx = isObj(bill.fixed) ? bill.fixed : {};
  const by = f.by === 'cover' ? 'cover' : 'all';

  // 步驟 2–5
  let Fr = freeOn ? sel(f.who) : [];
  const frAll = new Set(Fr);
  const Fx = fixedOn ? sel(fx.who).filter((id) => !frAll.has(id)) : [];
  const fxSet = new Set(Fx);
  let C = [];
  if (freeOn && by === 'cover') C = sel(f.coverWho).filter((id) => !frAll.has(id) && !fxSet.has(id));
  let incomplete = false;
  if (freeOn) {
    if (Fr.length === 0) {
      incomplete = true;
      C = [];
    } else if (by === 'cover' && C.length === 0) {
      incomplete = true;
      Fr = [];
    }
  }
  if (fixedOn && Fx.length === 0) incomplete = true;

  // 步驟 6
  const frSet = new Set(Fr);
  const N = P.filter((id) => !frSet.has(id) && !fxSet.has(id));
  if (N.length === 0) {
    if (Fr.length > 0 && Fx.length > 0) return fail(QUICK_ERRORS.NO_PAYERS);
    if (Fx.length > 0) return fail(QUICK_ERRORS.FIXED_COUNT_INVALID);
    return fail(QUICK_ERRORS.FREE_COUNT_INVALID);
  }
  const nSet = new Set(N);

  // 步驟 7
  const active = [];
  const skipped = [];
  if (partsOn) {
    for (const p of Array.isArray(bill.parts) ? bill.parts : []) {
      const pid = p && p.id;
      if (!p || !Array.isArray(p.items) || !p.items.every((v) => isIntIn(v, 1, LIMITS.MAX_AMOUNT))) {
        return fail(QUICK_ERRORS.PART_AMOUNT_INVALID, pid);
      }
      const who = sel(p.who, nSet);
      const amount = partAmount(p);
      if (amount === 0 || who.length === 0) {
        skipped.push(pid);
        continue;
      }
      active.push({ id: pid, amount, who });
    }
  }

  // 步驟 8
  let a = 0;
  if (Fx.length > 0) {
    if (!isIntIn(fx.amount, 0, LIMITS.MAX_AMOUNT)) return fail(QUICK_ERRORS.FIXED_EXCEEDS);
    a = fx.amount;
  }
  let sumA = 0;
  for (const p of active) sumA += p.amount;
  if (sumA > T) return fail(QUICK_ERRORS.PARTS_EXCEED_TOTAL);
  if (Fx.length * a > T) return fail(QUICK_ERRORS.FIXED_EXCEEDS);
  if (sumA + Fx.length * a > T) return fail(QUICK_ERRORS.SUM_EXCEEDS);

  // 步驟 9
  const R = T - sumA - Fx.length * a;
  let coverBase = 0;
  let normalBase = 0;
  if (R > 0) {
    if (C.length > 0) {
      [coverBase, normalBase] = splitByCore(R, N.length, [
        { count: C.length, shares: C.length + Fr.length },
        { count: N.length - C.length, shares: C.length },
      ]);
    } else {
      [normalBase] = splitByCore(R, N.length, [{ count: N.length, shares: 1 }]);
    }
  }
  if (round) {
    coverBase = roundTens(coverBase);
    normalBase = roundTens(normalBase);
  }

  // 步驟 10
  const parts = [];
  for (const p of active) {
    let add = evenAmount(p.amount, p.who.length);
    if (round) add = roundTens(add);
    parts.push({ id: p.id, amount: p.amount, people: p.who.length, add });
  }

  // 步驟 11、12
  const cSet = new Set(C);
  const addOf = new Map();
  active.forEach((p, i) => {
    for (const id of p.who) addOf.set(id, (addOf.get(id) || 0) + parts[i].add);
  });
  const persons = P.map((id) => {
    if (frSet.has(id)) return { id, kind: 'free', amount: 0 };
    if (fxSet.has(id)) return { id, kind: 'fixed', amount: a };
    if (cSet.has(id)) return { id, kind: 'cover', amount: coverBase + (addOf.get(id) || 0) };
    return { id, kind: 'normal', amount: normalBase + (addOf.get(id) || 0) };
  });
  let collected = 0;
  for (const p of persons) collected += p.amount;

  const byAmount = new Map();
  for (const p of persons) {
    if (!byAmount.has(p.amount)) byAmount.set(p.amount, { amount: p.amount, count: 0, ids: [] });
    const g = byAmount.get(p.amount);
    g.count += 1;
    g.ids.push(p.id);
  }
  const groups = [...byAmount.values()].sort((x, y) => y.amount - x.amount);

  const res = {
    ok: true,
    named: true,
    mode: on[0] || 'even',
    on,
    people: n,
    total: T,
    persons,
    groups,
    rows: [],
    combined: null,
    parts,
    skipped,
    incomplete,
    collected,
    diff: T - collected,
  };

  // on.length ≤ 1：rows／combined 與「同人數的匿名計算」相同
  if (on.length <= 1) {
    const mode = res.mode;
    if (mode === 'free' && !incomplete) {
      if (C.length > 0) {
        res.rows.push({ role: 'cover', count: C.length, amount: coverBase });
        if (N.length - C.length > 0) res.rows.push({ role: 'each', count: N.length - C.length, amount: normalBase });
      } else {
        res.rows.push({ role: 'each', count: N.length, amount: normalBase });
      }
      res.rows.push({ role: 'free', count: Fr.length, amount: 0 });
    } else if (mode === 'fixed' && !incomplete) {
      res.rows.push({ role: 'fixed', count: Fx.length, amount: a });
      res.rows.push({ role: 'each', count: N.length, amount: normalBase });
    } else if (mode === 'parts') {
      res.rows.push({ role: 'base', count: n, amount: normalBase });
      for (const p of parts) res.rows.push({ role: 'add', count: p.people, amount: p.add, partId: p.id });
      if (parts.length === 1) {
        res.combined = {
          withCount: parts[0].people,
          withAmount: normalBase + parts[0].add,
          withoutCount: n - parts[0].people,
          withoutAmount: normalBase,
        };
      }
    } else {
      res.rows.push({ role: 'each', count: n, amount: normalBase });
    }
  }
  return res;
}

/** 計算整筆紀錄（多張帳單） */
export function computeRecord(quick) {
  const list = quick && Array.isArray(quick.bills) ? quick.bills : [];
  const roster = quick && Array.isArray(quick.roster) && quick.roster.length > 0 ? quick.roster : null;
  const bills = list.map((b) => computeBill(b, roster || undefined));
  let sum = null;
  let persons = null;
  if (roster) {
    if (bills.length > 0 && bills.every((r) => r.ok)) {
      const totals = new Map();
      for (const m of roster) totals.set(m.id, 0);
      for (const r of bills) for (const p of r.persons) totals.set(p.id, (totals.get(p.id) || 0) + p.amount);
      persons = roster.map((m) => ({ id: m.id, amount: totals.get(m.id) }));
    }
  } else if (bills.length >= 2
    && bills.every((r) => r.ok && r.mode === 'even' && !r.incomplete && r.people === bills[0].people)) {
    let each = 0;
    for (const r of bills) each += r.rows[0].amount;
    sum = { people: bills[0].people, each };
  }
  return { bills, sum, persons };
}

/** 顯示名稱：name 非空用 name，否則「第 N 筆」（N 是它在清單的順位） */
export function partLabel(bill, partId) {
  const parts = bill && Array.isArray(bill.parts) ? bill.parts : [];
  const i = parts.findIndex((p) => p && p.id === partId);
  if (i >= 0 && typeof parts[i].name === 'string' && parts[i].name.trim() !== '') return parts[i].name;
  return '第 ' + (i >= 0 ? i + 1 : parts.length + 1) + ' 筆';
}

/** 新帳單（匿名：不帶 who／on；建立名單時由呼叫端補上） */
export function newBill(id) {
  return {
    id,
    people: 0,
    total: 0,
    mode: 'even',
    roundTens: false,
    parts: [],
    free: { by: 'all', count: 0, coverers: 1 },
    fixed: { count: 0, amount: 0 },
  };
}

export function newPart(id) {
  return { id, name: '', items: [], service: false, people: 0 };
}

function activePartsSum(bill) {
  let sum = 0;
  for (const p of Array.isArray(bill && bill.parts) ? bill.parts : []) {
    if (!p || !Array.isArray(p.items)) continue;
    const k = Array.isArray(p.who) ? p.who.length : p.people;
    if (p.items.length > 0 && isInt(k) && k > 0) sum += partAmount(p);
  }
  return sum;
}

/**
 * 錯誤的白話說明（一句話）。第二個參數 bill 可省略；有給時會帶入具體數字與第幾筆。
 */
export function errorText(result, bill) {
  if (!result || result.ok || !result.error) return '';
  const named = !!bill && Array.isArray(bill.who);
  const N = bill && isInt(bill.people) ? bill.people : null;
  const T = bill && isInt(bill.total) ? bill.total : null;
  const label = bill && result.partId !== undefined ? partLabel(bill, result.partId) : '其中一筆';
  switch (result.error) {
    case 'EMPTY':
      return named ? '還沒填完，請先選好這張帳單有誰，並填總金額。' : '還沒填完，請先填人數和總金額。';
    case 'PEOPLE_INVALID':
      return '人數請填 1 到 ' + QUICK_LIMITS.MAX_PEOPLE + ' 之間的整數。';
    case 'TOTAL_INVALID':
      return '總金額請填 1 到 ' + money(LIMITS.MAX_AMOUNT) + ' 元之間的整數。';
    case 'MODE_INVALID':
      return '算法的選項不正確，請重新選一次。';
    case 'PART_PEOPLE_INVALID': {
      const p = bill && Array.isArray(bill.parts) ? bill.parts.find((x) => x && x.id === result.partId) : null;
      if (p && isIntIn(p.people, 1, QUICK_LIMITS.MAX_PEOPLE) && N !== null) {
        return label + '額外付費的人填了 ' + p.people + ' 人，但總共只有 ' + N + ' 個人。';
      }
      return label + '額外付費的人數不對，請填 1 到總人數之間的整數。';
    }
    case 'PART_AMOUNT_INVALID':
      return label + '的金額有問題，每個金額都要是 1 元以上的整數，請檢查。';
    case 'PARTS_EXCEED_TOTAL':
      if (bill && T !== null) {
        return '額外付費的金額加起來（' + money(activePartsSum(bill)) + ' 元）比帳單總額（' + money(T) + ' 元）還多，請檢查金額。';
      }
      return '額外付費的金額加起來比帳單總額還多，請檢查金額。';
    case 'FREE_COUNT_INVALID': {
      const c = bill && bill.free ? bill.free.count : null;
      if (!named && N !== null && isInt(c)) {
        return '不用付的人數（' + c + ' 人）要比總人數（' + N + ' 人）少，請減少不用付的人數。';
      }
      return '不用付的人不能是所有的人，請留下幾位要付的人。';
    }
    case 'COVER_EXCEEDS': {
      const f = bill && bill.free ? bill.free : null;
      if (N !== null && f && isInt(f.count) && isInt(f.coverers)) {
        return '不用付的 ' + f.count + ' 人加上幫忙付的 ' + f.coverers + ' 人，一共 ' + (f.count + f.coverers)
          + ' 個人，但總共只有 ' + N + ' 個人，請減少人數。';
      }
      return '不用付的人加上幫忙付的人，比總人數還多，請減少人數。';
    }
    case 'FIXED_COUNT_INVALID': {
      const c = bill && bill.fixed ? bill.fixed.count : null;
      if (!named && N !== null && isInt(c)) {
        return '付固定金額的人數（' + c + ' 人）要比總人數（' + N + ' 人）少，請減少人數。';
      }
      return '付固定金額的人不能是所有的人，請留下幾位平分剩下的錢。';
    }
    case 'FIXED_EXCEEDS': {
      const f = bill && bill.fixed ? bill.fixed : null;
      if (T !== null && f && isInt(f.count) && isInt(f.amount)) {
        return '固定金額加起來（' + f.count + ' 人 × ' + money(f.amount) + ' 元 = ' + money(f.count * f.amount)
          + ' 元）比帳單總額（' + money(T) + ' 元）還多，請檢查金額。';
      }
      return '固定金額加起來比帳單總額還多，請檢查金額。';
    }
    case 'NO_PAYERS':
      return '不用付的人和付固定金額的人，已經是這張帳單所有的人，沒有人平分剩下的錢，請留下幾位。';
    case 'SUM_EXCEEDS':
      return '額外付費的金額加上固定金額，比帳單總額還多，請檢查金額。';
    default:
      return '輸入的資料有問題，請檢查。';
  }
}

// ---------- 顯示用文字（畫面與結算卡共用，純函式） ----------

export function rosterName(roster, id) {
  const list = Array.isArray(roster) ? roster : [];
  const i = list.findIndex((m) => m && m.id === id);
  if (i >= 0 && typeof list[i].name === 'string' && list[i].name.trim() !== '') return list[i].name;
  return '第 ' + (i >= 0 ? i + 1 : list.length + 1) + ' 位';
}

function row(count, note, amount, opts) {
  const o = opts || {};
  return {
    who: count + ' 人',
    note,
    amount,
    each: o.each !== undefined ? o.each : count !== 1,
    plus: o.plus === true,
  };
}

/**
 * 結果區每一列：[{ who, note, amount, each, plus }]（PLAN_v3.md 2.3）。
 * who 是「7 人」（平分時為空字串）；each 表示金額前是否加「每人」（人數為 1 時 false）；plus 表示金額前是否加「＋」。
 * 兩筆以上額外付費時，最後多一列提示（hint:true、amount:null）。
 * 有名單且同時開多種情況時，每列是一組金額相同的人，另附 names（最多列 3 個名字，其餘接「…」）。
 */
export function resultRows(bill, res, roster) {
  if (!res || !res.ok) return [];
  if (res.named && res.on.length >= 2) {
    return res.groups.map((g) => {
      const names = g.ids.map((id) => rosterName(roster, id));
      const text = names.length <= 3 ? names.join('、') : names.slice(0, 3).join('、') + '…';
      return { ...row(g.count, '', g.amount), names: text };
    });
  }
  const rows = res.rows;
  const find = (role) => rows.find((r) => r.role === role);
  const single = () => {
    const r = rows[0];
    return [{ who: '', note: '', amount: r.amount, each: res.people !== 1, plus: false }];
  };
  if (find('free')) {
    const cover = find('cover');
    const each = find('each');
    const out = [];
    if (cover) {
      out.push(row(cover.count, '幫忙付', cover.amount));
      if (each) out.push(row(each.count, '只付自己的', each.amount));
    } else if (each) {
      out.push(row(each.count, '要付', each.amount));
    }
    out.push(row(find('free').count, '不用付', 0, { each: false }));
    return out;
  }
  if (find('fixed')) {
    const fx = find('fixed');
    const each = find('each');
    const out = [row(fx.count, '付固定金額', fx.amount)];
    if (each) out.push(row(each.count, '其餘的人', each.amount));
    return out;
  }
  if (find('base')) {
    if (res.combined) {
      const c = res.combined;
      const out = [row(c.withCount, '有額外付費', c.withAmount)];
      if (c.withoutCount > 0) out.push(row(c.withoutCount, '沒有額外付費', c.withoutAmount));
      return out;
    }
    if (res.parts && res.parts.length >= 2) {
      const base = find('base');
      const out = [row(base.count, '每個人都要付', base.amount)];
      for (const p of res.parts) out.push(row(p.people, partNote(bill, p.id), p.add, { plus: true }));
      out.push({ who: '', note: '有額外付的人，把自己那幾筆加上去', amount: null, each: false, plus: false, hint: true });
      return out;
    }
    return single();
  }
  return single();
}

// 結果列裡每一筆的說明：沒取名「第 1 筆額外付」，有取名「『外帶』額外付」（加引號，才看得出是名字）
function partNote(bill, partId) {
  const parts = bill && Array.isArray(bill.parts) ? bill.parts : [];
  const p = parts.find((x) => x && x.id === partId);
  if (p && typeof p.name === 'string' && p.name.trim() !== '') return '「' + p.name + '」額外付';
  return partLabel(bill, partId) + '額外付';
}

/** 打字時結果縮成的一行（不含「元」） */
export function compactLine(bill, res, roster) {
  if (!res || !res.ok) return '';
  void roster;
  if (res.named && res.on.length >= 2) {
    const gs = res.groups;
    if (gs.length === 1) return '每人 ' + money(gs[0].amount);
    return '最多 ' + money(gs[0].amount) + '・最少 ' + money(gs[gs.length - 1].amount);
  }
  const rows = res.rows;
  const find = (role) => rows.find((r) => r.role === role);
  if (find('free')) {
    const cover = find('cover');
    const each = find('each');
    const parts = [];
    if (cover) {
      parts.push('幫忙付 ' + money(cover.amount));
      if (each) parts.push('自己的 ' + money(each.amount));
    } else if (each) {
      parts.push('要付 ' + money(each.amount));
    }
    parts.push('不用付 0');
    return parts.join('・');
  }
  if (find('fixed')) {
    const each = find('each');
    return '固定 ' + money(find('fixed').amount) + (each ? '・其餘 ' + money(each.amount) : '');
  }
  if (find('base')) {
    if (res.combined) {
      const c = res.combined;
      return '額外付費 ' + money(c.withAmount) + (c.withoutCount > 0 ? '・沒有 ' + money(c.withoutAmount) : '');
    }
    if (res.parts && res.parts.length >= 2) return '都要付 ' + money(find('base').amount) + '・另加各筆';
    return '每人 ' + money(find('base').amount);
  }
  return '每人 ' + money(rows[0].amount);
}

// 各種人的人數（有名單看 persons，匿名看 rows）
function countsOf(res) {
  const c = { normal: 0, cover: 0, free: 0, fixed: 0, fixedAmount: 0 };
  if (res.named) {
    for (const p of res.persons) {
      if (p.kind === 'normal') c.normal += 1;
      else if (p.kind === 'cover') c.cover += 1;
      else if (p.kind === 'free') c.free += 1;
      else { c.fixed += 1; c.fixedAmount = p.amount; }
    }
  } else {
    for (const r of res.rows) {
      if (r.role === 'each' || r.role === 'base') c.normal += r.count;
      else if (r.role === 'cover') c.cover += r.count;
      else if (r.role === 'free') c.free += r.count;
      else if (r.role === 'fixed') { c.fixed += r.count; c.fixedAmount = r.amount; }
    }
  }
  return c;
}

/**
 * 句子下方的回應行。key：'part:<id>'、'free'、'fixed'。該句還沒填完（或算不出來）回空字串。
 */
export function echoLine(bill, res, key) {
  if (!res || !res.ok || typeof key !== 'string') return '';
  if (key.startsWith('part:')) {
    const id = key.slice(5);
    const p = Array.isArray(res.parts) ? res.parts.find((x) => x.id === id) : null;
    if (!p) return '';
    return p.people === 1 ? '這 1 人額外付 ' + money(p.add) + ' 元'
      : '這 ' + p.people + ' 人每人額外付 ' + money(p.add) + ' 元';
  }
  const c = countsOf(res);
  if (key === 'free') {
    if (c.free === 0) return '';
    if (c.cover > 0) return '幫忙的人付自己的，再加上這 ' + c.free + ' 人的份';
    if (bill && bill.free && bill.free.by === 'cover') return '';
    return '其餘 ' + c.normal + ' 人平分全部的錢';
  }
  if (key === 'fixed') {
    if (c.fixed === 0) return '';
    return '其餘 ' + (c.normal + c.cover) + ' 人平分剩下的 ' + money(res.total - c.fixed * c.fixedAmount) + ' 元';
  }
  return '';
}

/** 「全部收齊」那一行（不含句號） */
export function collectedLine(res) {
  if (!res || !res.ok) return '';
  const collected = money(res.collected);
  if (res.diff > 0) return '全部收齊 ' + collected + ' 元，還差 ' + money(res.diff) + ' 元由付錢的人補';
  if (res.diff < 0) return '全部收齊 ' + collected + ' 元，比帳單多 ' + money(-res.diff) + ' 元';
  return '全部收齊 ' + collected + ' 元，剛好';
}

function diffLine(result) {
  return collectedLine(result) + '。';
}

// 為了算「不湊整」的對照值，從帳單內的 who 還原出一份只含 id 的名單
function rosterOf(bill) {
  return (Array.isArray(bill.who) ? bill.who : []).map((id) => ({ id, name: '' }));
}

/**
 * 白話算式，回傳字串陣列。names 是 part 顯示名稱對照（{partId: 名稱}，可省略；沒有就用 partLabel）。
 */
export function explainBill(bill, result, names) {
  if (!result || !result.ok) return [];
  const nameOf = (id) => {
    const n = names && (typeof names.get === 'function' ? names.get(id) : names[id]);
    return typeof n === 'string' && n.trim() !== '' ? n : partLabel(bill, id);
  };
  const rounded = bill.roundTens === true;
  const raw = rounded
    ? computeBill({ ...bill, roundTens: false }, result.named ? rosterOf(bill) : undefined)
    : result;
  const rowOf = (res, role, partId) => res.rows.find((r) => r.role === role && (partId === undefined || r.partId === partId));
  const N = result.people;
  const T = result.total;
  const lines = [];
  lines.push('帳單總額 ' + money(T) + ' 元，一共 ' + N + ' 個人。');

  const roundNote = (role, partId, text) => {
    if (!rounded) return;
    const a = rowOf(raw, role, partId);
    const b = rowOf(result, role, partId);
    if (a && b) lines.push('湊成整十：' + text + ' ' + money(a.amount) + ' 元，四捨五入到十位變成 ' + money(b.amount) + ' 元。');
  };
  const partLines = () => {
    for (const p of result.parts) {
      const part = bill.parts.find((x) => x.id === p.id);
      const itemsTotal = part.items.reduce((s, v) => s + v, 0);
      const label = nameOf(p.id);
      let line = label + '：';
      if (part.items.length > 1) line += part.items.map(money).join(' + ') + ' = ' + money(itemsTotal) + ' 元';
      else line += money(itemsTotal) + ' 元';
      if (part.service) line += '，另加一成服務費後是 ' + money(p.amount) + ' 元';
      const addRaw = raw.ok && raw.parts ? raw.parts.find((x) => x.id === p.id).add : p.add;
      line += addRaw === 0 ? '，由 ' + p.people + ' 人額外付費，每人不到 1 元，不用再加。'
        : '，由 ' + p.people + ' 人額外付費，每人再加 ' + money(addRaw) + ' 元。';
      lines.push(line);
      if (rounded && raw.ok && addRaw !== p.add) {
        lines.push('湊成整十：' + label + '每人再加 ' + money(addRaw) + ' 元，四捨五入到十位變成 ' + money(p.add) + ' 元。');
      }
    }
    for (const id of result.skipped) lines.push(nameOf(id) + '還沒填完，先不算。');
  };

  if (result.named && result.on.length >= 2) {
    const c = countsOf(result);
    if (c.free > 0) {
      lines.push(c.cover > 0
        ? c.cover + ' 人幫忙付，平均分擔 ' + c.free + ' 位不用付的人的份，這 ' + c.free + ' 人不用付。'
        : c.free + ' 人不用付，他們的份由其餘的人平分。');
    }
    if (c.fixed > 0) {
      lines.push(c.fixed + (c.fixed === 1 ? ' 人付固定的 ' : ' 人各付固定的 ') + money(c.fixedAmount)
        + ' 元，合計 ' + money(c.fixed * c.fixedAmount) + ' 元。');
    }
    partLines();
    const partsSum = result.parts.reduce((s, p) => s + p.amount, 0);
    const rest = T - partsSum - c.fixed * c.fixedAmount;
    lines.push('額外付費與固定金額都先扣掉，帳單剩下 ' + money(rest) + ' 元，由其餘 ' + (c.normal + c.cover)
      + ' 人平分（小數部分捨去），每個人再加上自己額外付費的那幾筆。');
    if (rounded) lines.push('湊成整十：每人平分的部分與每一筆額外付費，都已四捨五入到十位。');
    lines.push('每個人要付的金額：');
    for (const g of result.groups) {
      lines.push(g.amount === 0 ? g.count + ' 人不用付。' : g.count + (g.count === 1 ? ' 人付 ' : ' 人各付 ') + money(g.amount) + ' 元。');
    }
    lines.push(diffLine(result));
    return lines;
  }

  if (result.mode === 'even' || result.incomplete) {
    if (result.incomplete) {
      lines.push(result.mode === 'free' ? '還沒填不用付的情況，先照平分算。' : '還沒填完這個情況，先照平分算。');
    }
    const each = rowOf(raw, 'each');
    lines.push(money(T) + ' 元由 ' + N + ' 人平分，每人 ' + money(each.amount) + ' 元（小數部分捨去）。');
    roundNote('each', undefined, '每人');
  } else if (result.mode === 'parts') {
    partLines();
    const partsSum = result.parts.reduce((s, p) => s + p.amount, 0);
    const baseRaw = rowOf(raw, 'base').amount;
    if (result.parts.length > 0) {
      if (baseRaw === 0) {
        lines.push('額外付費的合計 ' + money(partsSum) + ' 元，帳單剩下 ' + money(T - partsSum) + ' 元，'
          + (T - partsSum === 0 ? '' : '由 ' + N + ' 人平分不到 1 元，') + '沒有額外付費的人不用付。');
      } else {
        lines.push('額外付費的合計 ' + money(partsSum) + ' 元，帳單剩下 ' + money(T - partsSum) + ' 元，由 ' + N
          + ' 人平分，每個人都要付 ' + money(baseRaw) + ' 元（小數部分捨去）。');
      }
    } else {
      lines.push('沒有額外付費的部分，' + money(T) + ' 元由 ' + N + ' 人平分，每人 ' + money(baseRaw) + ' 元（小數部分捨去）。');
    }
    roundNote('base', undefined, '每個人都要付');
    const base = rowOf(result, 'base').amount;
    if (result.combined) {
      const c = result.combined;
      let line = '也就是：有額外付費的 ' + c.withCount + (c.withCount === 1 ? ' 人付 ' : ' 人各付 ') + money(c.withAmount) + ' 元';
      if (c.withoutCount > 0) {
        line += c.withoutAmount === 0 ? '，沒有額外付費的 ' + c.withoutCount + ' 人不用付'
          : '，沒有額外付費的 ' + c.withoutCount + (c.withoutCount === 1 ? ' 人付 ' : ' 人各付 ') + money(c.withoutAmount) + ' 元';
      }
      lines.push(line + '。');
    } else if (result.parts.length > 1) {
      lines.push(base === 0 ? '每個人把自己額外付費的各筆加起來，就是要付的金額；沒有額外付費的人不用付。'
        : '每個人把自己額外付費的各筆加上去，就是要付的金額；每個人都要付 ' + money(base) + ' 元。');
    }
  } else if (result.mode === 'free') {
    const cover = rowOf(result, 'cover');
    const free = rowOf(result, 'free');
    const each = rowOf(raw, 'each');
    if (!cover) {
      lines.push(free.count + ' 人不用付，' + money(T) + ' 元由其餘 ' + (N - free.count) + ' 人平分，每人 '
        + money(each.amount) + ' 元（小數部分捨去）。');
      roundNote('each', undefined, '每人');
    } else {
      const coverRaw = rowOf(raw, 'cover');
      lines.push(free.count + ' 人不用付，由幫忙付的 ' + cover.count + ' 人平均分擔他們的份。');
      lines.push('幫忙付的每人付 總額 ×（' + cover.count + ' + ' + free.count + '）÷（' + cover.count + ' × ' + N
        + '）= ' + money(coverRaw.amount) + ' 元；其餘每人付 總額 ÷ ' + N
        + (each ? ' = ' + money(each.amount) + ' 元' : '') + '，小數部分都捨去。');
      roundNote('cover', undefined, '幫忙付的每人');
      if (each) roundNote('each', undefined, '其餘每人');
    }
  } else {
    const fixed = rowOf(result, 'fixed');
    const each = rowOf(raw, 'each');
    lines.push((fixed.amount === 0 ? fixed.count + ' 人不用付' : fixed.count + (fixed.count === 1 ? ' 人付固定的 ' : ' 人各付固定的 ') + money(fixed.amount) + ' 元')
      + '，合計 ' + money(fixed.count * fixed.amount)
      + ' 元；帳單剩下 ' + money(T - fixed.count * fixed.amount) + ' 元，由其餘 ' + (N - fixed.count) + ' 人平分，每人 '
      + money(each.amount) + ' 元（小數部分捨去）。');
    roundNote('each', undefined, '其餘每人');
  }
  lines.push(diffLine(result));
  return lines;
}
