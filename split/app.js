/* 多人分帳：操作介面 */
import { computeActivity, computeExpense, validateActivity, LIMITS, serializeExport, parseImport } from './core.js?v=20261121222228';
import { explainExpense, formatMoney } from './explain.js?v=20261121222228';
import * as store from './store.js?v=20261121222228';
import * as card from './card.js?v=20261121222228';
import {
  computeRecord, computeBill, errorText, explainBill, partLabel, partAmount, newBill, newPart,
  resultRows, compactLine, echoLine, collectedLine, rosterName, QUICK_LIMITS,
} from './quick.js?v=20261121222228';
import { BRAND } from '../shared/shell.js?v=20261121222228';

document.title = '多人分帳｜' + BRAND;

const $ = (s, r) => (r || document).querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = formatMoney;
const first = (s) => Array.from(String(s))[0] || '?';

let st = store.emptyState();
let storage = null;
let storageOk = false;
let baseline = new Map();
let blocked = false; // 有讀不出來又無法留存的資料時，不寫入儲存，保留原樣
let syncNotice = '';
let syncPending = false;
const orphans = []; // 別的分頁已刪掉、但這個分頁又改過的活動：等使用者決定留不留
const revived = []; // 這個分頁刪掉、但別的分頁在這之後又改過的活動：等使用者決定還要不要刪（儲存中先保留別處的版本）
let asking = false;
const notices = [];
const ui = { open: new Set(), cardKind: 'compact', importMsg: '', view: 'quick', recId: null };
const SESSION_KEY = 'lt_split_current';
let draft = null; // 還沒存成紀錄的空白計算
let pendingFocus = null;
let focusApplied = false;
let lastKey = null;
const mq = window.matchMedia('(min-width:900px)');

const cur = () => st.activities.find((a) => a.id === ui.recId) || null;
const nameOf = (act, id) => { const m = act.members.find((x) => x.id === id); return m ? m.name : '某位成員'; };

/* ---------- 儲存 ---------- */

function lostNotice(n) {
  return '有 ' + n + ' 筆讀不出來的資料，因為瀏覽器的儲存空間不夠，沒辦法另外留存。為了不弄丟它們，這次開啟期間的變更不會被儲存，請先到最下面「備份」匯出目前的活動。';
}

function persist() {
  if (!storage || blocked) { storageOk = false; return; }
  const r = store.saveMerged(storage, st, baseline);
  if (r.ok) {
    for (const id of r.deletedElsewhere || []) {
      const mine = st.activities.find((a) => a.id === id);
      if (mine && !orphans.some((o) => o.id === id)) orphans.push(JSON.parse(JSON.stringify(mine)));
    }
    for (const id of r.modifiedElsewhere || []) {
      const theirs = r.state.activities.find((a) => a.id === id);
      if (theirs && !revived.some((o) => o.id === id)) revived.push({ id, title: theirs.title });
    }
    st = r.state;
    baseline = store.makeBaseline(st);
    storageOk = true;
    if (r.conflicts.length > 0) syncNotice = '另一個分頁也更新過同一個活動，已用你這次的內容為準。';
  } else {
    storageOk = false;
    if (r.lost > 0) { blocked = true; notices.push(lostNotice(r.lost)); }
  }
}

function commit(focus) {
  ui.importMsg = '';
  syncNotice = '';
  persist();
  if (focus) pendingFocus = focus;
  render();
  askOrphans();
}

// 逐一詢問；有別的對話框開著就先不問，等它關閉後再問
async function askOrphans() {
  if (asking || (orphans.length === 0 && revived.length === 0) || anyDialogOpen()) return;
  asking = true;
  try {
    while ((orphans.length > 0 || revived.length > 0) && !anyDialogOpen()) {
      if (orphans.length === 0) {
        const rv = revived[0];
        const d2 = $('#dlgRevive');
        $('#drTitle').textContent = '「' + rv.title + '」在另一個分頁又改過';
        $('#drBody').textContent = '你剛剛刪掉了這個活動，但另一個分頁在這之後改過它。要還是刪除，還是保留另一個分頁的修改？';
        d2.guard = () => {};
        let v2;
        try { v2 = await showModal(d2, $('#drKeep')); } finally { d2.guard = null; }
        revived.shift();
        if (v2 === 'delete') {
          st.activities = st.activities.filter((a) => a.id !== rv.id);
          if (ui.recId === rv.id) setCurrent(null);
          ui.importMsg = '';
          syncNotice = '';
          persist();
          pendingFocus = '#main';
          render();
          toast('已刪除這個活動', 0, true);
        } else {
          render();
          toast('已保留另一個分頁的修改', 0, true);
        }
        continue;
      }
      const o = orphans[0];
      const d = $('#dlgGone');
      $('#dgTitle').textContent = '「' + o.title + '」已被刪除';
      $('#dgBody').textContent = '這個活動已經在另一個分頁被刪掉了，但你在這個分頁還改過它。要把你手上這份留下來嗎？';
      d.guard = () => {}; // 一定要選一個，按 Esc 不會關掉
      let v;
      try { v = await showModal(d, $('#dgKeep')); } finally { d.guard = null; }
      orphans.shift();
      if (v === 'keep') {
        const used = new Set(st.activities.map((a) => a.id));
        o.id = store.newId('a', used);
        st.activities.push(o);
        setCurrent(o.id);
        ui.importMsg = '';
        syncNotice = '';
        persist();
        pendingFocus = '#main';
        render();
        toast('已把這份存成新的活動', 0, true);
      } else {
        render();
        toast('已放掉你在這個分頁改的那份', 0, true);
      }
    }
  } finally { asking = false; }
}

let toastTimer = 0;
function toast(msg, ms, force) {
  // 還有「已被刪除」之類的詢問要問時，先不跳「已更新」這類提示，免得和詢問互相矛盾
  if (!force && (orphans.length > 0 || revived.length > 0)) return;
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms || 3200);
}

/* ---------- 對話框 ---------- */

const modalStack = []; // 目前開著的對話框，最後一個在最上面

function showModal(dlg, focusEl) {
  return new Promise((resolve) => {
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      const i = modalStack.lastIndexOf(dlg);
      if (i >= 0) modalStack.splice(i, 1);
      resolve(dlg.returnValue);
    };
    dlg.addEventListener('close', onClose);
    dlg.returnValue = '';
    modalStack.push(dlg);
    dlg.showModal();
    if (focusEl) { focusEl.focus(); if (focusEl.select) focusEl.select(); }
  });
}

// 最上面那個對話框有「關閉前要先確認」的規則時，Esc 一律由我們處理。
// 瀏覽器對連續按的 Esc 會讓第二次起的取消事件不能被攔下，所以不能只靠 cancel 事件。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.isComposing) return;
  // 剛關掉但 close 事件還沒處理完的對話框（open 已經是 false）不算，否則連按時會漏掉真正在最上面的那個
  const top = modalStack.slice().reverse().find((x) => x.open);
  if (top && top.guard) { e.preventDefault(); e.stopPropagation(); top.guard(); }
}, true);

for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => {
    if (!e.target.closest('[data-close]')) return;
    if (d.guard) d.guard(); else d.close('cancel');
  });
  d.addEventListener('cancel', (e) => { if (d.guard) { e.preventDefault(); d.guard(); } });
  d.addEventListener('close', () => setTimeout(() => { syncIfIdle(); askOrphans(); }, 0));
}

/* ---------- 多個分頁同步 ---------- */

function anyDialogOpen() { return !!document.querySelector('dialog[open]'); }

function syncIfIdle() {
  if (!syncPending || anyDialogOpen() || !storage || blocked) return;
  syncPending = false;
  const r = store.loadState(storage);
  if (!r.available) return;
  const keep = ui.recId;
  const next = r.state;
  next.currentId = keep && next.activities.some((a) => a.id === keep) ? keep : null;
  if (store.serializeState(next) === store.serializeState(st)) { baseline = store.makeBaseline(st); return; }
  const memDraft = $('#memName') ? $('#memName').value : '';
  st = next;
  if (keep && !next.currentId) { ui.recId = null; ui.view = 'quick'; draft = null; storeCurrentId(null); }
  baseline = store.makeBaseline(st);
  storageOk = true;
  syncNotice = '另一個分頁更新了資料，已同步。';
  render();
  if (memDraft && $('#memName')) $('#memName').value = memDraft;
}

window.addEventListener('storage', (e) => {
  if (e.storageArea && storage && e.storageArea !== storage) return;
  if (e.key !== null && e.key !== store.STORAGE_KEY) return;
  syncPending = true;
  syncIfIdle();
});

function restoreFocus(key) {
  const el = (key && document.querySelector('[data-fk="' + key + '"]:not([disabled])')) || $('#main');
  if (el) el.focus();
}

async function confirmBox(o) {
  const d = $('#dlgConfirm');
  $('#dcTitle').textContent = o.title;
  $('#dcBody').textContent = o.body;
  const ok = $('#dcOk');
  ok.textContent = o.okText || '確定';
  ok.className = 'btn ' + (o.danger ? 'danger' : 'primary');
  $('#dcCancel').textContent = o.cancelText || '取消';
  const v = await showModal(d, $('#dcCancel'));
  return v === 'ok';
}

async function askText(o) {
  const d = $('#dlgText');
  const inp = $('#dtInput');
  $('#dtTitle').textContent = o.title;
  $('#dtLabel').textContent = o.label;
  inp.value = o.value || '';
  inp.maxLength = o.max || LIMITS.MAX_NAME;
  inp.placeholder = o.placeholder || '';
  const note = $('#dtNote');
  note.hidden = !o.note;
  note.textContent = o.note || '';
  const err = $('#dtErr');
  err.hidden = true;
  const rm = $('#dtRemove');
  rm.hidden = !o.remove;
  rm.disabled = !!(o.remove && o.remove.disabled);
  if (o.remove) rm.textContent = o.remove.text;
  $('#dtOk').textContent = o.okText || '確定';
  const dateInp = $('#dtDate');
  $('#dtDateWrap').hidden = !o.date;
  if (o.date) dateInp.value = o.date;
  let result = null;
  $('#dtForm').onsubmit = (e) => {
    e.preventDefault();
    const v = inp.value.trim();
    if (!v) { err.textContent = '請先輸入' + o.label; err.hidden = false; inp.focus(); return; }
    if (o.date) {
      const msg = o.validate ? o.validate(v, dateInp.value) : '';
      if (msg) { err.textContent = msg; err.hidden = false; dateInp.focus(); return; }
    }
    result = { action: 'ok', value: v, date: o.date ? dateInp.value : undefined };
    d.close('ok');
  };
  rm.onclick = () => { result = { action: 'remove' }; d.close('remove'); };
  await showModal(d, inp);
  return result;
}

async function flow(fn) {
  const key = lastKey;
  focusApplied = false;
  document.body.dataset.busy = '1';
  try { await fn(); } finally {
    if (!focusApplied) restoreFocus(key);
    delete document.body.dataset.busy;
  }
}

/* ---------- 文字小工具 ---------- */

function splitSummary(ex, members) {
  const nm = (id) => { const m = members.find((x) => x.id === id); return m ? m.name : '?'; };
  const parts = ex.participants || [];
  const fx = ex.fixed || [];
  const eq = parts.every((p) => p.shares === parts[0].shares);
  let p = '';
  if (parts.length) {
    if (fx.length) p = eq ? '其餘平均' : '其餘依份數';
    else if (!eq) p = '依份數分（' + parts.length + ' 人）';
    else if (parts.length === members.length) p = members.length + ' 人平均';
    else if (parts.length <= 3) p = parts.map((x) => nm(x.memberId)).join('、') + '平均';
    else p = parts.length + ' 人平均';
  }
  let f = '';
  if (fx.length) f = fx.length <= 2 ? fx.map((x) => nm(x.memberId) + '固定 ' + money(x.amount)).join('、') : fx.length + ' 人固定金額';
  return f && p ? f + '，' + p : f || p || '還沒選人';
}

/* ---------- 畫面 ---------- */

function headHtml() {
  return '<header class="head"><span class="logo" aria-hidden="true"></span><div><a class="back" href="../index.html">&lsaquo; <span data-brand>' + esc(BRAND) + '</span></a>' +
    '<h1>多人分帳</h1></div>' +
    '<p class="trust"><span class="tick" aria-hidden="true"></span>免費、無廣告、不扣款，資料只存在你的手機</p></header>';
}

function noticesHtml() {
  let h = '';
  if (!storageOk) h += '<p class="notice" role="status">這次的資料不會被記住，關掉頁面就會消失。建議到最下面「備份」存一份。</p>';
  for (const n of notices) h += '<p class="notice" role="status">' + esc(n) + '</p>';
  if (syncNotice) h += '<p class="notice" role="status" id="syncNote">' + esc(syncNotice) + '</p>';
  return h;
}

function eventHtml(act, res) {
  const pick = st.activities.length > 1
    ? '<div class="pick"><label for="actSel">切換活動</label><select id="actSel">' +
      st.activities.map((a) => '<option value="' + a.id + '"' + (a.id === act.id ? ' selected' : '') + '>' + esc(a.title) + '</option>').join('') + '</select></div>'
    : '';
  return '<section class="sec event" aria-labelledby="h-event"><p class="label">活動</p><h2 class="ev-name" id="h-event" tabindex="-1">' + esc(act.title) + '</h2>' +
    '<p class="ev-meta">' + esc(act.createdAt) + ' · ' + act.members.length + ' 位成員' + (res.total > 0 ? ' · 共 <span class="amt">' + money(res.total) + '</span> 元' : '') + '</p>' + pick +
    '<div class="tools"><button type="button" class="btn ghost small" data-act="rename-activity" data-fk="act-rename">改名稱與日期</button>' +
    '<button type="button" class="btn ghost small" data-act="delete-activity" data-fk="act-delete">刪除活動</button></div></section>';
}

function membersHtml(act) {
  let h = '<section class="sec" aria-labelledby="h-mem"><h3 class="sec-title" id="h-mem">成員</h3>';
  if (act.members.length === 0) h += '<p class="empty-note">先加入一起分帳的人。可以一次輸入好幾個，用頓號或逗號隔開。</p>';
  else {
    h += '<ul class="chips">' + act.members.map((m, i) =>
      '<li class="c' + (i % 5) + '"><button type="button" class="chip" data-act="edit-member" data-id="' + m.id + '" data-fk="mem-' + m.id + '" aria-label="' + esc(m.name) + '，點一下可改名或移除"><span class="av" aria-hidden="true">' + esc(first(m.name)) + '</span>' + esc(m.name) + '</button></li>').join('') + '</ul>';
  }
  h += '<form class="addrow" data-form="add-member" novalidate><label for="memName">成員暱稱</label>' +
    '<input id="memName" type="text" maxlength="40" autocomplete="off" placeholder="例如：小安"><button type="submit" class="btn primary small">加入</button></form>';
  h += '</section>';
  return h;
}

