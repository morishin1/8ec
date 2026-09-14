/* ========================================================================
   QRコード在庫・備品管理

   中核の流れ:
     スマホ標準カメラ → QR読取 → その商品のページ → 入庫・出庫・貸出・返却・移動・棚卸

   QRにはURLだけを入れる（商品情報は持たせない）。
     個体     /zaiko/items/PC-00125
     数量品   /zaiko/products/SKU-0001
     保管場所 /zaiko/locations/L3

   いちばん大事なのは「QRを読む → 状況を見る → 操作する」が3タップ以内であること。
   そのためQRのURLで開いたときは、まずその1件だけを取りに行って先に描き、
   残りの一覧データはそのあと裏で読み込む。

   値を変える操作は、画面からUPDATEせずすべてSupabaseの関数を通す。
   「値を変える」と「履歴を残す」が必ず同じトランザクションになるようにするため。
   ======================================================================== */
'use strict';

const SUPA_URL = "https://htglvascsuqkixpmclwr.supabase.co";
const SUPA_KEY = "sb_publishable_yZCcrwdqjuf0u_5WBWlHIw_AxdvteEV";
const MAIL_DOMAIN = "@8grp.co.jp";
const BASE = "/zaiko";                 // QRのURLに入るパス
const LOAN_LONG_DAYS = 30;             // これを超えたら「長期貸出」
const DUP_SCAN_MS = 1800;              // 同じQRの読み直しを無視する時間
const LOAD_LIMIT = 3000;

const STATUSES = ['在庫', '貸出中', '使用中', '修理中', '故障', '紛失', '廃棄'];
const STATUS_ICON = {
  '在庫': 'inventory_2', '貸出中': 'assignment_ind', '使用中': 'person',
  '修理中': 'build', '故障': 'error', '紛失': 'help', '廃棄': 'delete'
};
const MENU = [
  ['dash', 'space_dashboard', 'ダッシュボード', ''],
  ['list', 'list_alt', '在庫一覧', '/list'],
  ['in', 'login', '入庫', '/in'],
  ['out', 'logout', '出庫', '/out'],
  ['loan', 'swap_horiz', '貸出・返却', '/loan'],
  ['stock', 'fact_check', '棚卸', '/stock'],
  ['locs', 'warehouse', '保管場所', '/locations'],
  ['hist', 'history', '履歴', '/history'],
  ['reg', 'add_box', '商品登録', '/register'],
  ['labels', 'qr_code_2', 'QRラベル', '/labels']
];

let sb = null;
let me = { email: '', name: '', role: 'viewer' };
const db = { cats: [], locs: [], items: [], prods: [], tx: [], stocktake: null, stChecked: [], stPast: [], members: [] };
const ui = {
  screen: 'dash', itemId: null, prodId: null, locId: null,
  kind: 'ind', q: '', fCat: '', fLoc: '', fStatus: '',
  fAction: '', hq: '', regKind: 'ind', made: null,
  drafts: {}, labelSel: {}, stScope: '', loaded: false
};

/* ---------------------------------------------------------------- 小道具 */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = (n) => (n == null || n === '') ? '—' : '¥' + Number(n).toLocaleString('ja-JP');
const P2 = (n) => String(n).padStart(2, '0');
function fmtDT(s) { if (!s) return '—'; const d = new Date(s); return `${d.getFullYear()}/${P2(d.getMonth() + 1)}/${P2(d.getDate())} ${P2(d.getHours())}:${P2(d.getMinutes())}`; }
function fmtD(s) { if (!s) return '—'; const d = new Date(s); return `${d.getFullYear()}/${P2(d.getMonth() + 1)}/${P2(d.getDate())}`; }
function daysSince(s) { if (!s) return 0; return Math.floor((Date.now() - new Date(s).getTime()) / 86400000); }
function canEdit() { return me.role === 'admin' || me.role === 'member'; }
function canAdmin() { return me.role === 'admin'; }

let toastTimer = null;
function toast(msg) {
  $('toastMsg').textContent = msg;
  $('toast').classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('on'), 2600);
}

/* QR画像は同じ文字列なら作り直さない（ラベル印刷で何十枚も並ぶため） */
const qrCache = {};
function qr(text) {
  if (qrCache[text]) return qrCache[text];
  try {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    qrCache[text] = q.createDataURL(4, 6);
  } catch (e) { qrCache[text] = ''; }
  return qrCache[text];
}
const origin = () => location.origin;
const itemUrl = (id) => origin() + BASE + '/items/' + id;
const prodUrl = (code) => origin() + BASE + '/products/' + code;
const locUrl = (id) => origin() + BASE + '/locations/' + id;

/* ---------------------------------------------------------------- 参照 */
const item = (id) => db.items.find(i => i.id === id);
const prod = (code) => db.prods.find(p => p.code === code);
const loc = (id) => db.locs.find(l => l.id === id);
const cat = (id) => db.cats.find(c => c.id === id);
const catName = (id) => (cat(id) || {}).name || '';

function locPath(id) {
  const out = [];
  let cur = loc(id), guard = 0;
  while (cur && guard++ < 8) { out.unshift(cur.name); cur = cur.parent_id ? loc(cur.parent_id) : null; }
  return out.join(' / ');
}
function locTree(id) {
  const out = [id];
  let added = true;
  while (added) {
    added = false;
    db.locs.forEach(l => { if (l.parent_id && out.includes(l.parent_id) && !out.includes(l.id)) { out.push(l.id); added = true; } });
  }
  return out;
}
function locDepth(id) {
  let d = 0, cur = loc(id);
  while (cur && cur.parent_id && d < 8) { d++; cur = loc(cur.parent_id); }
  return d;
}
/* 親→子の順に並べた保管場所（ツリー表示と選択肢の順序に使う） */
function locsOrdered() {
  const out = [];
  const walk = (parent) => {
    db.locs.filter(l => (l.parent_id || null) === parent)
      .sort((a, b) => (a.sort_no - b.sort_no) || a.name.localeCompare(b.name, 'ja'))
      .forEach(l => { out.push(l); walk(l.id); });
  };
  walk(null);
  return out;
}
const isLong = (it) => it.status === '貸出中' && daysSince(it.loaned_at) > LOAN_LONG_DAYS;
const needsOrder = (p) => (p.qty || 0) <= (p.min_qty || 0);

/* ---------------------------------------------------------------- 認証 */
(async function init() {
  if (!window.supabase) { showGate('読み込みに失敗しました。通信状況を確かめて、再読み込みしてください。'); return; }
  sb = window.supabase.createClient(SUPA_URL, SUPA_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storage: window.localStorage, storageKey: 'zimu-portal-auth' }
  });
  const { data: { session } } = await sb.auth.getSession();
  if (session && session.user) { await start(session.user.email); }
  else {
    // QRから来て未ログインなら、ログイン後にそのページへ戻す
    try { sessionStorage.setItem('zaiko.after', location.pathname); } catch (e) {}
    showGate('');
  }
})();

function showGate(msg) {
  $('gate').style.display = 'grid';
  $('app').style.display = 'none';
  $('gateErr').textContent = msg || '';
}

async function doLogin() {
  const id = $('g-id').value.trim(), pw = $('g-pw').value;
  if (!id || !pw) { $('gateErr').textContent = 'IDとパスワードを入力してください'; return; }
  const email = id.indexOf('@') > 0 ? id.toLowerCase() : id.toLowerCase() + MAIL_DOMAIN;
  const { data, error } = await sb.auth.signInWithPassword({ email, password: pw });
  if (error) { $('gateErr').textContent = 'IDまたはパスワードが違います'; return; }
  await start(data.user.email);
}
async function signOut() { await sb.auth.signOut(); location.href = BASE; }

async function start(email) {
  me.email = email;
  $('gate').style.display = 'none';
  $('app').style.display = 'block';
  renderMenu();

  // ログイン前に見ようとしたページがあれば、そこへ戻す
  try {
    const after = sessionStorage.getItem('zaiko.after');
    if (after && after.indexOf(BASE) === 0 && after !== location.pathname) {
      sessionStorage.removeItem('zaiko.after');
      history.replaceState(null, '', after);
    }
  } catch (e) {}

  await loadMe();
  await route(true);
}

