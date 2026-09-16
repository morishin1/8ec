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

/* 個体の状態。「現在庫」に数えるのは在庫と出品中（どちらもまだ手元にある）。
   売却済・廃棄は持っていないので「登録数」からも外す */
const STATUSES = ['在庫', '出品中', '社内使用', '貸出中', '修理中', '故障', '紛失', '売却済', '廃棄', '不明'];
const IN_STOCK = ['在庫', '出品中'];
const GONE = ['売却済', '廃棄'];
const STATUS_ICON = {
  '在庫': 'inventory_2', '出品中': 'sell', '社内使用': 'person', '貸出中': 'assignment_ind',
  '修理中': 'build', '故障': 'error', '紛失': 'help', '売却済': 'paid', '廃棄': 'delete', '不明': 'help'
};
/* 販売チャネル。左から画面に並ぶ */
const CHANNELS = [
  { key: 'amazon', label: 'Amazon', short: 'Am' },
  { key: 'rakuten', label: '楽天', short: '楽' },
  { key: 'mercari', label: 'メルカリ', short: 'メ' },
  { key: 'yahuoku', label: 'ヤフオク', short: 'ヤ' },
  { key: 'yahoo_free', label: 'ヤフーフリマ', short: 'フ' },
  { key: 'notion', label: 'Notion', short: 'No' }
];
const LIST_STATES = ['出品中', '出品停止', '保留', '売り切れ', '出品中止', '販売済み'];
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
const db = {
  cats: [], locs: [], masters: [], items: [], channels: [],
  tx: [], stocktake: null, stChecked: [], stPast: [], members: [], imports: []
};
const ui = {
  screen: 'dash', itemId: null, prodId: null, locId: null,
  q: '', fCat: '', fMaker: '', fLoc: '', fStock: '', fList: '',
  fAction: '', hq: '', regKind: 'ind', made: null, tab: 'info',
  drafts: {}, labelSel: {}, stScope: '', loaded: false, sel: {}, fBatch: null, doneBatch: null,
  listMode: 'unit', fSt: ''
};

/* 仕入の置き場所はたいてい柏の倉庫なので、取込の初期値にする。
   「柏倉庫」という名前で作られていればそれを、無ければ 柏 / 倉庫 を拾う */
const DEFAULT_IMPORT_LOC = '柏倉庫';
function defaultImportLoc() {
  const flat = db.locs.find(l => l.name === DEFAULT_IMPORT_LOC);
  if (flat) return flat.id;
  const byPath = db.locs.find(l => locPath(l.id).replace(/\s*\/\s*/g, '') === DEFAULT_IMPORT_LOC);
  if (byPath) return byPath.id;
  const site = db.locs.find(l => l.name === '柏');
  const room = site && db.locs.find(l => l.parent_id === site.id && l.name === '倉庫');
  return (room || site || {}).id || '';
}

/* ---------------------------------------------------------------- 小道具 */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = (n) => (n == null || n === '') ? '—' : '¥' + Number(n).toLocaleString('ja-JP');
const P2 = (n) => String(n).padStart(2, '0');
function fmtDT(s) { if (!s) return '—'; const d = new Date(s); return `${d.getFullYear()}/${P2(d.getMonth() + 1)}/${P2(d.getDate())} ${P2(d.getHours())}:${P2(d.getMinutes())}`; }
function fmtD(s) { if (!s) return '—'; const d = new Date(s); return `${d.getFullYear()}/${P2(d.getMonth() + 1)}/${P2(d.getDate())}`; }
function ymd(d) { d = d || new Date(); return `${d.getFullYear()}-${P2(d.getMonth() + 1)}-${P2(d.getDate())}`; }
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
const prod = (code) => db.masters.find(p => p.code === code);
const loc = (id) => db.locs.find(l => l.id === id);
const cat = (id) => db.cats.find(c => c.id === id);
const catName = (id) => (cat(id) || {}).name || '';

/* 商品マスタまわり。商品名が空の型番が多いので、名前は型番で代用する */
const titleOf = (p) => (p && (p.name || p.model)) || '';
const itemsOf = (code) => db.items.filter(i => i.product_code === code);
const channelsOf = (code) => db.channels.filter(c => c.product_code === code);

/* 個体管理の在庫数は手入力させず、各個体の状態から数える。
   数量管理は qty をそのまま使う                                   */
function stockOf(p) {
  if (!p) return { inStock: 0, registered: 0, total: 0 };
  if (p.kind !== 'individual') return { inStock: p.qty || 0, registered: p.qty || 0, total: p.qty || 0 };
  const list = itemsOf(p.code);
  return {
    inStock: list.filter(i => IN_STOCK.includes(i.status)).length,
    registered: list.filter(i => !GONE.includes(i.status)).length,
    total: list.length
  };
}
/* 在庫状態のことば。数量管理は最低在庫を基準に、個体管理は台数で見る */
function stockLabel(p) {
  const s = stockOf(p);
  if (p.kind !== 'individual') return s.inStock <= 0 ? '在庫なし' : (s.inStock <= (p.min_qty || 0) ? '要発注' : '在庫あり');
  if (s.inStock <= 0) return '在庫なし';
  return s.inStock <= 2 ? '残りわずか' : '在庫あり';
}
const STOCK_LABELS = ['在庫あり', '残りわずか', '在庫なし', '要発注'];

/* その商品がいまどこにあるか。個体が散っていたら「複数」 */
function placeOf(p) {
  if (p.kind !== 'individual') return locPath(p.location_id);
  const ids = [...new Set(itemsOf(p.code).filter(i => !GONE.includes(i.status)).map(i => i.location_id))];
  if (!ids.length) return locPath(p.location_id);
  return ids.length === 1 ? locPath(ids[0]) : `${locPath(ids[0])} ほか${ids.length - 1}`;
}
/* マスタと、その個体のうち最後に動いたもの */
function touchedAt(p) {
  let t = p.updated_at || p.created_at || '';
  itemsOf(p.code).forEach(i => { if ((i.updated_at || '') > t) t = i.updated_at; });
  return t;
}

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
/* 価格は「仕入 → 原価 → 売値 → 利益」の流れだけ。項目は増やさない。
     原価     = 仕入価格 + 手数料
     想定利益 = 販売予定価格 − 原価
     利益     = 実際の販売価格 − 原価                       */
const PLAN_MARKUP = 1.3;                 // 販売予定価格の初期値。あとから直せる
const yenSign = (n) => n == null ? '—' : (n < 0 ? '−' : '+') + yen(Math.abs(n));
const costOf = (it) => Number(it.price || 0) + Number(it.purchase_fee || 0);
const planOf = (it) => (it.plan_price == null || it.plan_price === '') ? null : Number(it.plan_price);
const expectedProfit = (it) => planOf(it) == null ? null : planOf(it) - costOf(it);
const realProfit = (it) => (it.sold_price == null || it.sold_price === '') ? null : Number(it.sold_price) - costOf(it);
const suggestPlan = (cost) => cost > 0 ? Math.ceil(cost * PLAN_MARKUP / 100) * 100 : null;
/* 商品ぜんぶの合計。廃棄は数えない */
function priceTotals(code) {
  const list = itemsOf(code).filter(i => i.status !== '廃棄');
  return list.reduce((a, i) => {
    a.cost += costOf(i);
    if (planOf(i) != null) a.plan += planOf(i);
    if (i.sold_price != null && i.sold_price !== '') a.sold += Number(i.sold_price);
    return a;
  }, { cost: 0, plan: 0, sold: 0, n: list.length });
}

/* 型番は表記ゆれがある（全角・半角、前後の空白、大文字小文字、ハイフンの種類）。
   そろえてから突き合わせる。DB側の inv_norm_model と同じ規則にしてある */
function normModel(s) {
  return String(s == null ? '' : s)
    .normalize('NFKC')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/\s+/g, '')
    .toUpperCase();
}
/* 型番の欄に状態や不具合まで書かれていることがある。
   （例「CF-QV9TFLVS ちゃんと閉められない」→ 型番と、状態の説明に分ける）
   日本語が始まるところで切る。英数字だけの続き（Western Digital など）は型番の一部として残す。 */