function expenseHtml(act, res) {
  let h = '<section class="sec" aria-labelledby="h-exp"><h3 class="sec-title" id="h-exp" tabindex="-1">支出</h3>';
  if (act.expenses.length === 0) {
    h += '<p class="empty-note">' + (act.members.length === 0 ? '加好成員後，就能開始記支出。' : '還沒有支出。按下面的「新增支出」記第一筆。') + '</p>';
  }
  act.expenses.forEach((ex, i) => {
    const r = res.expenses[i];
    const bad = !r.ok;
    const open = ui.open.has(ex.id);
    const title = ex.title.trim() || '未命名支出';
    const lines = explainExpense(ex, r.ok ? Object.assign({ ok: true }, r, { owed: r.owed }) : r, act.members);
    h += '<details class="exp' + (bad ? ' bad' : '') + '" data-id="' + ex.id + '"' + (open ? ' open' : '') + '><summary>' +
      '<span class="ico" aria-hidden="true">' + esc(first(title)) + '</span>' +
      '<span class="exp-main"><span class="exp-title">' + esc(title) + '</span>' +
      '<span class="exp-meta">' + (bad ? '還沒算對，點開看原因' : esc(nameOf(act, ex.payerId)) + '付 · ' + esc(splitSummary(ex, act.members))) + '</span></span>' +
      '<span class="amt exp-amt">' + (ex.amount > 0 ? money(ex.amount) : '—') + '</span><span class="chev" aria-hidden="true"></span></summary>' +
      '<div class="exp-body"><div class="how' + (bad ? ' bad' : '') + '">' + lines.map((l) => '<p>' + esc(l) + '</p>').join('') + '</div>';
    if (!bad) {
      h += '<ul class="shares">' + act.members.filter((m) => Object.prototype.hasOwnProperty.call(r.owed, m.id)).map((m) =>
        '<li><span>' + esc(m.name) + '</span><span class="amt">' + money(r.owed[m.id]) + '</span></li>').join('') + '</ul>';
    }
    h += '<div class="exp-act"><button type="button" class="btn ghost small" data-act="edit-expense" data-id="' + ex.id + '" data-fk="exp-edit-' + ex.id + '">' + (bad ? '修改' : '編輯') + '</button>' +
      '<button type="button" class="btn danger small" data-act="delete-expense" data-id="' + ex.id + '" data-fk="exp-del-' + ex.id + '">刪除</button></div></div></details>';
  });
  return h + '</section>';
}

function settleHtml(act, res) {
  let h = '<section class="sec" aria-labelledby="h-settle"><h3 class="sec-title" id="h-settle">結算</h3>';
  const nBad = res.expenses.filter((e) => !e.ok).length;
  if (nBad > 0) h += '<p class="err banner-bad" role="status">有 ' + nBad + ' 筆支出還沒算對，下面的數字先不包含這 ' + nBad + ' 筆。</p>';
  if (act.members.length === 0) return h + '<p class="empty-note">加入成員、記下支出後，這裡會算出每個人該付多少。</p></section>';
  h += '<table class="settle"><thead><tr><th scope="col">成員</th><th scope="col">該付</th><th scope="col">已付</th><th scope="col">差額</th></tr></thead><tbody>';
  for (const p of res.perMember) {
    const cls = p.balance > 0 ? 'in' : p.balance < 0 ? 'out' : 'zero';
    const tag = p.balance > 0 ? '應收' : p.balance < 0 ? '應付' : '剛好';
    h += '<tr><th scope="row">' + esc(nameOf(act, p.memberId)) + '</th><td class="amt">' + money(p.owed) + '</td><td class="amt">' + money(p.paid) +
      '</td><td class="diff ' + cls + '"><span class="tag">' + tag + '</span>' + (p.balance !== 0 ? '<span class="amt">' + money(Math.abs(p.balance)) + '</span>' : '') + '</td></tr>';
  }
  h += '</tbody></table></section>';

  h += '<section class="sec" aria-labelledby="h-xfer"><h3 class="sec-title" id="h-xfer">較少次數的還款方式</h3>';
  if (res.transfers.length > 0) {
    h += '<ul class="xfer">' + res.transfers.map((t) =>
      '<li><span class="who">' + esc(nameOf(act, t.from)) + '</span><span class="arrow" aria-hidden="true"></span><span class="sr-only">給</span><span class="who">' + esc(nameOf(act, t.to)) + '</span><span class="amt">' + money(t.amount) + '</span></li>').join('') + '</ul>';
  } else if (res.total > 0) {
    h += '<p class="alldone"><span class="tick" aria-hidden="true"></span>大家都結清了，不用再轉帳。</p>';
  } else {
    h += '<p class="empty-note">記下第一筆支出後，這裡會告訴你誰該給誰多少。</p>';
  }
  return h + '</section>';
}

function barHtml(act, res) {
  const noMem = act.members.length === 0;
  const noExp = act.expenses.length === 0;
  const nBad = res.expenses.filter((e) => !e.ok).length;
  let why = '';
  if (noMem) why = '先加成員，才能記支出。';
  else if (noExp) why = '記下第一筆支出，就能做結算卡。';
  else if (nBad > 0) why = '有 ' + nBad + ' 筆支出還沒算對，修好才能做結算卡。';
  const cardOff = noMem || noExp || nBad > 0;
  return '<div class="bar"><button type="button" class="btn ghost" data-act="add-expense" data-fk="add-exp"' + (noMem ? ' disabled' : '') + '>新增支出</button>' +
    '<button type="button" class="btn primary" data-act="open-card" data-fk="open-card"' + (cardOff ? ' disabled' : '') + '>產生結算卡</button>' +
    (why ? '<p class="why" id="barWhy">' + esc(why) + '</p>' : '') + '</div>';
}

function backupHtml(act) {
  return '<section class="sec" aria-labelledby="h-bak"><h3 class="sec-title" id="h-bak">備份</h3>' +
    '<p class="hint" style="margin-top:0">換手機或怕資料不見時用。備份檔只有你拿得到。</p>' +
    (ui.importMsg ? '<p class="err" role="alert" style="margin-bottom:10px">' + esc(ui.importMsg) + '</p>' : '') +
    '<div class="tools-row">' +
    (act ? '<button type="button" class="btn ghost" data-act="export" data-fk="export">' + (act.quick ? '匯出目前這筆的備份檔' : '匯出目前活動的備份檔') + '</button>' : '') +
    '<label class="btn ghost">匯入備份檔（加入為新的一筆）<input type="file" id="impFile" accept=".json,application/json" data-fk="import"></label>' +
    (st.activities.length ? '<button type="button" class="btn danger" data-act="clear-all" data-fk="clear">清除這台裝置上的所有資料</button>' : '') + '</div></section>';
}

function helpHtml(mode) {
  const d = (t, body) => '<details><summary>' + t + '<span class="chev" aria-hidden="true"></span></summary><div class="txt">' + body + '</div></details>';
  if (mode === 'quick') {
    return '<section class="help" aria-label="說明">' +
      d('怎麼算的', '<ol>' +
        '<li>所有金額都算到整數元。平分時每人金額捨去小數；大家照付之後如果和帳單差幾元，畫面會寫「還差幾元，由付錢的人補」。</li>' +
        '<li>「有一部分人需額外付費」：先把這幾筆（有勾「另加一成」的會再加一成，四捨五入到整數元）從總額扣掉，剩下的全部人平分，就是「每個人都要付」；每一筆再由額外付費的人平分。額外付費的人，要付的是「每個人都要付」加上自己那幾筆。</li>' +
        '<li>「有人不用付」：選「大家一起分」，不用付的人是 0 元，其餘的人平分；選「由別人幫忙付」，幫忙付的人平均分擔不用付的人的份，其餘每人 1 份。</li>' +
        '<li>「有人付固定金額」：先扣掉固定金額的合計，剩下的由其餘的人平分。</li>' +
        '<li>湊成整十：每個金額四捨五入到十位，所以收齊的錢可能比帳單多一點或少一點，畫面會寫出差多少。</li>' +
        '<li>每一張帳單各算各的；只有在每張都是單純平分、人數也一樣時，才會再加總出「每人合計」。</li>' +
        '<li>輸入名單：可以選是哪幾個人、取名字，並讓兩種特殊情況同時成立；名字沒填就顯示「第幾位」。算法與沒有名單時一樣，只是多知道了是誰。</li></ol>') +
      d('我的資料在哪裡', '<p>只存在這台裝置的瀏覽器裡，不會傳到任何地方，我們也看不到。</p><p>清除瀏覽器資料、換手機或換瀏覽器，資料就會不見。重要的紀錄請用上面的「備份」匯出一份。</p>') +
      d('僅供分帳試算', '<p>這個工具只做計算，不會付款、轉帳或扣款，結果僅供參考。</p><p>結算卡傳出去之前，請自己先看一遍。</p>') +
      '</section><p class="foot-note"><span data-brand>' + esc(BRAND) + '</span> · 免費、無廣告</p>';
  }
  return '<section class="help" aria-label="說明">' +
    d('怎麼算的', '<ol>' +
      '<li>每筆支出會先扣掉「固定金額」的人要付的，剩下的再分給其他人。</li>' +
      '<li>平均分就是每人 1 份；依份數分就按份數比例分，例如大人 2 份、小孩 1 份。</li>' +
      '<li>每個人的金額都算到整數元。除不盡的零頭（最多幾元）由這筆的付款人吸收，就算他沒有參與分攤也一樣。</li>' +
      '<li>差額 = 已付 − 該付。正數是應收，負數是應付。</li>' +
      '<li>還款建議：每次讓欠最多的人，付給該收最多的人，直到清完。次數不會超過「人數減一」，但不保證是最少的次數，所以只寫「較少次數」。</li>' +
      '<li>有算不出來的支出（例如固定金額加起來比總額多），那一筆會先被排除，並標出原因。</li></ol>') +
    d('我的資料在哪裡', '<p>只存在這台裝置的瀏覽器裡，不會傳到任何地方，我們也看不到。</p><p>清除瀏覽器資料、換手機或換瀏覽器，資料就會不見。重要的活動請用上面的「備份」匯出一份。</p>') +
    d('僅供分帳試算', '<p>這個工具只做計算，不會付款、轉帳或扣款，結果僅供參考。</p><p>結算卡上有成員暱稱和金額，傳出去之前請自己先看一遍。</p>') +
    '</section><p class="foot-note"><span data-brand>' + esc(BRAND) + '</span> · 免費、無廣告</p>';
}

function cardColHtml(act, res) {
  const ok = act && act.expenses.length > 0 && !res.hasErrors && act.members.length > 0;
  return '<aside class="cardcol" aria-label="結算卡預覽"><section class="sec">' +
    (ok ? '<img class="pv" id="pvImg" alt="結算卡預覽"><p>算好了，存成圖片就能丟群組。</p><button type="button" class="btn primary" data-act="open-card" data-fk="open-card2">放大並存成圖片</button>'
      : '<p style="margin:0">記好支出後，這裡會出現結算卡預覽。</p>') + '</section></aside>';
}

function render() {
  const act = cur();
  if (ui.view === 'advanced' && act && !act.quick) renderAdvanced(act); else renderQuick();
}

function renderAdvanced(act) {
  const scrollY = window.scrollY;
  const res = computeActivity(act);
  let h = '<div class="stage"><main class="app" id="main" tabindex="-1">' + headHtml() + noticesHtml();
  h += '<p class="to-quick"><button type="button" class="btn ghost small" data-act="to-quick" data-fk="to-quick">&lsaquo; 回到快速計算</button></p>';
  h += eventHtml(act, res) + membersHtml(act) + expenseHtml(act, res) + settleHtml(act, res) + barHtml(act, res) + backupHtml(act) + helpHtml();
  h += '</main>' + (mq.matches ? cardColHtml(act, res) : '') + '</div>';
  $('#app').innerHTML = h;
  if (mq.matches) {
    const img = $('#pvImg');
    if (img) { try { img.src = card.renderCard(act, res, 'compact').toDataURL('image/png'); } catch (e) { img.hidden = true; } }
  }
  window.scrollTo(0, scrollY);
  if (pendingFocus) {
    const el = $(pendingFocus);
    pendingFocus = null;
    if (el) { el.focus(); focusApplied = true; }
  }
}

/* ---------- 支出編輯 ---------- */

function whoBtn(m) {
  return h('button', { type: 'button', class: 'wbtn', 'aria-pressed': 'true', 'data-who': m.id, 'data-fk': 'who-' + m.id },
    h('span', { class: 'wname' }, m.name), h('span', { class: 'wamt', 'data-amt': '' }));
}

function adjRow(m) {
  const k = m.id;
  return h('div', { class: 'mrow', 'data-m': k },
    h('div', { class: 'mhead' }, h('span', { class: 'mname' }, m.name)),
    h('div', { class: 'extra', 'data-x': 'share' },
      h('label', { class: 'what', for: 'sh-' + k }, h('span', { class: 'sr-only' }, m.name + '的'), '份數'),
      h('input', { id: 'sh-' + k, type: 'text', inputmode: 'numeric', autocomplete: 'off', value: '1' }), h('span', { class: 'unit' }, '份')),
    h('div', { class: 'extra', 'data-x': 'fixed' },
      h('label', { class: 'what', for: 'fx-' + k }, h('span', { class: 'sr-only' }, m.name + '的'), '固定付'),
      h('input', { id: 'fx-' + k, type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: '不填就照一般算' }), h('span', { class: 'unit' }, '元')),
    h('p', { class: 'field-err', 'data-e': '', hidden: true }));
}

// 輸入框裡有加號時，換成加總後的數字（離開欄位或按 Enter 時用）
function collapsePlus(inp) {
  const p = store.parseMoneyExpr(inp.value);
  if (p.ok && !p.blank && /[+＋]/.test(inp.value)) inp.value = String(p.total);
}

