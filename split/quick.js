/*
 * 多人分帳第二版：現場算錢的計算模組（純計算，不碰畫面與儲存）
 *
 * 所有「分錢的除法」一律交給 core.js 的 computeExpense：
 * 用虛擬成員 p1…pN，加一位不在分攤名單內的虛擬付款人，除不盡的零頭自然落在付款人身上，
 * 不算進任何一列。服務費、湊成整十、加總是本模組自己的整數運算。
 * 規則出處：review/01_split_bill_v2.md「計算規則」與「標準答案案例」。
 */

import { LIMITS, QUICK_CORE_LIMITS, computeExpense } from './core.js?v=20261121093330';
import { formatMoney } from './explain.js?v=20261121093330';

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
});

const MODES = ['even', 'parts', 'free', 'fixed'];
const PAYER = 'payer';

function isInt(v) {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

function isIntIn(v, min, max) {
  return isInt(v) && v >= min && v <= max;
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

/** 計算一張帳單，回傳格式見 PLAN_v2.md 第 3 節 */
export function computeBill(bill) {
  if (!bill || typeof bill !== 'object') return fail(QUICK_ERRORS.EMPTY);
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
    const a = f.coverers;
    const b = f.each;
    if (!isIntIn(a, 0, QUICK_LIMITS.MAX_PEOPLE) || !isIntIn(b, 0, QUICK_LIMITS.MAX_PEOPLE)) {
      return fail(QUICK_ERRORS.COVER_EXCEEDS);
    }
    if (a === 0 || b === 0) {
      res.incomplete = true;
      evenRows();
      return finish(res);
    }
    const freeCount = a * b;
    if (a + freeCount > N) return fail(QUICK_ERRORS.COVER_EXCEEDS);
    const restCount = N - a - freeCount;
    const [cover, each] = splitByCore(T, N, [{ count: a, shares: 1 + b }, { count: restCount, shares: 1 }]);
    res.rows.push({ role: 'cover', count: a, amount: round ? roundTens(cover) : cover });
    if (restCount > 0) res.rows.push({ role: 'each', count: restCount, amount: round ? roundTens(each) : each });
    res.rows.push({ role: 'free', count: freeCount, amount: 0 });
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

/** 計算整筆紀錄（多張帳單） */
export function computeRecord(quick) {
  const list = quick && Array.isArray(quick.bills) ? quick.bills : [];
  const bills = list.map((b) => computeBill(b));
  let sum = null;
  if (bills.length >= 2
    && bills.every((r) => r.ok && r.mode === 'even' && !r.incomplete && r.people === bills[0].people)) {
    let each = 0;
    for (const r of bills) each += r.rows[0].amount;
    sum = { people: bills[0].people, each };
  }
  return { bills, sum };
}

/** 顯示名稱：name 非空用 name，否則「第 N 筆」（N 是它在清單的順位） */
export function partLabel(bill, partId) {
  const parts = bill && Array.isArray(bill.parts) ? bill.parts : [];
  const i = parts.findIndex((p) => p && p.id === partId);
  if (i >= 0 && typeof parts[i].name === 'string' && parts[i].name.trim() !== '') return parts[i].name;
  return '第 ' + (i >= 0 ? i + 1 : parts.length + 1) + ' 筆';
}

export function newBill(id) {
  return {
    id,
    people: 0,
    total: 0,
    mode: 'even',
    roundTens: false,
    parts: [],
    free: { by: 'all', count: 0, coverers: 1, each: 0 },
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
    if (p.items.length > 0 && isInt(p.people) && p.people > 0) sum += partAmount(p);
  }
  return sum;
}

/**
 * 錯誤的白話說明（一句話）。第二個參數 bill 可省略；有給時會帶入具體數字與第幾筆。
 */
export function errorText(result, bill) {
  if (!result || result.ok || !result.error) return '';
  const N = bill && isInt(bill.people) ? bill.people : null;
  const T = bill && isInt(bill.total) ? bill.total : null;
  const label = bill && result.partId !== undefined ? partLabel(bill, result.partId) : '其中一筆';
  switch (result.error) {
    case 'EMPTY':
      return '還沒填完，請先填人數和總金額。';
    case 'PEOPLE_INVALID':
      return '人數請填 1 到 ' + QUICK_LIMITS.MAX_PEOPLE + ' 之間的整數。';
    case 'TOTAL_INVALID':
      return '總金額請填 1 到 ' + money(LIMITS.MAX_AMOUNT) + ' 元之間的整數。';
    case 'MODE_INVALID':
      return '算法的選項不正確，請重新選一次。';
    case 'PART_PEOPLE_INVALID': {
      const p = bill && Array.isArray(bill.parts) ? bill.parts.find((x) => x && x.id === result.partId) : null;
      if (p && isIntIn(p.people, 1, QUICK_LIMITS.MAX_PEOPLE) && N !== null) {
        return label + '填了 ' + p.people + ' 個人分，但總共只有 ' + N + ' 個人。';
      }
      return label + '的人數不對，請填 1 到總人數之間的整數。';
    }
    case 'PART_AMOUNT_INVALID':
      return label + '的金額有問題，每個金額都要是 1 元以上的整數，請檢查。';
    case 'PARTS_EXCEED_TOTAL':
      if (bill && T !== null) {
        return '另外算的金額加起來（' + money(activePartsSum(bill)) + ' 元）比帳單總額（' + money(T) + ' 元）還多，請檢查金額。';
      }
      return '另外算的金額加起來比帳單總額還多，請檢查金額。';
    case 'FREE_COUNT_INVALID': {
      const c = bill && bill.free ? bill.free.count : null;
      if (N !== null && isInt(c)) {
        return '不用付的人數（' + c + ' 人）要比總人數（' + N + ' 人）少，請減少不用付的人數。';
      }
      return '不用付的人數要比總人數少，請減少不用付的人數。';
    }
    case 'COVER_EXCEEDS': {
      const f = bill && bill.free ? bill.free : null;
      if (N !== null && f && isInt(f.coverers) && isInt(f.each)) {
        const need = f.coverers + f.coverers * f.each;
        return '幫忙付的 ' + f.coverers + ' 人，每人幫 ' + f.each + ' 位付，加上被幫忙付的人，一共要 '
          + need + ' 個人，但總共只有 ' + N + ' 個人，請減少人數。';
      }
      return '幫忙付的人加上被幫忙付的人，比總人數還多，請減少人數。';
    }
    case 'FIXED_COUNT_INVALID': {
      const c = bill && bill.fixed ? bill.fixed.count : null;
      if (N !== null && isInt(c)) {
        return '付固定金額的人數（' + c + ' 人）要比總人數（' + N + ' 人）少，請減少人數。';
      }
      return '付固定金額的人數要比總人數少，請減少人數。';
    }
    case 'FIXED_EXCEEDS': {
      const f = bill && bill.fixed ? bill.fixed : null;
      if (T !== null && f && isInt(f.count) && isInt(f.amount)) {
        return '固定金額加起來（' + f.count + ' 人 × ' + money(f.amount) + ' 元 = ' + money(f.count * f.amount)
          + ' 元）比帳單總額（' + money(T) + ' 元）還多，請檢查金額。';
      }
      return '固定金額加起來比帳單總額還多，請檢查金額。';
    }
    default:
      return '輸入的資料有問題，請檢查。';
  }
}

function diffLine(result) {
  const collected = money(result.collected);
  if (result.diff > 0) return '全部收齊 ' + collected + ' 元，還差 ' + money(result.diff) + ' 元，由付錢的人補。';
  if (result.diff < 0) return '全部收齊 ' + collected + ' 元，比帳單多 ' + money(-result.diff) + ' 元。';
  return '全部收齊 ' + collected + ' 元，剛好。';
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
  const raw = bill.roundTens ? computeBill({ ...bill, roundTens: false }) : result;
  const rounded = bill.roundTens === true;
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

  if (result.mode === 'even' || result.incomplete) {
    if (result.incomplete) {
      lines.push(result.mode === 'free' ? '還沒填不用付的情況，先照平分算。' : '還沒填完這個情況，先照平分算。');
    }
    const each = rowOf(raw, 'each');
    lines.push(money(T) + ' 元由 ' + N + ' 人平分，每人 ' + money(each.amount) + ' 元（小數部分捨去）。');
    roundNote('each', undefined, '每人');
  } else if (result.mode === 'parts') {
    for (const p of result.parts) {
      const part = bill.parts.find((x) => x.id === p.id);
      const itemsTotal = part.items.reduce((s, v) => s + v, 0);
      const label = nameOf(p.id);
      let line = label + '：';
      if (part.items.length > 1) line += part.items.map(money).join(' + ') + ' = ' + money(itemsTotal) + ' 元';
      else line += money(itemsTotal) + ' 元';
      if (part.service) line += '，另加一成服務費後是 ' + money(p.amount) + ' 元';
      const addRaw = rowOf(raw, 'add', p.id).amount;
      line += addRaw === 0 ? '，由 ' + p.people + ' 人分，每人不到 1 元，不用再加。'
        : '，由 ' + p.people + ' 人分，每人再加 ' + money(addRaw) + ' 元。';
      lines.push(line);
      roundNote('add', p.id, label + '每人再加');
    }
    for (const id of result.skipped) lines.push(nameOf(id) + '還沒填完，先不算。');
    const partsSum = result.parts.reduce((s, p) => s + p.amount, 0);
    const baseRaw = rowOf(raw, 'base').amount;
    if (result.parts.length > 0) {
      if (baseRaw === 0) {
        lines.push('另外算的合計 ' + money(partsSum) + ' 元，帳單剩下 ' + money(T - partsSum) + ' 元，'
          + (T - partsSum === 0 ? '' : '由 ' + N + ' 人平分不到 1 元，') + '沒分到任何一筆的人不用付。');
      } else {
        lines.push('另外算的合計 ' + money(partsSum) + ' 元，帳單剩下 ' + money(T - partsSum) + ' 元，由 ' + N
          + ' 人平分，每人先付 ' + money(baseRaw) + ' 元（小數部分捨去）。');
      }
    } else {
      lines.push('沒有另外算的部分，' + money(T) + ' 元由 ' + N + ' 人平分，每人先付 ' + money(baseRaw) + ' 元（小數部分捨去）。');
    }
    roundNote('base', undefined, '每人先付');
    const base = rowOf(result, 'base').amount;
    if (result.combined) {
      const c = result.combined;
      let line = '也就是：有分的 ' + c.withCount + (c.withCount === 1 ? ' 人付 ' : ' 人各付 ') + money(c.withAmount) + ' 元';
      if (c.withoutCount > 0) {
        line += c.withoutAmount === 0 ? '，沒分的 ' + c.withoutCount + ' 人不用付'
          : '，沒分的 ' + c.withoutCount + (c.withoutCount === 1 ? ' 人付 ' : ' 人各付 ') + money(c.withoutAmount) + ' 元';
      }
      lines.push(line + '。');
    } else if (result.parts.length > 1) {
      lines.push(base === 0 ? '每個人把自己有分到的各筆加上去，就是要付的金額；沒分到任何一筆的人不用付。'
        : '每個人把自己有分到的各筆加上去，就是要付的金額；每人先付 ' + money(base) + ' 元是大家都有的部分。');
    }
  } else if (result.mode === 'free') {
    const cover = rowOf(result, 'cover');
    if (!cover) {
      const f = rowOf(result, 'free');
      const each = rowOf(raw, 'each');
      lines.push(f.count + ' 人不用付，' + money(T) + ' 元由其餘 ' + (N - f.count) + ' 人平分，每人 '
        + money(each.amount) + ' 元（小數部分捨去）。');
      roundNote('each', undefined, '每人');
    } else {
      const free = rowOf(result, 'free');
      const each = rowOf(raw, 'each');
      const coverRaw = rowOf(raw, 'cover');
      lines.push('幫忙付的 ' + cover.count + ' 人，一共幫 ' + free.count + ' 位付，這 ' + free.count + ' 人不用付。');
      lines.push('幫忙付的每人出自己加被幫忙的人的份數，其餘每人出 1 份，全部是 ' + N + ' 份。總額乘上自己的份數再除以 '
        + N + '，小數部分捨去：幫忙付的每人 ' + money(coverRaw.amount) + ' 元'
        + (each ? '，其餘每人 ' + money(each.amount) + ' 元' : '') + '。');
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

/**
 * 轉成進階（點人頭）活動。record 是帶 quick 的活動。
 * 成功：{ ok:true, activity }；失敗：{ ok:false, reason }。
 */
export function toAdvanced(record) {
  const bills = record && record.quick && Array.isArray(record.quick.bills) ? record.quick.bills : [];
  let n = 0;
  for (const b of bills) if (b && isInt(b.people) && b.people > n) n = b.people;
  if (n < 1) return { ok: false, reason: '還沒有填人數，不能改用點人頭。' };
  if (n > LIMITS.MAX_MEMBERS) {
    return { ok: false, reason: '進階畫面最多 ' + LIMITS.MAX_MEMBERS + ' 人，這筆有 ' + n + ' 人，不能轉換。' };
  }
  const members = [];
  for (let i = 1; i <= n; i++) members.push({ id: 'm' + i, name: i + ' 號' });
  const share = (k) => members.slice(0, k).map((m) => ({ memberId: m.id, shares: 1 }));
  const expenses = [];
  let seq = 0;
  const add = (title, amount, k) => {
    seq += 1;
    expenses.push({ id: 'e' + seq, title, payerId: 'm1', amount, participants: share(k), fixed: [] });
  };
  bills.forEach((b, i) => {
    if (!b || !isIntIn(b.people, 1, QUICK_LIMITS.MAX_PEOPLE) || !isIntIn(b.total, 1, LIMITS.MAX_AMOUNT)) return;
    const prefix = bills.length > 1 ? '第 ' + (i + 1) + ' 張・' : '';
    if (b.mode !== 'parts') {
      add(prefix + '大家一起分的', b.total, b.people);
      return;
    }
    const active = [];
    for (const p of Array.isArray(b.parts) ? b.parts : []) {
      if (!p || !Array.isArray(p.items) || !p.items.every((v) => isIntIn(v, 1, LIMITS.MAX_AMOUNT))) continue;
      const amount = partAmount(p);
      if (amount < 1 || !isIntIn(p.people, 1, QUICK_LIMITS.MAX_PEOPLE)) continue;
      active.push({ id: p.id, amount, people: Math.min(p.people, b.people) });
    }
    const rest = b.total - active.reduce((s, a) => s + a.amount, 0);
    if (rest > 0) add(prefix + '大家一起分的', rest, b.people);
    for (const a of active) add(prefix + partLabel(b, a.id), a.amount, a.people);
  });
  if (expenses.length === 0) return { ok: false, reason: '還沒有可以轉換的帳單，請先填好人數和總金額。' };
  return {
    ok: true,
    activity: { id: record.id, title: record.title, createdAt: record.createdAt, members, expenses },
  };
}
