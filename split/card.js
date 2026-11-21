/*
 * 結算卡：用 canvas 直接畫成圖片（收據造型，奶油色系）。寬固定 1080 像素。
 * 精簡版 1080x1350（內容太多時自動縮小字級、再不夠才加高）；明細版高度依內容增加。
 */
import { formatMoney } from './explain.js?v=20261121093330';
import { partLabel } from './quick.js?v=20261121093330';
import { BRAND } from '../shared/shell.js?v=20261121093330';

export const CARD_WIDTH = 1080;
export const COMPACT_HEIGHT = 1350;

const SANS = '"Microsoft JhengHei","Noto Sans TC","PingFang TC","Heiti TC","Hiragino Sans GB",sans-serif';
const MONO = '"Cascadia Mono",Consolas,"SF Mono",Menlo,"Courier New",' + SANS;
const C = {
  bg: '#EFE0C4', paper: '#FFF8EA', ink: '#4E3B2C', muted: '#7A634F',
  mint: '#A8DCD1', stamp: '#B33A2B',
};
const PAPER_X = 64;
const PAPER_W = CARD_WIDTH - PAPER_X * 2;
const L = 124;
const R = CARD_WIDTH - 124;
const W = R - L;
const TOOTH = 12;
const FOOT_H = 120;

export async function fontsReady() {
  try {
    if (document.fonts) {
      await document.fonts.ready;
      await Promise.all([
        document.fonts.load('700 40px ' + SANS, '結算已付'),
        document.fonts.load('700 40px ' + MONO, '0123456789'),
      ]);
    }
  } catch (e) { /* 系統字型本來就能用，失敗也不影響 */ }
}

/* ---------- 資料整理 ---------- */

export function buildModel(activity, result) {
  const name = new Map(activity.members.map((m) => [m.id, m.name]));
  const nm = (id) => name.get(id) || '某位成員';
  const each = result.perMember.map((p) => ({ name: nm(p.memberId), amount: p.owed }));
  const transfers = result.transfers.map((t) => ({ from: nm(t.from), to: nm(t.to), amount: t.amount }));
  const expenses = [];
  activity.expenses.forEach((e, i) => {
    const r = result.expenses[i];
    if (!r || !r.ok) return;
    const parts = [];
    for (const m of activity.members) {
      if (Object.prototype.hasOwnProperty.call(r.owed, m.id)) parts.push({ name: m.name, amount: r.owed[m.id] });
    }
    expenses.push({ title: e.title.trim() || '未命名支出', amount: e.amount, payer: nm(e.payerId), parts });
  });
  return { title: activity.title, date: activity.createdAt, total: result.total, each, transfers, expenses };
}

/* ---------- 繪圖小工具 ---------- */

function font(ctx, weight, size, family) {
  ctx.font = weight + ' ' + Math.max(8, Math.round(size)) + 'px ' + family;
}

function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(chars.slice(0, mid).join('') + '…').width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join('') + '…';
}

function spaced(ctx, px) {
  if ('letterSpacing' in ctx) ctx.letterSpacing = px + 'px';
}

function hline(ctx, x1, x2, y, dash, width, alpha) {
  ctx.save();
  ctx.strokeStyle = C.ink;
  ctx.globalAlpha = alpha === undefined ? 1 : alpha;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
  ctx.restore();
}

const dashed = (ctx, y) => hline(ctx, L, R, y, [14, 10], 3, 0.85);
const dotted = (ctx, x1, x2, y) => hline(ctx, x1, x2, y, [2, 7], 3, 0.55);

function arrow(ctx, x, y, w, size) {
  ctx.save();
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = Math.max(3, size * 0.07);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.moveTo(x + w - size * 0.28, y - size * 0.28);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w - size * 0.28, y + size * 0.28);
  ctx.stroke();
  ctx.restore();
}

function sectionHead(ctx, label, y, draw) {
  if (draw) {
    font(ctx, 700, 28, SANS);
    spaced(ctx, 6);
    ctx.fillStyle = C.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const cx = CARD_WIDTH / 2;
    ctx.fillText(label, cx + 3, y + 22);
    const tw = ctx.measureText(label).width;
    spaced(ctx, 0);
    dotted(ctx, L, cx - tw / 2 - 22, y + 11);
    dotted(ctx, cx + tw / 2 + 22, R, y + 11);
    ctx.textAlign = 'left';
  }
  return y + 56;
}