function openExpenseEditor(expenseId) {
  return flow(async () => {
    const act = cur();
    const members = act.members;
    const ids = members.map((m) => m.id);
    const ex = expenseId ? act.expenses.find((e) => e.id === expenseId) : null;
    const d = $('#dlgExp');
    const form = $('#exForm');
    const touched = new Set();
    let attempted = false;

    $('#exTitle').textContent = ex ? '編輯支出' : '新增支出';
    $('#exWho').replaceChildren(...members.map(whoBtn));
    $('#exRows').replaceChildren(...members.map(adjRow));
    $('#exPayer').replaceChildren(...members.map((m) => h('option', { value: m.id }, m.name)));

    // 填入初始值
    const last = act.expenses[act.expenses.length - 1];
    let payer = ex ? ex.payerId : (last && ids.includes(last.payerId) ? last.payerId : ids[0]);
    if (!ids.includes(payer)) payer = ids[0];
    $('#exName').value = ex ? ex.title : '';
    $('#exAmt').value = ex && ex.amount > 0 ? String(ex.amount) : '';
    $('#exPayer').value = payer;
    const parts = ex ? ex.participants || [] : members.map((m) => ({ memberId: m.id, shares: 1 }));
    const fixed = ex ? ex.fixed || [] : [];
    const byShare = new Map(parts.map((p) => [p.memberId, p.shares]));
    const byFixed = new Map(fixed.map((f) => [f.memberId, f.amount]));
    const sel = new Set(members.filter((m) => byShare.has(m.id) || byFixed.has(m.id)).map((m) => m.id));
    for (const m of members) {
      if (byShare.has(m.id) && byShare.get(m.id) > 0) $('#sh-' + m.id).value = String(byShare.get(m.id));
      if (byFixed.has(m.id) && byFixed.get(m.id) >= 0) $('#fx-' + m.id).value = String(byFixed.get(m.id));
    }
    // 有固定金額或份數不是 1，就先把這個區塊展開，免得使用者看不到為什麼金額不一樣
    $('#exAdv').open = !!ex && (fixed.length > 0 || parts.some((p) => p.shares !== 1));

    const readDraft = () => ({
      title: $('#exName').value,
      amount: $('#exAmt').value,
      payer: $('#exPayer').value,
      rows: members.map((m) => ({
        id: m.id,
        name: m.name,
        on: sel.has(m.id),
        shares: $('#sh-' + m.id).value,
        fixed: $('#fx-' + m.id).value,
      })),
    });

    function build(dr) {
      const errs = [];
      const fieldErr = {};
      const mr = store.parseMoneyExpr(dr.amount);
      let am;
      if (mr.blank) am = { ok: false, reason: '請輸入金額' };
      else if (!mr.ok) am = { ok: false, reason: mr.reason };
      else if (mr.total === 0) am = { ok: false, reason: '金額要大於 0' };
      else am = { ok: true, value: mr.total };
      if (!am.ok) { errs.push(am.reason); fieldErr.amount = am.reason; }
      const participants = [];
      const fx = [];
      for (const r of dr.rows) {
        if (!r.on) continue;
        if (store.normalizeNumberText(r.fixed) !== '') {
          const p = store.parseMoneyExpr(r.fixed, r.name + '的固定金額');
          let v = -1;
          if (p.ok) v = p.total; else { errs.push(p.reason); fieldErr['fx-' + r.id] = p.reason; }
          fx.push({ memberId: r.id, amount: v });
        } else {
          const p = store.parseShares(r.shares, r.name + '的份數');
          let sh = 0;
          if (p.ok) sh = p.value; else { errs.push(p.reason); fieldErr['sh-' + r.id] = p.reason; }
          participants.push({ memberId: r.id, shares: sh });
        }
      }
      const expense = {
        id: ex ? ex.id : 'tmp', title: dr.title.trim().slice(0, LIMITS.MAX_TITLE), payerId: dr.payer,
        amount: am.ok ? am.value : 0, participants, fixed: fx,
      };
      return { expense, errs, fieldErr, amountBlank: store.normalizeNumberText(dr.amount) === '' };
    }

    const p = (text) => h('p', null, text);

    function update() {
      const dr = readDraft();
      const b = build(dr);
      let r = null;
      if (b.errs.length === 0) r = computeExpense(b.expense, ids);
      const bad = b.errs.length > 0 || !r.ok;

      let advErr = false;
      for (const row of dr.rows) {
        const btn = form.querySelector('.wbtn[data-who="' + row.id + '"]');
        btn.setAttribute('aria-pressed', row.on ? 'true' : 'false');
        const owed = r && r.ok && row.on && Object.prototype.hasOwnProperty.call(r.owed, row.id) ? money(r.owed[row.id]) + ' 元' : '';
        btn.querySelector('[data-amt]').textContent = owed;
        const el = form.querySelector('.mrow[data-m="' + row.id + '"]');
        el.hidden = !row.on;
        el.classList.toggle('isfixed', store.normalizeNumberText(row.fixed) !== '');
        const fe = b.fieldErr['sh-' + row.id] || b.fieldErr['fx-' + row.id];
        const key = b.fieldErr['sh-' + row.id] ? 'sh-' + row.id : 'fx-' + row.id;
        const pe = el.querySelector('[data-e]');
        const show = !!fe && row.on && (touched.has(key) || attempted);
        if (show) advErr = true;
        pe.hidden = !show;
        pe.textContent = show ? fe : '';
      }
      if (advErr) $('#exAdv').open = true;
      const ae = $('#exAmtErr');
      const showAmt = b.fieldErr.amount && (touched.has('amount') || attempted) && !(b.amountBlank && !attempted && !touched.has('amount'));
      ae.hidden = !showAmt;
      ae.textContent = showAmt ? b.fieldErr.amount : '';
      $('#exAmt').setAttribute('aria-invalid', showAmt ? 'true' : 'false');

      const nodes = [];
      if (b.errs.length > 0) {
        if (b.amountBlank && b.errs.length === 1 && !attempted) {
          nodes.push(h('p', { class: 'muted' }, '先填好金額，這裡會即時算出每個人要付多少。'));
        } else {
          nodes.push(h('div', { class: 'err pv-err', role: 'alert' }, p('先把下面這些處理好：'), b.errs.map((e) => p('・' + e))));
        }
      } else if (!r.ok) {
        nodes.push(h('div', { class: 'err pv-err', role: 'alert' }, explainExpense(b.expense, r, members).map(p)));
      } else {
        nodes.push(h('p', { class: 'pv-title' }, '這筆怎麼算'), h('div', { class: 'pv-how' }, explainExpense(b.expense, r, members).map(p)));
      }
      if (bad && !(b.amountBlank && b.errs.length === 1 && !attempted)) nodes.push(h('p', { class: 'pv-draft' }, '有地方要改才能按「完成」，也可以先存成草稿，晚點再補。'));
      $('#exPreview').replaceChildren(...nodes);
      $('#exOk').disabled = bad;
      $('#exDraft').hidden = !bad;
      form.dataset.bad = bad ? '1' : '';
    }

    function save() {
      const dr = readDraft();
      const b = build(dr);
      const used = new Set(act.expenses.map((e) => e.id));
      const e = b.expense;
      if (!ex) e.id = store.newId('e', used);
      if (ex) act.expenses[act.expenses.findIndex((x) => x.id === ex.id)] = e;
      else act.expenses.push(e);
      ui.open.add(e.id);
      d.close('saved');
      return b.errs.length > 0 || !computeExpense(e, ids).ok;
    }

    $('#exWho').onclick = (e) => {
      const btn = e.target.closest('.wbtn');
      if (!btn) return;
      const id = btn.dataset.who;
      if (sel.has(id)) sel.delete(id); else sel.add(id);
      update();
    };
    form.oninput = (e) => { if (e.target.id) touched.add(e.target.id === 'exAmt' ? 'amount' : e.target.id); update(); };
    form.onchange = update;
    const collapseAmt = () => {
      const pr = store.parseMoneyExpr($('#exAmt').value);
      if (pr.ok && pr.total > 0) $('#exAmt').value = money(pr.total);
    };
    $('#exAmt').onblur = () => {
      touched.add('amount');
      collapseAmt();
      update();
    };
    $('#exAmt').onkeydown = (e) => { if (e.key === 'Enter') collapseAmt(); };
    for (const fxInp of $('#exRows').querySelectorAll('input[id^="fx-"]')) fxInp.addEventListener('blur', () => { collapsePlus(fxInp); update(); });
    $('#exRows').onkeydown = (e) => { if (e.key === 'Enter' && e.target.id && e.target.id.startsWith('fx-')) collapsePlus(e.target); };
    form.onsubmit = (e) => {
      e.preventDefault();
      if ($('#exOk').disabled) { attempted = true; update(); return; }
      const stillBad = save();
      form.dataset.result = stillBad ? 'draft' : 'done';
    };
    $('#exDraft').onclick = () => { save(); form.dataset.result = 'draft'; };
    form.dataset.result = '';
    update();
    // 有沒有改過任何欄位：用「整理過的內容」比較，金額的千分位、前後空白不算改動
    const snap = () => {
      const dr = readDraft();
      return JSON.stringify([dr.title.trim(), store.normalizeNumberText(dr.amount), dr.payer,
        dr.rows.map((r) => [r.id, r.on, r.on ? store.normalizeNumberText(r.fixed) : '', r.on && store.normalizeNumberText(r.fixed) === '' ? store.normalizeNumberText(r.shares) : ''])]);
    };
    const initial = snap();
    let asking = false;
    d.guard = async () => {
      if (asking) return;
      if (snap() === initial) { d.close('cancel'); return; }
      asking = true;
      try {
        const drop = await confirmBox({ title: '放棄剛剛的修改？', body: '這筆支出你改過的地方還沒存，現在關掉就會不見。', okText: '放棄修改', cancelText: '繼續編輯', danger: true });
        if (drop) d.close('cancel');
        else { const el = document.activeElement; if (!d.contains(el)) $('#exName').focus(); }
      } finally { asking = false; }
    };
    let v;
    try { v = await showModal(d, $('#exName')); } finally { d.guard = null; }
    if (v === 'saved') {
      const draft = form.dataset.result === 'draft';
      commit(null);
      toast(draft ? '已存成草稿，還沒算進結算' : ex ? '已更新這筆支出' : '已加入這筆支出');
    }
  });
}

/* ---------- 結算卡 ---------- */

function shareSupported() {
  try {
    return !!(navigator.canShare && navigator.share && navigator.canShare({ files: [new File(['x'], 'a.png', { type: 'image/png' })] }));
  } catch (e) {
    return false;
  }
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function openCard() {
  if (ui.view !== 'advanced') return openQuickCard();
  return flow(async () => {
    const act = cur();
    const res = computeActivity(act);
    if (!act || res.hasErrors || act.expenses.length === 0) return;
    const d = $('#dlgCard');
    let kind = ui.cardKind;
    let canvas = null;
    d.querySelector('input[name="ckKind"][value="' + kind + '"]').checked = true;
    $('#ckKinds').hidden = false;
    $('#ckNote').textContent = '圖上有成員暱稱和金額，傳出去前請先看一眼。';
    const canShare = shareSupported();
    $('#ckShare').hidden = !canShare;
    const draw = () => {
      canvas = card.renderCard(act, res, kind);
      const img = $('#ckImg');
      img.src = canvas.toDataURL('image/png');
      img.alt = '結算卡：' + act.title + '，總金額 ' + money(res.total) + ' 元';
      $('#ckHint').textContent = kind === 'compact' ? '一眼看到誰給誰多少，適合直接丟群組。' : '多列每一筆支出，方便大家對帳。';
    };
    d.onchange = (e) => {
      if (e.target.name === 'ckKind') { kind = e.target.value; ui.cardKind = kind; draw(); }
    };
    const fileName = () => store.safeFileName(act.title, act.createdAt, kind === 'detail' ? '明細' : '', 'png');
    $('#ckSave').onclick = async () => {
      try {
        downloadBlob(await card.canvasToBlob(canvas), fileName());
        toast('已存成圖片');
      } catch (e) { toast('存圖失敗，請再試一次'); }
    };
    $('#ckShare').onclick = async () => {
      try {
        const blob = await card.canvasToBlob(canvas);
        await navigator.share({ files: [new File([blob], fileName(), { type: 'image/png' })], title: act.title });
      } catch (e) {
        if (!e || e.name !== 'AbortError') toast('這台裝置無法分享，請改用「存成圖片」');
      }
    };
    draw();
    await showModal(d, null);
  });
}

/* ---------- 動作 ---------- */

const actions = {
  'rename-activity': () => flow(async () => {
    const act = cur();
    const r = await askText({
      title: '修改活動', label: '活動名稱', value: act.title, max: LIMITS.MAX_TITLE, okText: '儲存', date: act.createdAt,
      validate: (title, date) => {
        if (!date) return '這個日期不存在，或還沒選。請重新選一個日期。';
        const probs = validateActivity(Object.assign({}, act, { title, createdAt: date }));
        return probs.length ? '日期不正確：請重新選一個真的存在的日期。' : '';
      },
    });
    if (r && r.action === 'ok') { act.title = r.value; act.createdAt = r.date; commit(null); }
  }),
  'delete-activity': () => flow(async () => {
    const act = cur();
    const ok = await confirmBox({ title: '刪除「' + act.title + '」？', body: '這個活動和裡面所有支出都會不見，而且救不回來。想留著的話，先到最下面匯出備份。', okText: '刪除', danger: true });
    if (!ok) return;
    st.activities = st.activities.filter((a) => a.id !== act.id);
    setCurrent(null);
    commit('#main');
    toast('已刪除活動');
  }),
  'edit-member': (el) => flow(async () => {
    const act = cur();
    const m = act.members.find((x) => x.id === el.dataset.id);
    if (!m) return;
    const used = store.usedMemberIds(act).has(m.id);
    const r = await askText({
      title: '成員', label: '暱稱', value: m.name, okText: '儲存',
      note: used ? '「' + m.name + '」已經在支出裡，要先修改或刪掉那幾筆，才能移除。' : '',
      remove: { text: '移除這位成員', disabled: used },
    });
    if (!r) return;
    if (r.action === 'remove') {
      act.members = act.members.filter((x) => x.id !== m.id);
      commit('#memName');
      toast('已移除 ' + m.name);
    } else {
      const dup = act.members.some((x) => x.id !== m.id && x.name === r.value);
      m.name = r.value;
      commit('[data-fk="mem-' + m.id + '"]');
      if (dup) toast('已有同名的成員，建議改個不一樣的暱稱，才分得清楚', 4500);
    }
  }),
  'add-expense': () => openExpenseEditor(null),
  'edit-expense': (el) => openExpenseEditor(el.dataset.id),
  'delete-expense': (el) => flow(async () => {
    const act = cur();
    const ex = act.expenses.find((e) => e.id === el.dataset.id);
    if (!ex) return;
    const ok = await confirmBox({ title: '刪除「' + (ex.title.trim() || '未命名支出') + '」？', body: '這筆支出會不見，大家的結算會重新計算。', okText: '刪除', danger: true });
    if (!ok) return;
    act.expenses = act.expenses.filter((e) => e.id !== ex.id);
    ui.open.delete(ex.id);
    commit('#h-exp');
    toast('已刪除這筆支出');
  }),
  'open-card': () => openCard(),
  export: () => {
    const act = cur();
    try {
      const text = serializeExport(act);
      downloadBlob(new Blob([text], { type: 'application/json' }), store.safeFileName(act.title, act.createdAt, '備份', 'json'));
      toast('已匯出備份檔');
    } catch (e) {
      ui.importMsg = '這個活動目前有資料不完整，沒辦法匯出。請先檢查成員和支出。';
      render();
    }
  },
  'clear-all': () => flow(async () => {
    const ok = await confirmBox({ title: '清除所有資料？', body: '這台裝置上的所有活動、成員和支出都會被刪掉，救不回來。要留著的話，請先匯出備份。', okText: '全部清除', danger: true });
    if (!ok) return;
    st = store.emptyState();
    setCurrent(null);
    ui.open.clear();
    store.clearAll(storage);
    baseline = new Map();
    blocked = false;
    syncNotice = '';
    notices.length = 0;
    ui.importMsg = '';
    storageOk = !!storage;
    pendingFocus = '#main';
    render();
    toast('已清除所有資料');
  }),
};

async function doImport(file) {
  if (!file) return;
  if (file.size > 4000000) { ui.importMsg = '檔案太大，不是正確的備份檔。'; render(); return; }
  let text = '';
  try { text = await file.text(); } catch (e) { ui.importMsg = '讀不到這個檔案，請再試一次。'; render(); return; }
  const r = parseImport(text);
  if (!r.ok) { ui.importMsg = r.reason + '。目前的資料沒有被動到。'; render(); return; }
  const out = store.addImported(st, r.activity);
  st = out.state;
  setCurrent(out.activity.id);
  commit('#main');
  toast('已加入「' + out.activity.title + '」成為新活動');
}

/* ---------- 現場算錢（快速計算）畫面 ---------- */
/* 這一區的畫面全部用 DOM 方法與 textContent 建立，不用 innerHTML 放使用者輸入的文字 */

const MAXN = { people: QUICK_LIMITS.MAX_PEOPLE, amount: LIMITS.MAX_AMOUNT };
const live = new Set(); // 金額欄裡「還沒按加」的那一個，暫時放在 items 的最後一個
const blankNext = new Set(); // 剛按過「加」：金額欄要空著等下一個金額（重新整理後沒有這個狀態，最後一個金額會回到欄位裡）
const PART_NAME_MAX = 12; // 額外付費那一筆的名稱最多幾個字
const STICKY_MAX = 260; // 結果區黏在畫面頂端時的最大高度（px），超過就不黏
const STICKY_TOP = 8; // 結果區黏頂時離畫面上緣的距離（px），要和 split.css 的 .result top 一致
const PLACE_GAP = 10; // 打字時，正在輸入的那一句離縮小後結果區下緣的距離（px）
const TYPING_EXIT_MS = 220; // 焦點離開輸入欄後多久才收起打字狀態（iOS 點按鈕時焦點會先離開，太快收起會讓按鈕被推走）

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// 只用在「不含任何使用者資料」的固定字串（頁首、說明區、圖示）；使用者輸入的文字一律走 h() 與 textContent
function frag(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content;
}

// 圖示直接畫在頁面裡，不連外部資源
const ICONS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chev: '<path d="M9 5l7 7-7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  reply: '<path d="M5 4v9a3 3 0 0 0 3 3h11"/><path d="M15 12l4 4-4 4"/>',
  dots: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
  round: '<path d="M12 20V6M6 12l6-6 6 6"/><path d="M5 3h14"/>',
  bill: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M12.5 11v6M9.5 14h6"/>',
  card: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18M7 15h4"/>',
  parts: '<path d="M12 12V3a9 9 0 1 0 9 9z"/><path d="M15 9V3.6A9 9 0 0 1 20.4 9z"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.5M4 12h.5M4 18h.5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.6 2.7-5.5 6-5.5s6 1.9 6 5.5"/><circle cx="17.5" cy="9" r="2.5"/><path d="M17 14.6c2.4.2 4 1.8 4 4.4"/>',
  free: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-4 3-6 7-6s7 2 7 6"/><path d="M4 4l16 16"/>',
  fixed: '<path d="M3 3h9.5l8.3 8.3a2 2 0 0 1 0 2.8l-6.7 6.7a2 2 0 0 1-2.8 0L3 12.5z"/><circle cx="7.5" cy="7.5" r="1.2"/><text x="13.6" y="15.6" text-anchor="middle" font-size="9.5" font-weight="800" fill="currentColor" stroke="none" font-family="Arial,sans-serif">$</text>',
};

