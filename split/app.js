/* 多人分帳：操作介面 */
import { computeActivity, computeExpense, validateActivity, LIMITS, serializeExport, parseImport } from './core.js?v=20261121093330';
import { explainExpense, formatMoney } from './explain.js?v=20261121093330';
import * as store from './store.js?v=20261121093330';
import * as card from './card.js?v=20261121093330';
import { computeRecord, errorText, explainBill, partLabel, partAmount, newBill, newPart, toAdvanced, QUICK_LIMITS } from './quick.js?v=20261121093330';
import { BRAND } from '../shared/shell.js?v=20261121093330';

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
let pendingReveal = false; // 重畫後把聚焦的欄位捲到眼前（點了特殊情況、再加一筆）
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
    '<button type="button" class="btn ghost small" data-act="new-activity" data-fk="act-new">新增活動</button>' +
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
        '<li>「有一部分只有幾個人分」：先把這幾筆（有勾服務費的會再加一成，四捨五入到整數元）從總額扣掉，剩下的全部人平分，就是「每人先付」；每一筆再由有分的人平分，就是「每人再加」。每個人要付的，是先付加上自己有分到的那幾筆。</li>' +
        '<li>「有人不用付」：選「大家一起分」，不用付的人是 0 元，其餘的人平分；選「有人幫忙付」，幫忙付的人出自己加被幫忙的人的份數，其餘每人 1 份。</li>' +
        '<li>「有人付固定金額」：先扣掉固定金額的合計，剩下的由其餘的人平分。</li>' +
        '<li>湊成整十：每個金額四捨五入到十位，所以收齊的錢可能比帳單多一點或少一點，畫面會寫出差多少。</li>' +
        '<li>每一張帳單各算各的；只有在每張都是單純平分、人數也一樣時，才會再加總出「每人合計」。</li></ol>') +
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

function activeActivityInit(title) {
  const used = new Set(st.activities.map((a) => a.id));
  const a = { id: store.newId('a', used), title, createdAt: store.todayLocal(), members: [], expenses: [] };
  st.activities.push(a);
  setCurrent(a.id, 'advanced');
  return a;
}