async function loadMe() {
  const { data, error } = await sb.from('inventory_members').select('*').eq('email', me.email).maybeSingle();
  if (error) { showSetup(error); return; }
  me.name = (data && data.display_name) || me.email;
  me.role = (data && data.role) || 'viewer';
  $('whoName').textContent = me.name;
  $('whoRole').textContent = { admin: '管理者', member: '一般', viewer: '閲覧' }[me.role] || me.role;
}

function showSetup(err) {
  const missing = /does not exist|schema cache|42P01|PGRST205/i.test((err && (err.message || err.code)) || '');
  $('setup').style.display = missing ? 'block' : 'none';
  $('setupErr').textContent = missing ? '（Supabaseからの応答： ' + (err.message || err.code) + '）' : '';
  if (!missing) toast('読み込みに失敗しました：' + (err.message || err.code));
}

/* ---------------------------------------------------------------- 読み込み */

/* 一覧まわりのデータ。QRで直接開いたときは、詳細を描いたあとに裏で走らせる */
async function loadAll() {
  const q = [
    sb.from('inventory_categories').select('*').order('sort_no'),
    sb.from('inventory_locations').select('*').order('sort_no'),
    sb.from('inventory_items').select('*').limit(LOAD_LIMIT),
    sb.from('inventory_products').select('*').limit(LOAD_LIMIT),
    sb.from('inventory_transactions').select('*').order('occurred_at', { ascending: false }).limit(300),
    sb.from('inventory_stocktakes').select('*').order('started_at', { ascending: false }).limit(20)
  ];
  const [c, l, i, p, t, s] = await Promise.all(q);
  const bad = [c, l, i, p, t, s].find(r => r.error);
  if (bad) { showSetup(bad.error); return false; }

  db.cats = c.data || [];
  db.locs = l.data || [];
  db.items = (i.data || []).sort((a, b) => a.id.localeCompare(b.id, 'ja'));
  db.prods = (p.data || []).sort((a, b) => a.code.localeCompare(b.code, 'ja'));
  db.tx = t.data || [];
  const sts = s.data || [];
  db.stocktake = sts.find(x => x.status === 'open') || null;
  db.stPast = sts.filter(x => x.status !== 'open');
  await loadStocktakeItems();
  ui.loaded = true;
  $('setup').style.display = 'none';
  return true;
}

async function loadStocktakeItems() {
  db.stChecked = [];
  if (!db.stocktake) return;
  const { data, error } = await sb.from('inventory_stocktake_items')
    .select('*').eq('stocktake_id', db.stocktake.id).limit(LOAD_LIMIT);
  if (!error) db.stChecked = data || [];
}

async function refreshTx() {
  const { data, error } = await sb.from('inventory_transactions')
    .select('*').order('occurred_at', { ascending: false }).limit(300);
  if (!error) db.tx = data || [];
}

/* ---------------------------------------------------------------- ルーティング
   QRのURLがそのままその商品のページになる、が最優先の要件。
   画面内の移動も pushState で同じURLの形にそろえる                     */
function parsePath() {
  const p = location.pathname.replace(/\/+$/, '');
  const rest = p.indexOf(BASE) === 0 ? p.slice(BASE.length) : '';
  const seg = rest.split('/').filter(Boolean);
  if (!seg.length) return { screen: 'dash' };
  if (seg[0] === 'items' && seg[1]) return { screen: 'item', itemId: decodeURIComponent(seg[1]) };
  if (seg[0] === 'products' && seg[1]) return { screen: 'prod', prodId: decodeURIComponent(seg[1]) };
  if (seg[0] === 'locations' && seg[1]) return { screen: 'loc', locId: decodeURIComponent(seg[1]) };
  const byPath = { list: 'list', in: 'in', out: 'out', loan: 'loan', stock: 'stock', locations: 'locs', history: 'hist', register: 'reg', labels: 'labels' };
  return { screen: byPath[seg[0]] || 'dash' };
}

function pathFor(screen, id) {
  if (screen === 'item') return BASE + '/items/' + encodeURIComponent(id);
  if (screen === 'prod') return BASE + '/products/' + encodeURIComponent(id);
  if (screen === 'loc') return BASE + '/locations/' + encodeURIComponent(id);
  const m = MENU.find(x => x[0] === screen);
  return BASE + (m ? m[3] : '');
}

function go(screen, id) {
  const path = pathFor(screen, id);
  if (path !== location.pathname) history.pushState(null, '', path);
  closeSheet();
  applyRoute({ screen, itemId: screen === 'item' ? id : null, prodId: screen === 'prod' ? id : null, locId: screen === 'loc' ? id : null });
  window.scrollTo(0, 0);
}
window.addEventListener('popstate', () => route(false));

function applyRoute(r) {
  ui.screen = r.screen;
  ui.itemId = r.itemId || null;
  ui.prodId = r.prodId || null;
  ui.locId = r.locId || null;
  renderMenu();
  render();
}

async function route(first) {
  const r = parsePath();
  // QRで直接開いたときは、その1件だけ先に取って描く（読取から表示までを短くする）
  if (first && (r.screen === 'item' || r.screen === 'prod')) {
    const ok = await loadOne(r);
    if (ok) { applyRoute(r); loadAll().then(() => render()); return; }
  }
  if (!ui.loaded) { const ok = await loadAll(); if (!ok) return; }
  applyRoute(r);
}

async function loadOne(r) {
  const res = r.screen === 'item'
    ? await sb.from('inventory_items').select('*').eq('id', r.itemId).maybeSingle()
    : await sb.from('inventory_products').select('*').eq('code', r.prodId).maybeSingle();
  if (res.error) { showSetup(res.error); return false; }
  if (!res.data) return false;
  if (r.screen === 'item') db.items = [res.data]; else db.prods = [res.data];
  // 保管場所とカテゴリだけは表示に要るので一緒に取る
  const [l, c] = await Promise.all([
    sb.from('inventory_locations').select('*').order('sort_no'),
    sb.from('inventory_categories').select('*').order('sort_no')
  ]);
  db.locs = l.data || []; db.cats = c.data || [];
  return true;
}

/* ---------------------------------------------------------------- メニュー */
function renderMenu() {
  $('menu').innerHTML = MENU.map(([key, icon, label]) =>
    `<button class="${ui.screen === key ? 'on' : ''}" onclick="go('${key}')"><span class="ms">${icon}</span>${esc(label)}</button>`
  ).join('');
  $('siteName').textContent = db.locs.length ? (locsOrdered().find(l => l.kind === 'site') || {}).name || '' : '';
}

/* ---------------------------------------------------------------- 描画 */
function render() {
  const v = $('view');
  const fn = {
    dash: viewDash, list: viewList, item: viewItem, prod: viewProd, in: viewIn, out: viewOut,
    loan: viewLoan, stock: viewStock, locs: viewLocs, loc: viewLoc, hist: viewHist, reg: viewReg, labels: viewLabels
  }[ui.screen] || viewDash;
  v.innerHTML = fn();
  if (ui.screen === 'labels') bindLabelPicks();
}

const guardNote = () => canEdit() ? '' : '<div class="card" style="margin-bottom:15px">閲覧権限では操作できません。</div>';
const dis = () => canEdit() ? '' : 'disabled';