function icon(name) {
  return frag('<svg class="i" viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + '</svg>').firstChild;
}

// 通知與備份區：內容可能含系統訊息（例如匯入失敗的原因），用 DOM 方法建立，不經過 innerHTML
function noticesNode() {
  const box = document.createDocumentFragment();
  const add = (text, id) => box.append(h('p', { class: 'notice', role: 'status', id }, text));
  if (!storageOk) add('這次的資料不會被記住，關掉頁面就會消失。建議到最下面「備份」存一份。');
  for (const n of notices) add(n);
  if (syncNotice) add(syncNotice, 'syncNote');
  return box;
}

// 打字時儲存狀態變了（例如儲存空間滿了）：只換通知區，不重畫輸入欄
function refreshNotices() {
  const box = $('#notices');
  if (box) box.replaceChildren(noticesNode());
}

function backupNode(act) {
  return h('section', { class: 'sec', 'aria-labelledby': 'h-bak' },
    h('h3', { class: 'sec-title', id: 'h-bak' }, '備份'),
    h('p', { class: 'hint', style: 'margin-top:0' }, '換手機或怕資料不見時用。備份檔只有你拿得到。'),
    ui.importMsg ? h('p', { class: 'err', role: 'alert', style: 'margin-bottom:10px' }, ui.importMsg) : null,
    h('div', { class: 'tools-row' },
      h('button', { type: 'button', class: 'btn ghost', 'data-act': 'export', 'data-fk': 'export', hidden: !act }, act && !act.quick ? '匯出目前活動的備份檔' : '匯出目前這筆的備份檔'),
      h('label', { class: 'btn ghost' }, '匯入備份檔（加入為新的一筆）', h('input', { type: 'file', id: 'impFile', accept: '.json,application/json', 'data-fk': 'import' })),
      h('button', { type: 'button', class: 'btn danger', 'data-act': 'clear-all', 'data-fk': 'clear', hidden: !st.activities.length }, '清除這台裝置上的所有資料')));
}

// 第一次輸入後才有紀錄：備份區的「匯出」「清除」要立刻出現，不必重新整理
function refreshBackup() {
  const ex = $('[data-act="export"]');
  if (ex) ex.hidden = !cur();
  const cl = $('[data-act="clear-all"]');
  if (cl) cl.hidden = !st.activities.length;
}

function storeCurrentId(id) {
  try {
    if (id) sessionStorage.setItem(SESSION_KEY, id); else sessionStorage.removeItem(SESSION_KEY);
  } catch (e) { /* 不能用就當成每次都是新開 */ }
}

function setCurrent(id, view) {
  const a = id ? st.activities.find((x) => x.id === id) : null;
  ui.recId = a ? a.id : null;
  st.currentId = ui.recId;
  ui.view = a ? (view || (a.quick ? 'quick' : 'advanced')) : 'quick';
  if (!a) draft = null;
  live.clear();
  blankNext.clear();
  storeCurrentId(ui.recId);
}

// 讀進來的資料欄位可能不齊（欄位都是選填），補成畫面要用的樣子
function ensureShape(b) {
  if (!Array.isArray(b.parts)) b.parts = [];
  if (!b.free || typeof b.free !== 'object') b.free = { by: 'all', count: 0, coverers: 1 };
  if (!b.fixed || typeof b.fixed !== 'object') b.fixed = { count: 0, amount: 0 };
}

function quickModel() {
  const a = cur();
  if (a && a.quick) {
    for (const b of a.quick.bills) ensureShape(b);
    return a.quick;
  }
  if (!draft) draft = { bills: [newBill(store.newId('b', []))] };
  return draft;
}

const billOf = (id) => quickModel().bills.find((b) => b.id === id) || null;
const partOf = (b, id) => (b ? b.parts.find((p) => p.id === id) || null : null);

/* ----- 名單：有名單時的資料整理（不變式見 PLAN_v3.md 第 1 節；畫面這邊自己維持，與 core.js 的 cleanQuick 一致） ----- */

const ON_ORDER = ['parts', 'free', 'fixed'];
const ROSTER_NAME_MAX = 12; // 名單上的名字最多幾個字（畫面）
const isNamed = (m) => !!m && Array.isArray(m.roster) && m.roster.length > 0;

function ensureNamedFields(b) {
  if (!Array.isArray(b.who)) b.who = [];
  if (!Array.isArray(b.on)) b.on = [];
  for (const p of b.parts) if (!Array.isArray(p.who)) p.who = [];
  if (!Array.isArray(b.free.who)) b.free.who = [];
  if (!Array.isArray(b.free.coverWho)) b.free.coverWho = [];
  if (!Array.isArray(b.fixed.who)) b.fixed.who = [];
}

// 把一張帳單整理成不變式：所有清單照名單順序、不重複、是 bill.who 的子集；人數欄位等於清單長度；mode 是 on 的第一個
function syncBill(m, b) {
  ensureNamedFields(b);
  const ids = m.roster.map((r) => r.id);
  const keep = (list, allowed) => {
    const have = new Set(list);
    return ids.filter((id) => have.has(id) && (!allowed || allowed.has(id)));
  };
  b.who = keep(b.who, null);
  const inP = new Set(b.who);
  b.people = b.who.length;
  for (const p of b.parts) { p.who = keep(p.who, inP); p.people = p.who.length; }
  b.free.who = keep(b.free.who, inP);
  b.free.coverWho = keep(b.free.coverWho, inP);
  b.free.count = b.free.who.length;
  b.free.coverers = b.free.coverWho.length;
  b.fixed.who = keep(b.fixed.who, inP);
  b.fixed.count = b.fixed.who.length;
  const on = new Set(b.on);
  b.on = ON_ORDER.filter((k) => on.has(k));
  b.mode = b.on[0] || 'even';
}

// 「不用付」「固定金額」兩種人：在別的句子裡不能再選（只看目前開著的情況）
function frOn(b) { return b.on.includes('free') ? b.free.who : []; }
function fxOn(b) { return b.on.includes('fixed') ? b.fixed.who : []; }

// 某個人變成「不用付」或「固定金額」：同時從幫忙付、各筆額外付費的清單拿掉（不用付還要從固定金額拿掉）
function stripPerson(b, id, alsoFixed) {
  const not = (arr) => arr.filter((x) => x !== id);
  for (const p of b.parts) p.who = not(p.who);
  b.free.coverWho = not(b.free.coverWho);
  if (alsoFixed) b.fixed.who = not(b.fixed.who);
}

// 開著「不用付」或「固定金額」時，清掉清單裡和另一個衝突的人
function sanitizeCases(b) {
  if (b.on.includes('free')) {
    for (const id of b.free.who) stripPerson(b, id, b.on.includes('fixed') ? true : false);
  }
  if (b.on.includes('fixed')) {
    const fr = new Set(b.on.includes('free') ? b.free.who : []);
    b.fixed.who = b.fixed.who.filter((id) => !fr.has(id));
    for (const id of b.fixed.who) stripPerson(b, id, false);
  }
}

function canRosterOff(m) { return m.bills.every((b) => b.on.length <= 1); }

// 一張匿名帳單的各種情況 → 名單上的人。
// 目前開著的情況先用「前 k 位」（按下前後金額完全相同）；沒開著但有保留資料的情況，從還沒被用掉的人裡依序分配
// （人不夠就有幾個算幾個）。順序：開著的 → 不用付 → 固定金額 → 幫忙付 → 各筆額外付費，彼此不重疊
function allocateWho(b, who) {
  const used = new Set();
  const mark = (arr) => { for (const id of arr) used.add(id); return arr; };
  const next = (k) => mark(who.filter((id) => !used.has(id)).slice(0, Math.max(0, k)));
  const out = { free: null, cover: null, fixed: null, parts: b.parts.map(() => null) };
  const F = b.free.count;
  const M = b.free.by === 'cover' ? b.free.coverers : 0;
  if (b.mode === 'parts') b.parts.forEach((p, i) => { out.parts[i] = who.slice(0, p.people); mark(out.parts[i]); });
  else if (b.mode === 'free') { out.free = mark(who.slice(0, F)); out.cover = mark(who.slice(F, F + M)); }
  else if (b.mode === 'fixed') out.fixed = mark(who.slice(0, b.fixed.count));
  if (!out.free) out.free = next(F);
  if (!out.fixed) out.fixed = next(b.fixed.count);
  if (!out.cover) out.cover = next(M);
  b.parts.forEach((p, i) => { if (!out.parts[i]) out.parts[i] = next(p.people); });
  return out;
}

// 沒有名單 → 有名單：人數＝各帳單人數最大值、名字全空；金額與按下前完全相同
function rosterOn(m) {
  if (isNamed(m)) return false;
  const k = Math.max(0, ...m.bills.map((b) => b.people));
  if (!(k >= 1)) return false;
  const ids = [];
  for (let i = 0; i < k; i++) ids.push(store.newId('m', ids));
  m.roster = ids.map((id) => ({ id, name: '' }));
  for (const b of m.bills) {
    ensureShape(b);
    const who = ids.slice(0, b.people);
    const al = allocateWho(b, who);
    b.who = who.slice();
    b.on = b.mode === 'even' ? [] : [b.mode];
    b.parts.forEach((p, i) => { p.who = al.parts[i]; });
    b.free.who = al.free;
    b.free.coverWho = al.cover;
    b.fixed.who = al.fixed;
    syncBill(m, b);
  }
  return true;
}

// 有名單 → 沒有名單：人數不變，移除名單與所有 who／on（呼叫端先確認 canRosterOff）
function dropRoster(m) {
  for (const b of m.bills) {
    syncBill(m, b);
    b.mode = b.on[0] || 'even';
    delete b.who;
    delete b.on;
    for (const p of b.parts) delete p.who;
    delete b.free.who;
    delete b.free.coverWho;
    delete b.fixed.who;
  }
  delete m.roster;
}

function addToBill(m, b) {
  const inAny = new Set();
  for (const x of m.bills) for (const id of x.who) inAny.add(id);
  let r = m.roster.find((x) => !inAny.has(x.id)); // 先用「不在任何帳單」的人（取過名字才會留下）
  if (!r) {
    if (m.roster.length < QUICK_LIMITS.MAX_PEOPLE) {
      r = { id: store.newId('m', m.roster.map((x) => x.id)), name: '' };
      m.roster.push(r);
    } else {
      const have = new Set(b.who);
      r = m.roster.find((x) => !have.has(x.id));
      if (!r) return false;
    }
  }
  b.who.push(r.id);
  syncBill(m, b);
  return true;
}

function removeFromBill(m, b, id, prune) {
  b.who = b.who.filter((x) => x !== id);
  syncBill(m, b);
  if (prune && !m.bills.some((x) => x.who.includes(id))) {
    const r = m.roster.find((x) => x.id === id);
    if (r && String(r.name).trim() === '') m.roster = m.roster.filter((x) => x.id !== id);
  }
}

// 人數欄位（加減鈕、直接打數字）：變多就補人、變少就從尾端移出
function setPeopleNamed(m, b, n) {
  const want = Math.max(0, Math.min(MAXN.people, n));
  while (b.who.length > want) removeFromBill(m, b, b.who[b.who.length - 1], true);
  let guard = 0;
  while (b.who.length < want && guard++ < 200) if (!addToBill(m, b)) break;
  if (m.roster.length === 0) { for (const x of m.bills) { x.on = x.on.slice(0, 1); } dropRoster(m); }
}

function ensureRecord() {
  const a = cur();
  if (a && a.quick) return;
  const m = quickModel();
  const b = m.bills[0];
  if (!(b.people > 0 && b.total > 0)) return;
  const used = new Set(st.activities.map((x) => x.id));
  const rec = { id: store.newId('a', used), title: store.formatStamp(), createdAt: store.todayLocal(), members: [], expenses: [], quick: m };
  st.activities.push(rec);
  draft = null;
  const keepLive = [...live]; // 建立紀錄不該讓還沒按「加」的金額變成已加入的
  setCurrent(rec.id, 'quick');
  for (const id of keepLive) live.add(id);
}

const noticeSig = () => [storageOk, notices.length, syncNotice].join('|');

// 每次輸入後：必要時建立紀錄、自動儲存、只更新結果區與回應行（不重畫輸入欄，游標才不會跳）
function edit(fn) {
  fn();
  ensureRecord();
  const a = cur();
  if (a && a.quick) {
    const sig = noticeSig();
    ui.importMsg = '';
    persist();
    if (noticeSig() !== sig) refreshNotices();
  }
  updateAll();
  askOrphans();
}

// 結構改變（開關情況、加刪一筆）：只換掉這一張帳單的畫面，再同步把游標放到要填的那一格
// （iOS 只在使用者手勢的同步流程裡才會彈出鍵盤，所以 focus 一定要在點擊處理函式裡直接呼叫）
function rebuild(bid, fk) {
  ensureRecord();
  const a = cur();
  if (a && a.quick) persist();
  const m = quickModel();
  const i = m.bills.findIndex((x) => x.id === bid);
  const old = document.querySelector('.qbill[data-bill="' + bid + '"]');
  if (i >= 0 && old) old.replaceWith(billCard(m.bills[i], i, m.bills.length));
  updateAll();
  focusFk(fk);
  syncTyping();
  askOrphans();
}

function focusFk(fk) {
  if (!fk) return;
  const el = document.querySelector('[data-fk="' + fk + '"]:not([disabled])');
  if (el) el.focus();
}

/* ----- 數字欄 ----- */

// 聚焦後把內容全選。要等一下才選，而且只在它「現在還是焦點」時才選：
// 瀏覽器的 select() 會順便把焦點搶過來，若另一格剛拿到焦點，這裡的延遲動作會把它搶回去，兩格就會來回搶（2026-11-21 實測）
function selectLater(inp) {
  const v = inp.value;
  setTimeout(() => {
    if (document.activeElement !== inp || inp.value !== v) return; // 使用者已經開始打字就不要再全選，免得蓋掉剛打的字
    try { inp.select(); } catch (e) { /* 忽略 */ }
  }, 0);
}

// 人數這類只能是整數的欄位：只留數字，其他字元直接去掉
// 回傳 { n, bad, clean }。bad：'int'＝含數字以外的字（小數點、負號、字母…），'max'＝超過上限；
// 有 bad 時不改欄位內容（使用者打了什麼就留著，並在欄位下方說明），n 不可信
function parseDigits(text, max) {
  const t = store.normalizeNumberText(text); // 全形轉半形、去掉空白與千分位逗號
  if (t !== '' && !/^\d+$/.test(t)) return { n: 0, bad: 'int', clean: false };
  const n = t === '' ? 0 : Number(t);
  if (n > max) return { n: max, bad: 'max', clean: false };
  return { n, bad: null, clean: String(text) === (n > 0 ? String(n) : '') };
}

// 人數欄的提示：放在這一句的正下方；有問題時欄位標上 data-bad，結果區改成等待樣式
function setCountBad(inp, bad, max) {
  let hint = inp.countHint;
  if (!hint && !bad) return; // 從來沒出過問題的欄位不用建提示
  if (!hint) {
    hint = h('p', { class: 'mhint chint', id: 'ch-' + (inp.id || Math.random().toString(36).slice(2)), role: 'status', hidden: true });
    inp.countHint = hint;
    const unit = inp.closest('[data-line]');
    if (unit) unit.after(hint);
  }
  if (bad) {
    inp.dataset.bad = bad;
    inp.setAttribute('aria-invalid', 'true');
    inp.setAttribute('aria-describedby', hint.id);
    hint.hidden = false;
    hint.textContent = bad === 'max' ? '人數最多 ' + max + ' 人' : '人數請輸入整數';
  } else {
    delete inp.dataset.bad;
    inp.setAttribute('aria-invalid', 'false');
    inp.removeAttribute('aria-describedby');
    hint.hidden = true;
    hint.textContent = '';
  }
}

// 取得焦點時把整份資料拍下來；之後欄位內容不合法，就把資料還原成這個樣子（打 3.5 時中途的「3」不可留在資料裡）
function restoreModel(snap) {
  const m = quickModel();
  const c = JSON.parse(snap);
  for (const k of Object.keys(m)) delete m[k];
  Object.assign(m, c);
  const a = cur();
  if (a && a.quick) persist();
}

function bindNumber(inp, max, onSet, onBad) {
  inp.addEventListener('input', (e) => {
    if (e.isComposing) return;
    const r = parseDigits(inp.value, max);
    if (r.bad) {
      setCountBad(inp, r.bad, max);
      if (inp.entrySnap) restoreModel(inp.entrySnap);
      if (onBad) onBad(r.bad, inp.entryN);
      updateAll(); // 資料已還原成取得焦點時的樣子，結果區變成等待樣式
      return;
    }
    setCountBad(inp, null, max);
    if (!r.clean) inp.value = r.n > 0 ? String(r.n) : '';
    onSet(r.n);
  });
  inp.addEventListener('focus', () => {
    selectLater(inp);
    const r = parseDigits(inp.value, max);
    inp.entryN = r.bad ? inp.entryN || 0 : r.n;
    inp.entrySnap = JSON.stringify(quickModel());
  });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
}

const textAttrs = { type: 'text', inputmode: 'numeric', autocomplete: 'off', enterkeyhint: 'done' };

/** 句子裡的人數空格 */
function digitField(o) {
  const inp = h('input', { ...textAttrs, class: 'fill ' + (o.cls || 'w2'), id: o.id, 'data-fk': o.fk, placeholder: o.placeholder || '幾', 'aria-label': o.aria });
  inp.value = o.value > 0 ? String(o.value) : '';
  bindNumber(inp, o.max, o.onSet);
  return inp;
}

const hasPlus = (t) => /[+＋]/.test(t);

/**
 * 金額欄：接受「1000+500」這種加法（半形、全形加號都可以），輸入過程中就用加總值即時計算。
 * 看不懂的內容不猜，欄位下面顯示白話提示（o.hintEl 由呼叫端放在欄位附近），並把這一格當成還沒填。
 * o.onSet(總額, 解析結果)。離開欄位或按 Enter 時，把加法換成加總後的數字。
 */
function moneyField(o) {
  const inp = h('input', { ...textAttrs, class: 'fill ' + (o.cls || 'w1'), id: o.id, 'data-fk': o.fk, placeholder: o.placeholder || '', 'aria-label': o.aria });
  inp.value = o.value > 0 ? money(o.value) : '';
  const hint = h('p', { class: 'mhint', id: 'mh-' + o.id, role: 'status', hidden: true });
  inp.setAttribute('aria-describedby', hint.id);
  const read = () => store.parseMoneyExpr(inp.value, o.label || '金額');
  const show = (r) => {
    hint.hidden = r.ok;
    hint.textContent = r.ok ? '' : r.reason + '，這一格先當成還沒填。';
    inp.setAttribute('aria-invalid', r.ok ? 'false' : 'true');
  };
  const handle = () => {
    if (!inp.isConnected) return; // 畫面已經重畫過，這個欄位是舊的
    const r = read();
    show(r);
    o.onSet(r.ok ? r.total : 0, r);
  };
  inp.addEventListener('input', (e) => { if (!e.isComposing) handle(); });
  inp.addEventListener('compositionend', handle);
  inp.addEventListener('focus', () => selectLater(inp));
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
  inp.addEventListener('blur', () => {
    const r = read();
    show(r);
    if (r.ok) inp.value = r.total > 0 ? money(r.total) : '';
  });
  inp.hintEl = hint;
  return inp;
}

function stepper(o) {
  const inp = h('input', { ...textAttrs, class: 'fill', id: o.id, 'data-fk': o.fk, placeholder: '0' });
  inp.value = o.value > 0 ? String(o.value) : '';
  const minus = h('button', { type: 'button', class: 'step', 'aria-label': '減少' + o.aria, 'data-fk': o.fk + '-m' }, icon('minus'));
  const plus = h('button', { type: 'button', class: 'step', 'aria-label': '增加' + o.aria, 'data-fk': o.fk + '-p' }, icon('plus'));
  let last = o.value; // 最後一個合法的人數（欄位裡是不合法內容時，加減鈕以它為準）
  const sync = (n) => { minus.disabled = n <= 0; plus.disabled = n >= o.max; };
  sync(o.value);
  const now = () => { const r = parseDigits(inp.value, o.max); return r.bad === 'max' ? o.max : r.bad ? last : r.n; };
  const apply = (n) => { inp.value = n > 0 ? String(n) : ''; setCountBad(inp, null, o.max); last = n; sync(n); o.onSet(n); };
  minus.addEventListener('click', () => apply(Math.max(0, now() - 1)));
  plus.addEventListener('click', () => apply(Math.min(o.max, now() + 1)));
  bindNumber(inp, o.max, (n) => { last = n; sync(n); o.onSet(n); }, (bad, entry) => { if (entry !== undefined) last = entry; sync(last); if (bad === 'max') plus.disabled = true; });
  inp.setValue = (n) => { inp.value = n > 0 ? String(n) : ''; last = n; sync(n); }; // 人數從別處變動（例如勾選這張有誰參加）時用
  return h('div', { class: 'stepper' }, minus, inp, plus);
}

/* ----- 帳單卡 ----- */

const CASES = [
  ['parts', '有一部分人需額外付費', '有些錢只有部分人要出'],
  ['free', '有人不用付', '他的錢由大家分，或由別人幫忙付'],
  ['fixed', '有人付固定金額', '不管總共多少，他只付這個數'],
];

const line = (...kids) => h('div', { class: 'line', 'data-line': '' }, kids);

/* ----- 名字膠囊（有名單時，句子裡取代「▢ 人」） ----- */

// kind：part（這筆額外付費的人）、free（不用付）、cover（幫忙付）、fixed（固定金額）、who（這張帳單有誰）
function cgroup(kind, bid, pid) {
  return h('div', { class: 'cgroup', 'data-chips': '', 'data-kind': kind, 'data-bill': bid, 'data-part': pid || null },
    h('p', { class: 'chead' }, h('span', { class: 'cnt' })), h('div', { class: 'pills', role: 'group' }),
    h('p', { class: 'locknote', hidden: true }, '斜線的人已經設成不用付或固定金額，要先在那裡取消才能選。'));
}

function chipSelected(b, kind, pid) {
  if (kind === 'who') return b.who;
  if (kind === 'part') { const p = partOf(b, pid); return p ? p.who : []; }
  if (kind === 'free') return b.free.who;
  if (kind === 'cover') return b.free.coverWho;
  return b.fixed.who;
}

// 不能選的人：已經是「不用付」或「固定金額」的人，在別的句子裡不可選
function chipDisabled(b, kind) {
  if (kind === 'part' || kind === 'cover') return new Set([...frOn(b), ...fxOn(b)]);
  if (kind === 'free') return new Set(fxOn(b));
  if (kind === 'fixed') return new Set(frOn(b));
  return new Set();
}

function fillChips(el) {
  const m = quickModel();
  const b = billOf(el.dataset.bill);
  if (!b || !isNamed(m) || !Array.isArray(b.who)) return;
  const kind = el.dataset.kind;
  const pid = el.dataset.part;
  const sel = new Set(chipSelected(b, kind, pid));
  const dis = chipDisabled(b, kind);
  const a = document.activeElement;
  const fk = a && el.contains(a) && a.dataset ? a.dataset.fk : null;
  const ids = kind === 'who' ? m.roster.map((r) => r.id) : b.who;
  const box = el.querySelector('.pills');
  box.replaceChildren();
  for (const id of ids) {
    const on = sel.has(id);
    const nm = rosterName(m.roster, id);
    const locked = dis.has(id) && !on;
    const lastOne = kind === 'who' && on && sel.size <= 1; // 至少要留 1 人
    box.append(h('button', {
      type: 'button', class: 'pill', 'aria-pressed': on ? 'true' : 'false', disabled: locked || lastOne,
      title: locked ? '這個人已經在別的句子裡設定了' : lastOne ? '至少要留 1 人' : null,
      'data-act': 'chip', 'data-kind': kind, 'data-bill': b.id, 'data-part': pid || null, 'data-id': id,
      'data-fk': ['pill', kind, b.id, pid || '', id].join('-'),
    }, on ? icon('check') : null, nm));
  }
  if (ids.length === 0) box.append(h('span', { class: 'note' }, '先把上面的人數填好'));
  el.querySelector('.cnt').textContent = '已選 ' + sel.size + ' 人';
  el.querySelector('.locknote').hidden = !ids.some((id) => dis.has(id) && !sel.has(id));
  if (fk) focusFk(fk);
}

function toggleChip(el) {
  const m = quickModel();
  const b = billOf(el.dataset.bill);
  if (!b || !isNamed(m)) return;
  const id = el.dataset.id;
  const kind = el.dataset.kind;
  const has = (arr) => arr.includes(id);
  const flip = (arr) => (has(arr) ? arr.filter((x) => x !== id) : arr.concat(id));
  // 點膠囊會讓結果區、說明行變高變矮：記下被點的那顆在畫面上的位置，重畫後捲回去，讓它留在原地
  const sel = '[data-fk="' + el.dataset.fk + '"]';
  const before = el.getBoundingClientRect().top;
  edit(() => {
    if (kind === 'who') {
      if (has(b.who)) { if (b.who.length <= 1) return; removeFromBill(m, b, id, false); } else b.who = b.who.concat(id);
    } else if (kind === 'part') {
      const p = partOf(b, el.dataset.part);
      if (p) p.who = flip(p.who);
    } else if (kind === 'free') {
      if (has(b.free.who)) b.free.who = b.free.who.filter((x) => x !== id);
      else { b.free.who = b.free.who.concat(id); stripPerson(b, id, true); }
    } else if (kind === 'cover') {
      b.free.coverWho = flip(b.free.coverWho);
    } else if (kind === 'fixed') {
      if (has(b.fixed.who)) b.fixed.who = b.fixed.who.filter((x) => x !== id);
      else { b.fixed.who = b.fixed.who.concat(id); stripPerson(b, id, false); }
    }
    syncBill(m, b);
  });
  const nu = document.querySelector(sel);
  if (nu) {
    const d = nu.getBoundingClientRect().top - before;
    if (Math.abs(d) > 0.5) window.scrollBy({ top: d, left: 0, behavior: 'instant' });
  }
}
const echoP = (key) => h('p', { class: 'resp', 'data-echo': key, hidden: true }, icon('reply'), h('span', { class: 'etxt' }));

// 只有小標籤或勾了服務費時才需要這一行；只填一個數字時，欄位裡看得到，不重複顯示
function partTotalText(p) {
  const a = partAmount(p);
  const tags = p.items.length - (live.has(p.id) ? 1 : 0);
  if (!(a > 0) || (tags <= 0 && !p.service)) return '';
  return '合計 ' + money(a) + ' 元' + (p.service ? '（含一成服務費）' : '');
}

function partItem(b, p, i) {
  const bid = b.id;
  const pid = p.id;
  const many = b.parts.length >= 2;
  const lab = h('div', { class: 'lab' + (i > 0 ? ' has-del' : ''), hidden: !(many || (typeof p.name === 'string' && p.name.trim() !== '')) },
    h('span', { 'data-part-label': pid }, partLabel(b, pid)),
    i > 0 ? h('button', { type: 'button', class: 'del', 'data-act': 'part-del', 'data-bill': bid, 'data-part': pid, 'data-fk': 'pdel-' + pid, 'aria-label': '刪除' + partLabel(b, pid) }, icon('trash')) : null);

  if (!live.has(pid) && !blankNext.has(pid) && p.items.length > 0) live.add(pid); // 重畫（含重新整理）後，最後一個金額放回句子的空格裡
  const isLive = live.has(pid);
  const committed = isLive ? p.items.slice(0, -1) : p.items;
  const liveVal = isLive ? p.items[p.items.length - 1] : 0;
  const atMax = !isLive && p.items.length >= QUICK_LIMITS.MAX_ITEMS;
  const amt = moneyField({
    id: 'amt-' + pid, fk: 'amt-' + pid, value: liveVal, aria: '這一筆的金額（元）', placeholder: '多少', cls: 'w1',
    onSet: (n) => {
      edit(() => {
        const cp = partOf(billOf(bid), pid);
        if (!cp) return;
        const lv = live.has(pid);
        if (lv) {
          if (n > 0) cp.items[cp.items.length - 1] = n;
          else { cp.items.pop(); live.delete(pid); }
        } else if (n > 0 && cp.items.length < QUICK_LIMITS.MAX_ITEMS) {
          cp.items.push(n);
          live.add(pid);
          blankNext.delete(pid);
        }
      });
      const btn = document.querySelector('[data-fk="padd-' + pid + '"]');
      if (btn) btn.disabled = !(n > 0);
    },
  });
  if (atMax) amt.disabled = true;
  const named = isNamed(quickModel());
  const ppl = named ? null : digitField({
    id: 'pp-' + pid, fk: 'pp-' + pid, value: p.people, max: MAXN.people, aria: '幾個人額外付費', cls: 'w2',
    onSet: (n) => edit(() => { const cp = partOf(billOf(bid), pid); if (cp) cp.people = n; }),
  });

  const svc = h('input', { type: 'checkbox', id: 'svc-' + pid, 'data-fk': 'svc-' + pid });
  svc.checked = p.service === true;
  svc.addEventListener('change', () => edit(() => { const cp = partOf(billOf(bid), pid); if (cp) cp.service = svc.checked; }));

  const addBtn = h('button', { type: 'button', class: 'btn small padd', 'data-act': 'part-add', 'data-bill': bid, 'data-part': pid, 'data-fk': 'padd-' + pid }, icon('plus'), '加');
  if (!(liveVal > 0)) addBtn.disabled = true;
  const chips = h('ul', { class: 'items', 'aria-label': '已加入的金額' },
    committed.map((v, k) => h('li', null, h('button', {
      type: 'button', class: 'item-del', 'data-act': 'part-del-item', 'data-bill': bid, 'data-part': pid, 'data-idx': k,
      'data-fk': 'pit-' + pid + '-' + k, 'aria-label': '刪除 ' + money(v) + ' 元',
    }, money(v) + ' 元 ', h('span', { 'aria-hidden': 'true' }, '✕')))));

  const nameInp = h('input', { type: 'text', class: 'nm-inp', id: 'pn-' + pid, 'data-fk': 'pn-' + pid, maxlength: PART_NAME_MAX, autocomplete: 'off', placeholder: '第 ' + (i + 1) + ' 筆', 'aria-label': '這一筆的名稱' });
  nameInp.value = typeof p.name === 'string' ? p.name : '';
  const applyName = () => {
    const v = Array.from(nameInp.value).slice(0, PART_NAME_MAX).join('');
    edit(() => { const cp = partOf(billOf(bid), pid); if (cp) cp.name = v; });
    const cb = billOf(bid);
    const l = document.querySelector('[data-part-label="' + pid + '"]');
    if (l) {
      l.textContent = partLabel(cb, pid);
      l.parentElement.hidden = !(cb.parts.length >= 2 || v.trim() !== '');
    }
  };
  nameInp.addEventListener('input', (e) => { if (!e.isComposing) applyName(); });
  nameInp.addEventListener('compositionend', applyName);
  nameInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameInp.blur(); } });
  nameInp.addEventListener('blur', () => {
    const t = Array.from(nameInp.value.trim()).slice(0, PART_NAME_MAX).join('');
    if (t !== nameInp.value) { nameInp.value = t; applyName(); }
  });

  const moreId = 'more-' + pid;
  const more = h('details', { class: 'more', 'data-id': moreId },
    h('summary', { class: 'link' }, icon('dots'), '更多（這筆另加一成、好幾個金額相加、取名字）'),
    h('div', { class: 'more-body' },
      h('label', { class: 'chk', for: 'svc-' + pid }, svc, h('span', null, '這筆另加一成')),
      h('div', { class: 'addmore' },
        h('p', { class: 'note' }, atMax ? '最多加 ' + QUICK_LIMITS.MAX_ITEMS + ' 個金額。' : '好幾個金額要相加：把上面的金額填好，按「加」放進清單，再填下一個。'),
        committed.length > 0 ? chips : null,
        addBtn),
      h('label', { class: 'nm-lbl', for: 'pn-' + pid }, '取名字（最多 ' + PART_NAME_MAX + ' 字）'),
      nameInp));
  if (ui.open.has(moreId)) more.open = true;

  return h('div', { class: 'item', 'data-part-card': pid },
    lab,
    named
      ? line(h('span', null, '其中'), amt, h('span', null, '元，由這些人額外付費：'))
      : line(h('span', null, '其中'), amt, h('span', null, '元，由'), ppl, h('span', null, '人額外付費')),
    amt.hintEl,
    named ? cgroup('part', bid, pid) : null,
    echoP('part:' + pid),
    h('p', { class: 'ptotal', 'data-part-total': pid }, partTotalText(p)),
    more);
}

