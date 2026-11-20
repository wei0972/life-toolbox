/* 多人分帳：操作介面 */
import { computeActivity, computeExpense, validateActivity, LIMITS, serializeExport, parseImport } from './core.js?v=20261120201636';
import { explainExpense, formatMoney } from './explain.js?v=20261120201636';
import * as store from './store.js?v=20261120201636';
import * as card from './card.js?v=20261120201636';
import { BRAND } from '../shared/shell.js?v=20261120201636';

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
let asking = false;
const notices = [];
const ui = { open: new Set(), cardKind: 'compact', importMsg: '' };
let pendingFocus = null;
let focusApplied = false;
let lastKey = null;
const mq = window.matchMedia('(min-width:900px)');

const cur = () => st.activities.find((a) => a.id === st.currentId) || null;
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
  if (asking || orphans.length === 0 || anyDialogOpen()) return;
  asking = true;
  try {
    while (orphans.length > 0 && !anyDialogOpen()) {
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
        st.currentId = o.id;
        ui.importMsg = '';
        syncNotice = '';
        persist();
        pendingFocus = '#main';
        render();
        toast('已把這份存成新的活動');
      } else {
        render();
        toast('已放掉你在這個分頁改的那份');
      }
    }
  } finally { asking = false; }
}

let toastTimer = 0;
function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms || 3200);
}

/* ---------- 對話框 ---------- */

function showModal(dlg, focusEl) {
  return new Promise((resolve) => {
    const onClose = () => { dlg.removeEventListener('close', onClose); resolve(dlg.returnValue); };
    dlg.addEventListener('close', onClose);
    dlg.returnValue = '';
    dlg.showModal();
    if (focusEl) { focusEl.focus(); if (focusEl.select) focusEl.select(); }
  });
}

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
  const keep = st.currentId;
  const next = r.state;
  if (keep && next.activities.some((a) => a.id === keep)) next.currentId = keep;
  if (store.serializeState(next) === store.serializeState(st)) { baseline = store.makeBaseline(st); return; }
  const draft = $('#memName') ? $('#memName').value : '';
  st = next;
  baseline = store.makeBaseline(st);
  storageOk = true;
  syncNotice = '另一個分頁更新了資料，已同步。';
  render();
  if (draft && $('#memName')) $('#memName').value = draft;
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

function emptyHtml() {
  return '<section class="sec hero" aria-labelledby="h-hero"><h2 id="h-hero">幾個人一起花錢，三步就算清楚</h2>' +
    '<ol class="steps">' +
    '<li><b aria-hidden="true">1</b><span>加成員<small>輸入大家的暱稱就好</small></span></li>' +
    '<li><b aria-hidden="true">2</b><span>記支出<small>誰先付、多少錢、分給誰</small></span></li>' +
    '<li><b aria-hidden="true">3</b><span>看誰給誰<small>算好還能存成一張圖丟群組</small></span></li></ol>' +
    '<div class="row"><button type="button" class="btn primary" data-act="new-activity" data-fk="new-first">開始分帳</button>' +
    '<button type="button" class="btn ghost" data-act="sample" data-fk="sample">看範例</button></div>' +
    '<p class="after">範例是一份週五聚餐，可以隨意改，也可以刪掉。</p></section>';
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
    (act ? '<button type="button" class="btn ghost" data-act="export" data-fk="export">匯出目前活動的備份檔</button>' : '') +
    '<label class="btn ghost">匯入備份檔（加入為新活動）<input type="file" id="impFile" accept=".json,application/json" data-fk="import"></label>' +
    (st.activities.length ? '<button type="button" class="btn danger" data-act="clear-all" data-fk="clear">清除這台裝置上的所有資料</button>' : '') + '</div></section>';
}