/* ===== 1. ダッシュボード ===== */
function viewDash() {
  const live = db.items.filter(i => i.status !== '廃棄');
  const qtySum = db.prods.reduce((s, p) => s + (p.qty || 0), 0);
  const loans = live.filter(i => i.status === '貸出中');
  const longs = loans.filter(isLong);
  const using = live.filter(i => i.status === '使用中');
  const zero = db.prods.filter(p => (p.qty || 0) <= 0);
  const order = db.prods.filter(needsOrder);
  const broken = live.filter(i => i.status === '修理中' || i.status === '故障');
  const now = new Date(), ym = now.getFullYear() + '-' + P2(now.getMonth() + 1);
  const bought = db.items.filter(i => (i.purchased_on || '').slice(0, 7) === ym);
  const boughtSum = bought.reduce((s, i) => s + Number(i.price || 0), 0);

  // 棚卸で「まだ確認していない」件数
  const checkedIds = db.stChecked.filter(x => x.checked_at).map(x => x.item_id);
  const stLeft = db.stocktake ? db.stChecked.length - checkedIds.length : 0;

  const kpi = (label, v, note) =>
    `<div class="kpi"><div class="lbl">${esc(label)}</div><div class="v num">${v}</div><div class="n">${note || ''}</div></div>`;

  const chk = (icon, title, n, detail, screen, setup) =>
    `<button class="chk card" onclick="${setup || ''}go('${screen}')">
      <div class="h"><span class="ms">${icon}</span><span class="t">${esc(title)}</span>
        <span class="b ${n > 0 ? 'on' : 'off'}">${n}</span></div>
      <div class="d">${esc(detail)}</div></button>`;

  return `
    <div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:26px">
      <h1>ダッシュボード</h1>
      <span class="meta">${fmtDT(new Date().toISOString())}　${esc(me.name)}</span>
    </div>
    <div class="kpis">
      ${kpi('総在庫', live.length + qtySum, `個体 ${live.length}／数量 ${qtySum}`)}
      ${kpi('貸出中', loans.length, longs.length ? `${LOAN_LONG_DAYS}日超 ${longs.length}件` : '')}
      ${kpi('使用中', using.length, '')}
      ${kpi('在庫切れ', zero.length, '数量管理')}
      ${kpi('要発注', order.length, '最低在庫以下')}
      ${kpi('故障・修理', broken.length, '')}
      ${kpi('今月購入額', yen(boughtSum), `${bought.length}件`)}
    </div>

    <div class="sec">要確認</div>
    <div class="checks">
      ${chk('shopping_cart', '在庫数不足', order.length, '最低在庫を下回っている品目', 'list', "ui.kind='qty';ui.fStatus='';")}
      ${chk('schedule', '長期貸出', longs.length, `${LOAN_LONG_DAYS}日を超えて返却されていないもの`, 'loan')}
      ${chk('help', '棚卸未確認', stLeft, db.stocktake ? '実施中の棚卸で、まだ確認できていないもの' : '棚卸は実施していません', 'stock')}
      ${chk('build', '故障・修理中', broken.length, '使えない状態のまま残っているもの', 'list', "ui.kind='ind';ui.fStatus='修理中';")}
    </div>

    <div class="sec">直近の操作</div>
    ${db.tx.length ? db.tx.slice(0, 6).map(txRow).join('') : '<div class="empty">まだ操作の記録はありません。</div>'}
  `;
}

function txRow(t) {
  return `<div class="rowline">
    <span class="meta num" style="width:126px;flex:0 0 auto">${fmtDT(t.occurred_at)}</span>
    <span class="meta" style="width:72px;flex:0 0 auto;overflow:hidden;text-overflow:ellipsis">${esc(t.actor || '')}</span>
    <span style="flex:1 1 180px;min-width:0">${esc(t.label || t.ref_id)}</span>
    <span class="tag act">${esc(t.action)}</span>
    <span class="meta" style="flex:1 1 200px">${esc(t.before_value || '—')} → ${esc(t.after_value || '—')}</span>
  </div>`;
}