function partsBody(b) {
  const full = b.parts.length >= QUICK_LIMITS.MAX_PARTS;
  return [
    b.parts.map((p, i) => partItem(b, p, i)),
    h('button', { type: 'button', class: 'btn small addpart', 'data-act': 'part-new', 'data-bill': b.id, 'data-fk': 'pnew-' + b.id, disabled: full }, icon('plus'), '再加一筆'),
    full ? h('p', { class: 'note' }, '最多 ' + QUICK_LIMITS.MAX_PARTS + ' 筆。') : null,
  ];
}

function freeBody(b) {
  const bid = b.id;
  const f = b.free;
  if (isNamed(quickModel())) {
    const seg2 = (v, text) => h('button', {
      type: 'button', class: f.by === v ? 'on' : null, 'aria-pressed': f.by === v ? 'true' : 'false',
      'data-act': 'free-by', 'data-by': v, 'data-bill': bid, 'data-fk': 'by-' + v + '-' + bid,
    }, text);
    const out2 = [
      h('p', { class: 'sentence', 'data-line': '' }, '這些人不用付：'),
      cgroup('free', bid),
      h('p', { class: 'sentence', 'data-line': '' }, '他們的錢：'),
      h('div', { class: 'seg', role: 'group', 'aria-label': '他們的錢怎麼辦' }, seg2('all', '大家一起分'), seg2('cover', '由別人幫忙付')),
    ];
    if (f.by === 'cover') out2.push(h('p', { class: 'sentence', 'data-line': '' }, '由這些人幫忙付：'), cgroup('cover', bid));
    out2.push(echoP('free'));
    return out2;
  }
  const seg = (v, text) => h('button', {
    type: 'button', class: f.by === v ? 'on' : null, 'aria-pressed': f.by === v ? 'true' : 'false',
    'data-act': 'free-by', 'data-by': v, 'data-bill': bid, 'data-fk': 'by-' + v + '-' + bid,
  }, text);
  const out = [
    line(h('span', null, '有'),
      digitField({ id: 'fc-' + bid, fk: 'fc-' + bid, value: f.count, max: MAXN.people, aria: '幾個人不用付', cls: 'w2', onSet: (n) => edit(() => { billOf(bid).free.count = n; }) }),
      h('span', null, '人不用付，他們的錢：')),
    h('div', { class: 'seg', role: 'group', 'aria-label': '他們的錢怎麼辦' }, seg('all', '大家一起分'), seg('cover', '由別人幫忙付')),
  ];
  if (f.by === 'cover') {
    out.push(line(h('span', null, '由'),
      digitField({ id: 'fa-' + bid, fk: 'fa-' + bid, value: f.coverers, max: MAXN.people, aria: '幾個人幫忙付', cls: 'w2', onSet: (n) => edit(() => { billOf(bid).free.coverers = n; }) }),
      h('span', null, '人幫忙付')));
  }
  out.push(echoP('free'));
  return out;
}