const actions = {
  'new-activity': () => flow(async () => {
    const r = await askText({ title: '新的活動', label: '活動名稱', placeholder: '例如：週五聚餐', max: LIMITS.MAX_TITLE, okText: '建立' });
    if (r && r.action === 'ok') { activeActivityInit(r.value); commit('#memName'); }
  }),
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
const PART_NAME_MAX = 12; // 另外算的名稱最多幾個字
const COMPACT_FROM = 3; // 另外算有幾筆以上，結果區改用精簡排版
const STICKY_MAX = 260; // 結果區黏在畫面頂端時的最大高度（px），超過就不黏

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// 只用在「不含任何使用者資料」的固定字串（頁首、說明區）；使用者輸入的文字一律走 h() 與 textContent
function frag(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content;
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

function backupNode(act) {
  return h('section', { class: 'sec', 'aria-labelledby': 'h-bak' },
    h('h3', { class: 'sec-title', id: 'h-bak' }, '備份'),
    h('p', { class: 'hint', style: 'margin-top:0' }, '換手機或怕資料不見時用。備份檔只有你拿得到。'),
    ui.importMsg ? h('p', { class: 'err', role: 'alert', style: 'margin-bottom:10px' }, ui.importMsg) : null,
    h('div', { class: 'tools-row' },
      act ? h('button', { type: 'button', class: 'btn ghost', 'data-act': 'export', 'data-fk': 'export' }, act.quick ? '匯出目前這筆的備份檔' : '匯出目前活動的備份檔') : null,
      h('label', { class: 'btn ghost' }, '匯入備份檔（加入為新的一筆）', h('input', { type: 'file', id: 'impFile', accept: '.json,application/json', 'data-fk': 'import' })),
      st.activities.length ? h('button', { type: 'button', class: 'btn danger', 'data-act': 'clear-all', 'data-fk': 'clear' }, '清除這台裝置上的所有資料') : null));
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
  storeCurrentId(ui.recId);
}

function quickModel() {
  const a = cur();
  if (a && a.quick) return a.quick;
  if (!draft) draft = { bills: [newBill(store.newId('b', []))] };
  return draft;
}

const billOf = (id) => quickModel().bills.find((b) => b.id === id) || null;
const partOf = (b, id) => (b ? b.parts.find((p) => p.id === id) || null : null);

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
  setCurrent(rec.id, 'quick');
}

const noticeSig = () => [storageOk, notices.length, syncNotice].join('|');

// 每次輸入後：必要時建立紀錄、自動儲存、只更新結果區（不重畫輸入欄，游標才不會跳）
function edit(fn) {
  fn();
  ensureRecord();
  const a = cur();
  if (a && a.quick) {
    const sig = noticeSig();
    ui.importMsg = '';
    persist();
    if (noticeSig() !== sig) { render(); return; }
  }
  updateAll();
  askOrphans();
}

function rebuild(fk, reveal) {
  ensureRecord();
  const a = cur();
  if (a && a.quick) persist();
  if (fk) pendingFocus = '[data-fk="' + fk + '"]';
  pendingReveal = !!reveal;
  render();
  askOrphans();
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
function parseDigits(text, max) {
  let t = store.normalizeNumberText(text);
  const dot = t.indexOf('.');
  if (dot >= 0) t = t.slice(0, dot);
  const digits = t.replace(/\D/g, '');
  let n = digits === '' ? 0 : Number(digits);
  const over = n > max;
  if (over) n = max;
  return { n, clean: !over && String(text) === digits };
}

function bindNumber(inp, max, onSet) {
  inp.addEventListener('input', (e) => {
    if (e.isComposing) return;
    const r = parseDigits(inp.value, max);
    if (!r.clean) inp.value = r.n > 0 ? String(r.n) : '';
    onSet(r.n);
  });
  inp.addEventListener('focus', () => selectLater(inp));
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
}

const hasPlus = (t) => /[+＋]/.test(t);

/**
 * 金額欄：接受「1000+500」這種加法（半形、全形加號都可以），輸入過程中就用加總值即時計算。
 * 看不懂的內容不猜，欄位下面顯示白話提示，並把這一格當成還沒填。
 * o.onSet(總額, 解析結果)；o.onPlus(解析結果)（可省略）：欄位裡有加號且解析成功時改由它處理，不呼叫 onSet。
 * 離開欄位或按 Enter 時，把加法換成加總後的數字。
 */
function moneyField(o) {
  const inp = h('input', {
    type: 'text', inputmode: 'numeric', autocomplete: 'off', enterkeyhint: 'done',
    id: o.id, 'data-fk': o.fk, placeholder: o.placeholder || '', 'aria-label': o.aria,
  });
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
    if (r.ok && o.onPlus && hasPlus(inp.value)) { o.onPlus(r); return; }
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
  return h('div', { class: 'mfield' }, h('div', { class: 'money' }, inp, h('span', { class: 'unit' }, '元')), hint);
}

function stepper(o) {
  const inp = h('input', {
    type: 'text', inputmode: 'numeric', autocomplete: 'off', enterkeyhint: 'done',
    id: o.id, 'data-fk': o.fk, placeholder: '0',
  });
  inp.value = o.value > 0 ? String(o.value) : '';
  const minus = h('button', { type: 'button', class: 'step', 'aria-label': '減少' + o.aria, 'data-fk': o.fk + '-m' }, '−');
  const plus = h('button', { type: 'button', class: 'step', 'aria-label': '增加' + o.aria, 'data-fk': o.fk + '-p' }, '+');
  const sync = (n) => { minus.disabled = n <= 0; plus.disabled = n >= o.max; };
  sync(o.value);
  const now = () => parseDigits(inp.value, o.max).n;
  const apply = (n) => { inp.value = n > 0 ? String(n) : ''; sync(n); o.onSet(n); };
  minus.addEventListener('click', () => apply(Math.max(0, now() - 1)));
  plus.addEventListener('click', () => apply(Math.min(o.max, now() + 1)));
  bindNumber(inp, o.max, (n) => { sync(n); o.onSet(n); });
  return h('div', { class: 'stepper' }, minus, inp, plus);
}

/* ----- 帳單卡 ----- */

const TOGGLES = [
  ['parts', '有一部分只有幾個人分'],
  ['free', '有人不用付'],
  ['fixed', '有人付固定金額'],
];

function partCard(b, p, i) {
  const bid = b.id;
  const pid = p.id;
  const nameBtn = h('button', { type: 'button', class: 'pname-btn', 'data-fk': 'pn-' + pid, 'aria-label': partLabel(b, pid) + '，點一下可以改名' },
    partLabel(b, pid), h('span', { class: 'pname-edit' }, '改名'));
  const nameInp = h('input', { type: 'text', class: 'pname-inp', maxlength: PART_NAME_MAX, 'aria-label': '這一筆的名稱', placeholder: '第 ' + (i + 1) + ' 筆', hidden: true, autocomplete: 'off' });
  let cancel = false;
  const closeName = () => {
    nameInp.hidden = true;
    nameBtn.hidden = false;
    const label = partLabel(billOf(bid), pid);
    nameBtn.firstChild.textContent = label;
    nameBtn.setAttribute('aria-label', label + '，點一下可以改名');
  };
  nameBtn.addEventListener('click', () => {
    const cp = partOf(billOf(bid), pid);
    nameInp.value = cp ? cp.name : '';
    nameBtn.hidden = true;
    nameInp.hidden = false;
    cancel = false;
    nameInp.focus();
    nameInp.select();
  });
  nameInp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nameInp.blur(); }
    else if (e.key === 'Escape') { cancel = true; nameInp.blur(); }
  });
  nameInp.addEventListener('blur', () => {
    if (nameInp.hidden) return;
    if (!cancel) {
      const v = Array.from(nameInp.value.trim()).slice(0, PART_NAME_MAX).join('');
      edit(() => { const cp = partOf(billOf(bid), pid); if (cp) cp.name = v; });
    }
    closeName();
    updateAll();
  });

  const isLive = live.has(pid);
  const committed = isLive ? p.items.slice(0, -1) : p.items;
  const liveVal = isLive ? p.items[p.items.length - 1] : 0;
  const atMax = !isLive && p.items.length >= QUICK_LIMITS.MAX_ITEMS;
  const amtBox = moneyField({
    id: 'amt-' + pid, fk: 'amt-' + pid, value: liveVal, aria: '這一筆的金額（元）', placeholder: '這一筆的金額',
    // 打了加號：加號前面的每一段就等於按過「加」，變成小標籤；加號後面還在打的那一段留在欄位裡
    onPlus: (r) => {
      const cp = partOf(billOf(bid), pid);
      if (!cp) return;
      if (live.has(pid)) { cp.items.pop(); live.delete(pid); }
      const keepLast = !r.pending && r.values.length > 0;
      const tags = keepLast ? r.values.slice(0, -1) : r.values;
      const room = Math.max(0, QUICK_LIMITS.MAX_ITEMS - cp.items.length - (keepLast ? 1 : 0));
      cp.items.push(...tags.slice(0, room));
      if (keepLast) { cp.items.push(r.values[r.values.length - 1]); live.add(pid); }
      if (tags.length > room) toast('最多加 ' + QUICK_LIMITS.MAX_ITEMS + ' 個金額，多的沒有加進去', 4500);
      rebuild('amt-' + pid);
    },
    onSet: (n) => {
      edit(() => {
        const cb = billOf(bid);
        const cp = partOf(cb, pid);
        if (!cp) return;
        const lv = live.has(pid);
        if (lv) {
          if (n > 0) cp.items[cp.items.length - 1] = n;
          else { cp.items.pop(); live.delete(pid); }
        } else if (n > 0 && cp.items.length < QUICK_LIMITS.MAX_ITEMS) {
          cp.items.push(n);
          live.add(pid);
        }
      });
      const btn = document.querySelector('[data-fk="padd-' + pid + '"]');
      if (btn) btn.disabled = !(n > 0);
    },
  });
  const amt = amtBox.querySelector('input');
  if (atMax) amt.disabled = true;
  const addBtn = h('button', { type: 'button', class: 'btn primary small padd', 'data-act': 'part-add', 'data-bill': bid, 'data-part': pid, 'data-fk': 'padd-' + pid }, '加');
  if (!(liveVal > 0)) addBtn.disabled = true;
  const chips = h('ul', { class: 'items', 'aria-label': '已加入的金額' },
    committed.map((v, k) => h('li', null, h('button', {
      type: 'button', class: 'item-del', 'data-act': 'part-del-item', 'data-bill': bid, 'data-part': pid, 'data-idx': k,
      'data-fk': 'pit-' + pid + '-' + k, 'aria-label': '刪除 ' + money(v) + ' 元',
    }, money(v) + ' 元 ', h('span', { 'aria-hidden': 'true' }, '✕')))));
  const ppl = stepper({
    id: 'pp-' + pid, fk: 'pp-' + pid, value: p.people, max: MAXN.people, aria: '幾個人分',
    onSet: (n) => edit(() => { const cp = partOf(billOf(bid), pid); if (cp) cp.people = n; }),
  });
  const svc = h('input', { type: 'checkbox', id: 'svc-' + pid, 'data-fk': 'svc-' + pid });
  svc.checked = p.service === true;
  svc.addEventListener('change', () => edit(() => { const cp = partOf(billOf(bid), pid); if (cp) cp.service = svc.checked; }));

  return h('div', { class: 'part', 'data-part-card': pid },
    h('div', { class: 'part-head' },
      h('span', { class: 'pname' }, nameBtn, nameInp),
      b.parts.length > 1 ? h('button', { type: 'button', class: 'btn danger small', 'data-act': 'part-del', 'data-bill': bid, 'data-part': pid, 'data-fk': 'pdel-' + pid }, '刪除這一筆') : null),
    h('div', { class: 'calc' }, amtBox, addBtn),
    h('p', { class: 'hint tiny' }, atMax ? '最多加 ' + QUICK_LIMITS.MAX_ITEMS + ' 個金額。' : '有好幾個金額，就按「加」一個一個加進去'),
    committed.length > 0 ? chips : null,
    h('p', { class: 'ptotal', 'data-part-total': pid, 'aria-live': 'polite' }, partTotalText(p)),
    h('div', { class: 'prow' }, h('label', { class: 'lbl', for: 'pp-' + pid }, '幾個人分'), ppl),
    h('label', { class: 'chk', for: 'svc-' + pid }, svc, h('span', null, '還要另加一成服務費')));
}