/* ===== 2. 在庫一覧 ===== */
function setKind(k) { ui.kind = k; ui.fCat = ''; ui.fStatus = ''; render(); }
function onFilter() {
  ui.q = ($('f-q') || {}).value || '';
  ui.fCat = ($('f-cat') || {}).value || '';
  ui.fLoc = ($('f-loc') || {}).value || '';
  ui.fStatus = ($('f-status') || {}).value || '';
  renderListBody();
}
function locOptions(sel, allLabel) {
  return `<option value="">${esc(allLabel)}</option>` + locsOrdered().map(l =>
    `<option value="${esc(l.id)}"${sel === l.id ? ' selected' : ''}>${'　'.repeat(locDepth(l.id))}${esc(l.name)}</option>`).join('');
}
function listFiltered() {
  const q = ui.q.trim().toLowerCase();
  const inScope = ui.fLoc ? locTree(ui.fLoc) : null;
  if (ui.kind === 'ind') {
    return db.items.filter(i => {
      if (ui.fCat && i.category_id !== ui.fCat) return false;
      if (ui.fStatus && i.status !== ui.fStatus) return false;
      if (inScope && !inScope.includes(i.location_id)) return false;
      if (q) {
        const hay = [i.id, i.name, i.model, i.serial, i.user_name, i.maker].filter(Boolean).join(' ').toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }
  return db.prods.filter(p => {
    if (ui.fCat && p.category_id !== ui.fCat) return false;
    if (inScope && !inScope.includes(p.location_id)) return false;
    if (ui.fStatus === 'low' && !needsOrder(p)) return false;
    if (q) {
      const hay = [p.code, p.name, p.supplier].filter(Boolean).join(' ').toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });
}
function viewList() {
  const cats = db.cats.filter(c => c.kind === (ui.kind === 'ind' ? 'individual' : 'quantity'));
  return `
    <h1>在庫一覧</h1>
    <div class="seg" style="margin:15px 0">
      <button class="${ui.kind === 'ind' ? 'on' : ''}" onclick="setKind('ind')">個体管理</button>
      <button class="${ui.kind === 'qty' ? 'on' : ''}" onclick="setKind('qty')">数量管理</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px">
      <input class="input" id="f-q" value="${esc(ui.q)}" oninput="onFilter()" placeholder="商品名・管理番号・型番・利用者…">
      <select class="input" id="f-cat" onchange="onFilter()">
        <option value="">全カテゴリ</option>
        ${cats.map(c => `<option value="${esc(c.id)}"${ui.fCat === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
      <select class="input" id="f-loc" onchange="onFilter()">${locOptions(ui.fLoc, '全保管場所')}</select>
      <select class="input" id="f-status" onchange="onFilter()">
        ${ui.kind === 'ind'
          ? `<option value="">全状態</option>` + STATUSES.map(s => `<option${ui.fStatus === s ? ' selected' : ''}>${s}</option>`).join('')
          : `<option value="">すべて</option><option value="low"${ui.fStatus === 'low' ? ' selected' : ''}>最低在庫以下</option>`}
      </select>
    </div>
    <div id="listBody">${listBodyHtml()}</div>`;
}
function renderListBody() { const el = $('listBody'); if (el) el.innerHTML = listBodyHtml(); }
function listBodyHtml() {
  const rows = listFiltered();
  if (!rows.length) return `<div class="empty" style="margin-top:15px">該当する${ui.kind === 'ind' ? '機器' : '品目'}はありません。</div>`;
  if (ui.kind === 'ind') {
    return `<div class="meta" style="margin-top:12px">${rows.length} 件</div>
      <div class="table-wrap"><table class="t">
      <thead><tr><th>管理番号</th><th>商品名</th><th>カテゴリ</th><th>状態</th><th>保管場所</th><th>利用者</th><th></th></tr></thead>
      <tbody>${rows.map(i => `<tr class="clk" onclick="go('item','${esc(i.id)}')">
        <td class="nowrap num">${esc(i.id)}</td>
        <td>${esc(i.name)}<div class="meta">${esc([i.maker, i.model].filter(Boolean).join(' '))}</div></td>
        <td class="nowrap">${esc(catName(i.category_id))}</td>
        <td>${statusTag(i.status)}</td>
        <td class="meta">${esc(locPath(i.location_id))}</td>
        <td class="nowrap">${esc(i.user_name || '')}</td>
        <td class="nowrap"><span class="btn sm ghost">開く</span></td></tr>`).join('')}</tbody></table></div>`;
  }
  return `<div class="meta" style="margin-top:12px">${rows.length} 件</div>
    <div class="table-wrap"><table class="t">
    <thead><tr><th>商品コード</th><th>商品名</th><th>カテゴリ</th><th>現在庫</th><th>最低在庫</th><th>保管場所</th><th>単価</th><th></th></tr></thead>
    <tbody>${rows.map(p => `<tr class="clk" onclick="go('prod','${esc(p.code)}')">
      <td class="nowrap num">${esc(p.code)}</td>
      <td>${esc(p.name)}<div class="meta">${esc(p.supplier || '')}</div></td>
      <td class="nowrap">${esc(catName(p.category_id))}</td>
      <td class="num" style="font-size:19px;font-weight:500;${needsOrder(p) ? 'color:#B3261E' : ''}">${p.qty}</td>
      <td class="num meta">${p.min_qty}</td>
      <td class="meta">${esc(locPath(p.location_id))}</td>
      <td class="num meta">${yen(p.unit_price)}</td>
      <td class="nowrap"><span class="btn sm ghost">開く</span></td></tr>`).join('')}</tbody></table></div>`;
}
function statusTag(s, big) {
  return `<span class="tag st-${esc(s)}${big ? ' big' : ''}"><span class="ms">${STATUS_ICON[s] || 'inventory_2'}</span>${esc(s)}</span>`;
}

/* ===== 3. 個体の詳細（QRを読んだ直後の画面） ===== */
function viewItem() {
  const it = item(ui.itemId);
  if (!it) return `<div class="empty">該当する機器が見つかりません（${esc(ui.itemId || '')}）</div>`;
  const url = itemUrl(it.id);
  const hist = db.tx.filter(t => t.ref_kind === 'item' && t.ref_id === it.id);
  const op = (icon, label, fn, pri, on) =>
    `<button class="btn ${pri ? 'pri' : ''}" onclick="${fn}" ${on === false || !canEdit() ? 'disabled' : ''}>
      <span class="ms">${icon}</span><span class="t">${esc(label)}</span></button>`;

  return `
  <div class="detail">
    <div class="main">
      <div class="kind">${esc(catName(it.category_id) || '機器')}</div>
      <h1>${esc(it.name)}</h1>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span class="num" style="font-size:19px;font-weight:500">${esc(it.id)}</span>
        ${statusTag(it.status, true)}
        ${isLong(it) ? '<span class="tag" style="background:var(--l200)">長期貸出 ' + daysSince(it.loaned_at) + '日</span>' : ''}
      </div>
      <div class="info">
        <div><span class="k">保管場所</span>${esc(locPath(it.location_id)) || '—'}</div>
        <div><span class="k">利用者</span>${esc(it.user_name || '—')}</div>
        <div><span class="k">メーカー・型番</span>${esc([it.maker, it.model].filter(Boolean).join(' ') || '—')}</div>
        <div><span class="k">シリアル番号</span>${esc(it.serial || '—')}</div>
        <div><span class="k">購入日・価格</span>${it.purchased_on ? fmtD(it.purchased_on) : '—'}　${yen(it.price)}</div>
        <div><span class="k">棚卸確認</span>${it.last_checked_at ? fmtDT(it.last_checked_at) : '未確認'}</div>
      </div>
      ${guardNote()}
      <div class="ops">
        ${op('assignment_ind', '貸出', `sheetLoan('${esc(it.id)}')`, true, it.status === '在庫')}
        ${op('assignment_return', '返却', `sheetReturn('${esc(it.id)}')`, false, it.status === '貸出中')}
        ${op('move_down', '移動', `sheetMove('${esc(it.id)}')`)}
        ${op('build', '修理・故障', `sheetStatus('${esc(it.id)}')`)}
        ${op('fact_check', '棚卸確認', `checkItem('${esc(it.id)}')`)}
        ${canAdmin() ? op('delete', '廃棄', `sheetScrap('${esc(it.id)}')`) : ''}
      </div>
    </div>
    <div class="qrbox">
      <img src="${qr(url)}" alt="${esc(it.id)} のQRコード" width="140" height="140">
      <div class="u">${esc(url)}</div>
    </div>
  </div>
  <div class="sec">この機器の履歴</div>
  ${hist.length ? hist.map(txRow).join('') : '<div class="empty">まだ記録はありません。</div>'}`;
}

/* ===== 4. 数量品の詳細 ===== */
function viewProd() {
  const p = prod(ui.prodId);
  if (!p) return `<div class="empty">該当する品目が見つかりません（${esc(ui.prodId || '')}）</div>`;
  const url = prodUrl(p.code);
  const hist = db.tx.filter(t => t.ref_kind === 'product' && t.ref_id === p.code);
  return `
  <div class="detail">
    <div class="main">
      <div class="kind">${esc(catName(p.category_id) || '消耗品')}</div>
      <h1>${esc(p.name)}</h1>
      <div class="num" style="font-size:19px;font-weight:500">${esc(p.code)}</div>
      <div style="display:flex;align-items:flex-end;gap:20px;margin:18px 0 12px;flex-wrap:wrap">
        <div><div class="lbl">現在庫</div><div class="bignum num" ${needsOrder(p) ? 'style="color:#B3261E"' : ''}>${p.qty}</div></div>
        <div class="sub" style="display:grid;gap:4px">
          <div>最低在庫　<b class="num">${p.min_qty}</b></div>
          <div>保管場所　${esc(locPath(p.location_id)) || '—'}</div>
          <div>${esc(p.supplier || '—')}　${yen(p.unit_price)}</div>
          <div>棚卸確認　${p.last_checked_at ? fmtDT(p.last_checked_at) : '未確認'}</div>
        </div>
      </div>
      ${needsOrder(p) ? `<div class="needorder"><span class="ms">shopping_cart</span>要発注：最低在庫（${p.min_qty}）を下回っています</div>` : ''}
      ${guardNote()}
      <div class="ops">
        <button class="btn pri" onclick="sheetIn('${esc(p.code)}')" ${dis()}><span class="ms">login</span><span class="t">入庫</span></button>
        <button class="btn" onclick="sheetOut('${esc(p.code)}')" ${dis()}><span class="ms">logout</span><span class="t">出庫</span></button>
        <button class="btn" onclick="sheetCount('${esc(p.code)}')" ${dis()}><span class="ms">fact_check</span><span class="t">棚卸</span></button>
      </div>
    </div>
    <div class="qrbox">
      <img src="${qr(url)}" alt="${esc(p.code)} のQRコード" width="140" height="140">
      <div class="u">${esc(url)}</div>
    </div>
  </div>
  <div class="sec">この品目の履歴</div>
  ${hist.length ? hist.map(txRow).join('') : '<div class="empty">まだ記録はありません。</div>'}`;
}

/* ===== 5・6. 入庫 / 出庫 ===== */
function draftSet(code, v) { ui.drafts[code] = v; }
function viewIn() { return moveList('in'); }
function viewOut() { return moveList('out'); }
function moveList(mode) {
  const isIn = mode === 'in';
  if (!db.prods.length) return `<h1>${isIn ? '入庫' : '出庫'}</h1><div class="empty" style="margin-top:20px">数量管理の品目がまだありません。「商品登録」から登録してください。</div>`;
  const rows = db.prods.map(p => `
    <div class="rowline" style="gap:14px;align-items:center">
      <div style="flex:1 1 220px;min-width:0">
        <div style="font-weight:500">${esc(p.name)}</div>
        <div class="meta">${esc(p.code)}　${isIn ? esc(locPath(p.location_id)) : '最低在庫 ' + p.min_qty}</div>
      </div>
      <div class="num" style="font-size:22px;font-weight:500;width:56px;text-align:right;${!isIn && needsOrder(p) ? 'color:#B3261E' : ''}">${p.qty}</div>
      <input class="input num" type="number" min="1" style="width:74px;text-align:center;min-height:44px"
             value="${esc(ui.drafts[p.code] || '')}" placeholder="0" oninput="draftSet('${esc(p.code)}',this.value)">
      <button class="btn ${isIn ? 'pri' : ''}" onclick="${isIn ? 'sheetIn' : 'sheetOut'}('${esc(p.code)}',true)" ${dis()}>
        ${isIn ? '入庫' : '出庫'}</button>
    </div>`).join('');
  return `<h1>${isIn ? '入庫' : '出庫'}</h1>
    <p class="sub" style="margin:8px 0 15px">数量を入れて「${isIn ? '入庫' : '出庫'}」を押すと、確認のうえ在庫に反映し、履歴に前後の数を残します。</p>
    ${guardNote()}${rows}`;
}

/* ===== 7. 貸出・返却 ===== */
function viewLoan() {
  const out = db.items.filter(i => i.status === '貸出中');
  const avail = db.items.filter(i => i.status === '在庫');
  return `<h1>貸出・返却</h1>
    <div class="sec">貸出中（${out.length}）</div>
    ${out.length ? out.map(i => `
      <div class="rowline" style="align-items:center;gap:14px">
        <div style="flex:1 1 200px;min-width:0">
          <div style="font-weight:500">${esc(i.name)}</div><div class="meta">${esc(i.id)}</div></div>
        <div style="flex:0 0 auto">${esc(i.user_name || '')}</div>
        <div class="meta" style="flex:0 0 auto">${fmtD(i.loaned_at)}　${daysSince(i.loaned_at)}日</div>
        ${isLong(i) ? '<span class="tag" style="background:var(--l200)">長期貸出</span>' : ''}
        <div style="display:flex;gap:6px;margin-left:auto">
          <button class="btn sm pri" onclick="sheetReturn('${esc(i.id)}')" ${dis()}>返却</button>
          <button class="btn sm ghost" onclick="go('item','${esc(i.id)}')">詳細</button>
        </div>
      </div>`).join('') : '<div class="empty">貸出中のものはありません。</div>'}

    <div class="sec">貸出可能（${avail.length}）</div>
    ${avail.length ? `<div class="cards">${avail.map(i => `
      <div class="card">
        <div style="font-weight:500">${esc(i.name)}</div>
        <div class="meta" style="margin:2px 0 10px">${esc(i.id)}　${esc(locPath(i.location_id))}</div>
        <button class="btn sm pri" onclick="sheetLoan('${esc(i.id)}')" ${dis()}>貸出する</button>
      </div>`).join('')}</div>` : '<div class="empty">貸し出せる在庫がありません。</div>'}`;
}

/* ===== 8. 棚卸 ===== */
function viewStock() {
  if (!db.stocktake) {
    const scope = ui.stScope;
    const n = db.items.filter(i => i.status !== '廃棄' && (!scope || locTree(scope).includes(i.location_id))).length;
    return `<h1>棚卸</h1>
      <p class="sub" style="margin:8px 0 18px">対象を決めて始めると、その範囲の機器が「未確認」に並びます。QRを連続で読み取って確認していきます。</p>
      ${guardNote()}
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;max-width:620px">
        <select class="input" style="flex:1 1 220px" onchange="ui.stScope=this.value;render()">
          <option value="">すべて</option>
          ${locsOrdered().map(l => `<option value="${esc(l.id)}"${scope === l.id ? ' selected' : ''}>${'　'.repeat(locDepth(l.id))}${esc(l.name)}</option>`).join('')}
        </select>
      </div>
      <button class="btn lime" style="min-height:56px;margin-top:12px" onclick="startStocktake()" ${dis()}>
        <span class="ms">play_circle</span>棚卸開始（対象 ${n}件）</button>

      <div class="sec">これまでの棚卸</div>
      ${db.stPast.length ? `<div class="table-wrap"><table class="t">
        <thead><tr><th>実施</th><th>範囲</th><th>担当</th><th>確認</th></tr></thead>
        <tbody>${db.stPast.map(s => `<tr>
          <td class="nowrap meta">${fmtDT(s.started_at)}</td>
          <td>${esc(s.scope_location_id ? locPath(s.scope_location_id) : 'すべて')}</td>
          <td class="meta">${esc(s.actor || '')}</td>
          <td class="meta">—</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="empty">まだ実施していません。</div>'}`;
  }

  const st = db.stocktake;
  const all = db.stChecked;
  const done = all.filter(x => x.checked_at);
  const left = all.filter(x => !x.checked_at);
  const pct = all.length ? Math.round(done.length / all.length * 100) : 0;
  return `<h1>棚卸</h1>
    <div style="display:flex;align-items:flex-end;gap:20px;flex-wrap:wrap;margin:14px 0 6px">
      <div class="stcount num">${done.length} <small>/ ${all.length}</small></div>
      <div class="sub">${esc(st.scope_location_id ? locPath(st.scope_location_id) : 'すべて')}　開始 ${fmtDT(st.started_at)}</div>
    </div>
    <div class="prog"><i style="width:${pct}%"></i></div>
    ${guardNote()}
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn lime" style="min-height:56px;flex:1 1 220px" onclick="openScan('stocktake')" ${dis()}>
        <span class="ms">qr_code_scanner</span>連続読取</button>
      <button class="btn" style="min-height:56px" onclick="closeStocktake()" ${dis()}>棚卸を終了</button>
    </div>

    <div class="sec">未確認（${left.length}）</div>
    ${left.length ? `<div class="unchecked">${left.map(x => {
      const it = item(x.item_id) || { name: x.item_id, location_id: null };
      return `<div class="u"><span class="ms">help</span>
        <div style="flex:1;min-width:0"><div class="n">${esc(it.name)}</div>
          <div class="m">${esc(x.item_id)}　${esc(locPath(it.location_id))}</div></div>
        <button class="btn sm" onclick="checkItem('${esc(x.item_id)}')" ${dis()}>確認</button></div>`;
    }).join('')}</div>` : '<div class="empty">すべて確認できました。「棚卸を終了」を押してください。</div>'}

    <div class="sec">確認済み（${done.length}）</div>
    ${done.length ? `<div class="chips">${done.map(x => `<span>${esc(x.item_id)}</span>`).join('')}</div>` : '<div class="empty">まだありません。</div>'}`;
}

async function startStocktake() {
  const { data, error } = await sb.rpc('inv_start_stocktake', { p_scope: ui.stScope || null });
  if (error) { toast('棚卸を開始できませんでした：' + error.message); return; }
  db.stocktake = data;
  await loadStocktakeItems();
  render();
  toast('棚卸を開始しました');
}
async function closeStocktake() {
  if (!db.stocktake) return;
  const left = db.stChecked.filter(x => !x.checked_at).length;
  if (left && !confirm(`未確認が ${left} 件あります。このまま終了しますか？`)) return;
  const { error } = await sb.rpc('inv_close_stocktake', { p_id: db.stocktake.id });
  if (error) { toast('終了できませんでした：' + error.message); return; }
  db.stocktake = null; db.stChecked = [];
  const s = await sb.from('inventory_stocktakes').select('*').order('started_at', { ascending: false }).limit(20);
  if (!s.error) { db.stPast = (s.data || []).filter(x => x.status !== 'open'); }
  render();
  toast('棚卸を終了しました');
}

/* ===== 9. 保管場所 ===== */
function viewLocs() {
  const rows = locsOrdered();
  if (!rows.length) return '<h1>保管場所</h1><div class="empty" style="margin-top:20px">保管場所が登録されていません。</div>';
  const icon = { site: 'apartment', room: 'warehouse', shelf: 'shelves' };
  return `<h1>保管場所</h1>
    <div class="loctree" style="margin-top:15px">${rows.map(l => {
      const d = locDepth(l.id);
      const tree = locTree(l.id);
      const ni = db.items.filter(i => tree.includes(i.location_id) && i.status !== '廃棄').length;
      const np = db.prods.filter(p => tree.includes(p.location_id)).length;
      return `<div class="r ${l.kind}" style="padding-left:${d * 18}px">
        <span class="ms">${icon[l.kind] || 'shelves'}</span>
        <div style="min-width:0">
          <div class="n" style="font-size:${d === 0 ? 20 : d === 1 ? 17 : 15}px">${esc(l.name)}</div>
          <div class="c">個体 ${ni}件／数量品 ${np}種</div>
        </div>
        <div class="sp">
          <button class="btn sm ghost" onclick="ui.kind='ind';ui.fLoc='${esc(l.id)}';go('list')">在庫</button>
          ${l.kind === 'shelf' ? `<button class="btn sm ghost" onclick="go('loc','${esc(l.id)}')">棚QR</button>` : ''}
        </div></div>`;
    }).join('')}</div>`;
}

function viewLoc() {
  const l = loc(ui.locId);
  if (!l) return `<div class="empty">該当する保管場所が見つかりません（${esc(ui.locId || '')}）</div>`;
  const tree = locTree(l.id);
  const items = db.items.filter(i => tree.includes(i.location_id) && i.status !== '廃棄');
  const prods = db.prods.filter(p => tree.includes(p.location_id));
  const url = locUrl(l.id);
  return `<div class="detail">
    <div class="main">
      <div class="kind">保管場所</div>
      <h1>${esc(l.name)}</h1>
      <div class="sub">${esc(locPath(l.id))}</div>
      ${guardNote()}
      <div class="ops" style="max-width:520px">
        <button class="btn pri" onclick="sheetBulkMove('${esc(l.id)}')" ${dis()}>
          <span class="ms">move_down</span><span class="t">この棚へまとめて移動</span></button>
        <button class="btn" onclick="ui.labelSel={loc_${esc(l.id)}:true};go('labels')">
          <span class="ms">print</span><span class="t">棚ラベル印刷</span></button>
      </div>
    </div>
    <div class="qrbox">
      <img src="${qr(url)}" alt="${esc(l.name)} のQRコード" width="140" height="140">
      <div class="u">${esc(url)}</div>
    </div>
  </div>
  <div class="sec">この場所の在庫（個体 ${items.length}／数量品 ${prods.length}）</div>
  ${items.length || prods.length ? `<div class="table-wrap"><table class="t">
    <thead><tr><th>コード</th><th>商品名</th><th>状態・在庫</th><th></th></tr></thead><tbody>
    ${items.map(i => `<tr class="clk" onclick="go('item','${esc(i.id)}')">
      <td class="nowrap num">${esc(i.id)}</td><td>${esc(i.name)}</td><td>${statusTag(i.status)}</td>
      <td class="nowrap"><span class="btn sm ghost">開く</span></td></tr>`).join('')}
    ${prods.map(p => `<tr class="clk" onclick="go('prod','${esc(p.code)}')">
      <td class="nowrap num">${esc(p.code)}</td><td>${esc(p.name)}</td>
      <td class="num">${p.qty}</td><td class="nowrap"><span class="btn sm ghost">開く</span></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">この場所には何もありません。</div>'}`;
}

/* ===== 10. 履歴 ===== */
function onHistFilter() {
  ui.fAction = ($('h-act') || {}).value || '';
  ui.hq = ($('h-q') || {}).value || '';
  const el = $('histBody'); if (el) el.innerHTML = histBodyHtml();
}
function histBodyHtml() {
  const q = ui.hq.trim().toLowerCase();
  const rows = db.tx.filter(t => {
    if (ui.fAction && t.action !== ui.fAction) return false;
    if (q) {
      const hay = [t.label, t.ref_id, t.actor].filter(Boolean).join(' ').toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });
  if (!rows.length) return '<div class="empty" style="margin-top:15px">該当する記録はありません。</div>';
  return `<div class="meta" style="margin:12px 0 4px">${rows.length} 件</div>` + rows.map(txRow).join('');
}
function viewHist() {
  const acts = [...new Set(db.tx.map(t => t.action))];
  return `<h1>履歴</h1>
    <p class="sub" style="margin:8px 0 15px">操作の記録は書き換えも削除もされません（追記だけ）。</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;max-width:620px">
      <select class="input" id="h-act" onchange="onHistFilter()">
        <option value="">すべての操作</option>
        ${acts.map(a => `<option${ui.fAction === a ? ' selected' : ''}>${esc(a)}</option>`).join('')}
      </select>
      <input class="input" id="h-q" value="${esc(ui.hq)}" oninput="onHistFilter()" placeholder="商品名・ID・操作者">
    </div>
    <div id="histBody">${histBodyHtml()}</div>`;
}

/* ===== 11. 商品登録 ===== */
function setRegKind(k) { ui.regKind = k; ui.made = null; render(); }
function viewReg() {
  if (ui.made) {
    const m = ui.made;
    return `<h1>商品登録</h1>
      <div class="card" style="margin-top:20px;max-width:460px;display:flex;align-items:center;gap:18px">
        <img src="${qr(m.url)}" width="120" height="120" style="image-rendering:pixelated;background:#fff;padding:5px" alt="QR">
        <div style="min-width:0">
          <div style="font-weight:500">${esc(m.name)}</div>
          <div class="num" style="font-size:19px">${esc(m.id)}</div>
          <button class="btn sm pri" style="margin-top:10px" onclick="ui.labelSel={'${m.kind}_${esc(m.id)}':true};go('labels')">ラベル印刷へ →</button>
        </div>
      </div>
      <button class="btn" style="margin-top:15px" onclick="ui.made=null;render()">続けて登録する</button>`;
  }
  const ind = ui.regKind === 'ind';
  const cats = db.cats.filter(c => c.kind === (ind ? 'individual' : 'quantity'));
  const f = (id, label, type, extra) =>
    `<label class="field"><span>${esc(label)}</span><input class="input" id="r-${id}" ${type ? `type="${type}"` : ''} ${extra || ''}></label>`;
  return `<h1>商品登録</h1>
    ${canAdmin() ? '' : '<div class="card" style="margin:15px 0">商品の登録は管理者だけができます。</div>'}
    <div class="seg" style="margin:15px 0">
      <button class="${ind ? 'on' : ''}" onclick="setRegKind('ind')">個体管理</button>
      <button class="${!ind ? 'on' : ''}" onclick="setRegKind('qty')">数量管理</button>
    </div>
    <div class="fields">
      ${f('name', '商品名 *')}
      <label class="field"><span>カテゴリ *</span><select class="input" id="r-cat" onchange="previewId()">
        ${cats.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label>
      <label class="field"><span>保管場所 *</span><select class="input" id="r-loc">${locOptions('', '選択してください')}</select></label>
      ${ind ? f('maker', 'メーカー') + f('model', '型番') + f('serial', 'シリアル番号')
            + f('buy', '購入日', 'date') + f('price', '購入価格', 'number')
            : f('qty', '初期在庫 *', 'number') + f('min', '最低在庫数 *', 'number')
            + f('supplier', '仕入先') + f('unit', '単価', 'number')}
      ${f('note', '備考')}
    </div>
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:18px">
      <button class="btn lime" style="min-height:52px" onclick="doRegister()" ${canAdmin() ? '' : 'disabled'}>
        <span class="ms">add</span>登録してQR発行</button>
      <span class="meta">発行予定の管理番号: <b id="idPreview" class="num">—</b></span>
    </div>`;
}
/* 採番カウンタは「読むだけ」で予告する。実際の採番は登録のときに1回だけ */
async function previewId() {
  const el = $('idPreview'); if (!el) return;
  const pre = ui.regKind === 'ind' ? ((cat(($('r-cat') || {}).value) || {}).code_prefix || 'IT') : 'SKU';
  const { data } = await sb.from('inventory_counters').select('next_no').eq('prefix', pre).maybeSingle();
  const n = (data && data.next_no) || 1;
  el.textContent = pre + '-' + String(n).padStart(ui.regKind === 'ind' ? 5 : 4, '0');
}
async function doRegister() {
  const g = id => (($('r-' + id) || {}).value || '').trim();
  const name = g('name'), catId = g('cat'), locId = g('loc');
  if (!name || !catId || !locId) { toast('商品名・カテゴリ・保管場所は必ず入れてください'); return; }
  const ind = ui.regKind === 'ind';
  if (!ind && (g('qty') === '' || g('min') === '')) { toast('初期在庫と最低在庫数を入れてください'); return; }

  const pre = ind ? ((cat(catId) || {}).code_prefix || 'IT') : 'SKU';
  const { data: newId, error: e1 } = await sb.rpc('inv_next_id', { p_prefix: pre, p_digits: ind ? 5 : 4 });
  if (e1) { toast('採番できませんでした：' + e1.message); return; }

  if (ind) {
    const rec = {
      id: newId, name, category_id: catId, location_id: locId, status: '在庫',
      maker: g('maker') || null, model: g('model') || null, serial: g('serial') || null,
      purchased_on: g('buy') || null, price: g('price') === '' ? null : Number(g('price')),
      note: g('note') || null
    };
    const { error } = await sb.from('inventory_items').insert(rec);
    if (error) { toast('登録できませんでした：' + error.message); return; }
    db.items.push(rec);
    await logRegister('item', newId, name, '在庫（' + locPath(locId) + '）');
    ui.made = { kind: 'item', id: newId, name, url: itemUrl(newId) };
  } else {
    const rec = {
      code: newId, name, category_id: catId, location_id: locId,
      qty: Number(g('qty') || 0), min_qty: Number(g('min') || 0),
      supplier: g('supplier') || null, unit_price: g('unit') === '' ? null : Number(g('unit')),
      note: g('note') || null
    };
    const { error } = await sb.from('inventory_products').insert(rec);
    if (error) { toast('登録できませんでした：' + error.message); return; }
    db.prods.push(rec);
    await logRegister('product', newId, name, rec.qty + '（' + locPath(locId) + '）');
    ui.made = { kind: 'prod', id: newId, name, url: prodUrl(newId) };
  }
  await refreshTx();
  render();
  toast(newId + ' を登録しました');
}
/* 登録だけは関数を通さないので、履歴をここで足す（追記のみの表なので追加はできる） */
async function logRegister(kind, id, label, after) {
  await sb.from('inventory_transactions').insert({
    actor: me.name, ref_kind: kind, ref_id: id, label, action: '登録', before_value: '—', after_value: after
  });
}

/* ===== 12. QRラベル印刷 ===== */
function labelKey(kind, id) { return kind + '_' + id; }
function bindLabelPicks() {
  document.querySelectorAll('[data-pick]').forEach(el => {
    el.addEventListener('change', () => { ui.labelSel[el.dataset.pick] = el.checked; render(); });
  });
}
function pickAll(on) {
  ui.labelSel = {};
  if (on) {
    db.items.filter(i => i.status !== '廃棄').forEach(i => ui.labelSel[labelKey('item', i.id)] = true);
    db.prods.forEach(p => ui.labelSel[labelKey('prod', p.code)] = true);
    db.locs.filter(l => l.kind === 'shelf').forEach(l => ui.labelSel[labelKey('loc', l.id)] = true);
  }
  render();
}
function selectedLabels() {
  const out = [];
  db.items.filter(i => ui.labelSel[labelKey('item', i.id)]).forEach(i =>
    out.push({ id: i.id, name: i.name, loc: locPath(i.location_id), url: itemUrl(i.id) }));
  db.prods.filter(p => ui.labelSel[labelKey('prod', p.code)]).forEach(p =>
    out.push({ id: p.code, name: p.name, loc: locPath(p.location_id), url: prodUrl(p.code) }));
  db.locs.filter(l => ui.labelSel[labelKey('loc', l.id)]).forEach(l =>
    out.push({ id: l.id, name: l.name, loc: locPath(l.id), url: locUrl(l.id) }));
  return out;
}
function viewLabels() {
  const sel = selectedLabels();
  const pick = (kind, id, label, sub) => {
    const k = labelKey(kind, id);
    return `<label><input type="checkbox" data-pick="${esc(k)}" ${ui.labelSel[k] ? 'checked' : ''}>
      <span style="min-width:0"><b class="num">${esc(id)}</b> ${esc(label)}<br><span class="meta">${esc(sub)}</span></span></label>`;
  };
  return `<div data-noprint>
      <h1>QRラベル</h1>
      <p class="sub" style="margin:8px 0 12px">ラベルは実寸 40×30mm です。A4に並べても、ラベルプリンタでも同じ版で印刷できます。</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
        <button class="btn sm ghost" onclick="pickAll(true)">すべて選択</button>
        <button class="btn sm ghost" onclick="pickAll(false)">選択解除</button>
        <button class="btn lime" onclick="window.print()" ${sel.length ? '' : 'disabled'}>
          <span class="ms">print</span>${sel.length}件を印刷・PDF出力</button>
      </div>
      <div class="sec" style="margin-top:20px">機器（個体）</div>
      <div class="picks">${db.items.filter(i => i.status !== '廃棄').map(i => pick('item', i.id, i.name, locPath(i.location_id))).join('') || '<div class="meta">ありません</div>'}</div>
      <div class="sec">数量品</div>
      <div class="picks">${db.prods.map(p => pick('prod', p.code, p.name, locPath(p.location_id))).join('') || '<div class="meta">ありません</div>'}</div>
      <div class="sec">棚</div>
      <div class="picks">${db.locs.filter(l => l.kind === 'shelf').map(l => pick('loc', l.id, l.name, locPath(l.id))).join('') || '<div class="meta">ありません</div>'}</div>
      <div class="sec">印刷イメージ</div>
    </div>
    <div class="labels">${sel.map(s => `
      <div class="label"><img src="${qr(s.url)}" alt="">
        <div class="tx"><div class="id">${esc(s.id)}</div><div class="nm">${esc(s.name)}</div><div class="lo">${esc(s.loc)}</div></div>
      </div>`).join('')}</div>
    ${sel.length ? '' : '<div class="empty" data-noprint>印刷するものを選んでください。</div>'}`;
}

/* ---------------------------------------------------------------- ボトムシート */
let sheetState = null;
function openSheet(cfg) {
  sheetState = cfg;
  $('sheetPanel').innerHTML = `
    <div class="th"><h2>${esc(cfg.title)}</h2><span class="id num">${esc(cfg.subject || '')}</span></div>
    <div class="hint">${cfg.hint || ''}</div>
    ${cfg.body || ''}
    <div class="acts">
      <button class="btn cancel ghost" onclick="closeSheet()">やめる</button>
      <button class="btn cta lime" onclick="confirmSheet()">${esc(cfg.cta || '確定')}</button>
    </div>`;
  $('sheet').classList.add('on');
  const first = $('sheetPanel').querySelector('select,input');
  if (first) setTimeout(() => first.focus(), 60);
}
function closeSheet() { $('sheet').classList.remove('on'); sheetState = null; }
async function confirmSheet() {
  if (!sheetState) return;
  const fn = sheetState.run;
  const val = (($('sheetVal') || {}).value || '').trim();
  closeSheet();
  await fn(val);
}
const userOptions = () => {
  const names = [...new Set(db.items.map(i => i.user_name).filter(Boolean).concat(db.members.map(m => m.display_name)))];
  return names.map(n => `<option>${esc(n)}</option>`).join('');
};

function sheetLoan(id) {
  const it = item(id); if (!it) return;
  openSheet({
    title: '貸出', subject: id, cta: '貸出を記録',
    hint: `${esc(it.name)} を貸し出します。利用者を選ぶか、入力してください。`,
    body: `<label class="field"><span>利用者</span>
      <input class="input" id="sheetVal" list="uOpts" placeholder="例 佐藤 健" autocomplete="off">
      <datalist id="uOpts">${userOptions()}</datalist></label>`,
    run: (v) => itemOp(id, '貸出', v)
  });
}
function sheetReturn(id) {
  const it = item(id); if (!it) return;
  openSheet({
    title: '返却', subject: id, cta: '返却を記録',
    hint: `${esc(it.name)}（${esc(it.user_name || '')}）を返却し、${esc(locPath(it.location_id))} に戻します。`,
    run: () => itemOp(id, '返却', null)
  });
}
function sheetMove(id) {
  const it = item(id); if (!it) return;
  openSheet({
    title: '移動', subject: id, cta: '移動を記録',
    hint: `いまの場所：${esc(locPath(it.location_id)) || '—'}`,
    body: `<label class="field"><span>移動先</span><select class="input" id="sheetVal">${locOptions('', '選択してください')}</select></label>`,
    run: (v) => itemOp(id, '移動', v)
  });
}
function sheetStatus(id) {
  const it = item(id); if (!it) return;
  openSheet({
    title: '状態を変える', subject: id, cta: '変更を記録',
    hint: `いまの状態：${esc(it.status)}`,
    body: `<label class="field"><span>新しい状態</span><select class="input" id="sheetVal">
      ${['修理中', '故障', '紛失', '在庫', '使用中'].map(s => `<option${s === it.status ? ' selected' : ''}>${s}</option>`).join('')}
    </select></label>`,
    run: (v) => itemOp(id, '状態変更', v)
  });
}
function sheetScrap(id) {
  const it = item(id); if (!it) return;
  openSheet({
    title: '廃棄', subject: id, cta: '廃棄を記録',
    hint: `${esc(it.name)} を廃棄にします。在庫一覧からは外れますが、履歴は残ります。`,
    run: () => itemOp(id, '廃棄', null)
  });
}
function sheetBulkMove(locId) {
  const l = loc(locId); if (!l) return;
  const site = locTree(topSite(locId));
  const movable = db.items.filter(i => i.status === '在庫' && i.location_id !== locId && site.includes(i.location_id));
  openSheet({
    title: 'この棚へまとめて移動', subject: l.name, cta: `${movable.length}件を移動`,
    hint: `同じ拠点にある「在庫」の機器 ${movable.length} 件を ${esc(locPath(locId))} に移します。`,
    run: async () => {
      let ok = 0;
      for (const it of movable) {
        const { error } = await sb.rpc('inv_item_op', { p_item_id: it.id, p_action: '移動', p_value: locId, p_note: null });
        if (!error) { it.location_id = locId; ok++; }
      }
      await refreshTx(); render();
      toast(`${ok}件を移動しました`);
    }
  });
}
function topSite(id) {
  let cur = loc(id), guard = 0;
  while (cur && cur.parent_id && guard++ < 8) cur = loc(cur.parent_id);
  return cur ? cur.id : id;
}
function sheetIn(code, useDraft) { qtySheet(code, '入庫', useDraft); }
function sheetOut(code, useDraft) { qtySheet(code, '出庫', useDraft); }
function qtySheet(code, action, useDraft) {
  const p = prod(code); if (!p) return;
  const pre = useDraft ? (ui.drafts[code] || '') : '';
  openSheet({
    title: action, subject: code, cta: action + 'を記録',
    hint: `${esc(p.name)}　いまの在庫 ${p.qty}`,
    body: `<label class="field"><span>数量</span>
      <input class="input num" type="number" min="1" id="sheetVal" value="${esc(pre)}" placeholder="0"></label>`,
    run: async (v) => {
      const n = parseInt(v, 10);
      if (!n || n < 1) { toast('数量を入れてください'); return; }
      await productMove(code, action === '入庫' ? n : -n);
    }
  });
}
function sheetCount(code) {
  const p = prod(code); if (!p) return;
  openSheet({
    title: '棚卸', subject: code, cta: '実数で記録',
    hint: `${esc(p.name)}　帳簿上は ${p.qty} です。数えた実数を入れてください。`,
    body: `<label class="field"><span>実数</span>
      <input class="input num" type="number" min="0" id="sheetVal" value="${p.qty}"></label>`,
    run: async (v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 0) { toast('実数を入れてください'); return; }
      const { data, error } = await sb.rpc('inv_product_adjust', { p_code: code, p_actual: n, p_note: null });
      if (error) { toast('記録できませんでした：' + error.message); return; }
      const pr = prod(code); if (pr) { pr.qty = data; pr.last_checked_at = new Date().toISOString(); }
      await refreshTx(); render();
      toast(`実数 ${data} で記録しました`);
    }
  });
}

/* ---------------------------------------------------------------- 操作（すべて関数経由） */
async function itemOp(id, action, value) {
  const { data, error } = await sb.rpc('inv_item_op', { p_item_id: id, p_action: action, p_value: value || null, p_note: null });
  if (error) { toast(error.message || '記録できませんでした'); return; }
  const i = db.items.findIndex(x => x.id === id);
  if (i >= 0 && data) db.items[i] = data;
  await refreshTx();
  render();
  toast(action + 'を記録しました');
}
async function productMove(code, delta) {
  const { data, error } = await sb.rpc('inv_product_move', { p_code: code, p_delta: delta, p_note: null });
  if (error) { toast(error.message || '記録できませんでした'); return; }
  const p = prod(code); if (p) p.qty = data;
  delete ui.drafts[code];
  await refreshTx();
  render();
  toast(`${delta > 0 ? '入庫' : '出庫'}しました（在庫 ${data}）`);
}
async function checkItem(id) {
  const { data, error } = await sb.rpc('inv_item_op', { p_item_id: id, p_action: '棚卸確認', p_value: null, p_note: null });
  if (error) { toast(error.message || '記録できませんでした'); return; }
  const i = db.items.findIndex(x => x.id === id);
  if (i >= 0 && data) db.items[i] = data;
  if (db.stocktake) await loadStocktakeItems();
  await refreshTx();
  render();
  toast(id + ' を確認済みにしました');
}

/* ---------------------------------------------------------------- QRスキャナ */
let scan = { on: false, mode: 'lookup', stream: null, raf: null, last: {}, canvas: null };

function openScan(mode) {
  scan.mode = mode || 'lookup';
  scan.on = true;
  scan.last = {};
  $('scan').classList.add('on');
  $('scanTitle').textContent = scan.mode === 'stocktake' ? '棚卸：連続読取' : 'QRコードを読み取る';
  updateScanCount();
  renderScanSim();
  $('scanNoCam').style.display = 'none';
  setTimeout(startCam, 120);
}
function closeScan() {
  scan.on = false;
  stopCam();
  $('scan').classList.remove('on');
}
function updateScanCount() {
  const el = $('scanCount');
  if (scan.mode === 'stocktake' && db.stocktake) {
    const done = db.stChecked.filter(x => x.checked_at).length;
    el.textContent = `確認済み ${done} / ${db.stChecked.length}`;
    el.style.display = '';
  } else el.style.display = 'none';
}
function renderScanSim() {
  const pick = (arr, n) => arr.slice(0, n);
  const parts = []
    .concat(pick(db.items, 6).map(i => ({ t: i.id, u: itemUrl(i.id) })))
    .concat(pick(db.prods, 3).map(p => ({ t: p.code, u: prodUrl(p.code) })))
    .concat(pick(db.locs.filter(l => l.kind === 'shelf'), 3).map(l => ({ t: l.name, u: locUrl(l.id) })));
  $('scanSim').innerHTML = parts.length
    ? parts.map(p => `<button onclick="handleCode('${esc(p.u)}')">${esc(p.t)}</button>`).join('')
    : '<span class="meta">まだ登録がありません</span>';
}
function startCam() {
  const v = $('cam');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { noCam('この環境ではカメラを使用できません。下の入力から管理番号で開けます。'); return; }
  navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
    .then(stream => {
      scan.stream = stream;
      v.srcObject = stream;
      v.play().catch(() => {});
      scan.canvas = scan.canvas || document.createElement('canvas');
      const tick = () => {
        if (!scan.stream) return;
        if (v.readyState === v.HAVE_ENOUGH_DATA && typeof jsQR === 'function') {
          const w = Math.min(520, v.videoWidth || 0);
          if (w > 0) {
            const h = Math.round(w * (v.videoHeight / v.videoWidth));
            scan.canvas.width = w; scan.canvas.height = h;
            const ctx = scan.canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(v, 0, 0, w, h);
            const d = ctx.getImageData(0, 0, w, h);
            const hit = jsQR(d.data, w, h, { inversionAttempts: 'dontInvert' });
            if (hit && hit.data) handleCode(hit.data);
          }
        }
        scan.raf = requestAnimationFrame(tick);
      };
      scan.raf = requestAnimationFrame(tick);
    })
    .catch(() => noCam('カメラを開始できませんでした。カメラの許可、またはHTTPSでの表示を確かめてください。下の入力から管理番号でも開けます。'));
}
function noCam(msg) {
  $('scanNoCam').style.display = 'grid';
  $('scanNoCamMsg').textContent = msg;
}
function stopCam() {
  if (scan.raf) cancelAnimationFrame(scan.raf);
  scan.raf = null;
  if (scan.stream) { scan.stream.getTracks().forEach(t => t.stop()); scan.stream = null; }
  const v = $('cam'); if (v) v.srcObject = null;
}
function openManual() {
  const v = $('manualId').value.trim();
  if (!v) return;
  $('manualId').value = '';
  handleCode(v);
}

/* QRの中身は「URL」だが、管理番号だけを直接入力されることもある。
   どちらでも同じように扱えるよう、末尾のセグメントをキーとして見る */
function handleCode(raw) {
  const now = Date.now();
  const clean = String(raw).trim().split('?')[0].replace(/\/+$/, '');
  if (scan.last[clean] && now - scan.last[clean] < DUP_SCAN_MS) return;   // 同じQRの読み直しは無視
  scan.last[clean] = now;

  const seg = clean.split('/').filter(Boolean);
  const key = decodeURIComponent(seg[seg.length - 1] || '');
  const kindHint = seg.length > 1 ? seg[seg.length - 2] : '';

  const it = db.items.find(i => i.id === key);
  const pr = db.prods.find(p => p.code === key);
  const lc = db.locs.find(l => l.id === key || l.name === key);

  // 棚卸の連続読取中は画面を移らず、確認済みに足していく
  if (scan.mode === 'stocktake') {
    if (!it) { toast('棚卸の対象に見つかりません：' + key); return; }
    checkItem(it.id).then(updateScanCount);
    return;
  }

  // 見つかったときだけ閉じて移動する。読み間違いや関係ないQRで毎回閉じてしまうと、
  // 棚の前でカメラを構え直すことになるので、外したときは開いたままにする
  const jump = (screen, id) => { closeScan(); go(screen, id); };
  if (it) { jump('item', it.id); return; }
  if (pr) { jump('prod', pr.code); return; }
  if (lc) { jump('loc', lc.id); return; }
  // 手元のデータに無くても、URLの形が合っていればそのページを開いて取りに行かせる
  if (kindHint === 'items' || kindHint === 'products' || kindHint === 'locations') {
    closeScan();
    location.href = BASE + '/' + kindHint + '/' + encodeURIComponent(key);
    return;
  }
  toast('該当する商品が見つかりません：' + key);
}