function fixedBody(b) {
  const bid = b.id;
  const amt = moneyField({
    id: 'xa-' + bid, fk: 'xa-' + bid, value: b.fixed.amount, aria: '每人固定付多少（元）', placeholder: '多少', cls: 'w1',
    onSet: (n) => edit(() => { billOf(bid).fixed.amount = n; }),
  });
  if (isNamed(quickModel())) {
    return [
      line(h('span', null, '這些人每人固定付'), amt, h('span', null, '元：')),
      amt.hintEl,
      cgroup('fixed', bid),
      echoP('fixed'),
    ];
  }
  return [
    line(h('span', null, '有'),
      digitField({ id: 'xc-' + bid, fk: 'xc-' + bid, value: b.fixed.count, max: MAXN.people, aria: '幾個人付固定金額', cls: 'w2', onSet: (n) => edit(() => { billOf(bid).fixed.count = n; }) }),
      h('span', null, '人，每人固定付'), amt, h('span', null, '元')),
    amt.hintEl,
    echoP('fixed'),
  ];
}

const caseOpen = (b, m) => (isNamed(quickModel()) ? b.on.includes(m) : b.mode === m);

function caseNode(b, m, title, sub) {
  const bid = b.id;
  if (!caseOpen(b, m)) {
    return h('div', { class: 'case', 'data-case': m },
      h('button', { type: 'button', class: 'hd', 'aria-expanded': 'false', 'data-act': 'mode', 'data-mode': m, 'data-bill': bid, 'data-fk': 'case-' + m + '-' + bid },
        h('span', { class: 'ic' }, icon(m)),
        h('span', { class: 'tx' }, h('b', null, title), h('small', null, sub)),
        h('span', { class: 'go' }, icon('chev'))));
  }
  const body = m === 'parts' ? partsBody(b) : m === 'free' ? freeBody(b) : fixedBody(b);
  return h('div', { class: 'case open', 'data-case': m },
    h('div', { class: 'hd' },
      h('span', { class: 'ic' }, icon(m)),
      h('span', { class: 'tx' }, h('b', null, title)),
      h('button', { type: 'button', class: 'cancel', 'data-act': 'case-cancel', 'data-mode': m, 'data-bill': bid, 'data-fk': 'cancel-' + m + '-' + bid }, icon('close'), '取消')),
    h('div', { class: 'body' }, body));
}

function billCard(b, i, n) {
  const bid = b.id;
  const many = n > 1;
  const people = stepper({
    id: 'ppl-' + bid, fk: 'ppl-' + bid, value: b.people, max: MAXN.people, aria: '人數',
    onSet: (v) => {
      const m = quickModel();
      if (!isNamed(m)) { edit(() => { billOf(bid).people = v; }); return; }
      edit(() => setPeopleNamed(m, billOf(bid), v));
      if (!isNamed(quickModel())) render(); // 名單空了，回到沒有名單的畫面
    },
  });
  const total = moneyField({
    id: 'tot-' + bid, fk: 'tot-' + bid, value: b.total, aria: '總共多少錢（元）', placeholder: '0', cls: 'tot',
    onSet: (v) => edit(() => { billOf(bid).total = v; }),
  });
  const round = h('input', { type: 'checkbox', id: 'rt-' + bid, role: 'switch', 'data-fk': 'rt-' + bid });
  round.checked = b.roundTens === true;
  round.addEventListener('change', () => edit(() => { billOf(bid).roundTens = round.checked; }));

  return h('section', { class: 'qbill', 'data-bill': bid, 'aria-label': many ? '第 ' + (i + 1) + ' 張帳單' : '帳單' },
    many ? h('div', { class: 'qhead' }, h('h2', { class: 'qtitle' }, '第 ' + (i + 1) + ' 張帳單'),
      h('button', { type: 'button', class: 'btn danger small', 'data-act': 'bill-del', 'data-bill': bid, 'data-fk': 'bdel-' + bid }, '刪除這張')) : null,
    h('div', { class: 'qf', 'data-line': '' }, h('label', { class: 'lbl', for: 'ppl-' + bid }, '幾個人'), people),
    h('div', { class: 'qf', 'data-line': '' }, h('label', { class: 'lbl', for: 'tot-' + bid }, '總共多少錢'), h('div', { class: 'money' }, total, h('span', null, '元'))),
    total.hintEl,
    isNamed(quickModel()) && n > 1 ? h('div', { class: 'whorow' }, h('p', { class: 'sub' }, '這張有誰參加：'), cgroup('who', bid)) : null,
    h('div', { class: 'result', 'data-result': bid, 'aria-live': 'polite' }),
    h('div', { class: 'how-wrap', 'data-how': bid, hidden: true }),
    h('div', { class: 'divider' }, '以下有特殊情況才需要'),
    h('div', { class: 'cases' }, CASES.map(([m, title, sub]) => caseNode(b, m, title, sub))),
    h('label', { class: 'sw', for: 'rt-' + bid }, h('span', { class: 'ic' }, icon('round')),
      h('span', { class: 't' }, '湊成整十', h('small', null, '把金額湊成 10 的倍數，比較好收錢')), round));
}

/* ----- 結果區 ----- */

const isWaiting = (res) => card.quickWaiting(res);

// 還沒填的空格有幾個（顯示「請把下面兩個空格填完」用）
function blanksLeft(b) {
  const z = (n) => (n > 0 ? 0 : 1);
  let k = 1;
  if (Array.isArray(b.who)) {
    // 有名單：每個開著的情況，還沒選人、還沒填金額的地方各算一個
    k = 0;
    if (b.on.includes('parts')) {
      let best = 0;
      for (const p of b.parts) {
        const t = z(partAmount(p)) + z(p.who.length);
        if (t === 0) { best = 0; break; }
        if (best === 0) best = t;
      }
      k += best || (b.parts.length === 0 ? 1 : 0);
    }
    if (b.on.includes('free')) k += z(b.free.who.length) + (b.free.by === 'cover' ? z(b.free.coverWho.length) : 0);
    if (b.on.includes('fixed')) k += z(b.fixed.who.length) + z(b.fixed.amount);
    return Math.max(1, k);
  }
  if (b.mode === 'parts') {
    for (const p of b.parts) {
      const t = z(partAmount(p)) + z(p.people);
      if (t > 0) { k = t; break; }
    }
  } else if (b.mode === 'free') {
    k = b.free.by === 'cover' ? z(b.free.count) + z(b.free.coverers) : z(b.free.count);
  } else if (b.mode === 'fixed') {
    k = z(b.fixed.count) + z(b.fixed.amount);
  }
  return Math.max(1, k);
}

const waitText = (k, named) => (named ? '請把下面還沒填的地方填完'
  : k >= 3 ? '請把下面三個空格填完' : k === 2 ? '請把下面兩個空格填完' : '請把下面的空格填完');

function measureTall(el) {
  if (document.body.classList.contains('typing')) return; // 打字時結果縮成一行，量不準；結束後會再量
  el.classList.toggle('tall', el.offsetHeight > STICKY_MAX);
}

function fillResult(el, bill, res, roster) {
  const wasTall = el.classList.contains('tall');
  el.replaceChildren();
  el.classList.remove('tall');
  const full = h('div', { class: 'r-full' });
  const cmp = h('p', { class: 'r-compact' });
  el.append(full, cmp);
  if (res.ok === false) {
    if (res.error === 'EMPTY') {
      el.dataset.state = 'empty';
      full.append(h('p', { class: 'r-hint' }, '填好上面兩格，這裡就會出現每人要付多少'));
      return;
    }
    el.dataset.state = 'error';
    const t = errorText(res, bill);
    full.append(h('p', { class: 'r-err' }, t));
    cmp.textContent = t;
    measureTall(el);
    return;
  }
  if (isWaiting(res)) {
    // 選了特殊情況但還沒填完：不顯示大字金額，免得被當成答案
    el.dataset.state = 'wait';
    const t = waitText(blanksLeft(bill), Array.isArray(bill.who));
    full.append(h('p', { class: 'mid2' }, t));
    const ev = computeBill({ ...bill, mode: 'even' });
    const each = ev.ok ? ev.rows[0].amount : 0;
    if (each > 0) full.append(h('p', { class: 'sm' }, '不算這個的話，每人 ' + money(each) + ' 元'));
    cmp.textContent = t;
    measureTall(el);
    return;
  }
  el.dataset.state = 'ok';
  const list = resultRows(bill, res, roster);
  const rows = list.filter((r) => !r.hint);
  const amountText = (r) => (r.each ? '每人 ' : '') + (r.plus ? '＋' : '') + money(r.amount) + ' 元';
  if (rows.length === 1 && rows[0].who === '' && rows[0].note === '') {
    const r = rows[0];
    full.append(h('p', { class: 'big' }, r.each ? '每人 ' : null, h('span', { class: 'amt' }, money(r.amount)), ' 元'));
  } else {
    const box = h('div', { class: 'rows' + (rows.length >= 3 ? ' s3' : '') });
    for (const r of rows) {
      box.append(h('p', { class: 'r-row', 'data-who': r.who, 'data-amount': r.amount, 'data-each': r.each ? '1' : '0' },
        h('span', { class: 'rw' }, r.who), ' ', h('em', { class: r.names ? 'names' : null }, r.names || r.note), ' ', h('b', null, amountText(r))));
    }
    full.append(box);
  }
  for (const r of list) if (r.hint) full.append(h('p', { class: 'sm' }, r.note));
  const ok = res.diff === 0;
  full.append(h('p', { class: 'ok' + (ok ? '' : ' info') }, icon(ok ? 'check' : 'info'), collectedLine(res)));
  cmp.textContent = compactLine(bill, res, roster);
  if (wasTall && document.body.classList.contains('typing')) el.classList.add('tall');
  measureTall(el);
}