// 只有小標籤或勾了服務費時才需要這一行；只填一個數字時，欄位裡看得到，不重複顯示
function partTotalText(p) {
  const a = partAmount(p);
  const tags = p.items.length - (live.has(p.id) ? 1 : 0);
  if (!(a > 0) || (tags <= 0 && !p.service)) return '';
  return '合計 ' + money(a) + ' 元' + (p.service ? '（含一成服務費）' : '');
}

function partsPanel(b) {
  const nodes = b.parts.map((p, i) => partCard(b, p, i));
  const full = b.parts.length >= QUICK_LIMITS.MAX_PARTS;
  return h('div', { class: 'panel', 'data-panel': 'parts' }, nodes,
    h('button', { type: 'button', class: 'btn ghost', 'data-act': 'part-new', 'data-bill': b.id, 'data-fk': 'pnew-' + b.id, disabled: full }, '再加一筆'),
    full ? h('p', { class: 'hint tiny' }, '最多 ' + QUICK_LIMITS.MAX_PARTS + ' 筆。') : null);
}

function freePanel(b) {
  const bid = b.id;
  const f = b.free;
  const radio = (v, text) => {
    const inp = h('input', { type: 'radio', name: 'by-' + bid, value: v, 'data-fk': 'by-' + v + '-' + bid });
    inp.checked = f.by === v;
    inp.addEventListener('change', () => { if (inp.checked) { edit(() => { billOf(bid).free.by = v; }); rebuild('by-' + v + '-' + bid); } });
    return h('label', { class: 'seg-opt' }, inp, h('span', null, text));
  };
  const fields = [];
  if (f.by === 'all') {
    fields.push(h('label', { class: 'lbl', for: 'fc-' + bid }, '幾個人不用付'));
    fields.push(stepper({ id: 'fc-' + bid, fk: 'fc-' + bid, value: f.count, max: MAXN.people, aria: '不用付的人數', onSet: (n) => edit(() => { billOf(bid).free.count = n; }) }));
  } else {
    fields.push(h('label', { class: 'lbl', for: 'fa-' + bid }, '幫忙付的有幾個人'));
    fields.push(stepper({ id: 'fa-' + bid, fk: 'fa-' + bid, value: f.coverers, max: MAXN.people, aria: '幫忙付的人數', onSet: (n) => edit(() => { billOf(bid).free.coverers = n; }) }));
    fields.push(h('label', { class: 'lbl', for: 'fe-' + bid }, '每人幫幾位付'));
    fields.push(stepper({ id: 'fe-' + bid, fk: 'fe-' + bid, value: f.each, max: MAXN.people, aria: '每人幫幾位付', onSet: (n) => edit(() => { billOf(bid).free.each = n; }) }));
  }
  return h('div', { class: 'panel', 'data-panel': 'free' },
    h('div', { class: 'seg two', role: 'radiogroup', 'aria-label': '誰來出' }, radio('all', '大家一起分'), radio('cover', '有人幫忙付')),
    fields);
}