function helpHtml() {
  const d = (t, body) => '<details><summary>' + t + '<span class="chev" aria-hidden="true"></span></summary><div class="txt">' + body + '</div></details>';
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
  const scrollY = window.scrollY;
  const act = cur();
  const res = act ? computeActivity(act) : null;
  let h = '<div class="stage"><main class="app" id="main" tabindex="-1">' + headHtml() + noticesHtml();
  if (!act) {
    h += emptyHtml() + backupHtml(null) + helpHtml();
  } else {
    h += eventHtml(act, res) + membersHtml(act) + expenseHtml(act, res) + settleHtml(act, res) + barHtml(act, res) + backupHtml(act) + helpHtml();
  }
  h += '</main>' + (mq.matches && act ? cardColHtml(act, res) : '') + '</div>';
  $('#app').innerHTML = h;
  if (mq.matches && act) {
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

const MODES = [['none', '不參與'], ['share', '一起分'], ['fixed', '固定金額']];

function rowHtml(m) {
  const k = m.id;
  return '<div class="mrow" data-m="' + k + '"><div class="mhead"><span class="mname">' + esc(m.name) + '</span><span class="mamt" data-amt></span></div>' +
    '<div class="seg" role="radiogroup" aria-label="' + esc(m.name) + '怎麼分">' +
    MODES.map(([v, t]) => '<label class="seg-opt"><input type="radio" name="r-' + k + '" value="' + v + '"><span>' + t + '</span></label>').join('') + '</div>' +
    '<div class="extra" data-x="share" hidden><label class="what" for="sh-' + k + '"><span class="sr-only">' + esc(m.name) + '的</span>份數</label><input id="sh-' + k + '" type="text" inputmode="numeric" autocomplete="off" value="1"><span class="unit">份</span></div>' +
    '<div class="extra" data-x="fixed" hidden><label class="what" for="fx-' + k + '"><span class="sr-only">' + esc(m.name) + '的</span>固定付</label><input id="fx-' + k + '" type="text" inputmode="numeric" autocomplete="off" placeholder="例如：100"><span class="unit">元</span></div>' +
    '<p class="field-err" data-e hidden></p></div>';
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
    $('#exRows').innerHTML = members.map(rowHtml).join('');
    $('#exPayer').innerHTML = members.map((m) => '<option value="' + m.id + '">' + esc(m.name) + '</option>').join('');

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
    const useShares = parts.some((p) => p.shares !== 1);
    form.querySelector('input[name="exMode"][value="' + (useShares ? 'shares' : 'equal') + '"]').checked = true;
    for (const m of members) {
      const st0 = byFixed.has(m.id) ? 'fixed' : byShare.has(m.id) ? 'share' : 'none';
      form.querySelector('input[name="r-' + m.id + '"][value="' + st0 + '"]').checked = true;
      if (byShare.has(m.id) && byShare.get(m.id) > 0) $('#sh-' + m.id).value = String(byShare.get(m.id));
      if (byFixed.has(m.id) && byFixed.get(m.id) >= 0) $('#fx-' + m.id).value = String(byFixed.get(m.id));
    }

    const readDraft = () => ({
      title: $('#exName').value,
      amount: $('#exAmt').value,
      payer: $('#exPayer').value,
      mode: form.querySelector('input[name="exMode"]:checked').value,
      rows: members.map((m) => ({
        id: m.id,
        name: m.name,
        s: form.querySelector('input[name="r-' + m.id + '"]:checked').value,
        shares: $('#sh-' + m.id).value,
        fixed: $('#fx-' + m.id).value,
      })),
    });

    function build(dr) {
      const errs = [];
      const fieldErr = {};
      const am = store.parseAmount(dr.amount);
      if (!am.ok) { errs.push(am.reason); fieldErr.amount = am.reason; }
      const participants = [];
      const fx = [];
      for (const r of dr.rows) {
        if (r.s === 'share') {
          let sh = 1;
          if (dr.mode === 'shares') {
            const p = store.parseShares(r.shares, r.name + '的份數');
            if (p.ok) sh = p.value; else { sh = 0; errs.push(p.reason); fieldErr['sh-' + r.id] = p.reason; }
          }
          participants.push({ memberId: r.id, shares: sh });
        } else if (r.s === 'fixed') {
          const p = store.parseFixed(r.fixed, r.name + '的固定金額');
          let v = -1;
          if (p.ok) v = p.value; else { errs.push(p.reason); fieldErr['fx-' + r.id] = p.reason; }
          fx.push({ memberId: r.id, amount: v });
        }
      }
      const expense = {
        id: ex ? ex.id : 'tmp', title: dr.title.trim().slice(0, LIMITS.MAX_TITLE), payerId: dr.payer,
        amount: am.ok ? am.value : 0, participants, fixed: fx,
      };
      return { expense, errs, fieldErr, amountBlank: store.normalizeNumberText(dr.amount) === '' };
    }

    function update() {
      const dr = readDraft();
      const b = build(dr);
      let r = null;
      if (b.errs.length === 0) r = computeExpense(b.expense, ids);
      const bad = b.errs.length > 0 || !r.ok;

      for (const row of dr.rows) {
        const el = form.querySelector('.mrow[data-m="' + row.id + '"]');
        el.classList.toggle('off', row.s === 'none');
        el.querySelector('[data-x="share"]').hidden = !(row.s === 'share' && dr.mode === 'shares');
        el.querySelector('[data-x="fixed"]').hidden = row.s !== 'fixed';
        const amt = el.querySelector('[data-amt]');
        amt.textContent = r && r.ok && Object.prototype.hasOwnProperty.call(r.owed, row.id) ? money(r.owed[row.id]) + ' 元' : '';
        const fe = b.fieldErr['sh-' + row.id] || b.fieldErr['fx-' + row.id];
        const key = row.s === 'share' ? 'sh-' + row.id : 'fx-' + row.id;
        const p = el.querySelector('[data-e]');
        const show = fe && (touched.has(key) || attempted);
        p.hidden = !show;
        p.textContent = show ? fe : '';
      }
      const ae = $('#exAmtErr');
      const showAmt = b.fieldErr.amount && (touched.has('amount') || attempted) && !(b.amountBlank && !attempted && !touched.has('amount'));
      ae.hidden = !showAmt;
      ae.textContent = showAmt ? b.fieldErr.amount : '';
      $('#exAmt').setAttribute('aria-invalid', showAmt ? 'true' : 'false');

      let pv = '';
      if (b.errs.length > 0) {
        if (b.amountBlank && b.errs.length === 1 && !attempted) {
          pv = '<p class="muted">先填好金額，這裡會即時算出每個人要付多少。</p>';
        } else {
          pv = '<div class="err pv-err" role="alert"><p>先把下面這些處理好：</p>' + b.errs.map((e) => '<p>・' + esc(e) + '</p>').join('') + '</div>';
        }
      } else if (!r.ok) {
        pv = '<div class="err pv-err" role="alert">' + explainExpense(b.expense, r, members).map((l) => '<p>' + esc(l) + '</p>').join('') + '</div>';
      } else {
        const lines = explainExpense(b.expense, r, members);
        pv = '<p class="pv-title">這筆怎麼算</p><div class="pv-how">' + lines.map((l) => '<p>' + esc(l) + '</p>').join('') + '</div>';
      }
      if (bad && !(b.amountBlank && b.errs.length === 1 && !attempted)) pv += '<p class="pv-draft">有地方要改才能按「完成」，也可以先存成草稿，晚點再補。</p>';
      $('#exPreview').innerHTML = pv;
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

    form.oninput = (e) => { if (e.target.id) touched.add(e.target.id === 'exAmt' ? 'amount' : e.target.id); update(); };
    form.onchange = update;
    $('#exAmt').onblur = () => {
      touched.add('amount');
      const p = store.parseAmount($('#exAmt').value);
      if (p.ok) $('#exAmt').value = money(p.value);
      update();
    };
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
      return JSON.stringify([dr.title.trim(), store.normalizeNumberText(dr.amount), dr.payer, dr.mode,
        dr.rows.map((r) => [r.id, r.s, r.s === 'share' && dr.mode === 'shares' ? store.normalizeNumberText(r.shares) : '', r.s === 'fixed' ? store.normalizeNumberText(r.fixed) : ''])]);
    };
    const initial = snap();
    let asking = false;
    d.guard = async () => {
      if (asking) return;
      if (snap() === initial) { d.close('cancel'); return; }
      asking = true;
      const drop = await confirmBox({ title: '放棄剛剛的修改？', body: '這筆支出你改過的地方還沒存，現在關掉就會不見。', okText: '放棄修改', cancelText: '繼續編輯', danger: true });
      asking = false;
      if (drop) d.close('cancel');
      else { const el = document.activeElement; if (!d.contains(el)) $('#exName').focus(); }
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
  return flow(async () => {
    const act = cur();
    const res = computeActivity(act);
    if (!act || res.hasErrors || act.expenses.length === 0) return;
    const d = $('#dlgCard');
    let kind = ui.cardKind;
    let canvas = null;
    d.querySelector('input[name="ckKind"][value="' + kind + '"]').checked = true;
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
  st.currentId = a.id;
  return a;
}

const actions = {
  'new-activity': () => flow(async () => {
    const r = await askText({ title: '新的活動', label: '活動名稱', placeholder: '例如：週五聚餐', max: LIMITS.MAX_TITLE, okText: '建立' });
    if (r && r.action === 'ok') { activeActivityInit(r.value); commit('#memName'); }
  }),
  sample: () => {
    const used = new Set(st.activities.map((a) => a.id));
    const a = store.sampleActivity(store.todayLocal());
    a.id = store.newId('a', used);
    st.activities.push(a);
    st.currentId = a.id;
    ui.open.add('e3');
    commit('#h-event');
    toast('已放入範例，隨意改改看');
  },
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
    st.currentId = st.activities[0] ? st.activities[0].id : null;
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
  commit('#h-event');
  toast('已加入「' + out.activity.title + '」成為新活動');
}

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
    st.currentId = e.target.value;
    commit('#actSel');
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
  await card.fontsReady();
  render();
}

window.__lt = {
  ready: boot(),
  state: () => JSON.parse(JSON.stringify(st)),
  result: () => { const a = cur(); return a ? computeActivity(a) : null; },
  cardDataUrl: (kind) => {
    const a = cur();
    return card.renderCard(a, computeActivity(a), kind === 'detail' ? 'detail' : 'compact').toDataURL('image/png');
  },
};
