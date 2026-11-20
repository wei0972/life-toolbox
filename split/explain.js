/*
 * 把計算結果轉成給一般人看的白話說明（純函式，不碰畫面、不載入任何東西）。
 * 金額一律顯示千分位，例如 1,576。
 */

export function formatMoney(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n);
  const neg = n < 0;
  const s = String(Math.abs(Math.trunc(n)));
  const body = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg ? '-' + body : body;
}

const ERROR_TEXT = {
  AMOUNT_INVALID: '金額要是 1 元以上的整數，而且不能超過 99,999,999 元。',
  PAYER_MISSING: '請選一位付款人，而且他要在成員名單內。',
  NO_SHARERS: '還沒有指定誰要分攤這筆，請至少選一位。',
  MEMBER_UNKNOWN: '名單裡有不在成員名單中的人，請重新選擇。',
  MEMBER_DUPLICATED: '同一個人在這筆裡出現了不只一次，請只留一次。',
  SHARES_INVALID: '份數要是 1 以上的整數（最多 1,000）。',
  FIXED_INVALID: '固定金額要是 0 以上的整數，不能是負數或小數。',
  FIXED_EXCEEDS: '固定金額加起來比這筆支出還多，所以先不計算，請檢查金額。',
  FIXED_NOT_EQUAL_TOTAL: '所有人都設了固定金額，但加起來不等於這筆支出，所以先不計算，請檢查金額。',
};

function nameOf(members, id) {
  for (const m of Array.isArray(members) ? members : []) {
    if (m && m.id === id) return String(m.name);
  }
  return '某位成員';
}

function money(n) {
  return formatMoney(n) + ' 元';
}

function floorDiv(a, b) {
  let q = Math.floor(a / b);
  let r = a - q * b;
  while (r < 0) { q -= 1; r += b; }
  while (r >= b) { q += 1; r -= b; }
  return q;
}

/**
 * 逐行說明一筆支出怎麼算。
 * expense：原始支出；result：computeExpense 的結果；members：[{ id, name }]
 */
export function explainExpense(expense, result, members) {
  const lines = [];
  const title = expense && typeof expense.title === 'string' && expense.title.trim() !== '' ? '「' + expense.title.trim() + '」' : '這筆支出';
  if (!result || result.ok !== true) {
    lines.push(title + '目前無法計算。');
    const code = result && result.error;
    lines.push(Object.prototype.hasOwnProperty.call(ERROR_TEXT, code) ? ERROR_TEXT[code] : '資料有誤，請檢查後再試。');
    return lines;
  }

  const payer = nameOf(members, expense.payerId);
  const participants = Array.isArray(expense.participants) ? expense.participants : [];
  const fixed = Array.isArray(expense.fixed) ? expense.fixed : [];

  lines.push(title + '一共 ' + money(expense.amount) + '，由 ' + payer + ' 先付。');

  if (fixed.length > 0) {
    const parts = fixed.map((f) => nameOf(members, f.memberId) + ' ' + money(f.amount));
    const fixedSum = expense.amount - result.rest;
    lines.push('固定金額：' + parts.join('、') + '，合計 ' + money(fixedSum) + '，先從總額扣掉。');
    if (participants.length > 0) {
      lines.push('扣掉之後還剩 ' + money(result.rest) + '，由其餘的人分攤。');
    } else {
      lines.push('每個人都是固定金額，剛好等於這筆的總額，不需要再分攤。');
    }
  }

  if (participants.length > 0) {
    const names = participants.map((p) => nameOf(members, p.memberId));
    const allEqual = participants.every((p) => p.shares === participants[0].shares);
    const each = participants.map((p) => floorDiv(result.rest * p.shares, result.totalShares));
    if (allEqual) {
      lines.push(
        money(result.rest) + ' 由 ' + names.join('、') + ' 共 ' + participants.length + ' 人平均分，' +
          '每人 ' + money(each[0]) + '（除不盡的部分先捨去零頭）。'
      );
    } else {
      const parts = participants.map((p, i) => names[i] + ' ' + p.shares + ' 份');
      lines.push('依份數分攤：' + parts.join('、') + '，共 ' + result.totalShares + ' 份。');
      lines.push(
        money(result.rest) + ' 依份數分給每個人：' +
          participants.map((p, i) => names[i] + ' ' + money(each[i])).join('、') + '（各自捨去零頭）。'
      );
    }

    if (result.remainder > 0) {
      const payerIn = participants.some((p) => p.memberId === expense.payerId);
      if (payerIn) {
        lines.push('除不盡的零頭 ' + money(result.remainder) + '，由付款人 ' + payer + ' 吸收，所以 ' + payer + ' 這筆要分攤 ' + money(result.owed[expense.payerId]) + '。');
      } else {
        lines.push('除不盡的零頭 ' + money(result.remainder) + '，由付款人 ' + payer + ' 吸收（' + payer + ' 沒有參與分攤，但零頭仍由他負擔）。');
      }
    } else {
      lines.push('剛好除盡，沒有零頭。');
    }
  }

  const ownIds = Object.keys(result.owed);
  const sum = ownIds.reduce((s, id) => s + result.owed[id], 0);
  lines.push('每個人這筆要分攤：' + ownIds.map((id) => nameOf(members, id) + ' ' + money(result.owed[id])).join('、') + '，合計 ' + money(sum) + '。');
  return lines;
}