function fixedPanel(b) {
  const bid = b.id;
  return h('div', { class: 'panel', 'data-panel': 'fixed' },
    h('label', { class: 'lbl', for: 'xc-' + bid }, '幾個人付固定金額'),
    stepper({ id: 'xc-' + bid, fk: 'xc-' + bid, value: b.fixed.count, max: MAXN.people, aria: '付固定金額的人數', onSet: (n) => edit(() => { billOf(bid).fixed.count = n; }) }),
    h('label', { class: 'lbl', for: 'xa-' + bid }, '每人付多少'),
    moneyField({
      id: 'xa-' + bid, fk: 'xa-' + bid, value: b.fixed.amount, aria: '每人付多少（元）', placeholder: '例如 500',
      onSet: (n) => edit(() => { billOf(bid).fixed.amount = n; }),
    }));
}

function billCard(b, i, n) {
  const bid = b.id;
  const many = n > 1;
  const people = stepper({ id: 'ppl-' + bid, fk: 'ppl-' + bid, value: b.people, max: MAXN.people, aria: '人數', onSet: (v) => edit(() => { billOf(bid).people = v; }) });
  const total = moneyField({
    id: 'tot-' + bid, fk: 'tot-' + bid, value: b.total, aria: '總共多少錢（元）', placeholder: '例如 1,000',
    onSet: (v) => edit(() => { billOf(bid).total = v; }),
  });
  const togs = h('div', { class: 'togs', role: 'group', 'aria-label': '特殊情況' },
    TOGGLES.map(([m, text]) => {
      const on = b.mode === m;
      return h('button', {
        type: 'button', class: 'tog', 'aria-pressed': on ? 'true' : 'false', 'aria-label': on ? text + '，已選，點一下取消' : null,
        'data-act': 'mode', 'data-mode': m, 'data-bill': bid, 'data-fk': 'tog-' + m + '-' + bid,
      }, h('span', { class: 'tog-mark', 'aria-hidden': 'true' }), h('span', { class: 'tog-text' }, text),
      on ? h('span', { class: 'tog-cancel', 'aria-hidden': 'true' }, '取消') : null);
    }));
  let panel = null;
  if (b.mode === 'parts') panel = partsPanel(b);
  else if (b.mode === 'free') panel = freePanel(b);
  else if (b.mode === 'fixed') panel = fixedPanel(b);
  const round = h('input', { type: 'checkbox', id: 'rt-' + bid, role: 'switch', 'data-fk': 'rt-' + bid });
  round.checked = b.roundTens === true;
  round.addEventListener('change', () => edit(() => { billOf(bid).roundTens = round.checked; }));

  return h('section', { class: 'sec qbill', 'data-bill': bid, 'aria-label': many ? '第 ' + (i + 1) + ' 張帳單' : '帳單' },
    many ? h('div', { class: 'qhead' }, h('h2', { class: 'qtitle' }, '第 ' + (i + 1) + ' 張帳單'),
      h('button', { type: 'button', class: 'btn danger small', 'data-act': 'bill-del', 'data-bill': bid, 'data-fk': 'bdel-' + bid }, '刪除這張')) : null,
    h('div', { class: 'qfields' },
      h('div', { class: 'fld' }, h('label', { class: 'lbl big', for: 'ppl-' + bid }, '幾個人'), people),
      h('div', { class: 'fld' }, h('label', { class: 'lbl big', for: 'tot-' + bid }, '總共多少錢'), total)),
    h('div', { class: 'result', 'data-result': bid, 'aria-live': 'polite' }),
    h('p', { class: 'sub' }, '有下面的情況再點，沒有就不用點'),
    togs,
    panel,
    b.mode !== 'even' ? h('button', { type: 'button', class: 'linkbtn', 'data-act': 'to-advanced', 'data-action': 'to-advanced', 'data-fk': 'adv-' + bid }, '同時有兩種情況？改用點人頭') : null,
    h('label', { class: 'sw', for: 'rt-' + bid }, round, h('span', { class: 'sw-text' }, '湊成整十', h('small', null, '把金額湊成 10 的倍數，比較好收錢'))));
}