// 人數欄裡的內容不能用：結果區不顯示金額，改成等待樣式
function fillResultBad(el) {
  el.replaceChildren();
  el.classList.remove('tall');
  const t = '人數改好，這裡就會出現金額';
  el.dataset.state = 'wait';
  el.append(h('div', { class: 'r-full' }, h('p', { class: 'mid2' }, t)), h('p', { class: 'r-compact' }, t));
  measureTall(el);
}

function fillHow(wrap, bill, res, hide) {
  const show = res.ok === true && !isWaiting(res) && !hide;
  wrap.hidden = !show;
  if (!show) return;
  let d = wrap.querySelector('details');
  if (!d) {
    const id = 'how-' + bill.id;
    d = h('details', { class: 'how2', 'data-id': id },
      h('summary', null, '怎麼算的', h('span', { class: 'chev', 'aria-hidden': 'true' })), h('div', { class: 'how-body' }));
    if (ui.open.has(id)) d.open = true;
    wrap.append(d);
  }
  d.querySelector('.how-body').replaceChildren(...explainBill(bill, res).map((l) => h('p', null, l)));
}

function historyText(a) {
  if (a.quick) {
    const bs = a.quick.bills;
    if (bs.length === 1) {
      const b = bs[0];
      return b.people > 0 && b.total > 0 ? b.people + ' 人・' + money(b.total) + ' 元' : '還沒填完';
    }
    return bs.length + ' 張帳單・共 ' + money(bs.reduce((s, b) => s + b.total, 0)) + ' 元';
  }
  const r = computeActivity(a);
  return a.members.length + ' 位成員・共 ' + money(r.total) + ' 元';
}

function fillHistory() {
  const ul = $('#hist');
  if (!ul) return;
  ul.replaceChildren();
  const list = st.activities.slice().reverse();
  $('#histEmpty').hidden = list.length > 0;
  for (const a of list) {
    const isCur = a.id === ui.recId;
    ul.append(h('li', { class: 'hrow' + (isCur ? ' cur' : '') },
      h('button', { type: 'button', class: 'hopen', 'data-act': 'open-record', 'data-id': a.id, 'data-fk': 'rec-' + a.id, 'aria-current': isCur ? 'true' : null },
        h('span', { class: 'ht' }, a.title, a.quick ? null : h('em', { class: 'legacy' }, '舊版紀錄'), isCur ? h('em', null, '目前這筆') : null), h('span', { class: 'hs' }, historyText(a))),
      h('button', { type: 'button', class: 'btn danger small', 'data-act': 'delete-record', 'data-id': a.id, 'data-fk': 'delrec-' + a.id, 'aria-label': '刪除 ' + a.title }, '刪除')));
  }
}

function updateAll() {
  const m = quickModel();
  const rc = computeRecord(m);
  const roster = isNamed(m) ? m.roster : undefined;
  if (roster) {
    for (const el of document.querySelectorAll('[data-chips]')) fillChips(el);
    for (const b of m.bills) {
      const pi = document.getElementById('ppl-' + b.id);
      if (pi && pi.setValue && document.activeElement !== pi && !pi.dataset.bad) pi.setValue(b.people);
    }
  }
  const badBill = new Set();
  m.bills.forEach((b, i) => {
    const res = rc.bills[i];
    const bc = document.querySelector('.qbill[data-bill="' + b.id + '"]');
    const bad = !!(bc && bc.querySelector('input[data-bad]'));
    if (bad) badBill.add(i);
    const el = document.querySelector('[data-result="' + b.id + '"]');
    if (el) { if (bad) fillResultBad(el); else fillResult(el, b, res, roster); }
    const how = document.querySelector('[data-how="' + b.id + '"]');
    if (how) fillHow(how, b, res, bad);
    const waiting = bad || (res.ok === true && isWaiting(res));
    if (bc) {
      for (const e of bc.querySelectorAll('[data-echo]')) {
        const t = waiting ? '' : echoLine(b, res, e.dataset.echo);
        e.hidden = t === '';
        e.querySelector('.etxt').textContent = t;
      }
    }
    for (const p of b.parts) {
      const t = document.querySelector('[data-part-total="' + p.id + '"]');
      if (t) t.textContent = partTotalText(p);
    }
  });
  const sum = $('#qsum');
  if (sum) {
    sum.hidden = !rc.sum;
    $('#qsumAmt').textContent = rc.sum ? money(rc.sum.each) : '';
    $('#qsumNote').textContent = rc.sum ? '兩張以上的帳單人數都一樣，把每張帳單的每人金額加起來，一共 ' + rc.sum.people + ' 人。' : '';
  }
  const okAny = rc.bills.some((r, i) => r.ok && !isWaiting(r) && !badBill.has(i));
  const cb = $('[data-fk="open-card"]');
  if (cb) cb.disabled = !okAny;
  const why = $('#qWhy');
  if (why) {
    why.hidden = okAny;
    why.textContent = rc.bills.some((r) => r.ok) ? '把上面的空格填完，就能做結算卡。' : '填好人數和總金額，就能做結算卡。';
  }
  fillHistory();
  fillRecord(rc);
  refreshBackup();
  keepClear();
}

/* ----- 記下來：名稱與名單 ----- */

function recNameInput() {
  const inp = h('input', { type: 'text', id: 'recName', class: 'rec-name', maxlength: LIMITS.MAX_TITLE, autocomplete: 'off', enterkeyhint: 'done', 'data-fk': 'rec-name', 'aria-label': '這筆紀錄的名稱' });
  const apply = () => {
    const t = Array.from(inp.value.trim()).slice(0, LIMITS.MAX_TITLE).join('');
    const a = cur();
    if (!t || !a || !a.quick) return; // 清空時先不存，離開欄位時會放回原本的名稱
    edit(() => { cur().title = t; });
  };
  inp.addEventListener('input', (e) => { if (!e.isComposing) apply(); });
  inp.addEventListener('compositionend', apply);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
  inp.addEventListener('focus', () => selectLater(inp));
  inp.addEventListener('blur', () => { const a = cur(); if (a) inp.value = a.title; });
  return inp;
}

function recSection() {
  return h('section', { class: 'sec rec', id: 'rec', 'aria-labelledby': 'h-rec', hidden: true },
    h('h2', { class: 'rec-title', id: 'h-rec' }, icon('list'), '記下來', h('small', null, '（可以不做）')),
    h('div', { class: 'namerow', 'data-line': '' },
      h('label', { class: 'k', for: 'recName' }, '名稱'),
      h('div', { class: 'v' }, recNameInput(), icon('edit'))),
    h('div', { id: 'recBody' }));
}

function recBodyNodes(m, rc) {
  if (!isNamed(m)) {
    const k = Math.max(0, ...m.bills.map((b) => b.people));
    return [
      h('button', { type: 'button', class: 'btn ghost wide roster-btn', 'data-act': 'roster-on', 'data-fk': 'roster-on', disabled: !(k >= 1) }, icon('users'), '輸入名單（可以指定是誰）'),
      h('p', { class: 'note rec-note' }, '輸入名單後，可以選是哪幾個人，也可以同時有兩種特殊情況。'),
    ];
  }
  const amountOf = new Map();
  if (rc.persons) for (const p of rc.persons) amountOf.set(p.id, p.amount);
  const ul = h('ul', { class: 'paylist one' });
  m.roster.forEach((r) => {
    const amt = amountOf.get(r.id);
    ul.append(h('li', { class: amt === 0 ? 'zero' : null },
      h('button', { type: 'button', class: 'nm', 'data-act': 'rename-member', 'data-id': r.id, 'data-fk': 'nm-' + r.id, 'aria-label': rosterName(m.roster, r.id) + '，點一下改名' },
        rosterName(m.roster, r.id), icon('edit')),
      h('b', null, amt === undefined ? '—' : money(amt) + ' 元')));
  });
  const off = canRosterOff(m);
  return [
    h('p', { class: 'sub' }, '每個人要付', h('span', { class: 'note' }, '點名字可以改')),
    ul,
    h('div', { class: 'off-row' },
      h('button', { type: 'button', class: 'linkbtn', 'data-act': 'roster-off', 'data-fk': 'roster-off', disabled: !off }, '不用名單了'),
      off ? null : h('span', { class: 'note' }, '同時有兩種情況時需要名單')),
  ];
}

function fillRecord(rc) {
  const sec = $('#rec');
  if (!sec) return;
  const act = cur();
  const has = !!(act && act.quick);
  sec.hidden = !has;
  if (!has) return;
  const nm = $('#recName');
  if (document.activeElement !== nm) nm.value = act.title;
  $('#recBody').replaceChildren(...recBodyNodes(act.quick, rc));
}

/* ----- 打字狀態與鍵盤 ----- */
/*
 * 做法（PLAN_v3.md 3.2）：打字時不重畫輸入欄；任一文字輸入欄拿到焦點，<body> 加 typing，
 * 結果縮成一行、main 底部多留 60vh，並立刻把正在輸入的那一句捲到縮小後結果區的正下方。
 * 不去量鍵盤高度、不搬動黏頂元素：欄位一律放在畫面上半部，鍵盤自然在下半部。
 */

const isTextInput = (el) => !!el && el.tagName === 'INPUT' && el.type === 'text';
const inBill = (el) => isTextInput(el) && !!el.closest('.qbill');
const inApp = (el) => isTextInput(el) && !!el.closest('.qapp'); // 帳單裡的欄位，加上最下面「記下來」的名稱欄
let typingTimer = 0;

function typingOn() {
  clearTimeout(typingTimer);
  document.body.classList.add('typing');
}

function typingMaybeOff() {
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    if (inApp(document.activeElement)) return;
    document.body.classList.remove('typing');
    for (const el of document.querySelectorAll('.result')) measureTall(el);
  }, TYPING_EXIT_MS);
}

function syncTyping() {
  if (inApp(document.activeElement)) typingOn();
  else if (document.body.classList.contains('typing')) typingMaybeOff();
}

// 把這個輸入欄所在的那一句，放到縮小後結果區的正下方（結果區黏在頂端，所以位置是固定的）
function placeInput(inp) {
  const bc = inp.closest('.qbill');
  const res = bc && bc.querySelector('.result');
  const unit = inp.closest('[data-line]') || inp;
  if (!bc) {
    // 帳單外面的欄位（名稱）：那裡沒有黏頂的結果區，直接放到畫面上半部
    const gap = unit.getBoundingClientRect().top - (STICKY_TOP + PLACE_GAP + 20);
    if (Math.abs(gap) > 1) window.scrollBy({ top: gap, left: 0, behavior: 'instant' });
    return;
  }
  if (!res) return;
  // 結果區上方的欄位（幾個人、總共多少錢）本來就在畫面上半部，不用捲
  if (unit.compareDocumentPosition(res) & Node.DOCUMENT_POSITION_FOLLOWING) return;
  const gap = unit.getBoundingClientRect().top - (STICKY_TOP + res.offsetHeight + PLACE_GAP);
  if (Math.abs(gap) > 1) window.scrollBy({ top: gap, left: 0, behavior: 'instant' });
}

// 打字中結果變高（例如錯誤說明變兩行）而蓋住正在輸入的那一句時，把它再推回結果區下面
function keepClear() {
  const a = document.activeElement;
  if (!inBill(a) || !document.body.classList.contains('typing')) return;
  const res = a.closest('.qbill').querySelector('.result');
  const unit = a.closest('[data-line]') || a;
  if (!res || unit.compareDocumentPosition(res) & Node.DOCUMENT_POSITION_FOLLOWING) return;
  const over = unit.getBoundingClientRect().top - res.getBoundingClientRect().bottom;
  if (over < 0) window.scrollBy({ top: over - PLACE_GAP, left: 0, behavior: 'instant' });
}

document.addEventListener('focusin', (e) => {
  if (!inApp(e.target)) return;
  typingOn();
  placeInput(e.target);
});

document.addEventListener('focusout', (e) => {
  if (inApp(e.target)) typingMaybeOff();
});

/* ----- 整頁 ----- */

function captureFocus() {
  const a = document.activeElement;
  if (!a || !a.dataset || !a.dataset.fk) return null;
  let s = null;
  let e = null;
  try { s = a.selectionStart; e = a.selectionEnd; } catch (err) { /* 沒有游標位置 */ }
  return { fk: a.dataset.fk, s, e };
}

function topBar() {
  return h('header', { class: 'qtop' },
    h('a', { class: 'back', href: '../index.html', 'aria-label': '返回生活小工具箱首頁' }, icon('back'), '返回'),
    h('h1', null, '多人分帳'));
}

// 預設收起的第三層內容（用 details；展開狀態記在 ui.open，重畫後保留）
function foldNode(id, title, body) {
  const d = h('details', { class: 't3d', 'data-id': 'fold-' + id },
    h('summary', null, title, h('span', { class: 'chev', 'aria-hidden': 'true' })),
    h('div', { class: 't3b' }, body));
  if (ui.open.has('fold-' + id)) d.open = true;
  return d;
}

function renderQuick() {
  const keep = captureFocus();
  const m = quickModel();
  const n = m.bills.length;
  const act = cur();

  const kids = [];
  kids.push(topBar());
  kids.push(h('div', { id: 'notices' }, noticesNode()));
  m.bills.forEach((b, i) => kids.push(billCard(b, i, n)));
  kids.push(h('section', { class: 'qsum', id: 'qsum', hidden: true, 'aria-live': 'polite' },
    h('p', { class: 'qsum-line' }, '每人合計 ', h('span', { class: 'amt', id: 'qsumAmt' }), ' 元'), h('p', { class: 'hint tiny', id: 'qsumNote' })));
  kids.push(h('div', { class: 'qacts' },
    h('button', { type: 'button', class: 'btn ghost small', 'data-act': 'bill-new', 'data-fk': 'bill-new', disabled: n >= QUICK_LIMITS.MAX_BILLS }, icon('bill'), '再加一張帳單'),
    h('p', { class: 'hint tiny' }, '另一張要分開算的帳單，加在這裡。'),
    h('button', { type: 'button', class: 'btn primary wide', 'data-act': 'open-card', 'data-fk': 'open-card' }, icon('card'), '產生結算卡'),
    h('p', { class: 'why', id: 'qWhy' }, '填好人數和總金額，就能做結算卡。'),
    h('button', { type: 'button', class: 'btn wide quiet', 'data-act': 'new-calc', 'data-fk': 'new-calc' }, '重新算一筆')));
  kids.push(recSection());
  // 第三層：看範例、之前算過的、備份、說明。視覺份量比上面的主要流程輕
  const third = [];
  third.push(foldNode('examples', '看範例', h('div', { class: 'exs', 'data-zone': 'examples' },
    h('p', { class: 'hint', style: 'margin-top:0' }, '點一個，看它怎麼算（會另外開一筆新的）。'),
    h('button', { type: 'button', class: 'btn ghost', 'data-act': 'example', 'data-ex': '1', 'data-fk': 'ex1' }, '聚餐平分'),
    h('button', { type: 'button', class: 'btn ghost', 'data-act': 'example', 'data-ex': '2', 'data-fk': 'ex2' }, '有人幫家人付'),
    h('button', { type: 'button', class: 'btn ghost', 'data-act': 'example', 'data-ex': '3', 'data-fk': 'ex3' }, '有人沒喝酒，另有一人不用付'))));
  third.push(h('section', { class: 'sec', 'aria-labelledby': 'h-hist' },
    h('h3', { class: 'sec-title', id: 'h-hist' }, '之前算過的'),
    h('p', { class: 'hint', id: 'histEmpty', style: 'margin-top:0' }, '算過的會自動記在這裡，之後點一下就能打開。'),
    h('ul', { class: 'hist', id: 'hist' })));
  third.push(backupNode(act));
  third.push(foldNode('help', '說明', frag(helpHtml('quick'))));
  kids.push(h('div', { class: 'third' }, third));

  const main = h('main', { class: 'app qapp', id: 'main', tabindex: '-1' }, kids);
  const stage = h('div', { class: 'stage solo' }, main);
  $('#app').replaceChildren(stage);
  updateAll();
  // 焦點只在「原本的焦點因為重畫被移除、現在落在 body」時才還給畫面；焦點已經在別的欄位或按鈕上就絕不搶
  const a = document.activeElement;
  const free = !a || a === document.body || a === document.documentElement;
  if (pendingFocus) {
    const el = $(pendingFocus);
    pendingFocus = null;
    if (el && free) {
      el.focus();
      focusApplied = true;
      try { if (el.select && el.type === 'text') el.select(); } catch (e) { /* 忽略 */ }
    }
  } else if (keep && free) {
    const el = document.querySelector('[data-fk="' + keep.fk + '"]:not([disabled])');
    if (el) {
      el.focus();
      try { if (keep.s !== null && keep.e !== null) el.setSelectionRange(keep.s, keep.e); } catch (err) { /* 忽略 */ }
    }
  }
  syncTyping();
}