function wrapTokens(ctx, tokens, maxW) {
  const lines = [];
  let cur = '';
  for (const t of tokens) {
    const next = cur ? cur + '　' + t : t;
    if (cur && ctx.measureText(next).width > maxW) {
      lines.push(cur);
      cur = t;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/* ---------- 版面（measure 與 draw 共用同一套計算） ---------- */

function layout(ctx, m, kind, s, extraGap, H, draw) {
  const gap = 36 * s + extraGap;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  spaced(ctx, 0);
  const top = PAPER_X;
  let y = top + 64;

  // 標頭（固定大小）
  if (draw) {
    ctx.fillStyle = C.muted;
    font(ctx, 600, 30, SANS);
    ctx.textAlign = 'center';
    spaced(ctx, 12);
    ctx.fillText('結算', CARD_WIDTH / 2 + 6, y + 26);
    spaced(ctx, 0);

    let size = 68;
    font(ctx, 800, size, SANS);
    while (size > 42 && ctx.measureText(m.title).width > 600) {
      size -= 4;
      font(ctx, 800, size, SANS);
    }
    ctx.fillStyle = C.ink;
    ctx.fillText(fit(ctx, m.title, 600), CARD_WIDTH / 2, y + 138);

    ctx.fillStyle = C.muted;
    font(ctx, 600, 30, MONO);
    ctx.fillText(m.date, CARD_WIDTH / 2, y + 190);

    ctx.textAlign = 'left';
    ctx.fillStyle = C.ink;
    font(ctx, 800, 36, SANS);
    ctx.fillText('總金額', L, y + 282);
    ctx.textAlign = 'right';
    font(ctx, 800, 64, MONO);
    ctx.fillText(formatMoney(m.total), R, y + 282);
    ctx.textAlign = 'left';
  }
  y += 322;
  if (draw) dashed(ctx, y);
  y += gap;

  // 誰給誰多少
  y = sectionHead(ctx, '誰給誰多少', y, draw);
  if (m.transfers.length === 0) {
    const h = 250 * Math.min(1, s + 0.2);
    if (draw) {
      const cx = CARD_WIDTH / 2;
      const cy = y + h * 0.3;
      ctx.fillStyle = C.mint;
      ctx.beginPath();
      ctx.arc(cx, cy, 52, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = 9;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(cx - 22, cy + 2);
      ctx.lineTo(cx - 6, cy + 18);
      ctx.lineTo(cx + 24, cy - 16);
      ctx.stroke();
      ctx.fillStyle = C.ink;
      ctx.textAlign = 'center';
      font(ctx, 800, 58, SANS);
      ctx.fillText('大家都結清了', cx, y + h * 0.3 + 128);
      font(ctx, 600, 30, SANS);
      ctx.fillStyle = C.muted;
      ctx.fillText('不用再轉帳給誰', cx, y + h * 0.3 + 178);
      ctx.textAlign = 'left';
    }
    y += h * 0.3 + 200;
  } else {
    const rowH = 100 * s;
    const nameSize = 46 * s;
    const amtSize = 62 * s;
    const arrowW = 76 * s;
    m.transfers.forEach((t, i) => {
      if (draw) {
        const base = y + rowH * 0.66;
        font(ctx, 800, amtSize, MONO);
        const amtText = formatMoney(t.amount);
        const amtW = ctx.measureText(amtText).width;
        ctx.fillStyle = C.ink;
        ctx.textAlign = 'right';
        ctx.fillText(amtText, R, base);
        ctx.textAlign = 'left';
        font(ctx, 800, nameSize, SANS);
        const avail = (W - amtW - arrowW - 70 * s) / 2;
        const from = fit(ctx, t.from, avail);
        ctx.fillText(from, L, base);
        const x2 = L + ctx.measureText(from).width + 22 * s;
        arrow(ctx, x2, base - nameSize * 0.32, arrowW, nameSize);
        ctx.fillText(fit(ctx, t.to, avail), x2 + arrowW + 22 * s, base);
        if (i < m.transfers.length - 1) dotted(ctx, L, R, y + rowH - 2);
      }
      y += rowH;
    });
  }
  y += gap;
  if (draw) dashed(ctx, y - gap / 2 - 2);

  // 每人該付
  y = sectionHead(ctx, '每人該付', y, draw);
  {
    const rowH = 62 * s;
    const colGap = 64;
    const colW = (W - colGap) / 2;
    const rows = Math.ceil(m.each.length / 2);
    if (draw) {
      m.each.forEach((p, i) => {
        const col = i % 2;
        const row = (i / 2) | 0;
        const x1 = L + col * (colW + colGap);
        const x2 = x1 + colW;
        const base = y + row * rowH + rowH * 0.68;
        ctx.fillStyle = C.ink;
        font(ctx, 600, 33 * s, MONO);
        const a = formatMoney(p.amount);
        const aw = ctx.measureText(a).width;
        ctx.textAlign = 'right';
        font(ctx, 800, 36 * s, MONO);
        ctx.fillText(a, x2, base);
        ctx.textAlign = 'left';
        font(ctx, 600, 33 * s, SANS);
        ctx.fillText(fit(ctx, p.name, colW - aw - 70 * s), x1, base);
        dotted(ctx, x1, x2, y + row * rowH + rowH - 3);
      });
    }
    y += rows * rowH;
  }

  // 明細版：每筆支出
  if (kind === 'detail' && m.expenses.length > 0) {
    y += gap;
    if (draw) dashed(ctx, y - gap / 2);
    y = sectionHead(ctx, '每筆支出', y, draw);
    m.expenses.forEach((e, i) => {
      const amtText = formatMoney(e.amount);
      if (draw) {
        font(ctx, 800, 38, MONO);
        const aw = ctx.measureText(amtText).width;
        ctx.textAlign = 'right';
        ctx.fillStyle = C.ink;
        ctx.fillText(amtText, R, y + 34);
        ctx.textAlign = 'left';
        font(ctx, 800, 36, SANS);
        ctx.fillText(fit(ctx, e.title, W - aw - 30), L, y + 34);
      }
      y += 48;
      font(ctx, 600, 27, SANS);
      const lines = [e.payer + ' 先付，每人分攤：'];
      const words = e.parts.map((p) => fit(ctx, p.name, 220) + ' ' + formatMoney(p.amount));
      const wrapped = wrapTokens(ctx, words, W);
      if (draw) {
        ctx.fillStyle = C.muted;
        lines.forEach((ln) => { ctx.fillText(ln, L, y + 28); y += 38; });
        wrapped.forEach((ln) => { ctx.fillText(ln, L, y + 28); y += 38; });
      } else {
        y += 38 * (lines.length + wrapped.length);
      }
      y += 14;
      if (draw && i < m.expenses.length - 1) dotted(ctx, L, R, y);
      y += 16;
    });
  }
  return y;
}

function drawPaper(ctx, H) {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, CARD_WIDTH, H);
  const n = 40;
  const tw = PAPER_W / n;
  const t = PAPER_X;
  const b = H - PAPER_X;
  ctx.save();
  ctx.shadowColor = 'rgba(78,59,44,.28)';
  ctx.shadowBlur = 26;
  ctx.shadowOffsetY = 10;
  ctx.fillStyle = C.paper;
  ctx.beginPath();
  ctx.moveTo(PAPER_X, t);
  for (let i = 0; i < n; i++) {
    ctx.lineTo(PAPER_X + i * tw + tw / 2, t - TOOTH);
    ctx.lineTo(PAPER_X + (i + 1) * tw, t);
  }
  ctx.lineTo(PAPER_X + PAPER_W, b);
  for (let i = n; i > 0; i--) {
    ctx.lineTo(PAPER_X + i * tw - tw / 2, b + TOOTH);
    ctx.lineTo(PAPER_X + (i - 1) * tw, b);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawStamp(ctx) {
  ctx.save();
  ctx.translate(858, 150);
  ctx.rotate(-0.21);
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = C.stamp;
  ctx.fillStyle = C.stamp;
  const w = 214;
  const h = 84;
  const rr = (x, y, ww, hh, r) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + ww, y, x + ww, y + hh, r);
    ctx.arcTo(x + ww, y + hh, x, y + hh, r);
    ctx.arcTo(x, y + hh, x, y, r);
    ctx.arcTo(x, y, x + ww, y, r);
    ctx.closePath();
  };
  ctx.lineWidth = 5;
  rr(-w / 2, -h / 2, w, h, 10);
  ctx.stroke();
  ctx.lineWidth = 2.5;
  rr(-w / 2 + 9, -h / 2 + 9, w - 18, h - 18, 6);
  ctx.stroke();
  font(ctx, 800, 44, SANS);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  spaced(ctx, 6);
  ctx.fillText('已結算', 3, 3);
  spaced(ctx, 0);
  ctx.restore();
}

/**
 * 畫結算卡。kind：'compact'（精簡版）或 'detail'（明細版）。
 * 回傳 canvas（寬 1080）。呼叫前請先 await fontsReady()。
 */
export function renderCard(activity, result, kind) {
  const m = buildModel(activity, result);
  const mc = document.createElement('canvas');
  mc.width = CARD_WIDTH;
  mc.height = 100;
  const mctx = mc.getContext('2d');
  const bottomPad = PAPER_X + TOOTH + 10;
  const gapsCount = kind === 'detail' && m.expenses.length > 0 ? 4 : 3;

  let s = 1;
  let H = COMPACT_HEIGHT;
  let extra = 0;
  if (kind === 'compact') {
    s = 1.25;
    let end = layout(mctx, m, kind, s, 0, H, false);
    while (s > 0.55 && end + FOOT_H + bottomPad > H) {
      s = Math.round((s - 0.05) * 100) / 100;
      end = layout(mctx, m, kind, s, 0, H, false);
    }
    if (end + FOOT_H + bottomPad > H) H = Math.ceil(end + FOOT_H + bottomPad);
    extra = Math.min(90, Math.max(0, (H - bottomPad - FOOT_H - end) / gapsCount));
  } else {
    const end = layout(mctx, m, kind, 1, 0, H, false);
    H = Math.max(COMPACT_HEIGHT, Math.ceil(end + FOOT_H + bottomPad));
    extra = Math.min(60, Math.max(0, (H - bottomPad - FOOT_H - end) / gapsCount));
  }

  const canvas = document.createElement('canvas');
  canvas.width = CARD_WIDTH;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  drawPaper(ctx, H);
  layout(ctx, m, kind, s, extra, H, true);
  drawStamp(ctx);

  // 頁尾：虛線與品牌名稱
  const fy = H - bottomPad - FOOT_H + 24;
  dashed(ctx, fy);
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  font(ctx, 700, 30, SANS);
  spaced(ctx, 4);
  ctx.fillText(BRAND, CARD_WIDTH / 2 + 2, fy + 62);
  spaced(ctx, 0);
  return canvas;
}

/* ---------- 現場算錢（第二版）的結算卡 ---------- */

const money = formatMoney;

/** 還沒填完、算不出這個情況：不可把平分金額當成答案顯示或印出 */
export function quickWaiting(res) {
  if (!res || !res.ok) return false;
  if (res.incomplete) return true;
  return res.mode === 'parts' && Array.isArray(res.parts) && res.parts.length === 0;
}

const eachWord = (n) => (n === 1 ? '付' : '各付');

/**
 * 一張帳單的結果文字，畫面與結算卡共用。
 * 回傳 { rows:[{role,count,amount,partId?,label,big}], notes:[{kind,text}], diff:{text,diff} }；金額 0 的列 amount 為 null（寫「不用付」）
 */
export function quickLines(bill, res) {
  const rows = [];
  const coverMode = res.rows.some((r) => r.role === 'cover');
  const hasParts = !!(res.parts && res.parts.length > 0);
  for (const r of res.rows) {
    const zero = r.amount === 0 && r.role !== 'free';
    let label;
    if (r.role === 'each') {
      if (res.mode === 'even' || res.incomplete) label = zero ? '每人不用付' : '每人';
      else if (res.mode === 'free' && !coverMode) label = zero ? r.count + ' 人不用付' : r.count + ' 人' + eachWord(r.count);
      else label = zero ? '其餘 ' + r.count + ' 人不用付' : '其餘 ' + r.count + ' 人' + eachWord(r.count);
    } else if (r.role === 'base') {
      label = zero ? '沒分到任何一筆的人不用付' : hasParts ? '每人先付' : '每人';
    } else if (r.role === 'add') {
      label = '有分' + partLabel(bill, r.partId) + '的 ' + r.count + ' 人，' + (zero ? '不用再加' : '每人再加');
    } else if (r.role === 'cover') {
      label = zero ? '幫忙付的 ' + r.count + ' 人不用付' : '幫忙付的 ' + r.count + ' 人' + eachWord(r.count);
    } else if (r.role === 'free') {
      label = r.count + ' 人不用付';
    } else {
      label = zero ? r.count + ' 人不用付' : r.count + ' 人' + eachWord(r.count);
    }
    rows.push({
      role: r.role, count: r.count, amount: r.role === 'free' || zero ? null : r.amount,
      partId: r.partId, label, big: res.rows.length === 1,
    });
  }
  const notes = [];
  if (res.combined) {
    const c = res.combined;
    let t = '也就是：有分的 ' + c.withCount + ' 人' + eachWord(c.withCount) + ' ' + money(c.withAmount) + ' 元';
    if (c.withoutCount > 0) {
      t += c.withoutAmount === 0 ? '，沒分的 ' + c.withoutCount + ' 人不用付'
        : '，沒分的 ' + c.withoutCount + ' 人' + eachWord(c.withoutCount) + ' ' + money(c.withoutAmount) + ' 元';
    }
    notes.push({ kind: 'combined', text: t });
  } else if (res.parts && res.parts.length >= 2) {
    notes.push({ kind: 'multi', text: '每個人把自己有分到的加上去，就是要付的金額' });
  }
  for (const id of res.skipped || []) notes.push({ kind: 'skipped', text: partLabel(bill, id) + '還沒填完，先不算' });
  if (res.incomplete) notes.push({ kind: 'incomplete', text: '還沒填完，先照平分算' });
  let dt = '全部收齊 ' + money(res.collected) + ' 元，';
  if (res.diff > 0) dt += '還差 ' + money(res.diff) + ' 元，由付錢的人補';
  else if (res.diff < 0) dt += '比帳單多 ' + money(-res.diff) + ' 元';
  else dt += '剛好';
  return { rows, notes, diff: { text: dt, diff: res.diff } };
}

function wrapChars(ctx, text, maxW) {
  const lines = [];
  let cur = '';
  for (const ch of Array.from(text)) {
    if (cur && ctx.measureText(cur + ch).width > maxW) {
      lines.push(cur);
      cur = ch;
    } else cur += ch;
  }
  if (cur) lines.push(cur);
  return lines;
}

const Q_FOOT_H = 170;

function qlayout(ctx, rec, items, sum, draw) {
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  spaced(ctx, 0);
  let y = PAPER_X + 64;
  if (draw) {
    ctx.fillStyle = C.muted;
    font(ctx, 600, 30, SANS);
    ctx.textAlign = 'center';
    spaced(ctx, 12);
    ctx.fillText('結算', CARD_WIDTH / 2 + 6, y + 26);
    spaced(ctx, 0);
    let size = 68;
    font(ctx, 800, size, SANS);
    while (size > 42 && ctx.measureText(rec.title).width > 600) {
      size -= 4;
      font(ctx, 800, size, SANS);
    }
    ctx.fillStyle = C.ink;
    ctx.fillText(fit(ctx, rec.title, 600), CARD_WIDTH / 2, y + 138);
    ctx.textAlign = 'left';
  }
  y += 190;
  if (draw) dashed(ctx, y);
  y += 40;

  items.forEach((it, idx) => {
    const many = items.length > 1;
    y = sectionHead(ctx, many ? '第 ' + it.no + ' 張帳單' : '這筆帳單', y, draw);
    if (draw) {
      ctx.fillStyle = C.ink;
      ctx.textAlign = 'left';
      font(ctx, 800, 36, SANS);
      ctx.fillText(it.res.people + ' 人，總金額', L, y + 40);
      ctx.textAlign = 'right';
      font(ctx, 800, 56, MONO);
      ctx.fillText(formatMoney(it.res.total), R, y + 44);
      ctx.textAlign = 'left';
    }
    y += 84;
    if (it.waiting) {
      if (draw) {
        ctx.fillStyle = C.stamp;
        ctx.textAlign = 'left';
        font(ctx, 800, 44, SANS);
        ctx.fillText('還沒填完', L, y + 52);
        font(ctx, 600, 27, SANS);
        ctx.fillStyle = C.muted;
        ctx.fillText('這張帳單還算不出每人要付多少', L, y + 96);
      }
      y += 126;
      y += 22;
      if (idx < items.length - 1 || sum) {
        if (draw) dashed(ctx, y);
        y += 40;
      }
      return;
    }
    const lines = it.lines;
    lines.rows.forEach((r, i) => {
      const amtText = r.amount === null ? '' : formatMoney(r.amount);
      const size = r.big ? 76 : 48;
      font(ctx, 800, size, MONO);
      const aw = r.amount === null ? 0 : ctx.measureText(amtText).width + 56;
      const lblSize = r.big ? 44 : 33;
      font(ctx, 700, lblSize, SANS);
      const label = fit(ctx, r.label, W - aw - 24);
      const rowH = r.big ? 112 : 78;
      if (draw) {
        ctx.fillStyle = C.ink;
        ctx.textAlign = 'left';
        font(ctx, 700, lblSize, SANS);
        ctx.fillText(label, L, y + rowH * 0.66);
        if (r.amount !== null) {
          ctx.textAlign = 'right';
          font(ctx, 700, 30, SANS);
          ctx.fillText('元', R, y + rowH * 0.66);
          font(ctx, 800, size, MONO);
          ctx.fillText(amtText, R - 46, y + rowH * 0.66);
          ctx.textAlign = 'left';
        }
        if (i < lines.rows.length - 1) dotted(ctx, L, R, y + rowH - 2);
      }
      y += rowH;
    });
    const notes = lines.notes.concat([{ kind: 'diff', text: lines.diff.text }]);
    y += 10;
    for (const n of notes) {
      font(ctx, 600, 27, SANS);
      for (const ln of wrapChars(ctx, n.text, W)) {
        if (draw) {
          ctx.fillStyle = C.muted;
          font(ctx, 600, 27, SANS);
          ctx.fillText(ln, L, y + 26);
        }
        y += 38;
      }
    }
    y += 22;
    if (idx < items.length - 1 || sum) {
      if (draw) dashed(ctx, y);
      y += 40;
    }
  });

  if (sum) {
    y = sectionHead(ctx, '每人合計', y, draw);
    if (draw) {
      ctx.fillStyle = C.ink;
      ctx.textAlign = 'left';
      font(ctx, 800, 40, SANS);
      ctx.fillText(sum.people + ' 人，每人', L, y + 56);
      ctx.textAlign = 'right';
      font(ctx, 700, 34, SANS);
      ctx.fillText('元', R, y + 56);
      font(ctx, 800, 80, MONO);
      ctx.fillText(formatMoney(sum.each), R - 50, y + 56);
      ctx.textAlign = 'left';
    }
    y += 100;
  }
  return y;
}

/**
 * 畫現場算錢的結算卡：收據造型，寬 1080、高至少 1350，內容多就加高。
 * record：帶 quick 的活動（用到 title）；computed：computeRecord(record.quick) 的結果。
 * 呼叫前請先 await fontsReady()。
 */
export function renderQuickCard(record, computed) {
  const bills = record && record.quick && Array.isArray(record.quick.bills) ? record.quick.bills : [];
  const items = [];
  computed.bills.forEach((res, i) => {
    if (res && res.ok) {
      if (quickWaiting(res)) items.push({ no: i + 1, res, waiting: true, lines: null });
      else items.push({ no: i + 1, res, waiting: false, lines: quickLines(bills[i], res) });
    }
  });
  const sum = computed.sum && items.length >= 2 ? computed.sum : null;
  const rec = { title: String((record && record.title) || '') };
  const mc = document.createElement('canvas');
  mc.width = CARD_WIDTH;
  mc.height = 100;
  const end = qlayout(mc.getContext('2d'), rec, items, sum, false);
  const bottomPad = PAPER_X + TOOTH + 10;
  const H = Math.max(COMPACT_HEIGHT, Math.ceil(end + Q_FOOT_H + bottomPad));
  const canvas = document.createElement('canvas');
  canvas.width = CARD_WIDTH;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  drawPaper(ctx, H);
  qlayout(ctx, rec, items, sum, true);
  drawStamp(ctx);
  const fy = H - bottomPad - Q_FOOT_H + 24;
  dashed(ctx, fy);
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  font(ctx, 700, 30, SANS);
  spaced(ctx, 4);
  ctx.fillText(BRAND, CARD_WIDTH / 2 + 2, fy + 62);
  spaced(ctx, 0);
  font(ctx, 600, 26, SANS);
  ctx.fillText('不用下載、不用登入', CARD_WIDTH / 2, fy + 106);
  return canvas;
}

export function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png'))), 'image/png');
  });
}