/* ----- 結果區 ----- */

function fillResult(el, bill, res) {
  el.replaceChildren();
  el.classList.remove('open', 'tall');
  if (res.ok === false) {
    el.dataset.state = res.error === 'EMPTY' ? 'empty' : 'error';
    if (res.error !== 'EMPTY') el.append(h('p', { class: 'r-err' }, errorText(res, bill)));
    return;
  }
  if (card.quickWaiting(res)) {
    // 選了特殊情況但還沒填完：不顯示大字金額，免得被當成答案
    el.dataset.state = 'wait';
    el.append(h('p', { class: 'r-wait' }, '請把下面的欄位填完'));
    const each = res.rows.length > 0 ? res.rows[0].amount : 0;
    if (each > 0) el.append(h('p', { class: 'r-wait-sub' }, '不算這個情況的話，每人 ' + money(each) + ' 元'));
    return;
  }
  el.dataset.state = 'ok';
  const compact = res.mode === 'parts' && bill.parts.length >= COMPACT_FROM;
  el.classList.toggle('compact', compact);
  const ln = card.quickLines(bill, res);
  for (const r of ln.rows) {
    const attrs = {
      class: 'r-row' + (r.big ? ' big' : '') + (r.amount === null ? ' free' : '') + (compact && r.role === 'add' ? ' cmp' : ''),
      'data-role': r.role, 'data-count': r.count, 'data-amount': r.amount === null ? '' : r.amount,
    };
    if (compact && r.role === 'add') {
      el.append(h('p', attrs,
        h('span', { class: 'r-label' }, partLabel(bill, r.partId) + '・' + r.count + ' 人'),
        h('span', { class: 'r-val' }, r.amount === null ? '不用再加'
          : ['每人再加 ', h('span', { class: 'r-amt amt' }, money(r.amount)), ' 元'])));
      continue;
    }
    const p = h('p', attrs, h('span', { class: 'r-label' }, r.label));
    if (r.amount !== null) p.append(' ', h('span', { class: 'r-amt amt' }, money(r.amount)), ' 元');
    el.append(p);
  }
  const notes = compact ? ln.notes.filter((n) => n.kind !== 'multi') : ln.notes;
  let skippedDone = false;
  for (const n of notes) {
    if (compact && n.kind === 'skipped') {
      if (!skippedDone) {
        skippedDone = true;
        el.append(h('p', { class: 'r-note skipped' }, res.skipped.map((id) => partLabel(bill, id)).join('、') + '還沒填完，先不算'));
      }
      continue;
    }
    el.append(h('p', { class: 'r-note ' + n.kind }, n.text));
  }
  el.append(h('p', { class: 'r-diff' + (ln.diff.diff === 0 ? ' ok' : '') }, ln.diff.text));
  const id = 'how-' + bill.id;
  const d = h('details', { class: 'how2', 'data-id': id }, h('summary', null, '怎麼算的', h('span', { class: 'chev', 'aria-hidden': 'true' })),
    h('div', { class: 'how-body' }, explainBill(bill, res).map((l) => h('p', null, l))));
  if (ui.open.has(id)) d.open = true;
  el.classList.toggle('open', d.open);
  el.append(d);
  // 內容太多時不黏在畫面頂端，免得蓋掉太多畫面
  const folded = el.offsetHeight - (d.open ? d.querySelector('.how-body').offsetHeight : 0); // 不含展開的「怎麼算的」
  el.classList.toggle('tall', folded > STICKY_MAX);
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
  return '進階・' + a.members.length + ' 位成員・共 ' + money(r.total) + ' 元';
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
        h('span', { class: 'ht' }, a.title, isCur ? h('em', null, '目前這筆') : null), h('span', { class: 'hs' }, historyText(a))),
      h('button', { type: 'button', class: 'btn danger small', 'data-act': 'delete-record', 'data-id': a.id, 'data-fk': 'delrec-' + a.id, 'aria-label': '刪除 ' + a.title }, '刪除')));
  }
}