async function openQuickCard() {
  return flow(async () => {
    const act = cur();
    const m = quickModel();
    const rc = computeRecord(m);
    if (!rc.bills.some((r) => r.ok && !card.quickWaiting(r))) return;
    const rec = act || { title: store.formatStamp(), createdAt: store.todayLocal(), quick: m };
    const d = $('#dlgCard');
    let canvas = null;
    $('#ckKinds').hidden = true;
    $('#ckHint').textContent = '每人要付多少一目了然，適合直接傳給大家。';
    $('#ckNote').textContent = '傳出去前，先看一眼金額對不對。';
    $('#ckShare').hidden = !shareSupported();
    d.onchange = null;
    const fileName = () => store.safeFileName(rec.title, rec.createdAt, '', 'png');
    $('#ckSave').onclick = async () => {
      try {
        downloadBlob(await card.canvasToBlob(canvas), fileName());
        toast('已存成圖片');
      } catch (e) { toast('存圖失敗，請再試一次'); }
    };
    $('#ckShare').onclick = async () => {
      try {
        const blob = await card.canvasToBlob(canvas);
        await navigator.share({ files: [new File([blob], fileName(), { type: 'image/png' })], title: rec.title });
      } catch (e) {
        if (!e || e.name !== 'AbortError') toast('這台裝置無法分享，請改用「存成圖片」');
      }
    };
    canvas = card.renderQuickCard(rec, rc);
    const img = $('#ckImg');
    img.src = canvas.toDataURL('image/png');
    img.alt = '結算卡：' + rec.title;
    await showModal(d, null);
  });
}

// 範例（v3 資料格式）。名稱欄位一律空白，字眼只出現在範例按鈕上
const EXAMPLES = {
  1: (m) => { const b = m.bills[0]; b.people = 4; b.total = 1000; },
  2: (m) => {
    const b = m.bills[0];
    b.people = 10; b.total = 12000; b.mode = 'free'; b.free = { by: 'cover', count: 3, coverers: 1 };
  },
  // 有名單、同時兩種情況：10 人 12,000，其中 3,500 由前 7 人額外付費，另有第 10 位不用付（大家一起分）
  3: (m) => {
    const b = m.bills[0];
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push(store.newId('m', ids));
    m.roster = ids.map((id) => ({ id, name: '' }));
    b.people = 10; b.total = 12000; b.mode = 'parts'; b.on = ['parts', 'free']; b.who = ids.slice();
    b.parts = [{ ...newPart(store.newId('p', [])), items: [3500], people: 7, who: ids.slice(0, 7) }];
    b.free = { by: 'all', count: 1, coverers: 0, who: [ids[9]], coverWho: [] };
    b.fixed = { count: 0, amount: 0, who: [] };
  },
};

// 一次只能算一種情況：按鈕的點擊處理函式裡要同步做事（focus 才會彈出鍵盤），所以不用 await
function askTwoCases(onBoth, onOnly) {
  const d = $('#dlgTwo');
  const go = (fn) => () => { d.close('go'); fn(); };
  $('#twBoth').onclick = go(onBoth);
  $('#twOnly').onclick = go(onOnly);
  showModal(d, $('#twBoth'));
}

const quickActions = {
  // 點開某一種情況（匿名一次只開一種，前一種的資料保留）：要填的第一格立刻拿到焦點
  mode: (el) => {
    const b = billOf(el.dataset.bill);
    if (!b) return;
    const m = el.dataset.mode;
    const mod = quickModel();
    if (m === 'parts' && b.parts.length === 0) b.parts.push(newPart(store.newId('p', [])));
    if (isNamed(mod)) {
      // 有名單：幾種情況可以同時開著，點另一顆不會關掉前一顆
      ensureNamedFields(b);
      if (!b.on.includes(m)) b.on = b.on.concat(m);
      sanitizeCases(b);
      syncBill(mod, b);
      const firstPill = b.who[0] ? 'pill-' + (m === 'parts' ? 'part-' + b.id + '-' + b.parts[0].id : m + '-' + b.id + '-') + '-' + b.who[0] : null;
      rebuild(b.id, m === 'parts' ? 'amt-' + b.parts[0].id : m === 'fixed' ? 'xa-' + b.id : firstPill);
      return;
    }
    const first = m === 'parts' ? 'amt-' + b.parts[0].id : m === 'free' ? 'fc-' + b.id : 'xc-' + b.id;
    // 匿名一次只算一種：目前這種已經填完時，直接切換會讓它默默消失，先問
    if (b.mode !== 'even' && b.mode !== m) {
      const now = computeBill(b);
      if (now.ok === true && !card.quickWaiting(now)) {
        askTwoCases(
          () => { // 兩種一起算：建立名單，兩種都開著，游標放進新那一種的第一個金額空格
            if (!rosterOn(mod)) return;
            ensureNamedFields(b);
            b.on = b.on.concat(m);
            sanitizeCases(b);
            syncBill(mod, b);
            persist();
            pendingFocus = null;
            render();
            focusFk(m === 'parts' ? 'amt-' + b.parts[0].id : m === 'fixed' ? 'xa-' + b.id : null);
            askOrphans();
          },
          () => { b.mode = m; rebuild(b.id, first); });
        return;
      }
    }
    b.mode = m;
    rebuild(b.id, first);
  },
  'case-cancel': (el) => {
    const b = billOf(el.dataset.bill);
    if (!b) return;
    const mod = quickModel();
    if (isNamed(mod)) {
      b.on = b.on.filter((k) => k !== el.dataset.mode);
      syncBill(mod, b);
    } else b.mode = 'even';
    rebuild(b.id, 'case-' + el.dataset.mode + '-' + b.id);
  },
  chip: (el) => toggleChip(el),
  'roster-on': () => {
    const m = quickModel();
    if (!rosterOn(m)) return;
    persist();
    pendingFocus = null;
    render();
    askOrphans();
  },
  'roster-off': () => {
    const m = quickModel();
    if (!isNamed(m) || !canRosterOff(m)) return;
    dropRoster(m);
    persist();
    render();
    focusFk('roster-on');
    askOrphans();
  },
  'rename-member': (el) => flow(async () => {
    const m = quickModel();
    const k = m.roster.findIndex((r) => r.id === el.dataset.id);
    if (k < 0) return;
    const r = m.roster[k];
    const d = $('#dlgName');
    const inp = $('#nmInput');
    inp.value = r.name;
    inp.placeholder = '第 ' + (k + 1) + ' 位';
    $('#nmTitle').textContent = '改名字（現在是' + rosterName(m.roster, r.id) + '）';
    $('#nmNote').textContent = '留空就顯示「第 ' + (k + 1) + ' 位」。';
    let result = null;
    $('#nmForm').onsubmit = (e) => {
      e.preventDefault();
      result = Array.from(inp.value.trim()).slice(0, ROSTER_NAME_MAX).join('');
      d.close('ok');
    };
    const v = await showModal(d, inp);
    if (v === 'ok' && result !== null) {
      const cur0 = quickModel().roster.find((x) => x.id === r.id);
      if (cur0) cur0.name = result;
      commit(null);
    }
  }),
  'free-by': (el) => {
    const b = billOf(el.dataset.bill);
    if (!b) return;
    b.free.by = el.dataset.by;
    const named = isNamed(quickModel());
    if (named) syncBill(quickModel(), b);
    rebuild(b.id, el.dataset.by === 'cover' ? (named ? null : 'fa-' + b.id) : 'by-all-' + b.id);
  },
  'part-new': (el) => {
    const b = billOf(el.dataset.bill);
    if (!b || b.parts.length >= QUICK_LIMITS.MAX_PARTS) return;
    const p = newPart(store.newId('p', b.parts.map((x) => x.id)));
    b.parts.push(p);
    if (isNamed(quickModel())) ensureNamedFields(b);
    rebuild(b.id, 'amt-' + p.id);
  },
  'part-del': (el) => {
    const b = billOf(el.dataset.bill);
    if (!b) return;
    b.parts = b.parts.filter((p) => p.id !== el.dataset.part);
    live.delete(el.dataset.part);
    ui.open.delete('more-' + el.dataset.part);
    if (b.parts.length === 0) b.parts.push(newPart(store.newId('p', [])));
    if (isNamed(quickModel())) { ensureNamedFields(b); syncBill(quickModel(), b); }
    rebuild(b.id, 'pnew-' + b.id);
  },
  'part-add': (el) => {
    const pid = el.dataset.part;
    if (!live.has(pid)) return;
    live.delete(pid);
    blankNext.add(pid);
    rebuild(el.dataset.bill, 'amt-' + pid);
  },
  'part-del-item': (el) => {
    const b = billOf(el.dataset.bill);
    const p = partOf(b, el.dataset.part);
    if (!p) return;
    p.items.splice(Number(el.dataset.idx), 1);
    rebuild(b.id, 'amt-' + p.id);
  },
  'bill-new': () => {
    const m = quickModel();
    if (m.bills.length >= QUICK_LIMITS.MAX_BILLS) return;
    const b = newBill(store.newId('b', m.bills.map((x) => x.id)));
    if (isNamed(m)) { ensureNamedFields(b); b.who = m.roster.map((r) => r.id); syncBill(m, b); } // 有名單：新帳單預設所有人都參加
    m.bills.push(b);
    ensureRecord();
    persist();
    render();
    focusFk('ppl-' + b.id);
    askOrphans();
  },
  'bill-del': (el) => {
    const m = quickModel();
    if (m.bills.length <= 1) return;
    m.bills = m.bills.filter((b) => b.id !== el.dataset.bill);
    ensureRecord();
    persist();
    render();
    focusFk('bill-new');
    askOrphans();
  },
  'new-calc': () => {
    setCurrent(null);
    ui.importMsg = '';
    syncNotice = '';
    render();
    window.scrollTo(0, 0);
    const first = $('[data-fk^="ppl-"]');
    if (first) first.focus();
  },
  example: (el) => {
    setCurrent(null);
    const m = quickModel();
    EXAMPLES[el.dataset.ex](m);
    ensureRecord();
    persist();
    ui.importMsg = '';
    syncNotice = '';
    render();
    window.scrollTo(0, 0);
    askOrphans();
  },
  'open-record': (el) => {
    setCurrent(el.dataset.id);
    ui.importMsg = '';
    syncNotice = '';
    pendingFocus = '#main';
    render();
    window.scrollTo(0, 0);
  },
  'delete-record': (el) => flow(async () => {
    const a = st.activities.find((x) => x.id === el.dataset.id);
    if (!a) return;
    const ok = await confirmBox({ title: '刪除這筆紀錄？', body: '「' + a.title + '」（' + historyText(a) + '）會不見，而且救不回來。', okText: '刪除', danger: true });
    if (!ok) return;
    st.activities = st.activities.filter((x) => x.id !== a.id);
    if (ui.recId === a.id) setCurrent(null);
    commit('#main');
    toast('已刪除這筆紀錄');
  }),
  'to-quick': () => {
    setCurrent(null);
    ui.importMsg = '';
    syncNotice = '';
    render();
    window.scrollTo(0, 0);
  },
};

Object.assign(actions, quickActions);

/* ---------- 事件 ---------- */

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const fk = b.closest('[data-fk]') || b;
  lastKey = fk.dataset.fk || null;
  if (b.dataset.fk === 'open-card2') lastKey = 'open-card2';
  const fn = actions[b.dataset.act];
  if (fn) fn(b);
});

document.addEventListener('submit', (e) => {
  const f = e.target.closest('[data-form="add-member"]');
  if (!f) return;
  e.preventDefault();
  const act = cur();
  const input = $('#memName');
  const names = input.value.split(/[,，、\n]/).map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) { toast('先輸入暱稱再按「加入」'); input.focus(); return; }
  if (act.members.length + names.length > LIMITS.MAX_MEMBERS) { toast('成員最多 ' + LIMITS.MAX_MEMBERS + ' 人'); return; }
  const used = new Set(act.members.map((m) => m.id));
  let dup = false;
  for (const n of names) {
    const name = Array.from(n).slice(0, LIMITS.MAX_NAME).join('');
    if (act.members.some((m) => m.name === name)) dup = true;
    const id = store.newId('m', used);
    used.add(id);
    act.members.push({ id, name });
  }
  commit('#memName');
  if (dup) toast('已有同名的成員，建議改個不一樣的暱稱，才分得清楚', 4500);
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'actSel') {
    setCurrent(e.target.value);
    commit('#main');
  } else if (e.target.id === 'impFile') {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    doImport(f);
  }
});

document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (d.tagName === 'DETAILS' && d.dataset.id) {
    if (d.open) ui.open.add(d.dataset.id); else ui.open.delete(d.dataset.id);
  }
}, true);

mq.addEventListener('change', () => render());

/* ---------- 啟動與測試掛鉤 ---------- */

async function boot() {
  storage = store.getStorage();
  const r = store.loadState(storage);
  st = r.state;
  storageOk = r.available;
  if (storage && (r.bad.length > 0 || r.rawBad !== null)) {
    const items = r.rawBad !== null ? [r.rawBad] : r.bad;
    const s = store.stashCorruptItems(storage, items);
    if (s.lost > 0) {
      blocked = true;
      storageOk = false;
      notices.push(lostNotice(s.lost));
    } else {
      notices.push(r.rawBad !== null
        ? '這台裝置上存的資料整份讀不出來，已經原樣另外留存，沒有刪掉。'
        : '有 ' + r.bad.length + ' 筆資料讀不出來，已經另外留存，其他資料不受影響。');
      storageOk = store.saveState(storage, st);
    }
  }
  baseline = store.makeBaseline(st);
  let sid = null;
  try { sid = sessionStorage.getItem(SESSION_KEY); } catch (e) { sid = null; }
  setCurrent(sid && st.activities.some((a) => a.id === sid) ? sid : null);
  await card.fontsReady();
  render();
}

window.__lt = {
  ready: boot(),
  state: () => JSON.parse(JSON.stringify(st)),
  result: () => { const a = cur(); return a && !a.quick ? computeActivity(a) : null; },
  quickResult: () => computeRecord(quickModel()),
  view: () => ui.view,
  cardDataUrl: (kind) => {
    if (kind === 'quick') {
      const m = quickModel();
      const a = cur() || { title: store.formatStamp(), createdAt: store.todayLocal(), quick: m };
      return card.renderQuickCard(a, computeRecord(m)).toDataURL('image/png');
    }
    const a = cur();
    return card.renderCard(a, computeActivity(a), kind === 'detail' ? 'detail' : 'compact').toDataURL('image/png');
  },
};