const JP_HEAD = /^[ぁ-ゟ゠-ヿｦ-ﾟ一-鿿々-〇]/;
function tidyModel(m) {
  let t = String(m).trim();
  const o = (t.match(/[(（]/g) || []).length, c = (t.match(/[)）]/g) || []).length;
  if (o > c) { const i = t.search(/[(（][^(（)）]*$/); if (i > 0) t = t.slice(0, i); }
  return t.trim().replace(/[\s,、.。;；:：/_-]+$/, '');
}
const JP_ANY = /[ぁ-ゟ゠-ヿｦ-ﾟ一-鿿々-〇]/;
function splitModel(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return { model: '', note: '' };
  const notes = [];

  // 末尾の（　）に日本語が入っていれば、それは型番ではなく補足
  // （例「20H7-S0SU00（長筆さんの）」→ 型番と備考に分ける）
  let head = t;
  for (;;) {
    const m = head.match(/^(.*?)\s*[(（]([^()（）]*)[)）]\s*$/);
    if (!m || !JP_ANY.test(m[2])) break;
    notes.unshift(m[2].trim());
    head = m[1].trim();
  }

  // 空白のあとから日本語が始まったら、そこから先は状態や不具合の説明
  const parts = head.split(/(\s+)/);
  let model = parts[0];
  for (let k = 1; k < parts.length; k += 2) {
    const rest = parts.slice(k + 1).join('').trim();
    if (JP_HEAD.test(rest)) { notes.unshift(rest); model = tidyModel(model) || head; head = ''; break; }
    model += parts[k] + parts[k + 1];
  }
  if (head) model = head;

  return { model: tidyModel(model) || t, note: notes.filter(Boolean).join(' ／ ') };
}

/* 型番（無ければ商品名）で既存の商品を探す */
function findMaster(model, name, kind) {
  const key = normModel(model || name);
  if (!key) return null;
  return db.masters.find(p => p.kind === (kind || 'individual')
    && normModel(p.model || p.name) === key) || null;
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
    sb.from('inventory_stocktakes').select('*').order('started_at', { ascending: false }).limit(20),
    sb.from('inventory_channels').select('*').limit(LOAD_LIMIT),
    sb.from('inventory_imports').select('*').order('imported_at', { ascending: false }).limit(100)
  ];
  const [c, l, i, p, t, s, ch, im] = await Promise.all(q);
  const bad = [c, l, i, p, t, s, ch, im].find(r => r.error);
  if (bad) { showSetup(bad.error); return false; }
  db.imports = im.data || [];

  db.cats = c.data || [];
  db.locs = l.data || [];
  db.items = (i.data || []).sort((a, b) => a.id.localeCompare(b.id, 'ja'));
  db.masters = (p.data || []).sort((a, b) => titleOf(a).localeCompare(titleOf(b), 'ja'));
  db.channels = ch.data || [];
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

  // 保管場所とカテゴリは表示に要るので一緒に取る
  const [l, c] = await Promise.all([
    sb.from('inventory_locations').select('*').order('sort_no'),
    sb.from('inventory_categories').select('*').order('sort_no')
  ]);
  db.locs = l.data || []; db.cats = c.data || [];

  if (r.screen === 'item') {
    db.items = [res.data];
    // 個体の画面は商品名などをマスタから出すので、その1件も取る
    if (res.data.product_code) {
      const m = await sb.from('inventory_products').select('*').eq('code', res.data.product_code).maybeSingle();
      if (m.data) db.masters = [m.data];
    }
  } else {
    db.masters = [res.data];
    // 商品の画面はぶら下がる個体と販売情報まで見せる
    const [its, chs] = await Promise.all([
      sb.from('inventory_items').select('*').eq('product_code', res.data.code).limit(LOAD_LIMIT),
      sb.from('inventory_channels').select('*').eq('product_code', res.data.code)
    ]);
    db.items = its.data || [];
    db.channels = chs.data || [];
  }
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
  refreshSelBar();
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
  const qtyMasters = db.masters.filter(p => p.kind !== 'individual');
  const qtySum = qtyMasters.reduce((s, p) => s + (p.qty || 0), 0);
  const loans = live.filter(i => i.status === '貸出中');
  const longs = loans.filter(isLong);
  const using = live.filter(i => i.status === '使用中');
  const zero = qtyMasters.filter(p => (p.qty || 0) <= 0)
    .concat(db.masters.filter(p => p.kind === 'individual' && stockOf(p).inStock <= 0));
  const order = qtyMasters.filter(needsOrder);
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
      ${chk('shopping_cart', '在庫数不足', order.length, '最低在庫を下回っている品目', 'list', "ui.fStock='要発注';")}
      ${chk('schedule', '長期貸出', longs.length, `${LOAN_LONG_DAYS}日を超えて返却されていないもの`, 'loan')}
      ${chk('help', '棚卸未確認', stLeft, db.stocktake ? '実施中の棚卸で、まだ確認できていないもの' : '棚卸は実施していません', 'stock')}
      ${chk('build', '故障・修理中', broken.length, '使えない状態のまま残っているもの', 'list', "ui.q='';")}
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

/* ===== 2. 在庫一覧（商品マスタ単位。一覧はシンプルに、詳細で全部わかるように） ===== */
function onFilter() {
  ui.q = ($('f-q') || {}).value || '';
  ui.fCat = ($('f-cat') || {}).value || '';
  ui.fMaker = ($('f-maker') || {}).value || '';
  ui.fLoc = ($('f-loc') || {}).value || '';
  ui.fStock = ($('f-stock') || {}).value || '';
  ui.fSt = ($('f-st') || {}).value || '';
  ui.fList = ($('f-list') || {}).value || '';
  renderListBody();
}
function locOptions(sel, allLabel) {
  return `<option value="">${esc(allLabel)}</option>` + locsOrdered().map(l =>
    `<option value="${esc(l.id)}"${sel === l.id ? ' selected' : ''}>${'\u3000'.repeat(locDepth(l.id))}${esc(l.name)}</option>`).join('');
}

function listFiltered() {
  const q = ui.q.trim().toLowerCase();
  const inScope = ui.fLoc ? locTree(ui.fLoc) : null;
  const batch = batchOf(ui.fBatch);
  const only = batch ? (batch.product_codes || []) : null;
  return db.masters.filter(p => {
    if (only && only.indexOf(p.code) < 0) return false;
    if (ui.fCat && p.category_id !== ui.fCat) return false;
    if (ui.fMaker && (p.maker || '') !== ui.fMaker) return false;
    if (ui.fStock && stockLabel(p) !== ui.fStock) return false;
    if (ui.fList && !channelsOf(p.code).some(c => c.state === ui.fList)) return false;
    if (inScope) {
      const here = p.kind === 'individual'
        ? itemsOf(p.code).some(i => inScope.includes(i.location_id))
        : inScope.includes(p.location_id);
      if (!here) return false;
    }
    if (q) {
      // 商品名・型番のほか、ぶら下がる管理番号でも引けるようにする
      const hay = [p.name, p.model, p.maker, p.code, p.spec].filter(Boolean).join(' ').toLowerCase();
      const byNo = itemsOf(p.code).some(i =>
        (i.id || '').toLowerCase().includes(q) || (i.serial || '').toLowerCase().includes(q));
      if (hay.indexOf(q) < 0 && !byNo) return false;
    }
    return true;
  });
}

function setListMode(m) { ui.listMode = m; ui.sel = {}; render(); }

function viewList() {
  const makers = [...new Set(db.masters.map(p => p.maker).filter(Boolean))].sort();
  const unit = ui.listMode !== 'model';
  return `
    <h1>在庫一覧</h1>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:15px 0 4px">
      <p class="meta" style="flex:1 1 260px">
        ${unit ? '<strong>実物1台＝1行</strong>で並べています。行をクリックすると、その1台の詳細と履歴が見られます。'
               : '<strong>型番でまとめて</strong>数だけ見ています。行をクリックすると、個体の一覧や販売情報まで見られます。'}</p>
      <div class="listtools">
        <button class="btn sm ghost" onclick="exportInventoryCsv()">
          <span class="ms">download</span>CSVダウンロード</button>
        <button class="btn sm ghost" onclick="openImport('stock')" ${canAdmin() ? '' : 'disabled'}
          title="${canAdmin() ? '既存の在庫一覧CSV。販売状況や保管場所を補うのに使います' : '追加できる権限がありません'}">
          <span class="ms">upload_file</span>既存在庫CSV取込</button>
        <button class="btn sm" onclick="openImport('purchase')" ${canAdmin() ? '' : 'disabled'}
          title="${canAdmin() ? '毎週の自社落札CSV。ここから商品と個体が増えていきます' : '追加できる権限がありません'}">
          <span class="ms">upload_file</span>自社落札CSV取込</button>
        <button class="btn sm lime" onclick="go('reg')" ${canAdmin() ? '' : 'disabled'}>
          <span class="ms">add</span>商品登録</button>
      </div>
    </div>
    ${importHistLine()}
    ${batchBanner()}
    <div class="seg" style="margin:10px 0 4px">
      <button class="${unit ? 'on' : ''}" onclick="setListMode('unit')">個体別</button>
      <button class="${unit ? '' : 'on'}" onclick="setListMode('model')">型番別</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:4px">
      <input class="input" id="f-q" value="${esc(ui.q)}" oninput="onFilter()"
             placeholder="${unit ? '管理番号・型番・S/N…' : '型番・商品名・管理番号…'}">
      <select class="input" id="f-cat" onchange="onFilter()">
        <option value="">全カテゴリ</option>
        ${db.cats.map(c => `<option value="${esc(c.id)}"${ui.fCat === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
      <select class="input" id="f-maker" onchange="onFilter()">
        <option value="">全メーカー</option>
        ${makers.map(m => `<option${ui.fMaker === m ? ' selected' : ''}>${esc(m)}</option>`).join('')}
      </select>
      <select class="input" id="f-loc" onchange="onFilter()">${locOptions(ui.fLoc, '全保管場所')}</select>
      ${unit
        ? `<select class="input" id="f-st" onchange="onFilter()">
            <option value="">すべての状態</option>
            ${STATUSES.map(s => `<option${ui.fSt === s ? ' selected' : ''}>${esc(s)}</option>`).join('')}
          </select>`
        : `<select class="input" id="f-stock" onchange="onFilter()">
            <option value="">全在庫状態</option>
            ${STOCK_LABELS.map(s => `<option${ui.fStock === s ? ' selected' : ''}>${esc(s)}</option>`).join('')}
          </select>`}
      <select class="input" id="f-list" onchange="onFilter()">
        <option value="">全出品状態</option>
        ${LIST_STATES.map(s => `<option${ui.fList === s ? ' selected' : ''}>${esc(s)}</option>`).join('')}
      </select>
    </div>
    <div id="listBody">${listBodyHtml()}</div>
    ${canAdmin() ? `<div class="dangerzone">
      <span class="ms">warning_amber</span>
      <div style="flex:1;min-width:0">
        <div style="font-weight:500">在庫データの削除</div>
        <div class="meta">取り込みをやり直したいときに使います。履歴は消えません。</div>
      </div>
      <button class="btn sm" onclick="openWipe()">削除する…</button>
    </div>` : ''}`;
}

/* ---- 選んだ商品をまとめて直す ----
   取り込んだ直後はカテゴリも保管場所も全件が同じになるので、
   ここで分けていくのが実際の使いかたになる。
   触る項目だけチェックを入れてもらう（うっかり全部を上書きしないため）。 */
function openBulkEdit() {
  const codes = selCodes();
  if (!codes.length) return;
  const units = codes.reduce((a, c) => a + itemsOf(c).filter(i => !GONE.includes(i.status)).length, 0);
  const row = (key, label, inner) => `
    <div class="bulkrow">
      <label class="bchk"><input type="checkbox" id="bu-${key}" onchange="syncBulk()"> ${esc(label)}</label>
      <div class="bfield" id="bw-${key}">${inner}</div>
    </div>`;
  openModal(`${codes.length}商品をまとめて直す`, `
    <p class="meta" style="margin-bottom:14px">チェックを入れた項目だけを変えます。入れていない項目はそのままです。</p>
    ${row('cat', 'カテゴリ', `<select class="input" id="bv-cat">
      ${db.cats.map(c => `<option value="${esc(c.id)}">${esc(c.name)}（${c.kind === 'individual' ? '個体' : '数量'}）</option>`).join('')}
    </select>`)}
    ${row('maker', 'メーカー', `<input class="input" id="bv-maker" placeholder="例 Lenovo">`)}
    ${row('loc', '保管場所', `<select class="input" id="bv-loc">${locOptions('', '選択してください')}</select>
      <label class="bchk" style="margin-top:8px"><input type="checkbox" id="bv-units" checked>
        ぶら下がる個体（${units}台）も一緒に動かす</label>
      <div class="meta">外すと、商品の置き場所だけを直します。売却済・廃棄の個体は動かしません。</div>`)}
  `, [['閉じる', 'closeModal()', 'btn ghost'], ['この内容で直す', 'doBulkEdit()', 'btn lime']]);
  syncBulk();
}
function syncBulk() {
  let any = false;
  ['cat', 'maker', 'loc'].forEach(k => {
    const on = ($('bu-' + k) || {}).checked;
    const w = $('bw-' + k);
    if (w) w.classList.toggle('off', !on);
    if (on) any = true;
  });
  const go = $('modalFoot').querySelector('.btn.lime');
  if (go) go.disabled = !any;
}
async function doBulkEdit() {
  const codes = selCodes();
  const on = k => ($('bu-' + k) || {}).checked;
  const args = {
    p_codes: codes,
    p_category: on('cat') ? ($('bv-cat') || {}).value || null : null,
    p_maker: on('maker') ? (($('bv-maker') || {}).value || '').trim() : null,
    p_location: on('loc') ? ($('bv-loc') || {}).value || null : null,
    p_move_units: on('loc') ? !!($('bv-units') || {}).checked : false
  };
  if (args.p_category === null && args.p_maker === null && args.p_location === null) return;
  if (on('loc') && !args.p_location) { toast('保管場所を選んでください'); return; }
  closeModal();
  toast('直しています…');
  const { data, error } = await sb.rpc('inv_bulk_update_products', args);
  if (error) { toast('直せませんでした：' + error.message); return; }
  await loadAll();
  render();
  toast(`${data.products}商品を直しました${data.units ? `（個体 ${data.units}台を移動）` : ''}`);
}

/* ---- 選んだ商品をまとめて消す ---- */
function openBulkDelete() {
  const codes = selCodes();
  if (!codes.length) return;
  const units = codes.reduce((a, c) => a + itemsOf(c).length, 0);
  const chans = codes.reduce((a, c) => a + channelsOf(c).length, 0);
  const list = codes.slice(0, 50).map(c => {
    const p = prod(c);
    return `<div class="p"><span class="c">${esc(c)}</span><span>${esc(titleOf(p))}</span>
      <span class="meta" style="margin-left:auto">個体 ${itemsOf(c).length}台</span></div>`;
  }).join('');
  openModal(`${codes.length}商品を削除`, `
    <div class="card" style="background:#FDECEC;margin-bottom:15px">
      <strong>元に戻せません。</strong>ぶら下がる個体と販売情報も一緒に消えます。<br>
      <span class="meta">操作の履歴は残り、何を消したかも記録されます。</span>
    </div>
    <div class="sum">
      <div><div class="lbl">商品</div><div class="v err">${codes.length}</div></div>
      <div><div class="lbl">個体</div><div class="v err">${units}</div></div>
      <div><div class="lbl">販売情報</div><div class="v err">${chans}</div></div>
    </div>
    <div class="plist">${list}</div>
    ${codes.length > 50 ? `<div class="meta" style="margin-bottom:12px">先頭50件だけ表示しています。</div>` : ''}
    <label class="field"><span>確認のため「${WIPE_WORD}」と入力してください</span>
      <input class="input" id="bdWord" autocomplete="off" placeholder="${WIPE_WORD}"
             oninput="document.getElementById('bdGo').disabled = this.value.trim() !== '${WIPE_WORD}'"></label>
  `, [['閉じる', 'closeModal()', 'btn ghost'], ['削除する', 'doBulkDelete()', 'btn danger']]);
  const go = $('modalFoot').querySelector('.btn.danger');
  go.id = 'bdGo';
  go.disabled = true;
}
async function doBulkDelete() {
  if ((($('bdWord') || {}).value || '').trim() !== WIPE_WORD) return;
  const codes = selCodes();
  closeModal();
  toast('削除しています…');
  const { data, error } = await sb.rpc('inv_delete_products', { p_codes: codes });
  if (error) { toast('削除できませんでした：' + error.message); return; }
  ui.sel = {};
  await loadAll();
  render();
  toast(`${data.products}商品・個体 ${data.units}台・販売情報 ${data.channels}件を削除しました`);
}

/* ---- 在庫データの全削除。取り返しがつかないので、合言葉を打ってもらう ---- */
const WIPE_WORD = '削除します';
function openWipe() {
  const units = db.items.length;
  const masters = db.masters.length;
  const chans = db.channels.length;
  openModal('在庫データの削除', `
    <div class="card" style="background:#FDECEC;margin-bottom:15px">
      <strong>元に戻せません。</strong>いま登録されているものが消えます。<br>
      <span class="meta">操作の履歴（誰がいつ何をしたか）は追記のみの記録なので残ります。
        何をいつ消したかも履歴に入ります。</span>
    </div>
    <div class="sum">
      <div><div class="lbl">商品マスタ</div><div class="v err">${masters}</div></div>
      <div><div class="lbl">個体</div><div class="v err">${units}</div></div>
      <div><div class="lbl">販売情報</div><div class="v err">${chans}</div></div>
    </div>
    <label class="field" style="margin-bottom:12px"><span>消す範囲</span>
      <select class="input" id="wipeScope">
        <option value="all">すべて消す（商品マスタ・個体・販売情報）</option>
        <option value="units">個体だけ消す（商品マスタと販売情報は残す）</option>
      </select></label>
    <label class="field"><span>確認のため「${WIPE_WORD}」と入力してください</span>
      <input class="input" id="wipeWord" autocomplete="off" placeholder="${WIPE_WORD}"
             oninput="document.getElementById('wipeGo').disabled = this.value.trim() !== '${WIPE_WORD}'"></label>
  `, [['閉じる', 'closeModal()', 'btn ghost'], ['削除する', 'doWipe()', 'btn danger']]);
  const go = $('modalFoot').querySelector('.btn.danger');
  go.id = 'wipeGo';
  go.disabled = true;
}
async function doWipe() {
  if ((($('wipeWord') || {}).value || '').trim() !== WIPE_WORD) return;
  const scope = ($('wipeScope') || {}).value || 'all';
  closeModal();
  toast('削除しています…');
  const { data, error } = await sb.rpc('inv_wipe_inventory', { p_scope: scope });
  if (error) { toast('削除できませんでした：' + error.message); return; }
  await loadAll();
  render();
  toast(`個体 ${data.items}件・商品マスタ ${data.masters}件・販売情報 ${data.channels}件を削除しました`);
}
function renderListBody() {
  const el = $('listBody');
  if (el) el.innerHTML = listBodyHtml();
  refreshSelBar();
}

/* 商品名が型番と同じなら二重に出さない（例「16-AG0005AU」） */
const sameName = (p) => !p.name || !p.model || normModel(p.name) === normModel(p.model);

/* 一覧に出す管理番号。1商品に何十台もぶら下がるので、先頭だけ出して残りは件数にする */
function unitNos(p) {
  if (p.kind !== 'individual') return '<span class="meta">—</span>';
  const list = itemsOf(p.code).filter(i => !GONE.includes(i.status));
  if (!list.length) return '<span class="meta" style="color:#B3261E">個体なし</span>';
  const head = list.slice(0, 2).map(i => esc(i.id)).join('<br>');
  return head + (list.length > 2 ? `<br><span class="meta">ほか ${list.length - 2}件</span>` : '');
}

/* 個体別の一覧。実物1台＝1行。
   詰め込みすぎないよう、出すのは 管理番号・型番・メーカー・仕入日・原価・
   販売予定価格・保管場所・状態 だけ。S/Nやスペックは行をクリックした先で見る。
   数量管理の品目は個体を持たないので、1品目1行として数だけ出す。 */
function unitsFiltered() {
  const q = ui.q.trim().toLowerCase();
  const inScope = ui.fLoc ? locTree(ui.fLoc) : null;
  const batch = batchOf(ui.fBatch);
  const only = batch ? (batch.product_codes || []) : null;
  const hit = (i, m) => {
    if (only && only.indexOf(i.product_code) < 0) return false;
    if (ui.fCat && i.category_id !== ui.fCat) return false;
    if (ui.fMaker && ((m && m.maker) || i.maker || '') !== ui.fMaker) return false;
    if (ui.fSt && i.status !== ui.fSt) return false;
    if (inScope && !inScope.includes(i.location_id)) return false;
    if (ui.fList && !channelsOf(i.product_code).some(c => c.state === ui.fList)) return false;
    if (q) {
      const hay = [i.id, i.serial, i.source_id, (m && m.model) || i.model, (m && m.name) || i.name, i.note]
        .filter(Boolean).join(' ').toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  };
  const out = db.items.filter(i => hit(i, prod(i.product_code)))
    .map(i => ({ kind: 'item', i, m: prod(i.product_code) }));
  // 数量管理は個体を持たない。見えなくならないよう1品目1行で混ぜる
  db.masters.filter(p => p.kind !== 'individual').forEach(p => {
    const fake = { id: p.code, product_code: p.code, category_id: p.category_id, maker: p.maker,
                   model: p.model, name: p.name, location_id: p.location_id, status: '' };
    if (ui.fSt) return;
    if (hit(fake, p)) out.push({ kind: 'qty', i: fake, m: p });
  });
  return out;
}

function unitsBodyHtml() {
  const rows = unitsFiltered();
  if (!rows.length) return `<div class="empty" style="margin-top:15px">該当する在庫はありません。</div>`;
  const live = rows.filter(r => r.kind === 'item' && IN_STOCK.includes(r.i.status)).length;
  const qty = rows.filter(r => r.kind === 'qty').reduce((n, r) => n + (r.m.qty || 0), 0);
  return `<div class="meta" style="margin:12px 0 4px">${rows.length} 件${
      live ? `／うち在庫・出品中 ${live}台` : ''}${qty ? `／数量品 ${qty}` : ''}</div>
    <div class="table-wrap"><table class="t">
    <thead><tr>
      <th>管理番号</th><th>型番</th><th>メーカー</th><th>仕入日</th>
      <th style="text-align:right">原価</th><th style="text-align:right">販売予定価格</th>
      <th>保管場所</th><th>状態</th>${canEdit() ? '<th></th>' : ''}
    </tr></thead>
    <tbody>${rows.slice(0, 600).map(r => {
      const { i, m } = r;
      if (r.kind === 'qty') return `<tr class="clk" onclick="go('prod','${esc(m.code)}')">
        <td class="num" style="font-weight:600">${esc(m.code)}</td>
        <td class="nowrap">${esc(m.model || titleOf(m))}</td>
        <td class="nowrap">${esc(m.maker || '')}</td>
        <td class="meta">—</td>
        <td class="num meta r">${yen(m.unit_price)}</td>
        <td class="num meta r">—</td>
        <td class="meta">${esc(locPath(m.location_id))}</td>
        <td><span class="tag act">数量 ${m.qty}</span></td>
        ${canEdit() ? `<td class="nowrap ops2" onclick="event.stopPropagation()">
          <button class="btn sm" onclick="sheetIn('${esc(m.code)}')">入庫</button>
          <button class="btn sm" onclick="sheetOut('${esc(m.code)}')" ${m.qty > 0 ? '' : 'disabled'}>出庫</button>
          <button class="btn sm ghost" onclick="sheetCount('${esc(m.code)}')">数を直す</button></td>` : ''}
      </tr>`;
      const cost = costOf(i), plan = planOf(i);
      return `<tr class="clk" onclick="go('item','${esc(i.id)}')">
        <td class="num" style="font-weight:600">${esc(i.id)}
          ${i.source_id ? `<div class="meta">仕入元 ${esc(i.source_id)}</div>` : ''}</td>
        <td class="nowrap">${esc((m && m.model) || i.model || '')}</td>
        <td class="nowrap">${esc((m && m.maker) || i.maker || '')}</td>
        <td class="meta nowrap">${i.purchased_on ? fmtD(i.purchased_on) : '—'}</td>
        <td class="num r">${cost ? yen(cost) : '<span class="meta">—</span>'}</td>
        <td class="num r">${plan == null ? '<span class="meta">—</span>' : yen(plan)}</td>
        <td class="meta">${esc(locPath(i.location_id))}</td>
        <td>${statusTag(i.status)}</td>
        ${canEdit() ? `<td class="nowrap ops2" onclick="event.stopPropagation()">
          <button class="btn sm" onclick="unitMenu('${esc(i.id)}')">操作</button></td>` : ''}
      </tr>`;
    }).join('')}</tbody></table></div>
    ${rows.length > 600 ? '<div class="meta" style="margin-top:8px">先頭600件だけ表示しています。絞り込んでください。</div>' : ''}`;
}

function listBodyHtml() {
  if (ui.listMode !== 'model') return unitsBodyHtml();
  const rows = listFiltered();
  if (!rows.length) return `<div class="empty" style="margin-top:15px">該当する商品はありません。</div>`;
  const totalUnits = rows.reduce((n, p) => n + stockOf(p).inStock, 0);
  return `<div class="meta" style="margin:12px 0 4px">${rows.length} 商品／現在庫 ${totalUnits}</div>
    <div class="table-wrap"><table class="t">
    <thead><tr>
      ${canEdit() ? `<th class="ck"><input type="checkbox" id="selAll" onclick="toggleAll(this.checked)"
        ${allSelected(rows) ? 'checked' : ''} title="表示中をすべて選ぶ"></th>` : ''}
      <th>型番</th><th>管理番号</th><th>メーカー</th><th>カテゴリ</th>
      <th style="text-align:right">現在庫</th><th style="text-align:right">登録数</th>
      <th>保管場所</th><th>在庫状態</th><th>販売状況</th><th>最終更新</th>
      ${canEdit() ? '<th>在庫を動かす</th>' : ''}
    </tr></thead>
    <tbody>${rows.map(p => {
      const s = stockOf(p);
      const lbl = stockLabel(p);
      return `<tr class="clk${ui.sel[p.code] ? ' on' : ''}" onclick="go('prod','${esc(p.code)}')">
        ${canEdit() ? `<td class="ck" onclick="event.stopPropagation()">
          <input type="checkbox" ${ui.sel[p.code] ? 'checked' : ''} onchange="toggleOne('${esc(p.code)}',this.checked)"></td>` : ''}
        <td><span style="font-weight:500">${esc(p.model || titleOf(p))}</span>
          ${sameName(p) ? '' : `<div class="meta">${esc(p.name)}</div>`}
          <div class="meta">${esc(p.code)}${p.kind === 'quantity' ? '／数量管理' : ''}</div></td>
        <td class="meta nos">${unitNos(p)}</td>
        <td class="nowrap">${esc(p.maker || '')}</td>
        <td class="nowrap">${esc(catName(p.category_id))}</td>
        <td class="num" style="font-size:18px;font-weight:600;${s.inStock <= 0 ? 'color:#B3261E' : ''}">${s.inStock}</td>
        <td class="num meta">${s.registered}</td>
        <td class="meta">${esc(placeOf(p))}</td>
        <td>${stockTag(lbl)}</td>
        <td>${channelChips(p.code)}</td>
        <td class="meta nowrap">${touchedAt(p) ? fmtD(touchedAt(p)) : '—'}</td>
        ${canEdit() ? `<td class="nowrap ops2" onclick="event.stopPropagation()">${
          p.kind === 'individual'
            ? `<button class="btn sm" onclick="sheetSellQty('${esc(p.code)}')" ${s.inStock ? '' : 'disabled'}
                 title="売れたぶんを在庫から引きます">売れた</button>
               <button class="btn sm ghost" onclick="sheetStockSet('${esc(p.code)}')"
                 title="数えた実数を入れると、個体をその数にそろえます">数を直す</button>`
            : `<button class="btn sm" onclick="sheetIn('${esc(p.code)}')">入庫</button>
               <button class="btn sm" onclick="sheetOut('${esc(p.code)}')" ${p.qty > 0 ? '' : 'disabled'}>出庫</button>
               <button class="btn sm ghost" onclick="sheetCount('${esc(p.code)}')">数を直す</button>`
        }</td>` : ''}
      </tr>`;
    }).join('')}</tbody></table></div>`;
}

/* ---- 選ぶ ---- */
const selCodes = () => Object.keys(ui.sel).filter(k => ui.sel[k]);
function allSelected(rows) { return rows.length > 0 && rows.every(p => ui.sel[p.code]); }
function toggleOne(code, on) {
  if (on) ui.sel[code] = true; else delete ui.sel[code];
  renderListBody(); refreshSelBar();
}
function toggleAll(on) {
  listFiltered().forEach(p => { if (on) ui.sel[p.code] = true; else delete ui.sel[p.code]; });
  renderListBody(); refreshSelBar();
}
function clearSel() { ui.sel = {}; renderListBody(); refreshSelBar(); }

function refreshSelBar() {
  const bar = $('selbar');
  if (!bar) return;
  const n = selCodes().length;
  // 一覧以外の画面に移ったら、選択中でもバーは出さない
  bar.classList.toggle('on', n > 0 && ui.screen === 'list' && canEdit());
  $('selDel').style.display = canAdmin() ? '' : 'none';
  if (!n) return;
  const units = selCodes().reduce((a, c) => a + itemsOf(c).length, 0);
  $('selN').textContent = `${n} 商品を選択中（個体 ${units}台）`;
}

function stockTag(lbl) {
  const cls = { '在庫あり': 'ok', '残りわずか': 'few', '在庫なし': 'none', '要発注': 'few' }[lbl] || 'none';
  return `<span class="tag stk-${cls}">${esc(lbl)}</span>`;
}
/* 販売状況は一覧では小さく。出しているモールだけ色を付ける */
function channelChips(code) {
  const list = channelsOf(code);
  if (!list.length) return '<span class="meta">—</span>';
  return '<span class="malls">' + CHANNELS.filter(c => list.some(x => x.channel === c.key)).map(c => {
    const x = list.find(v => v.channel === c.key);
    const on = x.state === '出品中';
    return `<span class="tag ch ${on ? 'on' : ''}" title="${esc(c.label)}：${esc(x.state || '—')}">${esc(c.short)}</span>`;
  }).join('') + '</span>';
}

function statusTag(s, big) {
  return `<span class="tag st-${esc(s)}${big ? ' big' : ''}"><span class="ms">${STATUS_ICON[s] || 'inventory_2'}</span>${esc(s)}</span>`;
}

/* ---------------------------------------------------------------- 在庫一覧のCSV

   取り込みは「足すだけ」。すでにある在庫は書き換えない。
   在庫の数や状態は、入庫・出庫・貸出といった操作で動かすものなので、
   表計算の上書きで静かに変わってしまうと、履歴と現物が合わなくなる。

   読めるCSVは2種類ある。列を見て自動で見分ける。
     (1) この画面が書き出した形（商品マスタ1行＝1商品）
     (2) これまで使っていた「統合在庫一覧（型番別）」
         型番1行 → 商品マスタ1件、管理番号一覧を「 / 」で割って個体1台ずつ、
         出品状況 → 販売チャネル情報、へ組み替える。
         元の値は消さず「旧データ備考」に残す。                           */

const CSV_MASTER = [
  ['商品ID', p => p.code],
  ['商品名', p => p.name],
  ['型番', p => p.model],
  ['メーカー', p => p.maker],
  ['カテゴリ', p => catName(p.category_id)],
  ['管理方式', p => p.kind === 'individual' ? '個体管理' : '数量管理'],
  ['スペック', p => p.spec],
  ['現在庫', p => stockOf(p).inStock],
  ['登録数', p => stockOf(p).registered],
  ['最低在庫', p => p.kind === 'individual' ? '' : p.min_qty],
  ['保管場所', p => placeOf(p)],
  ['在庫状態', p => stockLabel(p)],
  ['販売状況', p => channelsOf(p.code).map(c => {
    const m = CHANNELS.find(x => x.key === c.channel) || { label: c.channel };
    return `${m.label}:${c.state || '未設定'}`;
  }).join(' ｜ ')],
  ['管理番号一覧', p => itemsOf(p.code).map(i => i.id).join(' / ')],
  ['仕入先', p => p.supplier],
  ['単価', p => p.unit_price],
  ['備考', p => p.note],
  ['旧データ備考', p => p.legacy_note],
  ['最終更新', p => touchedAt(p) ? fmtDT(touchedAt(p)) : '']
];

function exportInventoryCsv() {
  const rows = listFiltered();
  if (!rows.length) { toast('書き出すものがありません'); return; }
  const table = [CSV_MASTER.map(c => c[0])].concat(rows.map(r => CSV_MASTER.map(c => {
    const v = c[1](r);
    return v == null ? '' : v;
  })));
  const name = `備品在庫_${ymd()}.csv`;
  window.EightCsv.download(name, window.EightCsv.blob(window.EightCsv.build(table)));
  toast(`${rows.length}件を ${name} に書き出しました`);
}

/* カテゴリ名 → ID。表計算では名前で書くほうが扱いやすいので名前で受ける */
/* カテゴリ名 → ID。なぜ引けなかったかまで返す（取り込み画面で理由を出すため）。
   読み替え（impMap）が指定されていればそれを優先する */
function findCat(name, kind) {
  const n = String(name || '').trim();
  if (!n) return { id: null, reason: 'cat-empty', why: 'カテゴリが空です' };
  if (impMap.cat[n]) return { id: impMap.cat[n] };
  const hit = db.cats.filter(c => c.kind === kind && c.name === n);
  if (hit.length === 1) return { id: hit[0].id };
  const other = db.cats.filter(c => c.name === n);
  if (other.length) {
    const forWhat = other[0].kind === 'quantity' ? '数量管理' : '個体管理';
    return { id: null, reason: 'cat-kind', value: n, kind,
             why: `カテゴリ「${n}」は${forWhat}用として登録されています` };
  }
  return { id: null, reason: 'cat-missing', value: n, kind, why: `カテゴリ「${n}」がありません` };
}

/* 保管場所は「本社 / 倉庫 / 棚A-01」でも「棚A-01」でも受ける。
   末尾だけの指定で同じ名前が複数あるときは、取り違えないよう取り込まない */
function findLoc(text) {
  const t = String(text || '').trim();
  if (!t) return { id: null, reason: 'loc-empty', why: '保管場所が空です' };
  if (impMap.loc[t]) return { id: impMap.loc[t] };
  const byPath = db.locs.filter(l => locPath(l.id) === t);
  if (byPath.length === 1) return { id: byPath[0].id };
  const byName = db.locs.filter(l => l.name === t);
  if (byName.length === 1) return { id: byName[0].id };
  if (byName.length > 1) {
    const cand = byName.slice(0, 3).map(l => locPath(l.id)).join('、');
    return { id: null, reason: 'loc-ambiguous', value: t,
             why: `「${t}」が複数あります（${cand}）` };
  }
  return { id: null, reason: 'loc-missing', value: t, why: `保管場所「${t}」がありません` };
}

function pickImport() { $('csvFile').value = ''; $('csvFile').click(); }

/* ---- 仕入CSV取込の入口 ----
   毎週の作業なので、一覧 → 取込 → 内容確認 → 一括登録 の4手で終わるようにする。
   ここはファイルを渡すだけの画面。落とすか選ぶかのどちらでもよい。 */
/* 取込の入口は2つ。どちらもファイルを見て自動で判別するが、
   何のためのCSVかで説明を変える。
     purchase … 毎週の自社落札CSV。ここから商品と個体が増えていく（こちらが主）
     stock    … 既存の在庫一覧CSV。販売状況や保管場所を補う（初期移行・照合用） */
let importIntent = 'purchase';
function openImport(intent) {
  if (!canAdmin()) { toast('取り込みは管理者だけができます'); return; }
  importIntent = intent === 'stock' ? 'stock' : 'purchase';
  const buy = importIntent === 'purchase';
  openModal(buy ? '自社落札CSV取込' : '既存在庫CSV取込', `
    <div class="drop" id="drop"
         ondragover="dropOver(event,true)" ondragleave="dropOver(event,false)" ondrop="dropFile(event)">
      <span class="ms">upload_file</span>
      <div class="t">CSVファイルをここにドラッグ＆ドロップ</div>
      <button class="btn lime" onclick="pickImport()">ファイルを選ぶ</button>
    </div>
    <p class="meta" style="margin-top:12px">
      ${buy
        ? `毎週の<strong>自社落札CSV</strong>（<code>出品番号</code>と<code>落札価格</code>の列がある形）を読みます。
           <strong>ここで登録した商品と個体が、そのまま在庫一覧になります。</strong>
           管理番号とQRは1台ずつ発行します。`
        : `<strong>既存の在庫一覧CSV</strong>を読みます。現在庫・保管場所・販売状況などを補うための入口です。
           <strong>管理番号・S/N・仕入価格・原価といった仕入の情報は書き換えません。</strong>
           足りない個体を足すだけです。`}<br>
      ファイルの中身を見て自動で判別するので、どちらの入口からでも読めます。
      次の画面で確認してから登録します。<strong>すでに登録した個体は二重に入りません。</strong></p>
    ${db.imports.length ? `<div class="lbl" style="margin:16px 0 6px">前回の取込</div>
      <div class="meta">${esc(fmtDT(db.imports[0].imported_at))}　${esc(db.imports[0].file_name || '')}
        商品 ${db.imports[0].product_count}／個体 ${db.imports[0].item_count}　${esc(db.imports[0].actor || '')}</div>` : ''}
  `, [['閉じる', 'closeModal()', 'btn ghost'],
      ...(db.imports.length ? [['取込履歴', 'closeModal();openImportHist()', 'btn ghost']] : [])]);
}
function dropOver(e, on) { e.preventDefault(); const d = $('drop'); if (d) d.classList.toggle('on', on); }
function dropFile(e) {
  e.preventDefault();
  dropOver(e, false);
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  if (!/\.(csv|txt)$/i.test(f.name)) { toast('CSVファイルを落としてください'); return; }
  readInventoryCsv({ files: [f] });
}

/* ---- 取込履歴 ---- */
function importHistLine() {
  if (!db.imports.length) return '';
  const last = db.imports[0];
  return `<div class="histline">
    <span class="ms">history</span>
    <span class="meta">最後の取込　${esc(fmtDT(last.imported_at))}　${esc(last.file_name || '')}
      商品 ${last.product_count}／個体 ${last.item_count}</span>
    <button class="btn sm ghost" onclick="openImportHist()">CSV取込履歴</button>
  </div>`;
}
function openImportHist() {
  openModal('CSV取込履歴', db.imports.length ? `
    <div class="table-wrap"><table class="t">
      <thead><tr><th>取込日</th><th>ファイル名</th><th class="r">商品</th><th class="r">個体</th><th>登録者</th><th></th></tr></thead>
      <tbody>${db.imports.map(r => `<tr>
        <td class="nowrap num">${esc(fmtDT(r.imported_at))}</td>
        <td>${esc(r.file_name || '—')}${r.summary ? `<div class="meta">${esc(r.summary)}</div>` : ''}</td>
        <td class="r num">${r.product_count}</td>
        <td class="r num">${r.item_count}</td>
        <td class="nowrap">${esc(r.actor || '—')}</td>
        <td class="nowrap">${(r.product_codes || []).length
          ? `<button class="btn sm ghost" onclick="closeModal();showBatch(${r.id})">この分だけ見る</button>` : ''}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : '<div class="empty">まだ取り込みはありません。</div>',
    [['閉じる', 'closeModal()', 'btn ghost']]);
}

/* ---- 「今回登録した商品だけ表示」 ---- */
function showBatch(id, justNow) {
  ui.fBatch = id;
  // 「今回」と言えるのは取り込んだ直後だけ。履歴から過去の回を選んだ時点で終わり
  ui.doneBatch = justNow ? id : null;
  ui.q = ''; ui.fCat = ''; ui.fMaker = ''; ui.fLoc = ''; ui.fStock = ''; ui.fList = '';
  ui.sel = {};
  go('list');
}
function clearBatch() { ui.fBatch = null; render(); }
function batchOf(id) { return db.imports.find(r => r.id === id) || null; }

/* 今回発行したQRだけをまとめて印刷する。棚に貼るのは取り込んだ直後なので、
   選び直さなくてよいようにここから直接ラベル画面へ渡す */
function printBatchQr(id) {
  const b = batchOf(id);
  const ids = (b && b.item_ids) || [];
  const live = ids.filter(x => item(x));
  if (!live.length) { toast('印刷できるQRがありません'); return; }
  ui.labelSel = {};
  live.forEach(x => { ui.labelSel[labelKey('item', x)] = true; });
  go('labels');
  if (live.length < ids.length) toast(`${ids.length - live.length}件は削除済みのため除きました`);
}
const batchQrBtn = (b, cls) => (b && (b.item_ids || []).length)
  ? `<button class="btn ${cls || 'sm'}" onclick="printBatchQr(${b.id})">
      <span class="ms">print</span>今回登録したQRを印刷（${(b.item_ids || []).length}枚）</button>` : '';
function batchBanner() {
  const b = batchOf(ui.fBatch);
  if (!b) return '';
  const codes = b.product_codes || [];
  const alive = codes.filter(c => prod(c)).length;
  const now = ui.doneBatch === b.id;
  return `<div class="batchbar${now ? ' done' : ''}">
    <span class="ms">${now ? 'check_circle' : 'filter_alt'}</span>
    <div style="flex:1;min-width:0">
      <div class="bt">${now ? `今回登録した商品 ${alive}件` : `この取込で登録した商品 ${alive}件`}</div>
      <div class="meta">個体 ${b.item_count}台　${esc(fmtDT(b.imported_at))}　${esc(b.file_name || '')}${
        alive !== codes.length ? `　（${codes.length - alive}件は削除済み）` : ''}</div>
    </div>
    ${batchQrBtn(b)}
    <button class="btn sm ghost" onclick="clearBatch()">すべて表示</button>
  </div>`;
}

let importSrc = null;                  // 読み込んだCSVそのもの。読み替えを変えたら組み直す
let importPlan = null;
const impMap = { loc: {}, cat: {} };   // 取り込み画面でのその場の読み替え

async function readInventoryCsv(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  // 同じファイルを続けて選ぶと value が変わらず change が起きないので、読んだら空にしておく。
  // File はもう手元にあるので、ここで消しても読み込みには影響しない
  try { input.value = ''; } catch (e) { /* ドロップから来たときは input ではない */ }
  const { text, encoding } = window.EightCsv.decode(await file.arrayBuffer());
  const table = window.EightCsv.parse(text);
  if (!table.length) { toast('中身が読み取れませんでした'); return; }

  // 「統合在庫一覧」は先頭に見出しや集計が入っているので、本当のヘッダー行を探す
  let head = -1;
  for (let r = 0; r < Math.min(table.length, 12); r++) {
    const row = table[r].map(c => String(c || '').replace(/^﻿/, '').trim());
    if (row.includes('出品番号') && row.includes('落札価格')) { head = r; break; }
    if (row.includes('型番') && row.includes('管理番号一覧') && !row.includes('商品ID')) { head = r; break; }
    if (row.includes('商品ID') || (row.includes('商品名') && row.includes('管理方式'))) { head = r; break; }
  }
  if (head < 0) {
    openModal('取り込めませんでした', `
      <div class="card" style="margin-bottom:12px">見出しの行が見つかりませんでした。</div>
      <p class="meta">読めるのは次の3種類です。<br>
        ・仕入CSV（<code>出品番号</code> と <code>落札価格</code> の列がある）<br>
        ・この画面の「CSVダウンロード」で出した形（<code>商品ID</code> の列がある）<br>
        ・統合在庫一覧（型番別）（<code>型番</code> と <code>管理番号一覧</code> の列がある）</p>`,
      [['閉じる', 'closeModal()', 'btn ghost']]);
    return;
  }

  const H = table[head].map(c => String(c || '').replace(/^﻿/, '').trim());
  const idx = {};
  H.forEach((h, i) => { if (idx[h] == null) idx[h] = i; });
  const mode = (idx['出品番号'] != null && idx['落札価格'] != null) ? 'purchase'
             : (idx['管理番号一覧'] != null && idx['型番'] != null && idx['商品ID'] == null) ? 'legacy'
             : 'master';
  const body = table.slice(head + 1).filter(r => r.some(c => String(c).trim() !== ''));

  impMap.loc = {}; impMap.cat = {};
  planPrice = {}; planQty = {};
  importSrc = { mode, H, idx, body, file: file.name, encoding, headRow: head };
  replan();
  showImportPreview();
}

/* 読み替えを変えたら組み直す。件数がその場で変わるので、何が通るようになるか分かる */
function replan() {
  const s = importSrc;
  if (!s) return;
  const fn = { purchase: planPurchase, legacy: planLegacy, master: planMaster }[s.mode] || planMaster;
  importPlan = fn(s.H, s.idx, s.body, s.file, s.encoding, s.headRow);
}
function setImpMap(kind, value, id) {
  if (id) impMap[kind][value] = id; else delete impMap[kind][value];
  replan();
  showImportPreview();
}

const cell = (idx, row, h) => (idx[h] == null || idx[h] >= row.length) ? '' : String(row[idx[h]] == null ? '' : row[idx[h]]).trim();
/* 列名は運用のなかで揺れる（最低在庫 / 最低在庫数 など）。いくつか候補を見る */
const cellAny = (idx, row, names) => {
  for (const h of names) { const v = cell(idx, row, h); if (v !== '') return v; }
  return '';
};
const numOf = (v) => v === '' ? null : Number(String(v).replace(/[,¥\s]/g, ''));

/* 販売情報。モール別の列（Amazon出品状態 / Amazon URL …）と、
   書き出しの「販売状況」（Amazon:出品中 ｜ 楽天:…）のどちらでも読む */
function readChannels(idx, row) {
  const out = [];
  CHANNELS.forEach(c => {
    const st = cellAny(idx, row, [c.label + '出品状態', c.label + '状態']);
    const url = cellAny(idx, row, [c.label + ' URL', c.label + 'URL']);
    if (!st && !url) return;
    const e = { channel: c.key, state: LIST_STATES.includes(st) ? st : null };
    if (/^https?:/i.test(url)) e.url = url;
    else if (url) e.note = url;
    if (st && !e.state) e.note = (e.note ? e.note + ' ／ ' : '') + st;
    out.push(e);
  });
  if (out.length) return out;
  // 「販売状況」1列にまとまっている場合
  String(cell(idx, row, '販売状況') || '').split('｜').forEach(seg => {
    const i = seg.indexOf(':');
    if (i < 0) return;
    const c = CHANNELS.find(x => x.label === seg.slice(0, i).trim());
    if (!c) return;
    const st = seg.slice(i + 1).trim();
    out.push({ channel: c.key, state: LIST_STATES.includes(st) ? st : null, note: LIST_STATES.includes(st) ? null : st });
  });
  return out;
}

/* --- (1) この画面が書き出した形 --- */
function planMaster(H, idx, body, file, encoding, headRow) {
  const add = [], skip = [], bad = [];
  const seen = {}, seenNo = {};
  db.items.forEach(i => { seenNo[i.id] = 'すでに在庫にあります'; });
  body.forEach((row, n) => {
    const line = headRow + 2 + n;
    const g = h => cell(idx, row, h);
    const name = g('商品名') || g('型番');
    if (!name) { bad.push({ line, key: g('商品ID'), reason: 'no-name', why: '商品名も型番も空です' }); return; }
    const kind = g('管理方式') === '数量管理' ? 'quantity' : 'individual';
    const key = g('商品ID') || g('型番') || name;

    // 型番に状態や不具合が混ざっていたら分ける
    const sp = splitModel(g('型番'));
    const model = sp.model || g('型番');

    // 型番をそろえて既存を探す。CSVの商品IDは当てにしない
    // （手元のメモでしかなく、DBの主キーと同じとはかぎらない）
    const exists = findMaster(model, name, kind)
      || db.masters.find(p => g('商品ID') && p.source_code === g('商品ID'));
    // 同じ型番が2行に分かれていても、商品は1つにまとめて個体を両方ぶら下げる
    const dupKey = normModel(model || name) + '/' + kind;
    const twin = seen[dupKey] || null;

    const ca = findCat(g('カテゴリ'), kind);
    if (!ca.id) { bad.push({ line, key, ...ca }); return; }
    const lo = findLoc(g('保管場所').split(' ほか')[0]);
    if (!lo.id) { bad.push({ line, key, ...lo }); return; }

    // 同じ管理番号がCSVの2行に出てくることがある。1台は1回しか入れない
    const nos = [];
    (g('管理番号一覧') || '').split('/').map(x => x.trim()).filter(Boolean).forEach(no => {
      if (seenNo[no]) return;
      seenNo[no] = `${line}行目`;
      nos.push(no);
    });
    // 商品はあっても管理番号が入っていないことがある。足りない個体だけ足す
    if (exists && !nos.length) { skip.push({ line, key: exists.code, name: titleOf(exists) }); return; }
    const unitNote = [sp.note || '', sp.note ? `元の型番表記: ${g('型番')}` : ''].filter(Boolean).join('\n') || null;

    const entry = {
      line, key,
      sharesWith: exists ? exists.code : (twin ? twin.key : null),
      repair: !!exists,
      master: {
        // CSVの商品IDは主キーにしない。DB側で採番し、元の番号は控えとして持つ
        code: exists ? exists.code : null, source_code: g('商品ID') || null,
        name: g('商品名') || null, model: model || null,
        maker: g('メーカー') || null, category_id: ca.id, kind, spec: g('スペック') || null,
        location_id: lo.id, qty: kind === 'quantity' ? (numOf(g('現在庫')) || 0) : 0,
        min_qty: numOf(cellAny(idx, row, ['最低在庫', '最低在庫数'])) || 0,
        supplier: g('仕入先') || null, unit_price: numOf(g('単価')),
        note: g('備考') || null,
        legacy_note: cellAny(idx, row, ['旧データ備考', '旧データ在庫内訳']) || null
      },
      units: nos.map(id => ({ id, note: unitNote })),
      channels: exists ? [] : readChannels(idx, row)
    };
    if (!twin) seen[dupKey] = entry;
    add.push(entry);
  });
  return { mode: 'master', add, skip, bad, file, encoding };
}

/* --- (2) 統合在庫一覧（型番別）--- */
const LEGACY_STATUS = { 'あり': '在庫', '社内使用': '社内使用', '未設定': '不明', '不明': '不明', 'なし': '不明' };
const LEGACY_CHANNEL = {
  'Amazon': 'amazon', 'amazon': 'amazon', '楽天': 'rakuten', 'メルカリ': 'mercari',
  'ヤフオク': 'yahuoku', 'ヤフーフリマ': 'yahoo_free', 'Notion': 'notion'
};

/* 「あり:21 / 社内使用:4」→ [['在庫',21],['社内使用',4]] */
function parseBreakdown(text) {
  const out = [];
  String(text || '').split('/').forEach(part => {
    const m = part.trim().match(/^(.+?):\s*(\d+)$/);
    if (m) out.push([LEGACY_STATUS[m[1].trim()] || '不明', Number(m[2]), m[1].trim()]);
  });
  return out;
}
/* 「Amazon:出品停止/出品中 ｜ 楽天:出品中」→ チャネルごとの行 */
function parseListing(text) {
  const out = [];
  String(text || '').split('｜').forEach(seg => {
    const i = seg.indexOf(':');
    if (i < 0) return;
    const name = seg.slice(0, i).trim();
    const key = LEGACY_CHANNEL[name];
    if (!key) return;
    const rest = seg.slice(i + 1).trim();
    const first = rest.split(/[/,]/).map(x => x.trim()).find(x => LIST_STATES.includes(x)) || null;
    out.push({ channel: key, state: first, note: rest });
  });
  return out;
}

function planLegacy(H, idx, body, file, encoding, headRow) {
  const add = [], skip = [], bad = [];
  const seenModel = {}, seenNo = {};
  db.items.forEach(i => { seenNo[i.id] = 'すでに在庫にあります'; });

  body.forEach((row, n) => {
    const line = headRow + 2 + n;
    const g = h => cell(idx, row, h);
    const rawModel = g('型番');
    if (!rawModel) { bad.push({ line, key: '', reason: 'no-model', why: '型番が空です' }); return; }
    // 型番に状態や不具合が混ざっていたら分ける。説明は個体の備考に回す
    const sp = splitModel(rawModel);
    const model = sp.model || rawModel;

    const exists = findMaster(model, model, 'individual');
    // 同じ型番が2行に分かれていることがある（「A B」と「AB」など空白の有無）。
    // 商品は1つにまとめ、管理番号は捨てずに両方ぶら下げる
    const mk = normModel(model);
    const twin = seenModel[mk] || null;

    const nos = [], dropped = [];
    (g('管理番号一覧') || '').split('/').map(x => x.trim()).filter(Boolean).forEach(no => {
      if (seenNo[no]) { dropped.push(`${no}（${seenNo[no]}）`); return; }
      seenNo[no] = `${line}行目`;
      nos.push(no);
    });

    const bd = parseBreakdown(g('元データ在庫内訳'));
    const states = [];
    bd.forEach(([st, cnt]) => { for (let k = 0; k < cnt; k++) states.push(st); });

    const legacyNote = [
      g('元データ在庫内訳') ? `元データ在庫内訳: ${g('元データ在庫内訳')}` : '',
      g('在庫数') ? `旧在庫数: ${g('在庫数')}` : '',
      g('登録台数') ? `旧登録台数: ${g('登録台数')}` : '',
      g('在庫状況') ? `旧在庫状況: ${g('在庫状況')}` : '',
      g('備考') ? `備考: ${g('備考')}` : '',
      dropped.length ? `取り込まなかった重複管理番号: ${dropped.join(' / ')}` : ''
    ].filter(Boolean).join('\n');

    const chans = parseListing(g('出品状況'));
    [['Amazon URL', 'amazon'], ['メルカリURL', 'mercari'], ['ヤフオクURL', 'yahuoku'],
     ['ヤフーフリマURL', 'yahoo_free'], ['楽天URL', 'rakuten'], ['Notion URL', 'notion']].forEach(([h, key]) => {
      const v = g(h);
      if (!v) return;
      let c = chans.find(x => x.channel === key);
      if (!c) { c = { channel: key, state: null, note: '' }; chans.push(c); }
      if (/^https?:/i.test(v)) c.url = v;
      else c.note = (c.note ? c.note + ' ／ ' : '') + v;
    });

    // 商品はあっても管理番号が入っていないことがある（取込が途中で止まった等）。
    // そのときは商品を作らず、足りない個体だけ足す＝再取込がそのまま個体補完になる
    if (exists && !nos.length) {
      skip.push({ line, key: exists.code, name: titleOf(exists) });
      return;
    }

    // 型番から切り出した状態・不具合は、その行の個体の備考に付ける
    const unitNote = [sp.note || '', sp.note ? `元の型番表記: ${rawModel}` : ''].filter(Boolean).join('\n') || null;

    const entry = {
      line, key: model,
      sharesWith: exists ? exists.code : (twin ? twin.key : null),
      master: {
        code: exists ? exists.code : null,
        name: g('商品名') || null, model, maker: g('メーカー') || null,
        category_id: null, kind: 'individual', spec: g('スペック') || null,
        location_id: null, qty: 0, min_qty: 0, note: null, legacy_note: legacyNote
      },
      units: nos.map((id, k) => ({ id, status: states[k] || '不明', note: unitNote })),
      channels: exists ? [] : chans,
      dropped: dropped.length,
      repair: !!exists
    };
    if (!twin) seenModel[mk] = entry;
    add.push(entry);
  });
  return { mode: 'legacy', add, skip, bad, file, encoding };
}

/* --- (3) 仕入CSV（落札のたびに出る形）---
   1つの出品番号が「親1行＋子N行」で来る。
     親  … 構成（単体／セット）・総数・型番・落札価格・落札料
     子  … 個品ID（現物に貼ってあるバーコードの番号）・メーカー・スペック・状態
   価格は親にしか無いので、落札価格と落札料を子の台数で割って1台ずつに持たせる。
   割り切れないぶんは先頭の1台に寄せる（合計が仕入額とずれないように）。
   「商品名」の列は出品カテゴリ（NTPC / ｻﾌﾟﾗｲ）なので商品名には使わない。 */
let planPrice = {};   // 出品番号 → 手で直した販売予定価格（1台あたり）
let planQty = {};     // 出品番号 → 手で直した登録数量

/* 採番する管理番号の頭。型番の先頭の英数字を使う（WKBｾｯﾄ → WKB）。
   取れなければカテゴリの記号に任せる */
function idPrefixOf(model) {
  const m = String(model || '').toUpperCase().match(/^[A-Z0-9]+/);
  const p = m ? m[0].slice(0, 6) : '';
  return /[A-Z]/.test(p) ? p : '';
}

/* 「RYZEN7(7735U)-2.7GHZ / 16GB / 512GB / 14型」のように、中身のある列だけ並べる */
const SPEC_COLS = [['CPU（性能）', ''], ['RAMサイズ', ''], ['ＨＤ容量', ''],
                   ['液晶', '型'], ['ドライブ', ''], ['仕様', ''], ['OFFICE', '']];
const SPEC_EMPTY = ['-', 'ﾅｼ', 'ナシ', 'なし', '無', '無し'];

function purchaseSpec(idx, row) {
  const out = [];
  SPEC_COLS.forEach(([h, suffix]) => {
    const v = cell(idx, row, h);
    if (v && SPEC_EMPTY.indexOf(v) < 0) out.push(v + suffix);
  });
  return out.join(' / ');
}
/* 状態・症状・備考・詳細はそのまま備考に残す。検品や値付けの判断材料なので捨てない */
function purchaseNote(idx, row) {
  return ['状態', '症状', '詳細', '備考', '補足']
    .map(h => { const v = cell(idx, row, h); return v ? `${h}: ${v}` : ''; })
    .filter(Boolean).join('\n');
}
/* 開催日は 20260915 の形で来る */
const ymd8 = (v) => /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6)}` : null;

/* 合計を変えずに n 等分する。端数は先頭に寄せる */
function splitEven(total, n) {
  const base = Math.floor(total / n);
  const out = new Array(n).fill(base);
  out[0] += total - base * n;
  return out;
}

/* 登録数量ぶんの個体を組み立てる。数量を変えるたびにここで作り直す。
     数量と個品IDの数が合っている  → 個品IDをそのまま管理番号にする（現物のバーコードと一致）
     合っていない（セットなど）    → 管理番号を1台ずつ採番し、元の個品IDは仕入元IDとして残す
   落札価格と落札料は仕入全体の金額なので、登録数量で割って1台ずつに持たせる。
   端数は先頭の1台に寄せて、合計が仕入額とずれないようにする。 */
function buildUnits(x) {
  const qty = x.lot.qty, s = x.src;
  const same = qty === s.kids.length;
  const buy = splitEven(x.lot.buy, qty), fee = splitEven(x.lot.fee, qty);
  const src = s.kids.map(k => k.id).join(' / ');
  const out = [];
  for (let i = 0; i < qty; i++) {
    const k = same ? s.kids[i] : s.kids[0];
    out.push({
      id: same ? k.id : null,              // null なら取り込むときに採番する
      source_id: same ? null : src,
      idPrefix: x.idPrefix,
      status: '在庫',
      // シリアル番号は1台を指すものなので、数が合わないときは付けない（同じ番号が並ぶのを防ぐ）
      serial: same ? (k.serial || null) : null,
      note: k.note || null,
      purchased_on: s.bought,
      price: buy[i],
      purchase_fee: fee[i],
      plan_price: x.plan                   // 販売予定価格は1台あたり
    });
  }
  return out;
}
const costPer = (x) => x.lot.qty ? x.lot.cost / x.lot.qty : 0;
const gainPer = (x) => x.plan == null ? null : x.plan - costPer(x);
const gainLot = (x) => x.plan == null ? null : x.plan * x.lot.qty - x.lot.cost;

function planPurchase(H, idx, body, file, encoding, headRow) {
  const add = [], skip = [], bad = [];
  const seenNo = {}, seenLot = {}, seenSn = {};
  db.items.forEach(i => {
    seenNo[i.id] = 'すでに在庫にあります';
    // 採番して入れたものは、元の個品IDでも二重登録を防げるようにする
    String(i.source_id || '').split('/').forEach(v => {
      const t = v.trim(); if (t) seenNo[t] = 'すでに在庫にあります';
    });
    // 照合は 管理番号・個品ID → S/N → 型番 の順。S/Nは実物1台を指す
    const sn = String(i.serial || '').trim().toUpperCase();
    if (sn) seenSn[sn] = i.id;
  });

  // 出品番号ごとにまとめる。親（落札価格のある行）と子（個品IDのある行）に分ける
  const lots = [], byLot = {};
  body.forEach((row, n) => {
    const line = headRow + 2 + n;
    const g = h => cell(idx, row, h);
    const no = g('出品番号');
    if (!no) return;
    let lot = byLot[no];
    if (!lot) { lot = byLot[no] = { no, line, parent: null, kids: [] }; lots.push(lot); }
    if (g('落札価格') && !lot.parent) lot.parent = { line, row };
    if (g('個品ID') || g('個品ID(バーコード)')) lot.kids.push({ line, row });
  });

  lots.forEach(lot => {
    const key = lot.no;
    const line = lot.parent ? lot.parent.line : lot.line;
    const P = lot.parent ? (h => cell(idx, lot.parent.row, h)) : (() => '');

    if (!lot.parent) { bad.push({ line, key, reason: 'no-price', why: `出品番号 ${key} に落札価格の行がありません` }); return; }
    if (!lot.kids.length) { bad.push({ line, key, reason: 'no-unit', why: `出品番号 ${key} に個品IDの行がありません` }); return; }
    if (seenLot[key]) { bad.push({ line, key, reason: 'dup', why: `${seenLot[key]}行目と出品番号が重複しています` }); return; }
    seenLot[key] = line;

    const model = P('型番') || lot.kids.map(k => cell(idx, k.row, '型番')).find(Boolean) || '';
    if (!model) { bad.push({ line, key, reason: 'no-model', why: '型番が空です' }); return; }

    const kids = [], dropped = [];
    let already = 0;
    lot.kids.forEach(k => {
      const id = cell(idx, k.row, '個品ID(バーコード)') || cell(idx, k.row, '個品ID');
      if (!id) { dropped.push(`${k.line}行目（個品IDが空）`); return; }
      if (seenNo[id]) { dropped.push(`${id}（${seenNo[id]}）`); already++; return; }
      // 個品IDが新しくても、S/Nが一致すれば同じ実物。二重に登録しない
      const sn = cell(idx, k.row, 'Ｓ／Ｎ').trim().toUpperCase();
      if (sn && seenSn[sn]) { dropped.push(`${id}（S/N ${sn} が ${seenSn[sn]} にあります）`); already++; return; }
      seenNo[id] = `${k.line}行目`;
      if (sn) seenSn[sn] = `${k.line}行目`;
      kids.push({ id, row: k.row });
    });
    // 同じ仕入CSVをもう一度入れたとき。「取り込めない」ではなく「すでにある」として出す
    if (!kids.length && already === lot.kids.length) {
      skip.push({ line, key, name: model, units: [] }); return;
    }
    if (!kids.length) { bad.push({ line, key, reason: 'dup', why: '個品IDがすべて空か重複でした' }); return; }

    const maker = P('メーカー') || cell(idx, kids[0].row, 'メーカー') || '';
    const buy = numOf(P('落札価格')) || 0;
    const fee = numOf(P('落札料')) || 0;
    const cost = buy + fee;
    const bought = ymd8(P('開催日'));

    // 在庫数の基準は個品IDの数ではなく「総数」。
    // セット出品は個品IDが1つでも現物は9個ある、という形で来るため。
    const csvQty = numOf(P('総数')) || kids.length;
    const qty = planQty[key] != null ? planQty[key] : csvQty;
    const plan = planPrice[key] != null ? planPrice[key] : suggestPlan(cost / qty);

    // 同じ型番を別の出品番号で買うことがある。商品は1つにまとめ、個体だけ足す
    // （値段は個体ごとに持つので、仕入額が違っても1つの商品にぶら下げられる）
    const known = findMaster(model, model, 'individual');
    const earlier = add.find(a => normModel(a.master.model) === normModel(model));

    const x = {
      line, key,
      lot: { no: key, buy, fee, cost, qty, csvQty, kumi: P('構成') || '' },
      plan,
      idPrefix: idPrefixOf(model),
      src: {
        bought,
        kids: kids.map(k => ({
          id: k.id,
          serial: cell(idx, k.row, 'Ｓ／Ｎ') || null,
          note: purchaseNote(idx, k.row) || null
        }))
      },
      sharesWith: known ? known.code : (earlier ? earlier.key : null),
      master: {
        code: known ? known.code : null, name: model, model, maker: maker || null,
        category_id: null, kind: 'individual',
        spec: purchaseSpec(idx, kids[0].row) || null,
        location_id: null, qty: 0, min_qty: 0,
        note: [`出品番号 ${key}`,
               P('構成') ? `構成 ${P('構成')}（総数 ${csvQty}）` : '',
               bought ? `仕入日 ${bought}` : ''].filter(Boolean).join('　'),
        legacy_note: null
      },
      channels: [],
      dropped: dropped.length
    };
    x.units = buildUnits(x);
    add.push(x);
  });
  return { mode: 'purchase', add, skip, bad, file, encoding };
}

/* 取り込み確認画面で販売予定価格を直す。想定利益と合計がその場で変わる。
   作り直すと入力欄からフォーカスが外れるので、変わったところだけ書き換える */
function setPlanPrice(i, v) {
  const x = (importPlan.add || [])[i];
  if (!x) return;
  const s = String(v == null ? '' : v).trim();
  const n = s === '' ? null : numOf(s);
  if (n == null || isNaN(n)) delete planPrice[x.key]; else planPrice[x.key] = n;
  x.plan = planPrice[x.key] != null ? planPrice[x.key] : null;
  x.units.forEach(u => { u.plan_price = x.plan; });
  paintPurchase(i);
}

/* 登録数量を直す。個体の数・QRの数・1台あたり原価・想定利益がその場で変わる。
   値段を手で決めていなければ、1台あたり原価が変わったぶん目安も付け直す。 */
function setPlanQty(i, v) {
  const x = (importPlan.add || [])[i];
  if (!x) return;
  const n = Math.floor(numOf(String(v == null ? '' : v).trim()));
  if (!n || isNaN(n) || n < 1 || n > 999) return;    // 入力の途中は触らない
  x.lot.qty = n;
  planQty[x.key] = n;
  if (planPrice[x.key] == null) x.plan = suggestPlan(x.lot.cost / n);
  x.units = buildUnits(x);
  paintPurchase(i, true);
}
/* 数量の欄から離れたとき、入れかけの値が残らないように戻す */
function fixPlanQty(i) {
  const x = (importPlan.add || [])[i];
  const el = $('pq-' + i);
  if (x && el) el.value = x.lot.qty;
}

function paintPurchase(i, qtyChanged) {
  const x = (importPlan.add || [])[i];
  const set = (id, text, minus) => {
    const e = $(id);
    if (!e) return;
    e.textContent = text;
    e.classList.toggle('minus', !!minus);
  };
  if (x) {
    const g = gainPer(x);
    set('pc-' + i, yen(Math.round(costPer(x))));
    set('pg-' + i, g == null ? '—' : yen(Math.round(g)), g != null && g < 0);
    set('pgl-' + i, gainLot(x) == null ? '' : `合計 ${yen(Math.round(gainLot(x)))}`);
    const note = $('pqn-' + i);
    if (note) {
      note.textContent = x.lot.qty === x.lot.csvQty ? `CSV ${x.lot.csvQty}` : `CSV ${x.lot.csvQty} → ${x.lot.qty}`;
      note.classList.toggle('chg', x.lot.qty !== x.lot.csvQty);
    }
    const pp = $('pp-' + i);
    if (qtyChanged && pp && planPrice[x.key] == null) pp.value = x.plan == null ? '' : x.plan;
  }
  // 表の合計・上のまとめ・ボタンを、どれも古いまま残さないように一度に書き換える
  const t = purchaseTotals(importPlan.add);
  const minus = t.priced && t.gain < 0;
  set('ptQty', String(t.units));
  set('ptCost', yen(t.cost));   set('sumCost', yen(t.cost));
  set('ptPlan', t.plan ? yen(t.plan) : '—');
  set('sumPlan', t.plan ? yen(t.plan) : '—');
  set('ptGain', t.priced ? yen(t.gain) : '—', minus);
  set('sumGain', t.priced ? yen(t.gain) : '—', minus);
  const su = $('sumUnits');
  if (su) su.innerHTML = `${t.units}<span class="u">台</span>`;
  const btn = $('btnApply');
  if (btn) btn.textContent = `一括登録（商品 ${countPlan(importPlan).prods}・個体 ${t.units}）`;
}
function purchaseTotals(add) {
  return (add || []).filter(x => x.lot).reduce((a, x) => {
    a.cost += x.lot.cost;
    a.units += x.lot.qty;
    if (x.plan != null) { a.plan += x.plan * x.lot.qty; a.gain += x.plan * x.lot.qty - x.lot.cost; a.priced++; }
    return a;
  }, { cost: 0, plan: 0, gain: 0, units: 0, priced: 0 });
}

/* 取り込めない行は、理由ごとにまとめて件数を出す。
   「取り込めない 186」だけでは何を直せばいいか分からないため。
   未登録の値には読み替えの受け皿を付ける。実際の取り込みでは、
   ほとんどが「柏倉庫」のような1つの名前で落ちるので、
   ここで既存の場所に読み替えられれば、CSVを直さずに通せる。 */
const REASON_LABEL = {
  'loc-missing': '保管場所が未登録',
  'loc-ambiguous': '保管場所の名前が複数ある',
  'loc-empty': '保管場所が空',
  'cat-missing': 'カテゴリが未登録',
  'cat-kind': 'カテゴリの管理方式が違う',
  'cat-empty': 'カテゴリが空',
  'no-name': '商品名も型番も空',
  'no-model': '型番が空',
  'no-price': '落札価格の行がない',
  'no-unit': '個品IDの行がない',
  'dup': 'CSVの中で重複',
  'other': 'その他'
};
const REASON_ORDER = Object.keys(REASON_LABEL);

function badGroups(bad) {
  const g = {};
  bad.forEach(b => {
    const r = REASON_LABEL[b.reason] ? b.reason : 'other';
    (g[r] = g[r] || { reason: r, n: 0, values: {}, sample: b }).n++;
    if (b.value) {
      const v = (g[r].values[b.value] = g[r].values[b.value] || { n: 0, kind: b.kind });
      v.n++;
    }
  });
  return REASON_ORDER.filter(r => g[r]).map(r => g[r]);
}

/* 未登録の値に対する読み替えの選択肢 */
function fixSelect(reason, value, kind) {
  const isLoc = reason.indexOf('loc') === 0;
  const cur = isLoc ? impMap.loc[value] : impMap.cat[value];
  const opts = isLoc
    ? locsOrdered().map(l => `<option value="${esc(l.id)}"${cur === l.id ? ' selected' : ''}>${'　'.repeat(locDepth(l.id))}${esc(l.name)}</option>`).join('')
    : db.cats.filter(c => c.kind === (kind || 'individual'))
        .map(c => `<option value="${esc(c.id)}"${cur === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  return `<select class="input fixsel" onchange="setImpMap('${isLoc ? 'loc' : 'cat'}','${esc(value)}',this.value)">
    <option value="">読み替えない</option>${opts}</select>`;
}

/* 仕入CSVの確認表。出すのは 商品名／型番／数量／原価／販売予定価格／想定利益 だけ。
   「仕入れ → 原価が分かる → 売値を決める → 利益が分かる」が一目で追える並びにする。
   販売予定価格には目安（原価×1.3）を入れておくが、その場で必ず直せる。 */
function purchaseTable(add) {
  const t = purchaseTotals(add);
  return `<div class="table-wrap"><table class="t buy">
    <thead><tr>
      <th>商品名</th><th>型番</th><th class="r">数量</th>
      <th class="r">1台あたり原価</th><th class="r">販売予定価格</th><th class="r">想定利益</th>
    </tr></thead>
    <tbody>${add.map((x, i) => {
      const g = gainPer(x), gl = gainLot(x);
      const set = x.lot.csvQty > x.src.kids.length;
      return `<tr>
        <td>${esc(x.master.name)}${set
              ? `<div class="meta">${esc(x.lot.kumi || 'セット')}　個品ID ${x.src.kids.length}件 → 管理番号は1台ずつ発行</div>` : ''}</td>
        <td class="nowrap">${esc(x.master.model)}</td>
        <td class="r">
          <input class="input num qty" type="number" min="1" max="999" step="1" id="pq-${i}"
                 value="${x.lot.qty}" oninput="setPlanQty(${i},this.value)" onchange="fixPlanQty(${i})">
          <div class="meta qn${x.lot.qty !== x.lot.csvQty ? ' chg' : ''}" id="pqn-${i}">${
            x.lot.qty === x.lot.csvQty ? `CSV ${x.lot.csvQty}` : `CSV ${x.lot.csvQty} → ${x.lot.qty}`}</div></td>
        <td class="r num" ><span id="pc-${i}">${yen(Math.round(costPer(x)))}</span>
          <div class="meta">仕入合計 ${yen(x.lot.cost)}<br>（${yen(x.lot.buy)}＋手数料 ${yen(x.lot.fee)}）</div></td>
        <td class="r"><input class="input num plan" type="number" min="0" step="100" id="pp-${i}"
              value="${x.plan == null ? '' : esc(x.plan)}" placeholder="—"
              oninput="setPlanPrice(${i},this.value)"></td>
        <td class="r num"><span id="pg-${i}" class="${g != null && g < 0 ? 'minus' : ''}">${
            g == null ? '—' : yen(Math.round(g))}</span>
          <div class="meta" id="pgl-${i}">${gl == null ? '' : `合計 ${yen(Math.round(gl))}`}</div></td>
      </tr>`;
    }).join('')}</tbody>
    <tfoot><tr>
      <th colspan="2">合計</th>
      <th class="r num" id="ptQty">${t.units}</th>
      <th class="r num" id="ptCost">${yen(t.cost)}</th>
      <th class="r num" id="ptPlan">${t.plan ? yen(t.plan) : '—'}</th>
      <th class="r num${t.priced && t.gain < 0 ? ' minus' : ''}" id="ptGain">${t.priced ? yen(t.gain) : '—'}</th>
    </tr></tfoot>
  </table></div>
  <p class="meta" style="margin:6px 0 0">合計の欄は、数量ぶんを足した金額です（1台あたりではありません）。</p>`;
}

/* 確認画面に出す件数。二重登録を防いでいることが数で分かるようにする。
     新規商品   … このCSVで新しく作る商品（同じ型番が2回来ても1つに数える）
     既存へ追加 … すでにある商品に個体だけ足す仕入
     登録済み   … 管理番号がすでに在庫にある（同じCSVを二度入れたとき）
     重複       … CSVの中で重なっている・型番が無いなど、取り込めないもの */
function countPlan(p) {
  const fresh = {}, touched = {};
  let intoExisting = 0;
  p.add.forEach(x => {
    const known = x.master.code && prod(x.master.code);
    const key = known ? x.master.code
      : normModel(x.master.model || x.master.name || x.key) + '/' + (x.master.kind || 'individual');
    touched[key] = true;
    if (known || fresh[key]) { intoExisting++; return; }   // すでにある商品／この取込で作った商品に足す
    fresh[key] = true;
  });
  return {
    newProd: Object.keys(fresh).length,
    intoExisting,
    prods: Object.keys(touched).length,          // 実際にさわる商品の数（重複は1つに数える）
    done: p.skip.length,
    skipped: p.bad.length
  };
}

function showImportPreview() {
  const p = importPlan;
  const legacy = p.mode === 'legacy';
  const buy = p.mode === 'purchase';
  const units = p.add.reduce((n, x) => n + x.units.length, 0);
  const dropped = p.add.reduce((n, x) => n + (x.dropped || 0), 0);
  const unknown = p.add.reduce((n, x) => n + x.units.filter(u => u.status === '不明').length, 0);
  const groups = badGroups(p.bad);
  const fixable = groups.filter(g => Object.keys(g.values).length);
  const mapped = Object.keys(impMap.loc).length + Object.keys(impMap.cat).length;

  const list = (rows) => `<div class="plist">${rows.slice(0, 200).map(x =>
    `<div class="p"><span class="c">${esc(x.key || '（採番）')}</span>
      <span>${esc(x.name || (x.master && (x.master.name || x.master.model)) || '')}</span>
      ${x.units && x.units.length ? `<span class="meta">個体 ${x.units.length}台</span>` : ''}
      ${x.why ? `<span class="why">${esc(x.line)}行目：${esc(x.why)}</span>` : `<span class="meta" style="margin-left:auto">${x.line}行目</span>`}</div>`
  ).join('')}</div>${rows.length > 200 ? '<div class="meta" style="margin-bottom:12px">先頭200件だけ表示しています。</div>' : ''}`;

  const reasonHtml = groups.map(g => {
    const vals = Object.entries(g.values).sort((a, b) => b[1].n - a[1].n);
    return `<div class="rgroup">
      <div class="rh"><span class="rn">${g.n}</span>${esc(REASON_LABEL[g.reason])}</div>
      ${vals.length ? `<div class="rvals">${vals.map(([v, info]) => `
        <div class="rv">
          <span class="vv">「${esc(v)}」</span><span class="meta">${info.n}件</span>
          ${fixSelect(g.reason, v, info.kind)}
        </div>`).join('')}</div>`
        : `<div class="meta" style="padding:2px 0 0 26px">${esc(g.sample.why || '')}</div>`}
    </div>`;
  }).join('');

  const t = purchaseTotals(p.add);
  const shared = p.add.filter(x => x.sharesWith).length;
  const c = countPlan(p);
  const repair = p.add.filter(x => x.repair);
  const repairUnits = repair.reduce((n, x) => n + x.units.length, 0);

  openModal(buy ? '仕入CSV取込の確認' : '取り込む内容の確認', `
    <div class="card" style="margin-bottom:15px">
      ${esc(p.file)}（${p.encoding === 'shift_jis' ? 'Shift_JIS' : 'UTF-8'}として読み込み）<br>
      ${buy ? '<strong>仕入CSV</strong>として読みました。<strong>「総数」を在庫の台数として</strong>、1台ずつ管理番号とQRを発行します。'
            : legacy ? '<strong>統合在庫一覧（型番別）</strong>として読みました。型番ごとに商品マスタを作り、管理番号を1台ずつの個体に分けます。'
                     : '<strong>この画面の書き出し形式</strong>として読みました。'}<br>
      <strong>すでにある在庫は書き換えません。</strong>CSVにあって在庫に無いものだけを追加します。
    </div>
    ${buy ? `<div class="sum five">
      <div><div class="lbl">新規商品</div><div class="v add">${c.newProd}</div></div>
      <div><div class="lbl">既存商品への追加</div><div class="v add">${c.intoExisting}</div></div>
      <div><div class="lbl">個体・QR</div><div class="v add" id="sumUnits">${units}<span class="u">台</span></div></div>
      <div><div class="lbl">登録済み</div><div class="v skip">${c.done}</div></div>
      <div><div class="lbl">重複・取り込めない</div><div class="v${c.skipped ? ' err' : ''}">${c.skipped}</div></div>
    </div>
    <div class="sum">
      <div><div class="lbl">原価</div><div class="v" id="sumCost">${yen(t.cost)}</div></div>
      <div><div class="lbl">販売予定価格</div><div class="v" id="sumPlan">${t.plan ? yen(t.plan) : '—'}</div></div>
      <div><div class="lbl">想定利益</div>
        <div class="v add" id="sumGain">${t.priced ? yen(t.gain) : '—'}</div></div>
    </div>` : `<div class="sum">
      <div><div class="lbl">商品マスタ</div><div class="v add">${c.newProd}</div></div>
      <div><div class="lbl">個体</div><div class="v add">${units}</div></div>
      <div><div class="lbl">すでにある</div><div class="v skip">${p.skip.length}</div></div>
      <div><div class="lbl">取り込めない</div><div class="v err">${p.bad.length}</div></div>
    </div>`}

    ${buy && p.add.length ? `<div class="lbl" style="margin-bottom:6px">取り込む商品</div>
      ${purchaseTable(p.add)}
      <p class="meta" style="margin:-4px 0 14px">
        <strong>数量はその場で直せます。</strong>直すと個体数・QRの発行枚数・1台あたり原価・想定利益がすぐ付いてきます。<br>
        1台あたり原価 ＝（落札価格 ＋ 落札料）÷ 数量。端数は先頭の1台に寄せるので、合計は仕入額と一致します。
        販売予定価格は1台あたり原価の1.3倍を目安に入れてあります（手で直したものはそのまま残します）。
        ${p.add.some(x => x.lot.csvQty > x.src.kids.length)
          ? '<br>個品IDより総数が多いものは、<strong>管理番号を1台ずつ発行して別々のQRにします</strong>。元の個品IDは仕入元IDとして全台に残します。' : ''}
        ${shared ? `<br>同じ型番の <strong>${shared}件</strong> は、商品を分けずに個体だけ足します（値段は1台ずつ持ちます）。` : ''}</p>` : ''}

    ${buy && p.add.length ? `<div class="card" style="margin-bottom:15px">
      <div class="lbl" style="margin-bottom:5px">カテゴリと保管場所</div>
      仕入CSVには入っていないので、ここで選んだものを全件に当てます（あとから商品ごとに直せます）。
      保管場所は<strong>${esc(DEFAULT_IMPORT_LOC)}</strong>を初期値にしています。
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-top:12px">
        <label class="field"><span>カテゴリ *</span><select class="input" id="impCat">
          ${db.cats.filter(c => c.kind === 'individual').map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}
        </select></label>
        <label class="field"><span>保管場所 *</span>
          <select class="input" id="impLoc">${locOptions(defaultImportLoc(), '選択してください')}</select></label>
      </div>
      ${dropped ? `<p class="meta" style="margin:10px 0 0">個品IDが空か重複していた <strong>${dropped}行</strong> は取り込みません。</p>` : ''}
    </div>` : ''}

    ${repair.length ? `<div class="card" style="margin-bottom:15px">
      <div class="lbl" style="margin-bottom:5px">足りない個体を補います</div>
      すでにある商品 <strong>${repair.length}件</strong> に、まだ入っていない管理番号
      <strong>${repairUnits}件</strong> を足します。<strong>商品マスタは作り直しません。</strong><br>
      <span class="meta">${repair.slice(0, 8).map(x => esc(x.master.model || x.key)).join('、')}${
        repair.length > 8 ? ` ほか${repair.length - 8}件` : ''}</span>
    </div>` : ''}

    ${groups.length ? `<div class="lbl" style="margin-bottom:6px">取り込めない理由</div>
      ${fixable.length ? `<p class="meta" style="margin-bottom:8px">
        右の欄で<strong>登録済みのものに読み替える</strong>と、その場で取り込めるようになります（CSVを直す必要はありません）。</p>` : ''}
      <div class="reasons">${reasonHtml}</div>
      ` : ''}
    ${mapped ? `<div class="lbl" style="margin-bottom:6px">読み替えの設定（${mapped}件）</div>
      <div class="mapped">${
        Object.entries(impMap.loc).map(([v, id]) => `<div class="mv">
          <span class="vv">「${esc(v)}」</span><span class="ar">→</span>
          <span>${esc(locPath(id))}</span>
          <button class="btn sm ghost" onclick="setImpMap('loc','${esc(v)}','')">取り消す</button></div>`).join('') +
        Object.entries(impMap.cat).map(([v, id]) => `<div class="mv">
          <span class="vv">「${esc(v)}」</span><span class="ar">→</span>
          <span>${esc(catName(id))}</span>
          <button class="btn sm ghost" onclick="setImpMap('cat','${esc(v)}','')">取り消す</button></div>`).join('')
      }</div>
      <p class="meta" style="margin:-6px 0 14px">読み替えはこの取り込みのあいだだけ有効です。CSVそのものは書き換えません。</p>` : ''}

    ${legacy ? `<div class="card" style="margin-bottom:15px">
      <div class="lbl" style="margin-bottom:5px">取り込みかたの確認</div>
      ・カテゴリと保管場所は元データに無いので、下で選んだものを全件に当てます。<br>
      ・状態は「元データ在庫内訳」の件数どおりに割り当てます。ただし<strong>どの管理番号がどの状態かは元データに書かれていない</strong>ので、
        並び順で当てています。${unknown ? `うち <strong>${unknown}台</strong> は「不明」です。` : ''}
        棚卸で現物を確認して確定してください。<br>
      ・在庫数は取り込みません。<strong>各個体の状態から数えます</strong>（手入力の数と現物のずれを持ち込まないため）。<br>
      ・元の値は消さず「旧データ備考」に残します。
      ${dropped ? `<br>・重複していた管理番号 <strong>${dropped}件</strong> は1台だけ取り込み、残りは旧データ備考に書きます。` : ''}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-top:12px">
        <label class="field"><span>カテゴリ *</span><select class="input" id="impCat">
          ${db.cats.filter(c => c.kind === 'individual').map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}
        </select></label>
        <label class="field"><span>保管場所 *</span><select class="input" id="impLoc">${locOptions('', '選択してください')}</select></label>
      </div></div>` : ''}

    ${!buy && p.add.length ? `<div class="lbl" style="margin-bottom:6px">追加する商品</div>${list(p.add)}` : ''}
    ${p.skip.length ? `<div class="lbl" style="margin-bottom:6px">すでにあるので変更しません</div>${list(p.skip)}` : ''}
    ${p.bad.length ? `<div class="lbl" style="margin-bottom:6px">取り込めない行</div>${list(p.bad)}` : ''}
    ${canAdmin() ? '' : '<div class="card">商品の追加は管理者だけができます。</div>'}
  `, [
    ['閉じる', 'closeModal()', 'btn ghost'],
    ...(p.add.length && canAdmin() ? [[buy ? `一括登録（商品 ${c.prods}・個体 ${units}）` : `${p.add.length}商品・${units}台を追加`,
                                       'applyInventoryImport()', 'btn lime', 'btnApply']] : [])
  ]);
}

async function applyInventoryImport() {
  const p = importPlan;
  if (!p || !p.add.length) return;
  const catId = ($('impCat') || {}).value || null;
  const locId = ($('impLoc') || {}).value || null;
  const pickHere = p.mode === 'legacy' || p.mode === 'purchase';   // カテゴリと保管場所が元データに無い形
  if (pickHere && (!catId || !locId)) { toast('カテゴリと保管場所を選んでください'); return; }
  closeModal();
  toast(p.mode === 'purchase' ? `仕入 ${p.add.length}件を登録しています…` : `${p.add.length}商品を取り込んでいます…`);

  let units = [], txs = [];
  const chans = [];
  const touched = [];                      // 今回さわった商品。取込履歴に残して一覧を絞れるようにする
  let madeProds = 0;                       // 実際に新しく作った商品の数
  for (const x of p.add) {
    const m = Object.assign({}, x.master);
    if (pickHere) { m.category_id = catId; m.location_id = locId; }
    if (!m.name) m.name = m.model;

    // 商品は「型番で探して、無ければ作る」を関数の中で1回でやる。
    // CSVの商品IDを主キーにしない（既存の主キーとぶつかるため）。
    // 同じ型番を毎週仕入れても、商品は1つのまま個体だけ増えていく。
    const up = await sb.rpc('inv_upsert_product', { p_row: {
      model: m.model, name: m.name, kind: m.kind, maker: m.maker,
      category_id: m.category_id, location_id: m.location_id, spec: m.spec,
      qty: m.qty, min_qty: m.min_qty, supplier: m.supplier, unit_price: m.unit_price,
      note: m.note, legacy_note: m.legacy_note, source_code: m.source_code || null
    } });
    if (up.error) { toast('商品を登録できませんでした：' + up.error.message); return; }
    m.code = up.data.code;
    if (up.data.created) madeProds++;
    // 個体の分類は商品に合わせる（置き場所は今回選んだところ）
    else if (up.data.category_id) m.category_id = up.data.category_id;
    if (touched.indexOf(m.code) < 0) touched.push(m.code);

    for (const u of x.units) {
      let id = u.id;
      if (!id) {
        // 型番から取れる記号を頭に使う（WKBｾｯﾄ → WKB-00001）。取れなければカテゴリの記号
        const pre = u.idPrefix || (cat(m.category_id) || {}).code_prefix || 'IT';
        const { data, error } = await sb.rpc('inv_next_id', { p_prefix: pre, p_digits: 5 });
        if (error) { toast('管理番号を採番できませんでした：' + error.message); return; }
        id = data;
      }
      const row = {
        id, product_code: m.code, name: m.name, category_id: m.category_id,
        maker: m.maker, model: m.model, location_id: m.location_id,
        status: u.status || '在庫', legacy_note: m.legacy_note
      };
      // 仕入CSVは1台ずつに値段と個体の情報が付く。cost は計算される列なので送らない
      ['serial', 'note', 'purchased_on', 'price', 'purchase_fee', 'plan_price', 'source_id'].forEach(k => {
        if (u[k] != null && u[k] !== '') row[k] = u[k];
      });
      units.push(row);
      txs.push({
        actor: me.name, ref_kind: 'item', ref_id: id, label: m.name, action: '登録',
        before_value: '—',
        after_value: (u.status || '在庫') + '（' + locPath(m.location_id) + '）'
          + (p.mode === 'purchase'
             ? `／仕入 ${yen(costOf(u))}・予定 ${u.plan_price == null ? '未定' : yen(u.plan_price)}`
             : '／CSV取込')
      });
    }
    (x.channels || []).forEach(c => chans.push(Object.assign({ product_code: m.code }, c)));
  }

  // 手元のキャッシュは読み込み上限（LOAD_LIMIT）で頭打ちになるし、
  // 別の人が入れたものにも気づけない。入れる直前にDBへ問い合わせて、
  // すでにある管理番号を外す。これをしないと管理番号の主キーがぶつかる
  const ids = units.map(u => u.id);
  const taken = {};
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await sb.from('inventory_items')
      .select('id').in('id', ids.slice(i, i + 300));
    if (error) { toast('管理番号を確かめられませんでした：' + error.message); return; }
    (data || []).forEach(r => { taken[r.id] = true; });
  }
  const dupIds = ids.filter(x => taken[x]);
  if (dupIds.length) {
    const keep = new Set(units.filter(u => !taken[u.id]).map(u => u.id));
    units = units.filter(u => keep.has(u.id));
    txs = txs.filter(x => x.ref_kind !== 'item' || keep.has(x.ref_id));
  }

  // 追記するだけの取り込みなので、万一かち合っても上書きせず黙って飛ばす。
  // 途中まで入って止まる、という中途半端な結果にしないため
  const ins = async (table, rows, key) => {
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { error } = key
        ? await sb.from(table).upsert(chunk, { onConflict: key, ignoreDuplicates: true })
        : await sb.from(table).insert(chunk);
      if (error) throw new Error(`${table} に入れられませんでした：${error.message}`);
    }
  };
  const wasBuy = p.mode === 'purchase';
  const t = purchaseTotals(p.add);
  let batchId = null;
  try {
    if (units.length) await ins('inventory_items', units, 'id');
    if (chans.length) await ins('inventory_channels', chans, 'product_code,channel');
    if (txs.length) await ins('inventory_transactions', txs);
    // 履歴は最後に入れる。ここまで通ってはじめて「取り込めた」と言えるため
    const { data, error } = await sb.from('inventory_imports').insert({
      actor: me.name, file_name: p.file, kind: p.mode,
      product_count: touched.length, item_count: units.length,
      product_codes: touched,
      item_ids: units.map(u => u.id),      // 今回のQRだけまとめて印刷するのに使う
      summary: wasBuy
        ? `新規 ${madeProds}商品／既存へ追加 ${touched.length - madeProds}商品`
          + `／原価 ${yen(t.cost)}／想定利益 ${t.priced ? yen(t.gain) : '—'}`
        : `新規 ${madeProds}商品`
    }).select();
    if (!error && data && data[0]) batchId = data[0].id;
  } catch (e) { toast(e.message); return; }

  importPlan = null; importSrc = null;
  impMap.loc = {}; impMap.cat = {}; planPrice = {}; planQty = {};
  await loadAll();
  // 取り込んだら商品管理一覧に戻り、今回の分だけを出す
  if (batchId) showBatch(batchId, true); else { ui.fBatch = null; ui.doneBatch = null; go('list'); }
  const skipped = dupIds.length ? `／すでにあった ${dupIds.length}台は飛ばしました` : '';
  toast(wasBuy ? `商品 ${touched.length}件・個体 ${units.length}台を登録しました（原価 ${yen(t.cost)}／想定利益 ${t.priced ? yen(t.gain) : '—'}）${skipped}`
               : `${madeProds}商品・${units.length}台を取り込みました${skipped}`);
}

/* ---------------------------------------------------------------- モーダル */
function openModal(title, body, buttons) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = body;
  $('modalFoot').innerHTML = (buttons || []).map(([t, fn, cls, id]) =>
    `<button class="${cls || 'btn'}"${id ? ` id="${esc(id)}"` : ''} onclick="${fn}">${esc(t)}</button>`).join('');
  $('modal').classList.add('on');
}
function closeModal() { $('modal').classList.remove('on'); }

/* ===== 3. 個体の詳細（QRを読んだ直後の画面） ===== */
function viewItem() {
  const it = item(ui.itemId);
  if (!it) return `<div class="empty">該当する機器が見つかりません（${esc(ui.itemId || '')}）</div>`;
  const url = itemUrl(it.id);
  const m = prod(it.product_code);          // 商品名・型番はマスタ側が正
  const hist = db.tx.filter(t => t.ref_kind === 'item' && t.ref_id === it.id);
  const op = (icon, label, fn, pri, on) =>
    `<button class="btn ${pri ? 'pri' : ''}" onclick="${fn}" ${on === false || !canEdit() ? 'disabled' : ''}>
      <span class="ms">${icon}</span><span class="t">${esc(label)}</span></button>`;

  return `
  <div class="detail">
    <div class="main">
      <div class="kind">${esc(catName((m || it).category_id) || '機器')}</div>
      <h1>${esc(m ? titleOf(m) : it.name)}</h1>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span class="num" style="font-size:19px;font-weight:500">${esc(it.id)}</span>
        ${statusTag(it.status, true)}
        ${isLong(it) ? '<span class="tag" style="background:var(--l200)">長期貸出 ' + daysSince(it.loaned_at) + '日</span>' : ''}
      </div>
      <div class="info">
        <div><span class="k">保管場所</span>${esc(locPath(it.location_id)) || '—'}</div>
        <div><span class="k">利用者</span>${esc(it.user_name || '—')}</div>
        <div><span class="k">メーカー・型番</span>${esc([(m || it).maker, (m || it).model].filter(Boolean).join(' ') || '—')}</div>
        ${m ? `<div><span class="k">商品</span><a href="#" onclick="go('prod','${esc(m.code)}');return false">${esc(m.code)} を見る</a></div>` : ''}
        <div><span class="k">シリアル番号</span>${esc(it.serial || '—')}</div>
        ${it.source_id ? `<div><span class="k">仕入元ID</span>${esc(it.source_id)}</div>` : ''}
        <div><span class="k">仕入日</span>${it.purchased_on ? fmtD(it.purchased_on) : '—'}</div>
        <div><span class="k">棚卸確認</span>${it.last_checked_at ? fmtDT(it.last_checked_at) : '未確認'}</div>
      </div>
      ${priceBox(it)}
      ${guardNote()}
      <div class="ops">
        ${op('assignment_ind', '貸出', `sheetLoan('${esc(it.id)}')`, true, it.status === '在庫')}
        ${op('assignment_return', '返却', `sheetReturn('${esc(it.id)}')`, false, it.status === '貸出中')}
        ${op('move_down', '移動', `sheetMove('${esc(it.id)}')`)}
        ${op('build', '修理・故障', `sheetStatus('${esc(it.id)}')`)}
        ${op('paid', '売却', `sheetSell('${esc(it.id)}')`, false, !GONE.includes(it.status))}
        ${op('fact_check', '棚卸確認', `checkItem('${esc(it.id)}')`)}
        ${canAdmin() ? op('delete', '廃棄', `sheetScrap('${esc(it.id)}')`) : ''}
      </div>
    </div>
    <div class="qrbox">
      <img src="${qr(url)}" alt="${esc(it.id)} のQRコード" width="140" height="140">
      <div class="u">${esc(url)}</div>
    </div>
  </div>
  ${m && m.spec ? `<div class="sec">スペック</div><div class="pre">${esc(m.spec)}</div>` : ''}
  ${it.note ? `<div class="sec">備考</div><div class="pre">${esc(it.note)}</div>` : ''}
  ${it.legacy_note ? `<div class="sec">旧データ備考</div><div class="pre legacy">${esc(it.legacy_note)}</div>` : ''}
  <div class="sec">この機器の履歴</div>
  ${hist.length ? hist.map(txRow).join('') : '<div class="empty">まだ記録はありません。</div>'}`;
}

/* 値段は4つだけ出す。原価・販売予定価格・実際の販売価格・利益。
   売れていないうちは「想定利益」、売れたあとは「利益」。 */
function priceBox(it) {
  const cost = costOf(it), plan = planOf(it);
  const sold = (it.sold_price == null || it.sold_price === '') ? null : Number(it.sold_price);
  const gain = sold != null ? realProfit(it) : expectedProfit(it);
  const cel = (label, value, cls) =>
    `<div><div class="lbl">${label}</div><div class="v ${cls || ''}">${value}</div></div>`;
  return `<div class="prices">
    ${cel('原価', cost ? yen(cost) : '—')}
    ${cel('販売予定価格', plan == null ? '—' : yen(plan))}
    ${cel('実際の販売価格', sold == null ? '—' : yen(sold))}
    ${cel(sold != null ? '利益' : '想定利益',
          gain == null || !cost ? '—' : yen(gain),
          gain != null && cost ? (gain < 0 ? 'minus' : 'plus') : '')}
    <button class="btn sm ghost" onclick="sheetPrice('${esc(it.id)}')" ${dis()}>値段を直す</button>
  </div>`;
}

function sheetPrice(id) {
  const it = item(id); if (!it) return;
  const n = (v) => (v == null || v === '') ? '' : String(v);
  openSheet({
    title: '値段', subject: id, cta: '保存',
    hint: '原価 ＝ 仕入価格 ＋ 手数料。想定利益 ＝ 販売予定価格 − 原価。',
    body: `<label class="field" style="margin-bottom:10px"><span>仕入価格</span>
        <input class="input num" type="number" min="0" id="prBuy" value="${esc(n(it.price))}"
               oninput="paintPriceSheet()" placeholder="0"></label>
      <label class="field" style="margin-bottom:10px"><span>手数料</span>
        <input class="input num" type="number" min="0" id="prFee" value="${esc(n(it.purchase_fee))}"
               oninput="paintPriceSheet()" placeholder="0"></label>
      <div class="prow"><span>原価</span><b class="num" id="prCost">${yen(costOf(it))}</b></div>
      <label class="field" style="margin:10px 0"><span>販売予定価格</span>
        <input class="input num" type="number" min="0" step="100" id="sheetVal" value="${esc(n(it.plan_price))}"
               oninput="paintPriceSheet()" placeholder="未定"></label>
      <div class="prow"><span>想定利益</span><b class="num" id="prGain">${
        expectedProfit(it) == null ? '—' : yen(expectedProfit(it))}</b></div>`,
    run: (plan) => savePrice(id, numField('prBuy'), numField('prFee'), plan === '' ? null : Number(plan))
  });
  paintPriceSheet();
}
const numField = (el) => { const s = (($(el) || {}).value || '').trim(); return s === '' ? null : Number(s); };
function paintPriceSheet() {
  const buy = numField('prBuy'), fee = numField('prFee'), plan = numField('sheetVal');
  const cost = (buy || 0) + (fee || 0);
  const c = $('prCost'); if (c) c.textContent = yen(cost);
  const g = $('prGain');
  if (g) {
    const gain = plan == null ? null : plan - cost;
    g.textContent = gain == null ? '—' : yen(gain);
    g.classList.toggle('minus', gain != null && gain < 0);
  }
}
async function savePrice(id, buy, fee, plan) {
  const { data, error } = await sb.rpc('inv_item_price',
    { p_item_id: id, p_price: buy, p_fee: fee, p_plan: plan });
  if (error) { toast(error.message || '保存できませんでした'); return; }
  const i = db.items.findIndex(x => x.id === id);
  if (i >= 0 && data) db.items[i] = data;
  await refreshTx();
  render();
  toast('値段を保存しました');
}

/* ===== 4. 商品詳細（基本情報・個体一覧・販売情報・履歴の4タブ） ===== */
const TABS = [['info', 'info', '基本情報'], ['units', 'inventory_2', '個体一覧'],
              ['sales', 'storefront', '販売情報'], ['hist', 'history', '履歴']];
function setTab(t) { ui.tab = t; render(); }

function viewProd() {
  const p = prod(ui.prodId);
  if (!p) return `<div class="empty">該当する商品が見つかりません（${esc(ui.prodId || '')}）</div>`;
  const ind = p.kind === 'individual';
  const s = stockOf(p);
  const url = prodUrl(p.code);

  const body = {
    info: tabInfo, units: tabUnits, sales: tabSales, hist: tabHist
  }[ui.tab] || tabInfo;

  return `
  <div class="detail">
    <div class="main">
      <div class="kind">${esc(catName(p.category_id) || (ind ? '個体管理' : '数量管理'))}</div>
      <h1>${esc(titleOf(p))}</h1>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:4px">
        <span class="num" style="font-size:17px;font-weight:500">${esc(p.model || p.code)}</span>
        ${stockTag(stockLabel(p))}
        <span class="meta">${esc(ind ? '個体管理' : '数量管理')}</span>
      </div>
      <div style="display:flex;align-items:flex-end;gap:22px;margin:18px 0 4px;flex-wrap:wrap">
        <div><div class="lbl">現在庫</div><div class="bignum num"${s.inStock <= 0 ? ' style="color:#B3261E"' : ''}>${s.inStock}</div></div>
        <div><div class="lbl">登録数</div><div class="num" style="font-size:28px;font-weight:600">${s.registered}</div></div>
        <div class="sub" style="display:grid;gap:3px">
          <div>保管場所　${esc(placeOf(p)) || '—'}</div>
          <div>メーカー　${esc(p.maker || '—')}</div>
          ${!ind ? `<div>最低在庫　<b class="num">${p.min_qty}</b>　単価 ${yen(p.unit_price)}</div>` : ''}
        </div>
      </div>
      ${!ind && needsOrder(p) ? `<div class="needorder" style="margin-top:10px"><span class="ms">shopping_cart</span>要発注：最低在庫（${p.min_qty}）を下回っています</div>` : ''}
    </div>
    <div class="qrbox">
      <img src="${qr(url)}" alt="${esc(p.code)} のQRコード" width="140" height="140">
      <div class="u">${esc(url)}</div>
    </div>
  </div>

  <div class="tabs2">${TABS.map(([k, ic, lb]) =>
    `<button class="${ui.tab === k ? 'on' : ''}" onclick="setTab('${k}')"><span class="ms">${ic}</span>${lb}${
      k === 'units' && ind ? `<span class="n">${s.total}</span>` : ''}${
      k === 'sales' ? `<span class="n">${channelsOf(p.code).length}</span>` : ''}</button>`).join('')}</div>
  <div id="tabBody">${body(p)}</div>`;
}

/* --- 基本情報 --- */
function tabInfo(p) {
  const ind = p.kind === 'individual';
  return `
    <div class="info">
      <div><span class="k">商品ID</span>${esc(p.code)}</div>
      <div><span class="k">商品名</span>${esc(p.name || '（型番で代用）')}</div>
      <div><span class="k">型番</span>${esc(p.model || '—')}</div>
      <div><span class="k">メーカー</span>${esc(p.maker || '—')}</div>
      <div><span class="k">カテゴリ</span>${esc(catName(p.category_id) || '—')}</div>
      <div><span class="k">管理方式</span>${ind ? '個体管理（1台＝1レコード）' : '数量管理'}</div>
      ${!ind ? `<div><span class="k">仕入先</span>${esc(p.supplier || '—')}</div>
                <div><span class="k">単価</span>${yen(p.unit_price)}</div>` : ''}
    </div>
    ${ind ? prodPrices(p) : ''}
    ${p.spec ? `<div class="sec">スペック</div><div class="pre">${esc(p.spec)}</div>` : ''}
    ${p.note ? `<div class="sec">備考</div><div class="pre">${esc(p.note)}</div>` : ''}
    ${p.legacy_note ? `<div class="sec">旧データ備考</div>
      <div class="pre legacy">${esc(p.legacy_note)}</div>
      <p class="meta">移行前のデータです。消さずに残しています。</p>` : ''}
    ${guardNote()}<div class="ops" style="max-width:520px;margin-top:18px">
      ${!ind ? `
        <button class="btn pri" onclick="sheetIn('${esc(p.code)}')" ${dis()}><span class="ms">login</span><span class="t">入庫</span></button>
        <button class="btn" onclick="sheetOut('${esc(p.code)}')" ${dis()}><span class="ms">logout</span><span class="t">出庫</span></button>
        <button class="btn" onclick="sheetCount('${esc(p.code)}')" ${dis()}><span class="ms">fact_check</span><span class="t">棚卸</span></button>`
      : `
        <button class="btn pri" onclick="sheetStockSet('${esc(p.code)}')" ${dis()}>
          <span class="ms">edit</span><span class="t">在庫数を直す</span></button>
        <button class="btn" onclick="sheetSellQty('${esc(p.code)}')" ${dis()}>
          <span class="ms">paid</span><span class="t">売れた</span></button>`}
    </div>`;
}

/* 商品ぜんぶの値段。まだ売っていないものは販売予定価格で見込む。廃棄は数えない */
function prodPrices(p) {
  const t = priceTotals(p.code);
  if (!t.n || (!t.cost && !t.plan && !t.sold)) return '';
  const gain = (t.sold + t.plan) - t.cost;
  return `<div class="prices" style="margin-top:16px">
    <div><div class="lbl">原価（${t.n}台）</div><div class="v">${yen(t.cost)}</div></div>
    <div><div class="lbl">販売予定</div><div class="v">${t.plan ? yen(t.plan) : '—'}</div></div>
    <div><div class="lbl">売却済</div><div class="v">${t.sold ? yen(t.sold) : '—'}</div></div>
    <div><div class="lbl">見込み利益</div>
      <div class="v ${t.cost ? (gain < 0 ? 'minus' : 'plus') : ''}">${t.cost ? yen(gain) : '—'}</div></div>
  </div>
  <p class="meta" style="margin-top:6px">売れたものは実際の販売価格、売れていないものは販売予定価格で見込んでいます。</p>`;
}

/* --- 個体一覧。QRを出し、クリックで操作できる --- */
function tabUnits(p) {
  if (p.kind !== 'individual') return '<div class="empty">数量管理の商品なので、個体は持ちません。</div>';
  const list = itemsOf(p.code);
  if (!list.length) return '<div class="empty">個体がまだ登録されていません。</div>';
  return `${guardNote()}
    <div class="units">${list.map(i => `
      <div class="unit">
        <img src="${qr(itemUrl(i.id))}" alt="" width="72" height="72" onclick="go('item','${esc(i.id)}')" style="cursor:pointer">
        <div class="ux">
          <div class="num" style="font-weight:600;font-size:14px">${esc(i.id)}</div>
          <div style="margin:3px 0">${statusTag(i.status)}</div>
          <div class="meta">${esc(locPath(i.location_id) || '—')}</div>
          ${i.serial ? `<div class="meta">S/N ${esc(i.serial)}</div>` : ''}
          ${i.source_id ? `<div class="meta">仕入元 ${esc(i.source_id)}</div>` : ''}
          ${i.user_name ? `<div class="meta">${esc(i.user_name)}</div>` : ''}
          ${unitPriceLine(i)}
        </div>
        <div class="ua">
          <button class="btn sm ghost" onclick="go('item','${esc(i.id)}')">開く</button>
          <button class="btn sm" onclick="unitMenu('${esc(i.id)}')" ${dis()}>操作</button>
        </div>
      </div>`).join('')}</div>`;
}

/* 個体一覧に出す値段は1行だけ。原価 → 売値 → 利益の順で読める並びにする */
function unitPriceLine(i) {
  const cost = costOf(i);
  const sold = (i.sold_price == null || i.sold_price === '') ? null : Number(i.sold_price);
  const plan = planOf(i);
  if (!cost && plan == null && sold == null) return '';
  const gain = sold != null ? realProfit(i) : expectedProfit(i);
  return `<div class="meta uprice">原価 ${cost ? yen(cost) : '—'}
    <span class="ar">→</span>${sold != null ? yen(sold) : (plan == null ? '—' : yen(plan) + '（予定）')}
    ${gain != null && cost ? `<b class="${gain < 0 ? 'minus' : 'plus'}">${yenSign(gain)}</b>` : ''}</div>`;
}

/* 個体をクリックしたときの操作メニュー */
function unitMenu(id) {
  const it = item(id); if (!it) return;
  const can = (ok) => ok ? '' : 'disabled';
  openModal(`${it.id} の操作`, `
    <div class="card" style="margin-bottom:14px">${esc(titleOf(prod(it.product_code)) || it.name)}　${statusTag(it.status)}
      <div class="meta" style="margin-top:4px">${esc(locPath(it.location_id))}</div></div>
    <div class="ops" style="margin:0">
      <button class="btn pri" onclick="closeModal();sheetLoan('${esc(id)}')" ${can(it.status === '在庫')}>
        <span class="ms">assignment_ind</span><span class="t">貸出</span></button>
      <button class="btn" onclick="closeModal();sheetReturn('${esc(id)}')" ${can(it.status === '貸出中')}>
        <span class="ms">assignment_return</span><span class="t">返却</span></button>
      <button class="btn" onclick="closeModal();sheetMove('${esc(id)}')">
        <span class="ms">move_down</span><span class="t">移動</span></button>
      <button class="btn" onclick="closeModal();sheetUnitOut('${esc(id)}')" ${can(!GONE.includes(it.status))}>
        <span class="ms">logout</span><span class="t">出庫</span></button>
      <button class="btn" onclick="closeModal();sheetUnitIn('${esc(id)}')" ${can(it.status !== '在庫' && !GONE.includes(it.status))}>
        <span class="ms">login</span><span class="t">入庫</span></button>
      <button class="btn" onclick="closeModal();sheetStatus('${esc(id)}')">
        <span class="ms">build</span><span class="t">修理・状態</span></button>
      <button class="btn" onclick="closeModal();sheetSell('${esc(id)}')" ${can(!GONE.includes(it.status))}>
        <span class="ms">paid</span><span class="t">売却</span></button>
      ${canAdmin() ? `<button class="btn" onclick="closeModal();sheetScrap('${esc(id)}')" ${can(it.status !== '廃棄')}>
        <span class="ms">delete</span><span class="t">廃棄</span></button>` : ''}
    </div>`, [['閉じる', 'closeModal()', 'btn ghost']]);
}

/* --- 販売情報 --- */
function tabSales(p) {
  const list = channelsOf(p.code);
  return `${guardNote()}
    <p class="meta" style="margin-bottom:12px">モールごとの出品情報です。在庫一覧には出さず、ここでまとめて見ます。</p>
    <div class="table-wrap"><table class="t">
      <thead><tr><th>販売チャネル</th><th>SKU</th><th>商品URL</th><th>出品状態</th><th>メモ</th><th></th></tr></thead>
      <tbody>${CHANNELS.map(c => {
        const x = list.find(v => v.channel === c.key) || {};
        return `<tr>
          <td class="nowrap"><span class="tag ch ${x.state === '出品中' ? 'on' : ''}">${esc(c.short)}</span> ${esc(c.label)}</td>
          <td class="nowrap">${esc(x.sku || '—')}</td>
          <td>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener" class="meta" style="word-break:break-all">開く</a>` : '<span class="meta">—</span>'}</td>
          <td class="nowrap">${x.state ? `<span class="tag ${x.state === '出品中' ? 'ch on' : 'act'}">${esc(x.state)}</span>` : '<span class="meta">—</span>'}</td>
          <td class="meta" style="max-width:260px">${esc((x.note || '').slice(0, 80))}</td>
          <td class="nowrap"><button class="btn sm ghost" onclick="sheetChannel('${esc(p.code)}','${c.key}')" ${dis()}>編集</button></td>
        </tr>`;
      }).join('')}</tbody></table></div>`;
}

function sheetChannel(code, ch) {
  const c = CHANNELS.find(x => x.key === ch) || { label: ch };
  const x = db.channels.find(v => v.product_code === code && v.channel === ch) || {};
  openSheet({
    title: c.label, subject: code, cta: '保存',
    hint: 'このモールでの出品情報を入れます。空にすると「未設定」になります。',
    body: `<label class="field" style="margin-bottom:10px"><span>SKU</span>
        <input class="input" id="chSku" value="${esc(x.sku || '')}" placeholder="モールでの商品コード"></label>
      <label class="field" style="margin-bottom:10px"><span>商品URL</span>
        <input class="input" id="chUrl" value="${esc(x.url || '')}" placeholder="https://…"></label>
      <label class="field" style="margin-bottom:10px"><span>出品状態</span>
        <select class="input" id="sheetVal"><option value="">未設定</option>
        ${LIST_STATES.map(s => `<option${x.state === s ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
      <label class="field"><span>メモ</span>
        <input class="input" id="chNote" value="${esc(x.note || '')}"></label>`,
    run: async (state) => {
      const row = {
        product_code: code, channel: ch,
        sku: ($('chSku') || {}).value || null,
        url: ($('chUrl') || {}).value || null,
        state: state || null,
        note: ($('chNote') || {}).value || null
      };
      const { data, error } = await sb.from('inventory_channels')
        .upsert(row, { onConflict: 'product_code,channel' }).select();
      if (error) { toast('保存できませんでした：' + error.message); return; }
      const got = (data && data[0]) || row;
      const i = db.channels.findIndex(v => v.product_code === code && v.channel === ch);
      if (i >= 0) db.channels[i] = got; else db.channels.push(got);
      render();
      toast(c.label + 'の販売情報を保存しました');
    }
  });
}

/* --- 履歴 --- */
function tabHist(p) {
  const ids = itemsOf(p.code).map(i => i.id);
  const rows = db.tx.filter(t =>
    (t.ref_kind === 'product' && t.ref_id === p.code) ||
    (t.ref_kind === 'item' && ids.includes(t.ref_id)));
  if (!rows.length) return '<div class="empty">まだ記録はありません。</div>';
  return rows.map(t => `<div class="rowline">
    <span class="meta num" style="width:126px;flex:0 0 auto">${fmtDT(t.occurred_at)}</span>
    <span class="meta" style="width:72px;flex:0 0 auto">${esc(t.actor || '')}</span>
    <span class="num" style="flex:0 0 auto;font-size:12px">${esc(t.ref_id)}</span>
    <span class="tag act">${esc(t.action)}</span>
    <span class="meta" style="flex:1 1 200px">${esc(t.before_value || '—')} → ${esc(t.after_value || '—')}</span>
  </div>`).join('');
}

function sheetSell(id) {
  const it = item(id); if (!it) return;
  const cost = costOf(it), plan = planOf(it);
  openSheet({
    title: '売却', subject: id, cta: '売却を記録',
    hint: `${esc(titleOf(prod(it.product_code)) || it.name)} を売却済にします。現在庫からも登録数からも外れますが、履歴は残ります。`,
    body: `<label class="field"><span>実際の販売価格</span>
        <input class="input num" type="number" min="0" id="sheetVal"
               value="${plan == null ? '' : esc(plan)}" oninput="paintSellSheet(${cost})" placeholder="0"></label>
      <div class="prow"><span>原価</span><b class="num">${cost ? yen(cost) : '—'}</b></div>
      <div class="prow"><span>利益</span><b class="num" id="slGain">${
        cost && plan != null ? yen(plan - cost) : '—'}</b></div>
      <label class="field" style="margin-top:12px"><span>メモ（任意）</span>
        <input class="input" id="sellNote" placeholder="例 メルカリで販売"></label>`,
    run: (v) => itemOp(id, '売却', v, (($('sellNote') || {}).value || '').trim() || null)
  });
}
/* 一覧から「売れた」を記録する。個体管理は在庫の古いものから台数ぶん売却済にする。
   1台ずつどれを売ったか選びたいときは、商品詳細の個体一覧から操作する。 */
function sheetSellQty(code) {
  const p = prod(code); if (!p) return;
  const avail = itemsOf(code).filter(i => IN_STOCK.includes(i.status));
  if (!avail.length) { toast('売れる在庫がありません'); return; }
  const plan = planOf(avail[0]);
  openSheet({
    title: '売れた（在庫を引く）', subject: code, cta: '売却を記録',
    hint: `${esc(titleOf(p))}　現在庫 ${avail.length}台。<strong>管理番号の若いものから</strong>売却済にします。`,
    body: `<label class="field" style="margin-bottom:10px"><span>売れた台数</span>
        <input class="input num" type="number" min="1" max="${avail.length}" id="sqQty" value="1"
               oninput="paintSellQty('${esc(code)}')"></label>
      <label class="field"><span>1台あたりの販売価格</span>
        <input class="input num" type="number" min="0" id="sheetVal" value="${plan == null ? '' : esc(plan)}"
               oninput="paintSellQty('${esc(code)}')" placeholder="0"></label>
      <div class="prow"><span>売上</span><b class="num" id="sqSum">—</b></div>
      <div class="prow"><span>利益</span><b class="num" id="sqGain">—</b></div>
      <div class="prow" style="border-bottom:1px solid var(--rule)">
        <span>売却する管理番号</span><b class="num" id="sqIds" style="font-size:13px;text-align:right">—</b></div>`,
    run: async (price) => {
      const n = Math.max(1, Math.min(avail.length, parseInt(numField('sqQty') || 1, 10)));
      const v = String(price || '').trim();
      let ok = 0;
      for (const it of avail.slice(0, n)) {
        const { data, error } = await sb.rpc('inv_item_op',
          { p_item_id: it.id, p_action: '売却', p_value: v || null, p_note: '一覧から売却' });
        if (error) { toast(error.message || '記録できませんでした'); break; }
        const i = db.items.findIndex(x => x.id === it.id);
        if (i >= 0 && data) db.items[i] = data;
        ok++;
      }
      await refreshTx();
      render();
      toast(`${ok}台を売却しました（残り ${avail.length - ok}台）`);
    }
  });
  paintSellQty(code);
}
function paintSellQty(code) {
  const avail = itemsOf(code).filter(i => IN_STOCK.includes(i.status));
  const n = Math.max(1, Math.min(avail.length, parseInt(numField('sqQty') || 1, 10) || 1));
  const price = numField('sheetVal');
  const picked = avail.slice(0, n);
  const cost = picked.reduce((a, i) => a + costOf(i), 0);
  const set = (id, text, minus) => {
    const e = $(id); if (!e) return;
    e.textContent = text; e.classList.toggle('minus', !!minus);
  };
  set('sqSum', price == null ? '—' : yen(price * n));
  const gain = (price == null || !cost) ? null : price * n - cost;
  set('sqGain', gain == null ? '—' : yen(gain), gain != null && gain < 0);
  set('sqIds', picked.map(i => i.id).slice(0, 4).join('、') + (n > 4 ? ` ほか${n - 4}台` : ''));
}

function paintSellSheet(cost) {
  const s = (($('sheetVal') || {}).value || '').trim();
  const g = $('slGain'); if (!g) return;
  const gain = (s === '' || !cost) ? null : Number(s) - cost;
  g.textContent = gain == null ? '—' : yen(gain);
  g.classList.toggle('minus', gain != null && gain < 0);
}

/* ===== 5・6. 入庫 / 出庫 =====
   数量管理は qty を増減する。個体管理は1台ずつなので、
   出庫＝手元から出る（貸出・社内使用・売却）、入庫＝手元に戻る（在庫に戻す）に対応させる。
   どちらもQRを読めば続けて処理できる。                                      */
function draftSet(code, v) { ui.drafts[code] = v; }
function viewIn() { return moveList('in'); }
function viewOut() { return moveList('out'); }
function moveList(mode) {
  const isIn = mode === 'in';
  const targets = db.masters.filter(p => p.kind !== 'individual');
  const rows = targets.map(p => `
    <div class="rowline" style="gap:14px;align-items:center">
      <div style="flex:1 1 220px;min-width:0">
        <div style="font-weight:500">${esc(titleOf(p))}</div>
        <div class="meta">${esc(p.code)}　${isIn ? esc(locPath(p.location_id)) : '最低在庫 ' + p.min_qty}</div>
      </div>
      <div class="num" style="font-size:22px;font-weight:500;width:56px;text-align:right;${!isIn && needsOrder(p) ? 'color:#B3261E' : ''}">${p.qty}</div>
      <input class="input num" type="number" min="1" style="width:74px;text-align:center;min-height:44px"
             value="${esc(ui.drafts[p.code] || '')}" placeholder="0" oninput="draftSet('${esc(p.code)}',this.value)">
      <button class="btn ${isIn ? 'pri' : ''}" onclick="${isIn ? 'sheetIn' : 'sheetOut'}('${esc(p.code)}',true)" ${dis()}>
        ${isIn ? '入庫' : '出庫'}</button>
    </div>`).join('');

  return `<h1>${isIn ? '入庫' : '出庫'}</h1>
    <p class="sub" style="margin:8px 0 14px">
      ${isIn ? 'モノが増える・戻ってくるときの記録です。' : 'モノが減る・手元から出るときの記録です。'}
      <strong>QRを読めば続けて処理できます</strong>（数量品は数を入れ、個体は1台ずつ）。</p>
    ${guardNote()}
    <button class="btn lime" style="min-height:62px;width:100%;font-size:18px;margin-bottom:18px"
            onclick="openScan('${mode}')" ${dis()}>
      <span class="ms" style="font-size:28px">qr_code_scanner</span>QRを読んで${isIn ? '入庫' : '出庫'}</button>

    <div class="sec" style="margin-top:0">数量管理から選ぶ</div>
    ${targets.length ? rows : '<div class="empty">数量管理の品目はまだありません。</div>'}

    <div class="sec">個体は1台ずつ</div>
    <p class="meta">個体管理の機器は、上のQR読み取りか、商品詳細の「個体一覧」から操作してください。
      現在庫は各個体の状態から数えるので、ここで数を足し引きすることはありません。</p>`;
}

/* 個体を出す（貸出・社内使用・売却）。QRの出庫モードと個体一覧から使う */
function sheetUnitOut(id, after) {
  const it = item(id); if (!it) return;
  const m = prod(it.product_code);
  openSheet({
    title: '出庫', subject: id, cta: '記録する',
    hint: `${esc(titleOf(m) || it.name)}　いまの状態 ${esc(it.status)}`,
    body: `<label class="field" style="margin-bottom:10px"><span>どこへ出すか</span>
        <select class="input" id="sheetVal">
          <option value="社内使用">社内使用にする</option>
          <option value="貸出">貸出にする</option>
          <option value="売却">売却する</option>
        </select></label>
      <label class="field"><span>利用者・メモ</span>
        <input class="input" id="outWho" list="uOpts" placeholder="例 佐藤 健" autocomplete="off">
        <datalist id="uOpts">${userOptions()}</datalist></label>`,
    run: async (kind) => {
      const who = (($('outWho') || {}).value || '').trim();
      if (kind === '貸出') {
        if (!who) { toast('貸出のときは利用者を入れてください'); return; }
        await itemOp(id, '貸出', who);
      } else if (kind === '売却') {
        await itemOp(id, '売却', null, who || null);
      } else {
        await itemOp(id, '社内使用', who || null);
      }
      if (after) after();
    }
  });
}

/* 個体を戻す（在庫に戻す）。貸出中なら返却として記録する */
function sheetUnitIn(id, after) {
  const it = item(id); if (!it) return;
  const m = prod(it.product_code);
  const back = it.status === '貸出中';
  openSheet({
    title: '入庫', subject: id, cta: back ? '返却として記録' : '在庫に戻す',
    hint: `${esc(titleOf(m) || it.name)}　いまの状態 ${esc(it.status)}${back ? '（' + esc(it.user_name || '') + '）' : ''}
      → 在庫（${esc(locPath(it.location_id))}）`,
    run: async () => {
      await itemOp(id, back ? '返却' : '状態変更', back ? null : '在庫');
      if (after) after();
    }
  });
}

/* ===== 7. 貸出・返却 ===== *//* ===== 7. 貸出・返却 ===== */
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
      const np = db.masters.filter(p => p.kind !== 'individual' && tree.includes(p.location_id)).length;
      return `<div class="r ${l.kind}" style="padding-left:${d * 18}px">
        <span class="ms">${icon[l.kind] || 'shelves'}</span>
        <div style="min-width:0">
          <div class="n" style="font-size:${d === 0 ? 20 : d === 1 ? 17 : 15}px">${esc(l.name)}</div>
          <div class="c">個体 ${ni}件／数量品 ${np}種</div>
        </div>
        <div class="sp">
          <button class="btn sm ghost" onclick="ui.fLoc='${esc(l.id)}';go('list')">在庫</button>
          ${l.kind === 'shelf' ? `<button class="btn sm ghost" onclick="go('loc','${esc(l.id)}')">棚QR</button>` : ''}
        </div></div>`;
    }).join('')}</div>`;
}

function viewLoc() {
  const l = loc(ui.locId);
  if (!l) return `<div class="empty">該当する保管場所が見つかりません（${esc(ui.locId || '')}）</div>`;
  const tree = locTree(l.id);
  const items = db.items.filter(i => tree.includes(i.location_id) && i.status !== '廃棄');
  const prods = db.masters.filter(p => p.kind !== 'individual' && tree.includes(p.location_id));
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

/* ===== 11. 商品登録 =====
   毎週の仕入はCSVでまとめて入れる。1件ずつの登録は、CSVに載らないものを
   足すときの例外。画面もその順で、CSVを主、フォームを従にしている。 */
function setRegKind(k) { ui.regKind = k; ui.made = null; render(); }

function regCsvMain() {
  const last = db.imports[0];
  const done = lastImportDone();
  return `<div class="regmain">
    <div class="rmh">
      <span class="ms">upload_file</span>
      <div style="flex:1;min-width:220px">
        <h2>仕入CSVでまとめて登録</h2>
        <p>毎週の仕入CSVをアップロードすると、商品・個体・仕入価格をまとめて登録できます</p>
      </div>
      <button class="btn lime rmbtn" onclick="openImport()" ${canAdmin() ? '' : 'disabled'}>
        <span class="ms">upload_file</span>仕入CSVを取り込む</button>
    </div>
    ${done ? `<div class="rmdone">
      <span class="ms">check_circle</span>
      <div style="flex:1;min-width:0">
        <div class="t">今回登録した商品 ${done.prods}件</div>
        <div class="meta">個体 ${done.items}台　${esc(done.file)}</div>
      </div>
      ${batchQrBtn(batchOf(done.id))}
      <button class="btn sm ghost" onclick="showBatch(${done.id},true)">一覧で見る</button>
    </div>` : ''}
    ${last ? `<div class="rmlast">最終取込 ${esc(fmtDT(last.imported_at))}　${esc(last.file_name || '')}
      商品 ${last.product_count}／個体 ${last.item_count}　${esc(last.actor || '')}</div>` : ''}
  </div>`;
}
/* 取り込んだ直後だけ「今回登録した商品 ○件」を出す。
   商品登録に戻ってきたときにも見えるよう、直近の取込IDを覚えておく */
function lastImportDone() {
  const b = batchOf(ui.doneBatch);
  if (!b) return null;
  return { id: b.id, prods: (b.product_codes || []).length, items: b.item_count, file: b.file_name || '' };
}

function viewReg() {
  if (ui.made) {
    const m = ui.made;
    return `<h1>商品登録</h1>
      <div class="card" style="margin-top:20px;max-width:480px;display:flex;align-items:center;gap:18px">
        <img src="${qr(m.url)}" width="120" height="120" style="image-rendering:pixelated;background:#fff;padding:5px" alt="QR">
        <div style="min-width:0">
          <div style="font-weight:500">${esc(m.name)}</div>
          <div class="num" style="font-size:19px">${esc(m.id)}</div>
          <div class="meta">${esc(m.sub || '')}</div>
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
            <button class="btn sm pri" onclick="ui.labelSel={'${m.kind}_${esc(m.id)}':true};go('labels')">ラベル印刷へ →</button>
            <button class="btn sm ghost" onclick="go('prod','${esc(m.code)}')">商品を見る</button>
          </div>
        </div>
      </div>
      <button class="btn" style="margin-top:15px" onclick="ui.made=null;render()">続けて登録する</button>`;
  }
  const ind = ui.regKind === 'ind';
  const cats = db.cats.filter(c => c.kind === (ind ? 'individual' : 'quantity'));
  const f = (id, label, type, extra) =>
    `<label class="field"><span>${esc(label)}</span><input class="input" id="r-${id}" ${type ? `type="${type}"` : ''} ${extra || ''}></label>`;
  const ta = (id, label) =>
    `<label class="field" style="grid-column:1/-1"><span>${esc(label)}</span><textarea class="input" id="r-${id}" rows="2"></textarea></label>`;

  return `<h1>商品登録</h1>
    ${canAdmin() ? '' : '<div class="card" style="margin:15px 0">商品の登録は管理者だけができます。</div>'}

    ${regCsvMain()}

    <div class="sec regsub">1件ずつ商品登録</div>
    <p class="meta" style="margin:-8px 0 0">CSVに載らないものを手で足すときに使います。</p>

    <div class="seg" style="margin:15px 0">
      <button class="${ind ? 'on' : ''}" onclick="setRegKind('ind')">個体管理</button>
      <button class="${!ind ? 'on' : ''}" onclick="setRegKind('qty')">数量管理</button>
    </div>
    <p class="meta" style="margin-bottom:12px">${ind
      ? '1台＝1レコードで登録します。同じ型番がすでにあれば、その商品にぶら下がる個体として足します。'
      : '数が増減する消耗品などです。1品目＝1レコードで、在庫数を持ちます。'}</p>
    <div class="fields">
      ${f('name', '商品名 *')}
      <label class="field"><span>カテゴリ *</span><select class="input" id="r-cat" onchange="previewId()">
        ${cats.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label>
      <label class="field"><span>保管場所 *</span><select class="input" id="r-loc">${locOptions('', '選択してください')}</select></label>
      ${f('maker', 'メーカー')}
      ${f('model', '型番')}
      ${ta('spec', 'スペック')}
      ${ind ? f('serial', 'シリアル番号') + f('buy', '購入日', 'date') + f('price', '購入価格', 'number')
            : f('qty', '初期在庫数 *', 'number') + f('min', '最低在庫数 *', 'number') + f('unit', '購入単価', 'number')}
      ${ta('note', '備考')}
    </div>
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:18px">
      <button class="btn pri" onclick="doRegister()" ${canAdmin() ? '' : 'disabled'}>
        <span class="ms">add</span>登録してQR発行</button>
      <span class="meta">発行予定の${ind ? '管理番号' : '商品コード'}: <b id="idPreview" class="num">—</b></span>
    </div>`;
}

/* 採番カウンタは読むだけで予告する。実際の採番は登録のときに1回だけ */
async function previewId() {
  const el = $('idPreview'); if (!el) return;
  const pre = ui.regKind === 'ind' ? ((cat(($('r-cat') || {}).value) || {}).code_prefix || 'IT') : 'SKU';
  const { data } = await sb.from('inventory_counters').select('next_no').eq('prefix', pre).maybeSingle();
  const n = (data && data.next_no) || 1;
  el.textContent = pre + '-' + String(n).padStart(ui.regKind === 'ind' ? 5 : 4, '0');
}

/* 同じ型番の商品マスタを探す。無ければ作る */
/* 商品は「探して、無ければ作る」を関数の中で1回でやる。
   手元のキャッシュだけで判断すると、別の人が足した商品に気づかず
   主キーがぶつかる。商品IDの採番もDB側に任せる。 */
async function findOrCreateMaster(fields, kind) {
  const { data, error } = await sb.rpc('inv_upsert_product',
    { p_row: Object.assign({ kind }, fields) });
  if (error) throw new Error('商品を登録できませんでした：' + error.message);
  const hit = prod(data.code);
  if (hit) return hit;
  const rec = Object.assign({ code: data.code, kind }, fields, { category_id: data.category_id });
  db.masters.push(rec);
  return rec;
}

async function doRegister() {
  const g = id => (($('r-' + id) || {}).value || '').trim();
  const name = g('name'), catId = g('cat'), locId = g('loc');
  if (!name || !catId || !locId) { toast('商品名・カテゴリ・保管場所は必ず入れてください'); return; }
  const ind = ui.regKind === 'ind';
  if (!ind && (g('qty') === '' || g('min') === '')) { toast('初期在庫数と最低在庫数を入れてください'); return; }

  try {
    if (ind) {
      const m = await findOrCreateMaster({
        name, category_id: catId, maker: g('maker') || null, model: g('model') || null,
        spec: g('spec') || null, note: g('note') || null, location_id: locId, qty: 0, min_qty: 0
      }, 'individual');

      const pre = (cat(catId) || {}).code_prefix || 'IT';
      const { data: newId, error } = await sb.rpc('inv_next_id', { p_prefix: pre, p_digits: 5 });
      if (error) { toast('採番できませんでした：' + error.message); return; }

      const rec = {
        id: newId, product_code: m.code, name, category_id: catId, location_id: locId, status: '在庫',
        maker: g('maker') || null, model: g('model') || null, serial: g('serial') || null,
        purchased_on: g('buy') || null, price: g('price') === '' ? null : Number(g('price')),
        note: g('note') || null
      };
      const { error: e2 } = await sb.from('inventory_items').insert(rec);
      if (e2) { toast('登録できませんでした：' + e2.message); return; }
      db.items.push(rec);
      await logRegister('item', newId, name, '在庫（' + locPath(locId) + '）');
      ui.made = { kind: 'item', id: newId, code: m.code, name, url: itemUrl(newId), sub: '商品 ' + m.code };
      toast(newId + ' を登録しました');
    } else {
      const m = await findOrCreateMaster({
        name, category_id: catId, maker: g('maker') || null, model: g('model') || null,
        spec: g('spec') || null, note: g('note') || null, location_id: locId,
        qty: Number(g('qty') || 0), min_qty: Number(g('min') || 0),
        unit_price: g('unit') === '' ? null : Number(g('unit'))
      }, 'quantity');
      await logRegister('product', m.code, name, m.qty + '（' + locPath(locId) + '）');
      ui.made = { kind: 'prod', id: m.code, code: m.code, name, url: prodUrl(m.code), sub: '数量管理' };
      toast(m.code + ' を登録しました');
    }
  } catch (e) { toast(e.message || String(e)); return; }

  await refreshTx();
  render();
}

/* 登録だけは関数を通らないので、履歴をここで足す（追記のみの表なので入れられる） */
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
    db.masters.forEach(p => ui.labelSel[labelKey('prod', p.code)] = true);
    db.locs.filter(l => l.kind === 'shelf').forEach(l => ui.labelSel[labelKey('loc', l.id)] = true);
  }
  render();
}
function selectedLabels() {
  const out = [];
  db.items.filter(i => ui.labelSel[labelKey('item', i.id)]).forEach(i =>
    out.push({ id: i.id, name: i.name, loc: locPath(i.location_id), url: itemUrl(i.id) }));
  db.masters.filter(p => ui.labelSel[labelKey('prod', p.code)]).forEach(p =>
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
      <div class="picks">${db.masters.map(p => pick('prod', p.code, titleOf(p), placeOf(p))).join('') || '<div class="meta">ありません</div>'}</div>
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
function closeSheet() {
  $('sheet').classList.remove('on');
  sheetState = null;
  reopenScan();          // 入庫・出庫のQR読み取り中なら、やめても読み取りに戻る
}
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
      ${['在庫', '出品中', '修理中', '故障', '紛失', '不明'].map(s => `<option${s === it.status ? ' selected' : ''}>${s}</option>`).join('')}
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
function qtySheet(code, action, useDraft, after) {
  const p = prod(code); if (!p) return;
  const pre = useDraft ? (ui.drafts[code] || '') : '1';
  openSheet({
    title: action, subject: code, cta: action + 'を記録',
    hint: `${esc(titleOf(p))}　いまの在庫 ${p.qty}`,
    body: `<label class="field"><span>数量</span>
      <input class="input num" type="number" min="1" id="sheetVal" value="${esc(pre)}" placeholder="0"></label>`,
    run: async (v) => {
      const n = parseInt(v, 10);
      if (!n || n < 1) { toast('数量を入れてください'); return; }
      await productMove(code, action === '入庫' ? n : -n);
      if (after) after();
    }
  });
}
/* 在庫数を直接入れる（個体管理）。
   個体管理は数そのものを持たず、各個体の状態から数えている。
   なので「18台」と入れられたら、個体をその数にそろえる。
       減らす → 在庫・出品中のものから、選んだ状態（既定は不明）にする
       増やす → 管理番号を採番して足す
   何が起きるかは確定前に全部見せる。数だけ静かに変わる、という形にはしない。 */
function sheetStockSet(code) {
  const p = prod(code); if (!p) return;
  if (p.kind !== 'individual') { sheetCount(code); return; }
  const now = stockOf(p).inStock;
  openSheet({
    title: '在庫数を直す', subject: code, cta: 'この数にする',
    hint: `${esc(titleOf(p))}　いまの現在庫 <strong>${now}台</strong>。
      個体管理は各個体の状態から数えているので、入れた数に<strong>個体をそろえます</strong>。`,
    body: `<label class="field" style="margin-bottom:10px"><span>実際の在庫数</span>
        <div style="display:flex;gap:8px;align-items:center">
          <button type="button" class="btn" style="min-width:52px" onclick="bumpStock('${esc(code)}',-1)">−</button>
          <input class="input num" type="number" min="0" max="999" id="sheetVal" value="${now}"
                 oninput="paintStockSet('${esc(code)}')" style="text-align:center">
          <button type="button" class="btn" style="min-width:52px" onclick="bumpStock('${esc(code)}',1)">＋</button>
        </div></label>
      <label class="field" id="ssWhyBox" hidden><span>減らすぶんの状態</span>
        <select class="input" id="ssWhy" onchange="paintStockSet('${esc(code)}')">
          <option value="不明">不明（棚卸で見つからない）</option>
          <option value="紛失">紛失</option>
          <option value="社内使用">社内使用にする</option>
          <option value="廃棄">廃棄</option>
        </select></label>
      <div class="prow"><span>差</span><b class="num" id="ssDiff">±0</b></div>
      <div class="pre" id="ssPlan" style="margin-top:10px">変わりません。</div>`,
    run: async (v) => {
      const want = parseInt(String(v || '').trim(), 10);
      if (isNaN(want) || want < 0) { toast('実際の在庫数を入れてください'); return; }
      const avail = itemsOf(code).filter(i => IN_STOCK.includes(i.status));
      const diff = want - avail.length;
      if (!diff) { toast('変わりませんでした'); return; }

      if (diff < 0) {
        const why = (($('ssWhy') || {}).value) || '不明';
        let ok = 0;
        for (const it of avail.slice(0, -diff)) {
          const { data, error } = await sb.rpc('inv_item_op',
            { p_item_id: it.id, p_action: why === '廃棄' ? '廃棄' : (why === '社内使用' ? '社内使用' : '状態変更'),
              p_value: why === '廃棄' || why === '社内使用' ? null : why, p_note: '在庫数を直す' });
          if (error) { toast(error.message || '記録できませんでした'); break; }
          const k = db.items.findIndex(x => x.id === it.id);
          if (k >= 0 && data) db.items[k] = data;
          ok++;
        }
        await refreshTx(); render();
        toast(`${ok}台を${why}にしました（現在庫 ${stockOf(prod(code)).inStock}）`);
        return;
      }

      if (!canAdmin()) { toast('個体を増やせるのは管理者だけです'); return; }
      const made = [];
      for (let k = 0; k < diff; k++) {
        const pre = idPrefixOf(p.model) || (cat(p.category_id) || {}).code_prefix || 'IT';
        const { data: id, error } = await sb.rpc('inv_next_id', { p_prefix: pre, p_digits: 5 });
        if (error) { toast('管理番号を採番できませんでした：' + error.message); break; }
        const row = { id, product_code: code, name: p.name, category_id: p.category_id,
                      maker: p.maker, model: p.model, location_id: p.location_id, status: '在庫' };
        const { error: e2 } = await sb.from('inventory_items').insert(row);
        if (e2) { toast('足せませんでした：' + e2.message); break; }
        db.items.push(row);
        made.push(id);
        await sb.from('inventory_transactions').insert({
          actor: me.name, ref_kind: 'item', ref_id: id, label: p.name, action: '登録',
          before_value: '—', after_value: `在庫（${locPath(p.location_id)}）／在庫数を直す` });
      }
      await refreshTx(); render();
      toast(made.length ? `${made.length}台を足しました（${made.join('、')}）` : '足せませんでした');
    }
  });
  paintStockSet(code);
}
function bumpStock(code, d) {
  const el = $('sheetVal'); if (!el) return;
  el.value = Math.max(0, (parseInt(el.value, 10) || 0) + d);
  paintStockSet(code);
}
function paintStockSet(code) {
  const p = prod(code); if (!p) return;
  const avail = itemsOf(code).filter(i => IN_STOCK.includes(i.status));
  const want = parseInt((($('sheetVal') || {}).value || '').trim(), 10);
  const diff = isNaN(want) ? 0 : want - avail.length;
  const why = (($('ssWhy') || {}).value) || '不明';
  const d = $('ssDiff');
  if (d) { d.textContent = diff > 0 ? `＋${diff}台` : diff < 0 ? `−${-diff}台` : '±0'; d.classList.toggle('minus', diff < 0); }
  const box = $('ssWhyBox'); if (box) box.hidden = diff >= 0;
  const el = $('ssPlan'); if (!el) return;
  if (isNaN(want)) { el.textContent = '実際の在庫数を入れてください。'; return; }
  if (!diff) { el.textContent = '変わりません。'; return; }
  if (diff < 0) {
    const picked = avail.slice(0, -diff).map(i => i.id);
    el.textContent = `次の ${picked.length}台を「${why}」にします。\n${picked.join('、')}`;
  } else {
    const pre = idPrefixOf(p.model) || (cat(p.category_id) || {}).code_prefix || 'IT';
    el.textContent = canAdmin()
      ? `管理番号を ${diff}個 発行して足します（${pre}-… の続き番号）。\n置き場所は ${locPath(p.location_id) || '未設定'} です。`
      : '個体を増やせるのは管理者だけです。';
  }
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
async function itemOp(id, action, value, note) {
  const { data, error } = await sb.rpc('inv_item_op', { p_item_id: id, p_action: action, p_value: value || null, p_note: note || null });
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
let scan = { on: false, mode: 'lookup', stream: null, raf: null, last: {}, canvas: null, done: 0 };

const SCAN_TITLE = { stocktake: '棚卸：連続読取', in: '入庫：QRを読む', out: '出庫：QRを読む' };

function openScan(mode) {
  scan.mode = mode || 'lookup';
  scan.on = true;
  scan.last = {};
  scan.done = 0;
  $('scan').classList.add('on');
  $('scanTitle').textContent = SCAN_TITLE[scan.mode] || 'QRコードを読み取る';
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
/* 確認シートを出しているあいだはカメラを止める。読み取り続けて二重に記録しないため */
function pauseScan() { stopCam(); $('scan').classList.remove('on'); }
function reopenScan() {
  if (!scan.on) return;
  $('scan').classList.add('on');
  renderScanSim();
  setTimeout(startCam, 120);
}
function updateScanCount() {
  const el = $('scanCount');
  if (scan.mode === 'stocktake' && db.stocktake) {
    const done = db.stChecked.filter(x => x.checked_at).length;
    el.textContent = `確認済み ${done} / ${db.stChecked.length}`;
    el.style.display = '';
  } else if (scan.mode === 'in' || scan.mode === 'out') {
    el.textContent = `${scan.mode === 'in' ? '入庫' : '出庫'} ${scan.done}件`;
    el.style.display = '';
  } else el.style.display = 'none';
}
function renderScanSim() {
  const pick = (arr, n) => arr.slice(0, n);
  const parts = []
    .concat(pick(db.items, 6).map(i => ({ t: i.id, u: itemUrl(i.id) })))
    .concat(pick(db.masters, 3).map(p => ({ t: p.code, u: prodUrl(p.code) })))
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
  const pr = db.masters.find(p => p.code === key);
  const lc = db.locs.find(l => l.id === key || l.name === key);

  // 棚卸の連続読取中は画面を移らず、確認済みに足していく
  if (scan.mode === 'stocktake') {
    if (!it) { toast('棚卸の対象に見つかりません：' + key); return; }
    checkItem(it.id).then(updateScanCount);
    return;
  }

  // 入庫・出庫モードも画面を移らない。1件ごとに確認シートを出し、
  // 確定したらスキャナに戻るので、そのまま次のQRを読める
  if (scan.mode === 'in' || scan.mode === 'out') {
    const isIn = scan.mode === 'in';
    const done = () => { scan.done++; scan.last = {}; updateScanCount(); reopenScan(); };
    if (pr) {
      if (pr.kind === 'individual') { toast('この商品は個体管理です。個体のQRを読んでください'); return; }
      pauseScan();
      qtySheet(pr.code, isIn ? '入庫' : '出庫', false, done);
      return;
    }
    if (it) {
      if (GONE.includes(it.status)) { toast(`${it.id} は${it.status}です`); return; }
      if (isIn && it.status === '在庫') { toast(`${it.id} はすでに在庫です`); return; }
      pauseScan();
      (isIn ? sheetUnitIn : sheetUnitOut)(it.id, done);
      return;
    }
    toast('該当する商品が見つかりません：' + key);
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

/* Escapeで、開いているものを手前から順に閉じる */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('modal').classList.contains('on')) { closeModal(); return; }
  if ($('sheet').classList.contains('on')) { closeSheet(); return; }
  if (scan.on) closeScan();
});