function updateAll() {
  const m = quickModel();
  const rc = computeRecord(m);
  m.bills.forEach((b, i) => {
    const el = document.querySelector('[data-result="' + b.id + '"]');
    if (el) fillResult(el, b, rc.bills[i]);
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
  const okAny = rc.bills.some((r) => r.ok && !card.quickWaiting(r));
  const cb = $('[data-fk="open-card"]');
  if (cb) cb.disabled = !okAny;
  const why = $('#qWhy');
  if (why) {
    why.hidden = okAny;
    why.textContent = rc.bills.some((r) => r.ok) ? '把上面的欄位填完，就能做結算卡。' : '填好人數和總金額，就能做結算卡。';
  }
  fillHistory();
  keepFieldClear();
}

// 正在填的欄位若被黏在頂端的結果區蓋住（結果變高時會發生），就捲到它的下面
function keepFieldClear() {
  const a = document.activeElement;
  if (!a || !a.matches || !a.matches('input') || !a.closest('.qbill')) return;
  const res = a.closest('.qbill').querySelector('.result');
  if (!res || getComputedStyle(res).position !== 'sticky') return;
  const rr = res.getBoundingClientRect();
  const ar = a.getBoundingClientRect();
  if (ar.bottom <= rr.top || ar.top >= rr.bottom) return;
  window.scrollBy(0, ar.top - rr.bottom - 40);
}

const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

// 把要填的欄位捲到眼前：扣掉黏在頂端的結果區，並留一點空間給欄位上方的標題字
function revealField(el) {
  const res = el.closest('.qbill') ? el.closest('.qbill').querySelector('.result') : null;
  const stuck = !!res && getComputedStyle(res).position === 'sticky';
  const top = (stuck ? res.offsetHeight : 0) + 8;
  const r = el.getBoundingClientRect();
  if (r.top >= top + 28 && r.bottom <= window.innerHeight - 16) return;
  window.scrollBy({ top: r.top - (top + 44), left: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
}

/* ----- 整頁 ----- */

function captureFocus() {
  const a = document.activeElement;
  if (!a || !a.dataset || !a.dataset.fk) return null;
  let s = null;
  let e = null;
  try { s = a.selectionStart; e = a.selectionEnd; } catch (err) { /* 沒有游標位置 */ }
  return { fk: a.dataset.fk, s, e };
}

function renderQuick() {
  const scrollY = window.scrollY;
  const keep = captureFocus();
  const m = quickModel();
  const n = m.bills.length;
  const act = cur();

  const kids = [];
  kids.push(frag(headHtml()));
  kids.push(noticesNode());
  m.bills.forEach((b, i) => kids.push(billCard(b, i, n)));
  kids.push(h('section', { class: 'qsum', id: 'qsum', hidden: true, 'aria-live': 'polite' },
    h('p', { class: 'qsum-line' }, '每人合計 ', h('span', { class: 'amt', id: 'qsumAmt' }), ' 元'), h('p', { class: 'hint tiny', id: 'qsumNote' })));
  kids.push(h('div', { class: 'qacts' },
    h('button', { type: 'button', class: 'btn ghost', 'data-act': 'bill-new', 'data-fk': 'bill-new', disabled: n >= QUICK_LIMITS.MAX_BILLS }, '再加一張帳單'),
    h('p', { class: 'hint tiny' }, '續攤、另一家店，各算各的。'),
    h('button', { type: 'button', class: 'btn primary wide', 'data-act': 'open-card', 'data-fk': 'open-card' }, '產生結算卡'),
    h('p', { class: 'why', id: 'qWhy' }, '填好人數和總金額，就能做結算卡。'),
    h('button', { type: 'button', class: 'btn ghost wide', 'data-act': 'new-calc', 'data-fk': 'new-calc' }, '重新算一筆')));
  kids.push(h('section', { class: 'sec', 'aria-labelledby': 'h-ex' },
    h('h3', { class: 'sec-title', id: 'h-ex' }, '看範例'),
    h('p', { class: 'hint', style: 'margin-top:0' }, '點一個，看它怎麼算（會另外開一筆新的）。'),
    h('div', { class: 'exs' },
      h('button', { type: 'button', class: 'btn ghost', 'data-act': 'example', 'data-ex': '1', 'data-fk': 'ex1' }, '聚餐平分'),
      h('button', { type: 'button', class: 'btn ghost', 'data-act': 'example', 'data-ex': '2', 'data-fk': 'ex2' }, '有人沒喝酒'),
      h('button', { type: 'button', class: 'btn ghost', 'data-act': 'example', 'data-ex': '3', 'data-fk': 'ex3' }, '有人幫家人付'))));
  kids.push(h('section', { class: 'sec', 'aria-labelledby': 'h-hist' },
    h('h3', { class: 'sec-title', id: 'h-hist' }, '之前算過的'),
    h('p', { class: 'hint', id: 'histEmpty', style: 'margin-top:0' }, '算過的會自動記在這裡，之後點一下就能打開。'),
    h('ul', { class: 'hist', id: 'hist' })));
  kids.push(h('section', { class: 'sec', 'aria-labelledby': 'h-adv' },
    h('h3', { class: 'sec-title', id: 'h-adv' }, '進階'),
    h('p', { class: 'hint', style: 'margin-top:0' }, '要記誰先墊錢、替每個人取名、算誰該給誰多少，用這個。'),
    h('button', { type: 'button', class: 'btn ghost wide', 'data-act': 'new-activity', 'data-fk': 'adv-new' }, '進階：點人頭記帳')));
  kids.push(backupNode(act));
  kids.push(frag(helpHtml('quick')));

  const main = h('main', { class: 'app', id: 'main', tabindex: '-1' }, kids);
  const stage = h('div', { class: 'stage solo' }, main);
  $('#app').replaceChildren(stage);
  updateAll();
  window.scrollTo(0, scrollY);
  const reveal = pendingReveal;
  pendingReveal = false;
  // 焦點只在「原本的焦點因為重畫被移除、現在落在 body」時才還給畫面；焦點已經在別的欄位或按鈕上就絕不搶
  const a = document.activeElement;
  const free = !a || a === document.body || a === document.documentElement;
  if (pendingFocus) {
    const el = $(pendingFocus);
    pendingFocus = null;
    if (el && free) {
      el.focus({ preventScroll: reveal });
      focusApplied = true;
      try { if (el.select && el.type === 'text') el.select(); } catch (e) { /* 忽略 */ }
      if (reveal) revealField(el);
    }
  } else if (keep && free) {
    const el = document.querySelector('[data-fk="' + keep.fk + '"]:not([disabled])');
    if (el) {
      el.focus();
      try { if (keep.s !== null && keep.e !== null) el.setSelectionRange(keep.s, keep.e); } catch (err) { /* 忽略 */ }
    }
  }
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

const EXAMPLES = {
  1: (b) => { b.people = 4; b.total = 1000; },
  2: (b) => {
    b.people = 10; b.total = 13200; b.mode = 'parts';
    b.parts = [{ ...newPart(store.newId('p', [])), name: '酒', items: [3500], service: true, people: 7 }];
  },
  3: (b) => { b.people = 10; b.total = 12000; b.mode = 'free'; b.free = { by: 'cover', count: 0, coverers: 1, each: 3 }; },
};

const quickActions = {
  mode: (el) => {
    const b = billOf(el.dataset.bill);
    if (!b) return;
    const m = el.dataset.mode;
    b.mode = b.mode === m ? 'even' : m;
    if (b.mode === 'parts' && b.parts.length === 0) {
      b.parts.push(newPart(store.newId('p', [])));
    }
    if (b.mode === 'even') { rebuild('tog-' + m + '-' + b.id); return; }
    // 點開某一種情況：要填的第一格立刻拿到焦點、捲到眼前
    const first = b.mode === 'parts' ? 'amt-' + b.parts[0].id : b.mode === 'free' ? (b.free.by === 'cover' ? 'fa-' : 'fc-') + b.id : 'xc-' + b.id;
    rebuild(first, true);
  },
  'part-new': (el) => {
    const b = billOf(el.dataset.bill);
    if (!b || b.parts.length >= QUICK_LIMITS.MAX_PARTS) return;
    const used = b.parts.map((p) => p.id);
    const p = newPart(store.newId('p', used));
    b.parts.push(p);
    rebuild('amt-' + p.id, true);
  },
  'part-del': (el) => {
    const b = billOf(el.dataset.bill);
    if (!b) return;
    b.parts = b.parts.filter((p) => p.id !== el.dataset.part);
    live.delete(el.dataset.part);
    if (b.parts.length === 0) b.parts.push(newPart(store.newId('p', [])));
    rebuild('pnew-' + b.id);
  },
  'part-add': (el) => {
    const pid = el.dataset.part;
    if (!live.has(pid)) return;
    live.delete(pid);
    rebuild('amt-' + pid);
  },
  'part-del-item': (el) => {
    const b = billOf(el.dataset.bill);
    const p = partOf(b, el.dataset.part);
    if (!p) return;
    p.items.splice(Number(el.dataset.idx), 1);
    rebuild('amt-' + p.id);
  },
  'bill-new': () => {
    const m = quickModel();
    if (m.bills.length >= QUICK_LIMITS.MAX_BILLS) return;
    const b = newBill(store.newId('b', m.bills.map((x) => x.id)));
    m.bills.push(b);
    rebuild('ppl-' + b.id);
  },
  'bill-del': (el) => {
    const m = quickModel();
    if (m.bills.length <= 1) return;
    m.bills = m.bills.filter((b) => b.id !== el.dataset.bill);
    rebuild('bill-new');
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
    EXAMPLES[el.dataset.ex](m.bills[0]);
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
  'to-advanced': () => flow(async () => {
    const d = $('#dlgAdv');
    const err = $('#daErr');
    err.hidden = true;
    err.textContent = '';
    let converted = null;
    $('#daOk').onclick = () => {
      const act = cur();
      const r = toAdvanced(act && act.quick ? act : null);
      if (!r.ok) { err.textContent = r.reason; err.hidden = false; return; } // 不能轉就把原因寫在對話框裡，資料完全不動
      converted = r.activity;
      d.close('ok');
    };
    await showModal(d, $('#daCancel'));
    if (!converted) return;
    const i = st.activities.findIndex((a) => a.id === converted.id);
    if (i < 0) return;
    st.activities[i] = converted; // 同一個編號、標題與日期，不再有 quick
    setCurrent(converted.id, 'advanced');
    commit('#main');
    toast('已改用點人頭，請確認每筆是哪幾位分', 5000);
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
    const box = d.closest('.result');
    if (box) box.classList.toggle('open', d.open); // 展開「怎麼算的」時不黏住，免得比螢幕還高
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
