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
   売却済・廃棄は持っていないので「登録数」からも外す。
   「予約中」は8RENTの申込が入って発送待ちの状態（レンタル可能数からは外れる）。
   「販売予約」は楽天など販売チャネルで受注が入って発送待ちの状態
   （レンタル可能数からも、他チャネルの販売可能数からも外れる） */
const STATUSES = ['在庫', '出品中', '予約中', '販売予約', '社内使用', '貸出中', '修理中', '故障', '紛失', '売却済', '廃棄', '不明'];
const IN_STOCK = ['在庫', '出品中'];
const GONE = ['売却済', '廃棄'];
const STATUS_ICON = {
  '在庫': 'inventory_2', '出品中': 'sell', '予約中': 'event_available', '販売予約': 'local_mall',
  '社内使用': 'person', '貸出中': 'assignment_ind',
  '修理中': 'build', '故障': 'error', '紛失': 'help', '売却済': 'paid', '廃棄': 'delete', '不明': 'help'
};
/* 販売サイト。一覧のタブもバッジも、この並び順のまま出る。
   tab が付いているものだけ、在庫一覧の上にタブとして並べる */
const CHANNELS = [
  { key: 'rakuten', label: '楽天', short: '楽', tab: true },
  { key: 'amazon', label: 'Amazon', short: 'Am', tab: true },
  { key: 'mercari', label: 'メルカリ', short: 'メ', tab: true },
  { key: 'yahuoku', label: 'ヤフオク', short: 'ヤ', tab: true },
  { key: 'yahoo_free', label: 'ヤフーフリマ', short: 'フ', tab: true },
  { key: 'other', label: 'その他', short: '他' },
  { key: 'notion', label: 'Notion', short: 'No' }
];
const TAB_CHANNELS = CHANNELS.filter(c => c.tab);

/* 価格調査。各モールの検索結果を新しいタブで開くだけのショートカットで、
   価格を取りに行ったり、DBへ保存したりはしない（相場は人が見て判断する）。
   検索語は メーカー＋型番、メーカーが無ければ型番だけ。商品名では検索しない
   （別製品が混ざるため）。URLへ入れるときは必ずエンコードする。 */
const MARKETS = [
  { key: 'rakuten', mark: '楽', label: '楽天市場で型番検索',
    url: (q) => 'https://search.rakuten.co.jp/search/mall/' + encodeURIComponent(q) + '/' },
  { key: 'amazon',  mark: 'A',  label: 'Amazonで型番検索',
    url: (q) => 'https://www.amazon.co.jp/s?k=' + encodeURIComponent(q) },
  { key: 'mercari', mark: 'メ', label: 'メルカリで型番検索',
    url: (q) => 'https://jp.mercari.com/search?keyword=' + encodeURIComponent(q) }
];
/* 検索語。前後の空白を落とし、メーカーと型番のあいだは半角スペース1個にそろえる。
   個体のシリアル・管理番号・仕入価格・備考は入れない（社内の情報を外へ出さない） */
function marketQuery(maker, model) {
  const clean = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
  const m = clean(model);
  if (!m) return '';
  const mk = clean(maker);
  return mk ? mk + ' ' + m : m;
}
/* 3モールのボタン。型番が無い商品は押せないようにして、理由をツールチップに出す。
   行クリック（商品詳細を開く）と二重に反応しないよう、伝播を止める。 */
function marketBtns(maker, model, compact) {
  const q = marketQuery(maker, model);
  const btns = MARKETS.map(k => q
    ? `<a class="mchk" href="${esc(k.url(q))}" target="_blank" rel="noopener noreferrer"
         onclick="event.stopPropagation()" title="${esc(k.label + '：' + q)}"
         aria-label="${esc(k.label + '：' + q)}">${esc(k.mark)}</a>`
    : `<span class="mchk off" aria-disabled="true" role="img"
         title="型番を登録すると検索できます"
         aria-label="${esc(k.label)}（型番を登録すると検索できます）">${esc(k.mark)}</span>`).join('');
  return compact
    ? `<div class="mchks sp" onclick="event.stopPropagation()"><span class="lbl">価格調査</span>${btns}</div>`
    : `<div class="mchks" onclick="event.stopPropagation()">${btns}</div>`;
}
/* 8RENTの「おすすめ商品」で使う印 */
const RENTAL_TAGS = [
  { key: 'recommend', label: 'おすすめ' },
  { key: 'popular', label: '人気' },
  { key: 'new', label: '新着' }
];
const RENTAL_TAG_LABEL = Object.fromEntries(RENTAL_TAGS.map(t => [t.key, t.label]));
const isChanKey = (k) => CHANNELS.some(c => c.key === k);
const chanLabel = (k) => (CHANNELS.find(c => c.key === k) || { label: k }).label;
/* 出品状態。「未出品」は状態ではなく、行が無いこと自体で表す */
const LISTED = '出品中';
const LIST_STATES = ['出品中', '出品停止', '売り切れ', '販売済み', '保留'];
/* 昔のデータで使っていた言い方も読めるようにする（書くのは LIST_STATES だけ） */
const LIST_STATES_IN = LIST_STATES.concat(['出品中止']);
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
  ['labels', 'qr_code_2', 'QRラベル', '/labels'],
  ['rental', 'car_rental', '8RENT申込', '/rental-requests'],
  // マスター管理はメニューにも管理者だけ出す（画面側でも権限を見る）
  ['master', 'tune', 'マスター管理', '/masters', 'admin']
];

let sb = null;
let me = { email: '', name: '', role: 'viewer' };
const db = {
  cats: [], locs: [], masters: [], items: [], channels: [],
  tx: [], stocktake: null, stChecked: [], stPast: [], members: [], imports: [], rentalReqs: [],
  chanSettings: [],         // 販売サイトごとの管理画面URL（inventory_channel_settings）
  stats: null               // 今月の経営数値（inv_dashboard_stats）
};
const ui = {
  screen: 'dash', itemId: null, prodId: null, locId: null,
  q: '', fCat: '', fMaker: '', fLoc: '', fStock: '',
  fAction: '', hq: '', regKind: 'ind', made: null, tab: 'info',
  drafts: {}, labelSel: {}, stScope: '', loaded: false, sel: {}, selItems: {}, fBatch: null, doneBatch: null,
  // 一覧のタブ。individual / model のほかに、販売サイトのキーと 'none'（未出品）を取る
  listMode: 'unit', fSt: '', fDiff: false, fNoPrice: false, fRental: '', fRentEl: '',
  mTab: 'loc'                // マスター管理のタブ（保管場所／カテゴリー）
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

/* ---- カテゴリーのマスター（inventory_categories が正） ----
   公開側（inv_public_categories）も同じ表を見る。/zaiko だけ別の名前、
   ということにならないよう、表示名は常に name を出す。 */
const catLive = (c) => !c || c.enabled !== false;
/* 親→子の順。同じ親の中は表示順→名前 */
function catsOrdered(kind) {
  const out = [];
  const seen = new Set();              // 同じものを二度たどらない（輪になっていても止まる）
  const walk = (parent) => {
    db.cats.filter(c => (c.parent_id || null) === parent && (!kind || c.kind === kind) && !seen.has(c.id))
      .sort((a, b) => ((a.sort_no || 0) - (b.sort_no || 0)) || String(a.name).localeCompare(String(b.name), 'ja'))
      .forEach(c => { seen.add(c.id); out.push(c); walk(c.id); });
  };
  walk(null);
  // 親が別の管理方式で落ちた子も拾う（迷子にしない）
  db.cats.filter(c => (!kind || c.kind === kind) && !out.includes(c)).forEach(c => out.push(c));
  return out;
}
const catDepth = (id) => {
  let d = 0, c = cat(id);
  const seen = new Set([id]);
  while (c && c.parent_id && d < 8 && !seen.has(c.parent_id)) { seen.add(c.parent_id); d++; c = cat(c.parent_id); }
  return d;
};
/* 選択肢に出す名前。子は親の下にぶら下げて見せる */
const catOptLabel = (c) => '\u3000'.repeat(catDepth(c.id)) + c.name + (catLive(c) ? '' : '（無効）');
/* 新規登録で選べるカテゴリー。無効は出さない（いま選ばれているものは残す） */
const catsFor = (kind, keep) => catsOrdered(kind).filter(c => catLive(c) || c.id === keep);
/* このカテゴリーに子があるか。ある場合は、新規登録で子まで選んでもらう */
const catHasKids = (id) => db.cats.some(c => c.parent_id === id && catLive(c));
/* 自分と自分の子孫（在庫一覧の「パソコン（すべて）」で使う） */
function catTree(id) {
  const out = [id];
  let added = true;
  while (added) {
    added = false;
    db.cats.forEach(c => { if (c.parent_id && out.includes(c.parent_id) && !out.includes(c.id)) { out.push(c.id); added = true; } });
  }
  return out;
}

/* 商品マスタまわり。商品名が空の型番が多いので、名前は型番で代用する */
const titleOf = (p) => (p && (p.name || p.model)) || '';
const itemsOf = (code) => db.items.filter(i => i.product_code === code);

/* ---- 出品情報 ----
   出品は実物1台ごとに持つ（item_id あり）。
   item_id が無い行は「商品まるごとの出品情報」で、移行前のデータと数量管理がこれにあたる。
   1台ずつの出品情報が無いときは、商品まるごとの行をその台にも当てる。
   台数が多いので、読み込みのたびに索引を作っておく（一覧は600行×サイト数を引く） */
function reindexChannels() {
  db.chByItem = {}; db.chByProd = {};
  db.channels.forEach(c => {
    const to = c.item_id ? (db.chByItem[c.item_id] = db.chByItem[c.item_id] || [])
                         : (db.chByProd[c.product_code] = db.chByProd[c.product_code] || []);
    to.push(c);
  });
}
const listingsOf = (itemId) => (db.chByItem || {})[itemId] || [];
const channelsOf = (code) => (db.chByProd || {})[code] || [];

/* その1台の、あるサイトでの出品情報。1台ぶんが無ければ商品まるごとの行を使う */
function listingOf(it, key) {
  if (!it) return null;
  const mine = listingsOf(it.id).find(x => x.channel === key);
  if (mine) return mine;
  const up = channelsOf(it.product_code).find(x => x.channel === key);
  return up ? Object.assign({}, up, { fromProduct: true }) : null;
}
/* いま出品しているサイトのキー。一覧のバッジとタブはこれだけを見る */
function liveOn(it) {
  if (!it) return [];
  return CHANNELS.filter(c => {
    const x = listingOf(it, c.key);
    return x && x.state === LISTED;
  }).map(c => c.key);
}
/* 数量管理の品目は個体を持たないので、商品まるごとの行で見る */
function liveOnProd(code) {
  return CHANNELS.filter(c => channelsOf(code).some(x => x.channel === c.key && x.state === LISTED))
                 .map(c => c.key);
}

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
  const seen = new Set();
  let cur = loc(id), guard = 0;
  while (cur && guard++ < 8 && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur.name);
    cur = cur.parent_id ? loc(cur.parent_id) : null;
  }
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
  const seen = new Set([id]);
  while (cur && cur.parent_id && d < 8 && !seen.has(cur.parent_id)) { seen.add(cur.parent_id); d++; cur = loc(cur.parent_id); }
  return d;
}
/* 使える保管場所かどうか。無効にした場所は新規登録・移動の候補に出さない。
   すでに置いてあるものの表示には出す（名前が消えると履歴が読めなくなるため） */
const locLive = (l) => !l || l.enabled !== false;
/* 選択肢に出す名前。同じ「倉庫」が拠点ごとにあるので、フルパスで区別する */
const locLabel = (id) => {
  const l = loc(id);
  if (!l) return id || '';
  return locPath(id) + (locLive(l) ? '' : '（無効）');
};

/* 親→子の順に並べた保管場所（ツリー表示と選択肢の順序に使う） */
function locsOrdered() {
  const out = [];
  const seen = new Set();              // 同じものを二度たどらない（輪になっていても止まる）
  const walk = (parent) => {
    db.locs.filter(l => (l.parent_id || null) === parent && !seen.has(l.id))
      .sort((a, b) => (a.sort_no - b.sort_no) || a.name.localeCompare(b.name, 'ja'))
      .forEach(l => { seen.add(l.id); out.push(l); walk(l.id); });
  };
  walk(null);
  // 親が見つからない場所も拾う（マスターの途中でおかしくなっても見えなくならないように）
  db.locs.filter(l => !seen.has(l.id)).forEach(l => out.push(l));
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

/* S/N（シリアル番号）も同じ要領でそろえる。突き合わせにだけ使い、
   個体に保存する値そのものは書き換えない（元の表記のまま残す）。 */
function normSn(s) {
  return String(s == null ? '' : s)
    .normalize('NFKC')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/\s+/g, '')
    .toUpperCase();
}
/* 「未記入の代わり」に入っているだけの値は、同じ実物を指す証拠にしない。
   これで一致させると、無関係な2台が「同じS/N」として片方だけ登録される事故になる。 */
const SN_DUMMY = new Set([
  '不明', 'フメイ', 'N/A', 'NA', 'NONE', '-', 'ナシ', 'なし', '無', '無し',
  '未確認', '未定', '未記入', 'UNKNOWN', 'NULL', 'ナシ・不明'
]);
function isDummySn(normed) {
  if (!normed) return true;                       // 空欄
  if (SN_DUMMY.has(normed)) return true;
  if (normed.length > 1 && /^(.)\1+$/.test(normed)) return true;   // "0000000000" "----------" など
  return false;
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
    sb.from('inventory_imports').select('*').order('imported_at', { ascending: false }).limit(100),
    sb.from('inventory_rental_requests').select('*').order('created_at', { ascending: false }).limit(500),
    sb.from('inventory_channel_listings').select('*').limit(LOAD_LIMIT),
    sb.from('inventory_channel_settings').select('*'),
    sb.rpc('inv_dashboard_stats')
  ];
  const [c, l, i, p, t, s, ch, im, rr, cl, cs, ds] = await Promise.all(q);
  const bad = [c, l, i, p, t, s, ch, im].find(r => r.error);
  if (bad) { showSetup(bad.error); return false; }
  db.imports = im.data || [];
  db.rentalReqs = rr.error ? [] : (rr.data || []);   // 未実行(setup.sql未更新)でも他が動くよう静かに空にする
  db.chanSettings = cs.error ? [] : (cs.data || []);
  // 経営数値。migration未適用でも他の画面が動くよう、取れなければnullにする
  db.stats = ds.error ? null : (ds.data || null);

  db.cats = c.data || [];
  db.locs = l.data || [];
  db.items = (i.data || []).sort((a, b) => a.id.localeCompare(b.id, 'ja'));
  db.masters = (p.data || []).sort((a, b) => titleOf(a).localeCompare(titleOf(b), 'ja'));
  // 商品まるごとの出品情報（inventory_channel_listings）を、既存の個体別
  // 出品情報（inventory_channels）と同じ配列にまとめる。移行前（未実行）でも
  // 静かに空扱いにし、他の画面が動かなくならないようにする
  db.channels = (ch.data || []).concat(cl.error ? [] : (cl.data || []));
  reindexChannels();
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
  const byPath = { list: 'list', in: 'in', out: 'out', loan: 'loan', stock: 'stock', locations: 'locs',
                   masters: 'master', history: 'hist', register: 'reg', labels: 'labels', 'rental-requests': 'rental' };
  const screen = byPath[seg[0]] || 'dash';
  return screen === 'list' ? { screen, listMode: modeFromQuery() } : { screen };
}

/* 在庫一覧のタブはURLに持たせる。読み込み直しても同じタブが開くようにする。
     ?view=individual / ?view=model / ?channel=rakuten … / ?channel=none（未出品） */
function modeFromQuery() {
  const q = new URLSearchParams(location.search || '');
  const ch = q.get('channel'), v = q.get('view');
  if (ch === 'none') return 'none';
  if (ch && isChanKey(ch)) return ch;
  if (v === 'model') return 'model';
  if (v === 'individual' || v === 'unit') return 'unit';
  return null;                       // 指定が無ければ、いま開いているタブのまま
}
function listQuery() {
  if (ui.listMode === 'model') return '?view=model';
  if (ui.listMode === 'none') return '?channel=none';
  if (isChanKey(ui.listMode)) return '?channel=' + ui.listMode;
  return '?view=individual';
}

function pathFor(screen, id) {
  if (screen === 'item') return BASE + '/items/' + encodeURIComponent(id);
  if (screen === 'prod') return BASE + '/products/' + encodeURIComponent(id);
  if (screen === 'master') return BASE + '/masters';
  if (screen === 'loc') return BASE + '/locations/' + encodeURIComponent(id);
  const m = MENU.find(x => x[0] === screen);
  return BASE + (m ? m[3] : '') + (screen === 'list' ? listQuery() : '');
}

function go(screen, id) {
  const path = pathFor(screen, id);
  if (path !== location.pathname + location.search) history.pushState(null, '', path);
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
  if (r.listMode) ui.listMode = r.listMode;
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
    // 個体の画面は商品名などをマスタから出すので、その1件も取る。
    // 出品情報は1台ぶんと商品まるごとの両方（1台ぶんが無ければ商品の行を当てるため）
    if (res.data.product_code) {
      const [m, chs, cls] = await Promise.all([
        sb.from('inventory_products').select('*').eq('code', res.data.product_code).maybeSingle(),
        sb.from('inventory_channels').select('*').eq('product_code', res.data.product_code),
        sb.from('inventory_channel_listings').select('*').eq('product_code', res.data.product_code)
      ]);
      if (m.data) db.masters = [m.data];
      db.channels = (chs.data || []).concat(cls.error ? [] : (cls.data || []));
    } else {
      const chs = await sb.from('inventory_channels').select('*').eq('item_id', res.data.id);
      db.channels = chs.data || [];
    }
  } else {
    db.masters = [res.data];
    // 商品の画面はぶら下がる個体と販売情報まで見せる
    const [its, chs, cls] = await Promise.all([
      sb.from('inventory_items').select('*').eq('product_code', res.data.code).limit(LOAD_LIMIT),
      sb.from('inventory_channels').select('*').eq('product_code', res.data.code),
      sb.from('inventory_channel_listings').select('*').eq('product_code', res.data.code)
    ]);
    db.items = its.data || [];
    db.channels = (chs.data || []).concat(cls.error ? [] : (cls.data || []));
  }
  reindexChannels();
  return true;
}

/* ---------------------------------------------------------------- メニュー */
function renderMenu() {
  $('menu').innerHTML = MENU.filter(([, , , , need]) => need !== 'admin' || canAdmin()).map(([key, icon, label]) =>
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
    loan: viewLoan, stock: viewStock, locs: viewLocs, loc: viewLoc, master: viewMaster,
    hist: viewHist, reg: viewReg, labels: viewLabels,
    rental: viewRentalRequests
  }[ui.screen] || viewDash;
  v.innerHTML = fn();
  if (ui.screen === 'labels') bindLabelPicks();
}

const guardNote = () => canEdit() ? '' : '<div class="card" style="margin-bottom:15px">閲覧権限では操作できません。</div>';
const dis = () => canEdit() ? '' : 'disabled';

/* ===== 1. ダッシュボード ===== */
/* ---- 今月の経営状況 ----
   売上だけでなく、粗利と在庫原価を同じ画面で見られるようにする。
   数はすべてサーバー側（inv_dashboard_stats）が実データから数えたもので、
   画面では計算し直さない（履歴の読み込み上限に左右されないため）。
   並びは 売上 → 粗利 → 粗利率 → 販売 → 仕入 → 在庫 の順。 */
function plBlock() {
  const st = db.stats;
  const kpi = (label, v, note, cls) =>
    `<div class="kpi ${cls || ''}"><div class="lbl">${esc(label)}</div><div class="v num${
      cls && cls.indexOf('na') >= 0 ? ' na' : ''}">${v}</div><div class="n">${note || ''}</div></div>`;
  if (!st) {
    return `<div class="sec">今月の経営状況</div>
      <div class="card" style="margin-bottom:22px">まだ集計できていません。
        <span class="meta">migration <code>2026-09-19-dashboard-pl.sql</code> を実行すると出ます。</span></div>`;
  }
  const n = (v) => Number(v || 0);
  const gp = n(st.gross_profit);
  const margin = st.gross_margin == null ? null : Number(st.gross_margin);
  const avg = st.avg_profit_per_unit == null ? null : Number(st.avg_profit_per_unit);
  const miss = n(st.profit_missing_cost);
  const noPriceM = n(st.sold_price_missing_month);
  // 粗利を出せた台数。原価か売価が入っていない個体は入らない
  const base = st.profit_count == null ? n(st.sold_count) - miss : n(st.profit_count);
  return `
    <div class="sec">今月の経営状況<span class="secn">${esc(st.month || '')}</span></div>
    <div class="kpis pl">
      ${kpi('今月売上', yen(n(st.sales_total)), noPriceM
          ? `売価未登録 ${noPriceM}台は入っていません`
          : (st.rental_available
              ? `販売 ${yen(n(st.sales_sale))}／レンタル ${yen(n(st.sales_rental))}`
              : '販売のみ（レンタル売上は未集計）'), 'lead')}
      ${kpi('今月粗利', yen(gp), miss ? `原価未登録 ${miss}台は除く` : '実売価格 − 原価',
          'lead' + (gp < 0 ? ' minus' : ''))}
      ${kpi('粗利率', margin == null ? '—' : margin + '%',
          margin == null ? '売れた実績がありません'
            : (base < n(st.sold_count)
                ? `${noPriceM ? '原価・売価が登録済み' : '原価登録済み'} ${base}台を対象`
                : '粗利 ÷ 売上'),
          margin == null ? 'na' : '')}
      ${kpi('今月販売台数', n(st.sold_count) + '台', miss ? `うち原価未登録 ${miss}台` : '')}
      ${kpi('今月仕入額', yen(n(st.purchase_amount)), '仕入価格＋諸費用')}
      ${kpi('今月仕入台数', n(st.purchase_count) + '台', '仕入日で集計')}
      ${kpi('現在庫原価', yen(n(st.stock_cost)), `${n(st.stock_count)}台（売却済・廃棄を除く）`)}
      ${kpi('平均粗利／台', avg == null ? '—' : yen(avg),
          avg == null ? '売れた実績がありません'
            : (base < n(st.sold_count) ? `今月粗利 ÷ ${base}台` : '今月粗利 ÷ 販売台数'),
          avg == null ? 'na' : '')}
    </div>
    ${miss ? `<p class="plnote">原価（仕入価格＋諸費用）が入っていない個体が ${miss}台あります。
      売値をそのまま粗利にすると実態と違うので、粗利・粗利率・平均粗利からは外しています
      （売上と販売台数には入っています）。</p>` : ''}
    ${noPriceM ? `<p class="plnote">今月売却した ${noPriceM}台は販売価格が登録されていないため、
      今月売上・粗利に入っていません。「要確認」の<b>売価未登録</b>から直してください。</p>` : ''}

    <div class="sec">在庫の質</div>
    <div class="kpis">
      ${kpi('60日超在庫', n(st.aged_60) + '台', '仕入から60日を超えたもの')}
      ${kpi('90日超在庫', n(st.aged_90) + '台', '仕入から90日を超えたもの', n(st.aged_90) ? 'minus' : '')}
      ${kpi('90日超の原価', yen(n(st.aged_90_cost)), '寝ている資金')}
      ${kpi('平均在庫日数', st.avg_stock_days == null ? '—' : Number(st.avg_stock_days) + '日',
          n(st.stock_no_date) ? `仕入日なし ${n(st.stock_no_date)}台は除く` : '保有在庫の平均',
          st.avg_stock_days == null ? 'na' : '')}
    </div>`;
}

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
  // 棚卸で「まだ確認していない」件数
  const checkedIds = db.stChecked.filter(x => x.checked_at).map(x => x.item_id);
  const stLeft = db.stocktake ? db.stChecked.length - checkedIds.length : 0;
  // 売却済みなのに売価が入っていない個体。0件なら「要確認」に出さない
  const noPrice = Number((db.stats || {}).sold_price_missing || 0);

  const kpi = (label, v, note, cls) =>
    `<div class="kpi ${cls || ''}"><div class="lbl">${esc(label)}</div><div class="v num">${v}</div><div class="n">${note || ''}</div></div>`;

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
    ${plBlock()}

    <div class="sec">在庫の状況</div>
    <div class="kpis">
      ${kpi('総在庫', live.length + qtySum, `個体 ${live.length}／数量 ${qtySum}`)}
      ${kpi('貸出中', loans.length, longs.length ? `${LOAN_LONG_DAYS}日超 ${longs.length}件` : '')}
      ${kpi('使用中', using.length, '')}
      ${kpi('在庫切れ', zero.length, '数量管理')}
      ${kpi('要発注', order.length, '最低在庫以下')}
      ${kpi('故障・修理', broken.length, '')}
    </div>

    <div class="sec">要確認</div>
    <div class="checks">
      ${chk('shopping_cart', '在庫数不足', order.length, '最低在庫を下回っている品目', 'list', "ui.fStock='要発注';")}
      ${chk('schedule', '長期貸出', longs.length, `${LOAN_LONG_DAYS}日を超えて返却されていないもの`, 'loan')}
      ${chk('help', '棚卸未確認', stLeft, db.stocktake ? '実施中の棚卸で、まだ確認できていないもの' : '棚卸は実施していません', 'stock')}
      ${chk('build', '故障・修理中', broken.length, '使えない状態のまま残っているもの', 'list', "ui.q='';")}
      ${noPrice ? `<button class="chk card" onclick="showNoPrice(true)">
        <div class="h"><span class="ms">sell</span><span class="t">売価未登録</span>
          <span class="b on">${noPrice}</span></div>
        <div class="d">売却済みですが販売価格が登録されていません</div></button>` : ''}
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
  ui.fRentEl = ($('f-rent') || {}).value || '';
  renderListBody();
  paintTabCounts();
}
function locOptions(sel, allLabel) {
  // 同じ名前の「倉庫」が拠点ごとにあるので、フルパス（柏 / 倉庫）で出して区別できるようにする。
  // 無効にした場所は候補に出さないが、いま入っているものだけは消さずに残す
  return `<option value="">${esc(allLabel)}</option>` + locsOrdered()
    .filter(l => locLive(l) || sel === l.id)
    .map(l => `<option value="${esc(l.id)}"${sel === l.id ? ' selected' : ''}>${esc(locLabel(l.id))}</option>`).join('');
}

function listFiltered() {
  const q = ui.q.trim().toLowerCase();
  const inScope = ui.fLoc ? locTree(ui.fLoc) : null;
  const batch = batchOf(ui.fBatch);
  const only = batch ? (batch.product_codes || []) : null;
  return db.masters.filter(p => {
    if (only && only.indexOf(p.code) < 0) return false;
    if (!catFilterHit(p.category_id)) return false;
    if (ui.fMaker && (p.maker || '') !== ui.fMaker) return false;
    if (ui.fStock && stockLabel(p) !== ui.fStock) return false;
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

function setListMode(m) { ui.listMode = m; ui.sel = {}; ui.selItems = {}; ui.fDiff = false; go('list'); }

/* いま選んでいるタブが販売サイト（または未出品）なら、そのキーを返す */
const chanTab = () => (isChanKey(ui.listMode) || ui.listMode === 'none') ? ui.listMode : '';

/* タブの件数。いま掛けている絞り込みのなかで数える。
   タブ自身の絞り込みは外して数えるので、切り替えても数は動かない */
function tabCounts() {
  const n = { none: 0, rental: 0 };
  TAB_CHANNELS.forEach(c => { n[c.key] = 0; });
  unitsFiltered(true).forEach(r => {
    // 8RENTは販売チャネルではないので、未出品の判定には混ぜない。
    // 出品先のタブとは別に、同じ行をもう一度数える
    if (r.kind === 'item' && isRentalOn(r.i)) n.rental++;
    const on = r.kind === 'item' ? liveOn(r.i) : liveOnProd(r.m.code);
    if (!on.length) { n.none++; return; }
    on.forEach(k => { if (n[k] != null) n[k]++; });
  });
  return n;
}

function listTabs() {
  const n = tabCounts();
  const b = (key, label, count) => `<button class="${ui.listMode === key ? 'on' : ''}"
      onclick="setListMode('${key}')">${esc(label)}${
      count == null ? '' : `<span class="n" id="tc-${key}">${count}</span>`}</button>`;
  return `<div class="chtabs">
    ${b('unit', '個体別')}${b('model', '型番別')}
    <span class="sep"></span>
    ${TAB_CHANNELS.map(c => b(c.key, c.label, n[c.key])).join('')}
    ${b('rental', '8RENT', n.rental)}
    ${b('none', '未出品', n.none)}
  </div>`;
}
/* 絞り込みを変えたときは本体だけ描き直すので、タブの件数はここで入れ替える */
function paintTabCounts() {
  const n = tabCounts();
  Object.keys(n).forEach(k => { const el = $('tc-' + k); if (el) el.textContent = n[k]; });
}

function viewList() {
  const makers = [...new Set(db.masters.map(p => p.maker).filter(Boolean))].sort();
  const unit = ui.listMode !== 'model';
  const tab = chanTab();
  const lead = ui.listMode === 'rental'
    ? '<strong>8RENT（レンタル）に出している個体</strong>だけを出しています。販売サイトへの出品とは別の区分です。'
    : tab === 'none'
    ? 'どの販売サイトにも出していない在庫です。<strong>ここから出品先を決めていきます。</strong>'
    : tab ? `<strong>${esc(chanLabel(tab))}に出品中</strong>の在庫だけを出しています。ほかのサイトにも出していれば、出品先の欄に並びます。`
    : unit ? '<strong>実物1台＝1行</strong>で並べています。行をクリックすると、その1台の詳細と履歴が見られます。'
           : '<strong>型番でまとめて</strong>数だけ見ています。行をクリックすると、個体の一覧や販売情報まで見られます。';
  return `
    <h1>在庫一覧</h1>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:15px 0 4px">
      <p class="meta" style="flex:1 1 260px">${lead}</p>
      <div class="listtools">
        <button class="btn sm ghost" onclick="exportInventoryCsv()">
          <span class="ms">download</span>CSVダウンロード</button>
        <button class="btn sm lime" onclick="openImport()" ${canAdmin() ? '' : 'disabled'}
          title="${canAdmin() ? 'CSVでまとめて／1件ずつ、どちらもここから' : '追加できる権限がありません'}">
          <span class="ms">upload_file</span>商品取込</button>
        <button class="btn sm ghost" onclick="openImportHist()">
          <span class="ms">history</span>CSV取込履歴</button>
        <button class="btn sm ghost" onclick="openRakutenSync()" ${canAdmin() ? '' : 'disabled'}
          title="${canAdmin() ? '楽天に登録済みの自社商品を取得し、商品マスターの不足情報を補う' : '同期できる権限がありません'}">
          <span class="ms">sync</span>楽天商品を同期</button>
        <button class="btn sm ghost" onclick="openRakutenOrders()" ${canAdmin() ? '' : 'disabled'}
          title="${canAdmin() ? '楽天RMSの注文を取り込み、売れた台数を在庫から引く' : '取り込める権限がありません'}">
          <span class="ms">receipt_long</span>楽天の注文を取り込む</button>
      </div>
    </div>
    ${importHistLine()}
    ${batchBanner()}
    ${diffBar()}
    ${noPriceBar()}
    ${listTabs()}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:4px">
      <input class="input" id="f-q" value="${esc(ui.q)}" oninput="onFilter()"
             placeholder="${unit ? '管理番号・型番・S/N…' : '型番・商品名・管理番号…'}">
      <select class="input" id="f-cat" onchange="onFilter()">
        <option value="">全カテゴリ</option>
        ${catFilterOptions(ui.fCat)}
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
          </select>
          <select class="input" id="f-rent" onchange="onFilter()" title="8RENT（レンタル）に出している個体で絞る">
            <option value="">8RENT すべて</option>
            <option value="on"${ui.fRentEl === 'on' ? ' selected' : ''}>レンタル対象だけ</option>
            <option value="off"${ui.fRentEl === 'off' ? ' selected' : ''}>対象外だけ</option>
          </select>`
        : `<select class="input" id="f-stock" onchange="onFilter()">
            <option value="">全在庫状態</option>
            ${STOCK_LABELS.map(s => `<option${ui.fStock === s ? ' selected' : ''}>${esc(s)}</option>`).join('')}
          </select>`}
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
      ${catsFor().map(c => `<option value="${esc(c.id)}"${catHasKids(c.id) ? ' disabled' : ''}>${
        esc(catOptLabel(c))}（${c.kind === 'individual' ? '個体' : '数量'}）</option>`).join('')}
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
function unitsFiltered(ignoreTab) {
  const q = ui.q.trim().toLowerCase();
  const inScope = ui.fLoc ? locTree(ui.fLoc) : null;
  const batch = batchOf(ui.fBatch);
  const only = batch ? (batch.product_codes || []) : null;
  const tab = ignoreTab ? '' : chanTab();
  const hit = (i, m) => {
    if (only && only.indexOf(i.product_code) < 0) return false;
    if (!catFilterHit(i.category_id)) return false;
    if (ui.fMaker && ((m && m.maker) || i.maker || '') !== ui.fMaker) return false;
    if (ui.fSt && i.status !== ui.fSt) return false;
    if (ui.fRentEl === 'on' && !i.rental_eligible) return false;
    if (ui.fRentEl === 'off' && i.rental_eligible) return false;
    if (inScope && !inScope.includes(i.location_id)) return false;
    if (q) {
      const hay = [i.id, i.serial, i.source_id, (m && m.model) || i.model, (m && m.name) || i.name, i.note]
        .filter(Boolean).join(' ').toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  };
  // 販売サイトのタブ。ほかのサイトにも出していれば、行にはそれも並べる（絞るのはここだけ）
  const onTab = (on) => !tab || (tab === 'none' ? !on.length : on.indexOf(tab) >= 0);
  // 8RENTタブ。販売サイトのタブと同じ見た目で並べるが、判定は出品ではなくレンタル対象
  const rentTab = !ignoreTab && ui.listMode === 'rental';
  const out = db.items.filter(i => {
    if (ui.fDiff && !isMismatch(i)) return false;
    if (ui.fNoPrice && !isNoPrice(i)) return false;
    if (rentTab && !isRentalOn(i)) return false;
    return hit(i, prod(i.product_code)) && onTab(liveOn(i));
  }).map(i => ({ kind: 'item', i, m: prod(i.product_code) }));
  // 数量管理は個体を持たない。見えなくならないよう1品目1行で混ぜる
  db.masters.filter(p => p.kind !== 'individual').forEach(p => {
    const fake = { id: p.code, product_code: p.code, category_id: p.category_id, maker: p.maker,
                   model: p.model, name: p.name, location_id: p.location_id, status: '' };
    if (ui.fSt || ui.fDiff || ui.fNoPrice || ui.fRentEl || rentTab) return;
    if (hit(fake, p) && onTab(liveOnProd(p.code))) out.push({ kind: 'qty', i: fake, m: p });
  });
  return out;
}

/* 在庫差異。手元に無いのに、まだどこかに出品中のまま残っている1台。
   自社在庫DBが正なので、出品のほうを直してもらう */
function isMismatch(i) { return GONE.includes(i.status) && liveOn(i).length > 0; }
const mismatchAll = () => db.items.filter(isMismatch);

/* 売却済みなのに販売価格が入っていない1台。金額として数えられないので、
   今月売上にも粗利にも入らない。null も 0 も同じ「未登録」として扱う */
function isNoPrice(i) { return i.status === '売却済' && !(Number(i.sold_price) > 0); }
const noPriceAll = () => db.items.filter(isNoPrice);

function diffBar() {
  const n = mismatchAll().length;
  if (!n && !ui.fDiff) return '';
  if (ui.fDiff) return `<div class="diffbar on">
    <span class="ms">filter_alt</span>
    <div style="flex:1;min-width:0"><div class="bt">在庫差異 ${n}台</div>
      <div class="meta">売却済・廃棄なのに、販売サイトでは出品中のままです。</div></div>
    <button class="btn sm ghost" onclick="showDiff(false)">すべて表示</button>
  </div>`;
  return `<div class="diffbar">
    <span class="ms">warning_amber</span>
    <div style="flex:1;min-width:0"><div class="bt">在庫差異 ${n}台</div>
      <div class="meta">手元に無いのに、販売サイトでは出品中のままです。出品停止を確認してください。</div></div>
    <button class="btn sm" onclick="showDiff(true)">確認する</button>
  </div>`;
}
function showDiff(on) {
  ui.fDiff = !!on;
  if (on) { ui.listMode = 'unit'; ui.fSt = ''; ui.fNoPrice = false; }
  go('list');
}

/* 「売価未登録」だけを個体別で出す。ここで売却の金額を入れ直してもらう */
function showNoPrice(on) {
  ui.fNoPrice = !!on;
  if (on) { ui.listMode = 'unit'; ui.fSt = ''; ui.fDiff = false; ui.q = ''; }
  go('list');
}

/* 絞り込んでいる間だけ、何を見ているかを上に出す */
function noPriceBar() {
  if (!ui.fNoPrice) return '';
  const n = noPriceAll().length;
  return `<div class="diffbar on">
    <span class="ms">sell</span>
    <div style="flex:1;min-width:0"><div class="bt">売価未登録 ${n}台</div>
      <div class="meta">売却済みですが販売価格が登録されていません。
        行を開いて売却価格を入れると、売上と粗利に入ります。</div></div>
    <button class="btn sm ghost" onclick="showNoPrice(false)">すべて表示</button>
  </div>`;
}

/* 出品先。出しているサイトだけ小さく並べる。長い名前は出さない */
function listingChips(on, title) {
  if (!on.length) return '<span class="meta">—</span>';
  return '<span class="malls">' + CHANNELS.filter(c => on.indexOf(c.key) >= 0).map(c =>
    `<span class="tag ch on" title="${esc(c.label)}${title ? '：' + esc(title) : '：出品中'}">${esc(c.short)}</span>`
  ).join('') + '</span>';
}

function unitsBodyHtml() {
  const rows = unitsFiltered();
  if (!rows.length) return `<div class="empty" style="margin-top:15px">該当する在庫はありません。</div>`;
  const live = rows.filter(r => r.kind === 'item' && IN_STOCK.includes(r.i.status)).length;
  const qty = rows.filter(r => r.kind === 'qty').reduce((n, r) => n + (r.m.qty || 0), 0);
  const pick = canEdit();
  const rentN = rows.filter(r => r.kind === 'item' && isRentalOn(r.i)).length;
  return `<div class="meta" style="margin:12px 0 4px">${rows.length} 件${
      live ? `／うち在庫・出品中 ${live}台` : ''}${rentN ? `／8RENT対象 ${rentN}台` : ''}${qty ? `／数量品 ${qty}` : ''}</div>
    <div class="table-wrap"><table class="t">
    <thead><tr>
      ${pick ? `<th class="ck"><input type="checkbox" id="selAllItems" onclick="toggleAllItems(this.checked)"
        ${allItemsSelected(rows) ? 'checked' : ''} title="表示中の個体をすべて選ぶ"></th>` : ''}
      <th>管理番号</th><th>型番</th><th>メーカー</th><th>仕入日</th>
      <th style="text-align:right">原価</th><th style="text-align:right">販売予定価格</th>
      <th class="mchk-col">価格調査</th>
      <th>出品先</th><th>保管場所</th><th>状態</th><th>8RENT</th>
    </tr></thead>
    <tbody>${rows.slice(0, 600).map(r => {
      const { i, m } = r;
      // 数量管理は現物1台を指す管理番号を持たない。「—」と出し、
      // 状態も「在庫 42」と数で出して、個体管理の行と取り違えないようにする
      if (r.kind === 'qty') return `<tr class="clk qty" onclick="go('prod','${esc(m.code)}')">
        ${pick ? '<td class="ck"></td>' : ''}
        <td class="meta">—<div class="meta">数量管理</div></td>
        <td class="nowrap">${esc(m.model || titleOf(m))}
          <div class="meta num">${esc(m.code)}</div>${marketBtns(m.maker, m.model, true)}</td>
        <td class="nowrap">${esc(m.maker || '')}</td>
        <td class="meta">—</td>
        <td class="num meta r">${yen(m.unit_price)}</td>
        <td class="num meta r">—</td>
        <td class="mchk-col">${marketBtns(m.maker, m.model)}</td>
        <td class="mall">${listingChips(liveOnProd(m.code))}</td>
        <td class="meta">${esc(locPath(m.location_id))}</td>
        <td>${qtyTag(m)}</td>
        <td class="meta">—</td>
      </tr>`;
      const cost = costOf(i), plan = planOf(i);
      // 型番・メーカーは商品マスターを優先。価格調査の検索語にも同じものを使う
      const mk = { model: (m && m.model) || i.model || '', maker: (m && m.maker) || i.maker || '' };
      return `<tr class="clk${isMismatch(i) ? ' warn' : ''}${ui.selItems[i.id] ? ' on' : ''}" data-item="${esc(i.id)}" onclick="go('item','${esc(i.id)}')">
        ${pick ? `<td class="ck" onclick="event.stopPropagation()">
          <input type="checkbox" ${ui.selItems[i.id] ? 'checked' : ''} onchange="toggleItem('${esc(i.id)}',this.checked)"></td>` : ''}
        <td class="num" style="font-weight:600">
          <a class="idlink" href="/zaiko/items/${encodeURIComponent(i.id)}"
             onclick="event.stopPropagation();event.preventDefault();go('item','${esc(i.id)}')"
             title="この1台の詳細と履歴">${esc(i.id)}</a>
          ${i.source_id ? `<div class="meta">仕入元 ${esc(i.source_id)}</div>` : ''}</td>
        <td class="nowrap">${esc(mk.model)}${marketBtns(mk.maker, mk.model, true)}</td>
        <td class="nowrap">${esc(mk.maker)}</td>
        <td class="meta nowrap">${i.purchased_on ? fmtD(i.purchased_on) : '—'}</td>
        <td class="num r">${cost ? yen(cost) : '<span class="meta">—</span>'}</td>
        <td class="num r">${plan == null ? '<span class="meta">—</span>' : yen(plan)}</td>
        <td class="mchk-col">${marketBtns(mk.maker, mk.model)}</td>
        <td class="mall">${listingChips(liveOn(i))}</td>
        <td class="meta">${esc(locPath(i.location_id))}</td>
        <td>${statusTag(i.status)}</td>
        <td>${rentalTag(i)}</td>
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
      <th>出品先</th><th>保管場所</th><th>在庫状態</th><th>最終更新</th>
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
        <td class="mall">${listingChips(prodLiveOn(p))}</td>
        <td class="meta">${esc(placeOf(p))}</td>
        <td>${stockTag(lbl)}</td>
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
function clearSel() { ui.sel = {}; renderListBody(); }

/* ---- 個体を選ぶ（在庫一覧・個体別） ----
   商品（型番別）の選択とは別に持つ。「同じ商品10台のうち3台だけ8RENTに出す」
   という運用ができるように、選ぶ単位は実物1台にする。 */
const selItemIds = () => Object.keys(ui.selItems).filter(k => ui.selItems[k]);
const selItemRows = () => selItemIds().map(id => item(id)).filter(Boolean);
/* 「全選択」は、いま絞り込みで表示している個体だけを対象にする */
const shownItemIds = () => unitsFiltered().filter(r => r.kind === 'item').map(r => r.i.id);
function allItemsSelected(rows) {
  const ids = rows.filter(r => r.kind === 'item').map(r => r.i.id);
  return ids.length > 0 && ids.every(id => ui.selItems[id]);
}
/* チェックのたびに表を作り直すと（最大600行）重くなるので、
   その行の見た目と「全選択」「操作バー」だけを直す */
function toggleItem(id, on) {
  if (on) ui.selItems[id] = true; else delete ui.selItems[id];
  const tr = document.querySelector(`#listBody tr[data-item="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`);
  if (tr) tr.classList.toggle('on', !!on);
  const all = $('selAllItems');
  if (all) all.checked = allItemsSelected(unitsFiltered());
  refreshSelBar();
}
function toggleAllItems(on) {
  shownItemIds().forEach(id => { if (on) ui.selItems[id] = true; else delete ui.selItems[id]; });
  renderListBody();
}
function clearItemSel() { ui.selItems = {}; renderListBody(); }

/* 8RENT対象の判定。行の「レンタル対象」表示・上部の件数・タブの件数・
   タブの絞り込みは、すべてこの1つを通す（表示と件数がずれないように）。
   売却済・廃棄は手元に無いので対象に数えない。 */
const isRentalOn = (i) => !!(i && i.rental_eligible) && !GONE.includes(i.status);

/* 8RENT対象かどうかを行に出す。売却済・廃棄は手元に無いので「—」 */
function rentalTag(i) {
  if (GONE.includes(i.status)) return '<span class="meta">—</span>';
  return i.rental_eligible
    ? '<span class="tag rent on"><span class="ms">devices</span>レンタル対象</span>'
    : '<span class="tag rent">対象外</span>';
}

/* ---- 画面下の一括操作バー ----
   個体別のときは個体の操作、型番別のときはこれまでどおり商品の操作を出す。 */
function refreshSelBar() {
  const bar = $('selbar');
  if (!bar) return;
  const unit = ui.listMode !== 'model';
  const n = unit ? selItemIds().length : selCodes().length;
  const on = n > 0 && ui.screen === 'list' && canEdit();
  bar.classList.toggle('on', on);
  document.body.classList.toggle('selbar-on', on);
  if (!on) { bar.innerHTML = ''; return; }
  bar.innerHTML = unit ? selBarItems(n) : selBarProds(n);
}
function selBarItems(n) {
  const b = (label, icon, fn, cls) =>
    `<button class="btn sm ${cls || ''}" onclick="${fn}"><span class="ms">${icon}</span>${label}</button>`;
  return `<span class="n"><span class="ms">check_box</span>${n}件選択中</span>
    <div class="selops">
      ${b('8RENTに出す', 'devices', 'openBulkRental()', 'lime')}
      ${b('8RENTから外す', 'devices_off', 'openBulkRentalOff()')}
      ${b('貸出', 'assignment_ind', 'openBulkLoan()')}
      ${b('売却', 'paid', 'openBulkSell()')}
      ${b('修理', 'build', 'openBulkRepair()')}
      ${b('棚卸', 'fact_check', 'openBulkCheck()')}
      ${canAdmin() ? b('廃棄', 'delete', 'openBulkScrap()', 'danger') : ''}
    </div>
    <button class="btn sm ghost" onclick="clearItemSel()">選択解除</button>`;
}
function selBarProds(n) {
  const units = selCodes().reduce((a, c) => a + itemsOf(c).length, 0);
  return `<span class="n">${n} 商品を選択中（個体 ${units}台）</span><span class="sp"></span>
    <div class="selops">
      <button class="btn sm" onclick="openBulkEdit()"><span class="ms">edit</span>まとめて直す</button>
      ${canAdmin() ? '<button class="btn sm danger" onclick="openBulkDelete()"><span class="ms">delete</span>削除</button>' : ''}
    </div>
    <button class="btn sm ghost" onclick="clearSel()">選択を解除</button>`;
}

/* 選んだ個体の内訳。モーダルの説明文に出して、何台が対象外になるかを先に見せる */
function selBreakdown(skip) {
  const rows = selItemRows();
  const ng = rows.filter(i => (skip || []).includes(i.status));
  const by = {};
  ng.forEach(i => { by[i.status] = (by[i.status] || 0) + 1; });
  return { rows, n: rows.length, ng: ng.length, ok: rows.length - ng.length,
           note: Object.keys(by).map(k => `${k} ${by[k]}台`).join('・') };
}
function bulkHead(text, cls) {
  return `<div class="card" style="${cls === 'warn' ? 'background:#FDECEC;' : ''}margin-bottom:14px">${text}</div>`;
}

/* ---- 8RENTに出す（個体のレンタル対象） ----
   商品の「8RENTに掲載するか」（rental_enabled）とは別の設定。
   ここで選んだ個体だけが、8ECのレンタル可能数に数えられる。
   最初の1台を対象にしたら、その商品の掲載も自動でONにする。 */
function openBulkRental() {
  const b = selBreakdown(GONE);
  if (!b.n) return;
  const codes = [...new Set(b.rows.map(i => i.product_code))];
  const offCodes = codes.filter(c => { const p = prod(c); return p && !p.rental_enabled; });
  const nowOn = b.rows.filter(i => i.rental_eligible).length;
  openModal('8RENTに出す', `
    ${bulkHead(`選んだ <strong>${b.n}台</strong>（${codes.length}商品）をレンタル対象にします。
      ${nowOn ? `<span class="meta">すでに対象：${nowOn}台</span>` : ''}
      ${b.ng ? `<div class="meta" style="margin-top:4px">${esc(b.note)} は手元にないので対象にできません。</div>` : ''}`)}
    <p class="meta" style="margin-bottom:12px">
      レンタル可能数に数えるのは <strong>状態が「在庫」かつレンタル対象</strong>の個体だけです。
      レンタル対象にしても、在庫のうちは楽天でも売れます（先に売れたほうに1台が渡ります）。
      楽天の出品はこの操作では解除しません。</p>
    ${offCodes.length ? `<p class="meta" style="margin-bottom:12px">
      <strong>${offCodes.length}商品</strong>がまだ8RENT非掲載です。最初の1台を対象にするので、
      あわせて商品も8RENTに掲載します（掲載しないと8ECには出ません）。</p>` : ''}
    <label class="field"><span>メモ（任意・履歴に残ります）</span>
      <input class="input" id="blNote" placeholder="例 8RENT用に確保"></label>
  `, [['閉じる', 'closeModal()', 'btn ghost'],
      ['8RENT対象にする', "doBulk('8RENT対象')", 'btn lime']]);
}

/* ---- 8RENTから外す（販売用に戻す） ----
   レンタルの約束が生きている個体（予約中・貸出中）は外せない。
   商品の掲載設定（rental_enabled）はここでは触らない。対象が0台になった商品は、
   結果画面で知らせて、掲載を止めるかどうかは人が商品詳細で決める。 */
function openBulkRentalOff() {
  const b = selBreakdown(GONE.concat(['予約中', '貸出中']));
  if (!b.n) return;
  const rows = b.rows.filter(i => i.rental_eligible && !GONE.includes(i.status));
  const codes = [...new Set(rows.map(i => i.product_code))];
  // この操作でレンタル対象が0台になりそうな商品（掲載中のもの）
  const willEmpty = codes.filter(c => {
    const off = rows.filter(i => i.product_code === c && !['予約中', '貸出中'].includes(i.status)).length;
    const p = prod(c);
    return p && p.rental_enabled && rentalEligibleOf(c) - off <= 0;
  });
  openModal('8RENTから外す', `
    ${bulkHead(`選んだ <strong>${b.n}台</strong>のうち、<strong>${b.ok}台</strong>をレンタル対象から外します。
      <div class="meta" style="margin-top:4px">外した個体は8ECのレンタル可能数から抜け、販売用として在庫に残ります。</div>
      ${b.ng ? `<div class="meta" style="margin-top:4px">${esc(b.note)} は外せません（予約中・貸出中はレンタルの約束が残っているため、先にキャンセル・返却してください）。</div>` : ''}`)}
    ${willEmpty.length ? `<p class="meta" style="margin-bottom:12px">
      <strong>${willEmpty.map(c => esc(titleOf(prod(c)))).join('・')}</strong> はレンタル対象が0台になります。
      商品の8RENT掲載はそのままにします（8ECでは「在庫切れ」の表示になります）。
      掲載自体を止めるときは、商品詳細の「8RENT設定を変える」で非公開にしてください。</p>` : ''}
    <label class="field"><span>メモ（任意・履歴に残ります）</span>
      <input class="input" id="blNote" placeholder="例 販売用に戻す"></label>
  `, [['閉じる', 'closeModal()', 'btn ghost'],
      ['8RENTから外す', "doBulk('8RENT対象外')", 'btn']]);
}

/* ---- 貸出（社内・お客様への貸出） ---- */
function openBulkLoan() {
  const b = selBreakdown(STATUSES.filter(s => s !== '在庫'));
  if (!b.n) return;
  openModal('まとめて貸出', `
    ${bulkHead(`選んだ <strong>${b.n}台</strong>のうち、<strong>${b.ok}台</strong>を貸出中にします。
      ${b.ng ? `<div class="meta" style="margin-top:4px">${esc(b.note)} は「在庫」ではないので貸し出せません。</div>` : ''}`)}
    <label class="field" style="margin-bottom:10px"><span>貸出先・利用者</span>
      <input class="input" id="blUser" list="uOptsBulk" placeholder="例 佐藤 健 ／ 株式会社◯◯" autocomplete="off">
      <datalist id="uOptsBulk">${userOptions()}</datalist></label>
    <label class="field" style="margin-bottom:10px"><span>返却予定日（任意）</span>
      <input class="input" type="date" id="blDue"></label>
    <label class="field"><span>メモ（任意）</span>
      <input class="input" id="blNote" placeholder="例 短期プロジェクトで使用"></label>
  `, [['閉じる', 'closeModal()', 'btn ghost'], ['貸出にする', "doBulk('貸出')", 'btn lime']]);
}

/* ---- 売却（販売済みにする） ---- */
function openBulkSell() {
  const b = selBreakdown(['予約中', '貸出中', '売却済', '廃棄']);
  if (!b.n) return;
  openModal('まとめて売却', `
    ${bulkHead(`選んだ <strong>${b.n}台</strong>のうち、<strong>${b.ok}台</strong>を売却済（販売済み）にします。
      <div class="meta" style="margin-top:4px">売却済にすると在庫から外れ、8RENTのレンタル可能数にも数えなくなります。</div>
      ${b.ng ? `<div class="meta" style="margin-top:4px">${esc(b.note)} はそのまま売却できません（先に返却・キャンセルしてください）。</div>` : ''}`, 'warn')}
    <label class="field" style="margin-bottom:10px"><span>販売価格（任意・1台あたり）</span>
      <input class="input num" type="number" min="0" step="100" id="blPrice" placeholder="例 42000">
      <span class="meta">選んだ台すべてに同じ価格で記録します。1台ずつ違うときは空のままにしてください。</span></label>
    <label class="field"><span>メモ（任意）</span>
      <input class="input" id="blNote" placeholder="例 楽天で販売"></label>
  `, [['閉じる', 'closeModal()', 'btn ghost'], ['売却にする', "doBulk('売却')", 'btn']]);
}

/* ---- 修理（状態を修理中にする） ---- */
function openBulkRepair() {
  const b = selBreakdown(['売却済', '廃棄', '予約中', '販売予約', '修理中']);
  if (!b.n) return;
  openModal('まとめて修理中にする', `
    ${bulkHead(`選んだ <strong>${b.n}台</strong>のうち、<strong>${b.ok}台</strong>を修理中にします。
      ${b.ng ? `<div class="meta" style="margin-top:4px">${esc(b.note)} は変更できません。</div>` : ''}`)}
    <label class="field"><span>修理の理由・メモ（任意・履歴に残ります）</span>
      <input class="input" id="blNote" placeholder="例 キーボード不良／バッテリー交換"></label>
  `, [['閉じる', 'closeModal()', 'btn ghost'], ['修理中にする', "doBulk('修理')", 'btn lime']]);
}

/* ---- 棚卸（現物を確認したことを記録する。状態は変えない） ---- */
function openBulkCheck() {
  const b = selBreakdown(GONE);
  if (!b.n) return;
  openModal('まとめて棚卸（現物確認）', `
    ${bulkHead(`選んだ <strong>${b.n}台</strong>のうち、<strong>${b.ok}台</strong>を「現物確認済み」として記録します。
      <div class="meta" style="margin-top:4px">状態は変えません。いつ・誰が・どの個体を確認したかを履歴に残します。</div>
      ${b.ng ? `<div class="meta" style="margin-top:4px">${esc(b.note)} は手元にないので確認できません。</div>` : ''}`)}
    <label class="field"><span>メモ（任意）</span>
      <input class="input" id="blNote" placeholder="例 本社倉庫で確認"></label>
  `, [['閉じる', 'closeModal()', 'btn ghost'], ['確認済みにする', "doBulk('棚卸')", 'btn lime']]);
}

/* ---- 廃棄（取り返しがつかないので、確認してからにする） ---- */
function openBulkScrap() {
  const b = selBreakdown(['廃棄']);
  if (!b.n) return;
  openModal('まとめて廃棄', `
    ${bulkHead(`選んだ <strong>${b.n}台</strong>のうち、<strong>${b.ok}台</strong>を廃棄にします。
      <strong>在庫から外れ、元には戻せません。</strong>
      <div class="meta" style="margin-top:4px">履歴（誰がいつ何を廃棄したか）は残ります。</div>`, 'warn')}
    <label class="field" style="margin-bottom:10px"><span>廃棄の理由（任意・履歴に残ります）</span>
      <input class="input" id="blNote" placeholder="例 水濡れで起動しない"></label>
    <label class="bchk"><input type="checkbox" id="blConfirm"
      onchange="document.getElementById('blGo').disabled = !this.checked"> 元に戻せないことを確認しました</label>
  `, [['閉じる', 'closeModal()', 'btn ghost'], ['廃棄にする', "doBulk('廃棄')", 'btn danger', 'blGo']]);
  const go = $('blGo'); if (go) go.disabled = true;
}

/* ---- まとめて実行 ----
   1台ずつの検証・履歴はサーバー側（inv_items_bulk_op → inv_item_op）に任せる。
   失敗した個体は選択に残して、理由とあわせて出す。 */
const BULK_LABEL = { '8RENT対象': '8RENT対象', '8RENT対象外': '8RENT対象外', '貸出': '貸出',
                     '売却': '売却', '修理': '修理', '棚卸': '棚卸', '廃棄': '廃棄' };
async function doBulk(action) {
  const ids = selItemIds();
  if (!ids.length) return;
  const val = (id) => (($(id) || {}).value || '').trim();
  if (action === '貸出' && !val('blUser')) { toast('貸出先を入力してください'); return; }
  const args = {
    p_ids: ids, p_action: action,
    p_value: action === '貸出' ? val('blUser') : (action === '売却' ? (val('blPrice') || null) : null),
    p_note: val('blNote') || null,
    p_due: action === '貸出' ? (val('blDue') || null) : null,
    p_enable_product: action === '8RENT対象'   // 最初の1台なら商品の掲載も自動でON
  };
  closeModal();
  toast(`${BULK_LABEL[action]}を実行しています…`);
  const { data, error } = await sb.rpc('inv_items_bulk_op', args);
  if (error) { toast('実行できませんでした：' + error.message); return; }
  ui.selItems = {};
  ((data && data.ng) || []).forEach(x => { ui.selItems[x.id] = true; });  // 失敗した分は選んだままにする
  await loadAll();
  render();
  showBulkResult(action, data || {});
}

/* 成功件数・失敗件数・失敗理由を出す。全部成功なら短く1行で伝える */
function showBulkResult(action, r) {
  const ok = r.ok || 0, ng = (r.ng || []).length, total = r.total || 0;
  const extra = r.products_enabled ? `（商品 ${r.products_enabled}件も8RENTに掲載しました）` : '';
  const empty = (r.products_empty || []);
  if (!ng && !empty.length) {
    toast(action === '8RENT対象' ? `8RENT対象に${ok}台追加しました${extra}`
        : action === '8RENT対象外' ? `${ok}台を8RENT対象から外しました`
        : `${ok}台を${BULK_LABEL[action]}にしました`);
    return;
  }
  // レンタル対象が0台になった商品は、掲載を落とさずに知らせる（止めるかは人が決める）
  if (!ng && empty.length) {
    toast(`${ok}台を8RENT対象から外しました`);
    openModal('8RENTから外しました', `
      ${bulkHead(`${ok}台をレンタル対象から外しました。`)}
      <p class="meta" style="margin-bottom:10px">次の商品は<strong>レンタル対象が0台</strong>になりました。
        8RENTの掲載設定（公開中）はそのままにしています。8ECでは「在庫切れ」の表示になり、申込はできません。
        掲載自体を止めるときは、商品詳細の「8RENT設定を変える」で非公開にしてください。</p>
      <div class="plist">${empty.map(x =>
        `<div class="p"><span class="c">${esc(x.code)}</span><span>${esc(x.name || '')}</span>
          <button class="btn sm ghost" style="margin-left:auto"
            onclick="closeModal();go('prod','${esc(x.code)}')">商品を開く</button></div>`).join('')}</div>
    `, [['閉じる', 'closeModal()', 'btn ghost']]);
    return;
  }
  const one = ng === 1 ? `${total}台中${ok}台成功・1台は${esc(r.ng[0].reason)}` : `${total}台中${ok}台成功・${ng}台失敗`;
  toast(one);
  openModal(`${BULK_LABEL[action]}の結果`, `
    <div class="sum" style="margin-bottom:14px">
      <div><div class="lbl">対象</div><div class="v">${total}</div></div>
      <div><div class="lbl">成功</div><div class="v">${ok}</div></div>
      <div><div class="lbl">できなかった</div><div class="v err">${ng}</div></div>
    </div>
    ${extra ? `<p class="meta" style="margin-bottom:10px">${esc(extra)}</p>` : ''}
    ${empty.length ? `<p class="meta" style="margin-bottom:10px">
      ${esc(empty.map(x => x.name || x.code).join('・'))} はレンタル対象が0台になりました。
      8RENTの掲載はそのままです（8ECでは「在庫切れ」）。止めるときは商品詳細の「8RENT設定を変える」から。</p>` : ''}
    <div class="table-wrap"><table class="t">
      <thead><tr><th>管理番号</th><th>理由</th></tr></thead>
      <tbody>${r.ng.map(x => `<tr><td class="num">${esc(x.id)}</td><td class="meta">${esc(x.reason)}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="meta" style="margin-top:10px">できなかった個体は選んだままにしています。状態を直してからもう一度お試しください。</p>
  `, [['閉じる', 'closeModal()', 'btn ghost']]);
}


function stockTag(lbl) {
  const cls = { '在庫あり': 'ok', '残りわずか': 'few', '在庫なし': 'none', '要発注': 'few' }[lbl] || 'none';
  return `<span class="tag stk-${cls}">${esc(lbl)}</span>`;
}
/* 型番別の行の出品先。ぶら下がる個体のどれか1台でも出ていれば、そのサイトを出す */
function prodLiveOn(p) {
  const set = {};
  liveOnProd(p.code).forEach(k => { set[k] = true; });
  itemsOf(p.code).forEach(i => { if (!GONE.includes(i.status)) liveOn(i).forEach(k => { set[k] = true; }); });
  return CHANNELS.filter(c => set[c.key]).map(c => c.key);
}

function statusTag(s, big) {
  return `<span class="tag st-${esc(s)}${big ? ' big' : ''}"><span class="ms">${STATUS_ICON[s] || 'inventory_2'}</span>${esc(s)}</span>`;
}
/* 数量管理の状態。個体は「在庫」「貸出中」と1台の状態を出すが、
   こちらは数そのものなので「在庫 42」と数まで出して見分けられるようにする */
function qtyTag(p) {
  const n = p.qty || 0;
  if (n <= 0) return `<span class="tag stk-none">在庫なし</span>`;
  const few = p.min_qty > 0 && n <= p.min_qty;
  return `<span class="tag stk-${few ? 'few' : 'ok'}"><span class="ms">inventory_2</span>在庫 ${n}</span>`;
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
  ['販売状況', p => CHANNELS.map(c => {
    const x = channelsOf(p.code).find(v => v.channel === c.key);
    const live = itemsOf(p.code).some(i => !GONE.includes(i.status) && (listingOf(i, c.key) || {}).state === LISTED);
    const st = live ? LISTED : (x ? (x.state || '未設定') : null);
    return st ? `${c.label}:${st}` : '';
  }).filter(Boolean).join(' ｜ ')],
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
/* CSVに書かれた値がこのカテゴリーを指しているか。
   カテゴリーID・表示名・別名（aliases）のどれでも受ける。
   表示名を「PC」から「パソコン」に変えても、昔のCSVが取り込めるようにするため。 */
const catMatches = (c, n) =>
  c.id.toLowerCase() === n.toLowerCase() || c.name === n ||
  (c.aliases || []).some(a => String(a).trim() === n);

function findCat(name, kind) {
  const n = String(name || '').trim();
  if (!n) return { id: null, reason: 'cat-empty', why: 'カテゴリが空です' };
  if (impMap.cat[n]) return { id: impMap.cat[n] };
  // 正確な一致から順に見る（別名がぶつかっても取り違えないように）
  const pick = (list) => list.find(c => c.id.toLowerCase() === n.toLowerCase())
                      || list.find(c => c.name === n)
                      || list.find(c => (c.aliases || []).some(a => String(a).trim() === n));
  const same = catsFor(kind).filter(c => catMatches(c, n));
  const hit = pick(same);
  if (hit) return { id: hit.id };
  const other = db.cats.filter(c => catMatches(c, n));
  if (other.length) {
    const o = pick(other) || other[0];
    if (!catLive(o)) {
      return { id: null, reason: 'cat-off', value: n, kind,
               why: `カテゴリ「${n}」は無効にされています` };
    }
    const forWhat = o.kind === 'quantity' ? '数量管理' : '個体管理';
    return { id: null, reason: 'cat-kind', value: n, kind,
             why: `カテゴリ「${n}」は${forWhat}用として登録されています` };
  }
  // 知らないカテゴリーを勝手に作らない。エラー一覧に出して、
  // マスター管理で足してもらってから取り込み直す
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

/* ---- 楽天商品を同期 ----
   Rakuten Developers APIで自社楽天店舗の商品を取得し、Edge Function
   （zaiko/supabase-functions/rakuten-product-sync/）経由で inventory_products の
   不足情報を補う。実在庫（inventory_items）はここでは作らない。
   候補が複数あって自動で選べないものは「要確認」に出し、人に選んでもらう。 */
let rakutenLastResult = null;
/* 楽天商品を同期。
   8ECの公開ページは楽天APIを呼ばない。ここで取り込んだ商品画像（images）と
   スペックを商品マスターに保存し、公開ページはそれだけを読む。
   画像は images に入れ、image_url（人が/zaikoで指定したメイン画像）は同期で触らない。 */
function rakutenImageStats() {
  const listed = db.masters.filter(p => (channelsOf(p.code) || []).some(c =>
    c.channel === 'rakuten' && (c.external_item_code || c.url)));
  const noImg = listed.filter(p =>
    !(p.image_url || '').trim() && !(Array.isArray(p.images) ? p.images.filter(Boolean).length : 0));
  return { listed: listed.length, noImg: noImg.length };
}
function openRakutenSync() {
  if (!canAdmin()) { toast('同期は管理者だけができます'); return; }
  const st = rakutenImageStats();
  openModal('楽天商品を同期', `
    <p class="meta" style="margin-bottom:12px">楽天に出品している商品の<strong>写真</strong>と、商品名・スペック等の
      不足情報を商品マスターへ取り込みます。写真は <code>images</code> に入り、
      <strong>/zaikoで登録したメイン画像は上書きしません</strong>。8ECの公開ページは商品マスターだけを読みます
      （表示のたびに楽天APIは呼びません）。実在庫は増えません。</p>
    <div id="rkDone" style="display:none"></div>
    <div class="prices" style="margin-bottom:14px">
      <div><div class="lbl">楽天に掲載中</div><div class="v" id="rkStListed">${st.listed}商品</div></div>
      <div><div class="lbl">うち写真が無い</div><div class="v ${st.noImg ? 'minus' : ''}" id="rkStNoImg">${st.noImg}商品</div></div>
    </div>
    <label class="field" style="margin-bottom:12px"><span>同期する範囲</span>
      <select class="input" id="rkMode" onchange="syncRakutenMode()">
        <option value="missing" id="rkOptMissing">画像が未取得の商品だけ（${st.noImg}商品）</option>
        <option value="all" id="rkOptAll">楽天に掲載している商品すべて（${st.listed}商品）</option>
        <option value="one">1商品だけ（掲載URLを指定）</option>
        <option value="catalog">楽天の商品一覧から商品マスターを補完（新規登録もする）</option>
      </select>
      <span class="meta" id="rkModeHint"></span></label>
    <div id="rkOneWrap" style="display:none">
      <label class="field" style="margin-bottom:12px"><span>掲載URL</span>
        <input class="input" type="text" id="rkTargetUrl" placeholder="https://item.rakuten.co.jp/店舗ID/商品番号/">
        <span class="meta">商品URLはここに入れた値だけを使い、商品コードから推測はしません。</span></label>
      <label class="field" style="margin-bottom:12px"><span>反映先の商品コード（任意）</span>
        <input class="input" type="text" id="rkTargetCode" placeholder="例 P-00432">
        <span class="meta">入れると、その商品に直接反映します。空なら型番などで自動照合します。</span></label>
    </div>
    <label class="field" id="rkLimitWrap" style="max-width:220px;display:none"><span>取得件数</span>
      <input class="input num" type="number" id="rkLimit" value="5" min="1" max="30"></label>
    <div id="rkResult" style="margin-top:16px"></div>`,
    [['閉じる', 'closeModal()', 'btn ghost'],
     ['同期する', 'runRakutenSync()', 'btn lime', 'rkGoBtn']]);
  syncRakutenMode();
}
function syncRakutenMode() {
  const m = ($('rkMode') || {}).value || 'missing';
  const show = (id, on) => { const el = $(id); if (el) el.style.display = on ? '' : 'none'; };
  show('rkOneWrap', m === 'one');
  show('rkLimitWrap', m === 'catalog');
  const hint = {
    missing: '写真がまだ無い商品だけを対象にします。ふだんの取り込みはこれで十分です。',
    all: '掲載中の商品すべてを見直します。すでに入っている値は上書きしません。',
    one: '1商品だけ試すとき（接続確認にも）。',
    catalog: '楽天の商品一覧を取得し、型番などで照合して商品マスターを補完します（該当が無ければ新規登録）。'
  }[m] || '';
  const el = $('rkModeHint'); if (el) el.textContent = hint;
}
/* 同期に失敗した理由の呼び名。商品ごとにこのどれかが付く */
const RK_FAIL = {
  not_found_by_item_code: { label: '楽天APIで商品が見つからない',
    hint: 'external_item_code は入っていますが、その商品コードが自社店舗の商品一覧にありません。出品を終了した商品か、商品コードが古い可能性があります。' },
  not_found_by_url: { label: 'listing URL不一致',
    hint: '登録してある掲載URLの商品が楽天側にありません。URLが変わったか、出品を終了しています。商品詳細の「楽天」行でURLを直してください。' },
  no_key: { label: 'external_item_code不明',
    hint: '楽天の商品コードも掲載URLも登録されていないため、照合できません。商品詳細の「楽天」行にURLを入れてください。' },
  no_images_in_api: { label: 'APIレスポンスに画像なし',
    hint: '楽天側では見つかりましたが、APIが画像を返しませんでした。楽天の商品ページに画像が登録されているかご確認ください。' },
  api_error: { label: 'APIエラー',
    hint: '取り込みの途中でエラーが返りました。時間をおいて再試行してください。' },
  not_searched: { label: '未確認のページが残っています',
    hint: '商品一覧を最後まで見きれませんでした。再試行すると続きから探します。' }
};
const RK_FAIL_ORDER = ['not_found_by_url', 'not_found_by_item_code', 'no_key',
                       'no_images_in_api', 'api_error', 'not_searched'];

/* 楽天同期の実行。codes を渡すと、その商品だけをやり直す（失敗分の再試行）。 */
async function runRakutenSync(opts) {
  const codes = (opts && opts.codes) || null;
  const btn = $('rkGoBtn');
  if (btn) { btn.disabled = true; btn.textContent = '同期中…'; }
  const done = $('rkDone');
  if (done) { done.style.display = 'none'; done.innerHTML = ''; }
  const host = $('rkResult');
  host.innerHTML = `<div class="status" style="padding:10px 0"><span class="ms">progress_activity</span> ${
    codes ? `失敗した${codes.length}商品をやり直しています…` : '楽天から取得しています…'}</div>`;
  let okDone = false;
  try {
    const mode = codes ? 'all' : (($('rkMode') || {}).value || 'missing');
    const limit = Math.max(1, Math.min(30, parseInt(numField('rkLimit') || 5, 10) || 5));
    const targetUrl = (($('rkTargetUrl') || {}).value || '').trim();
    const targetCode = (($('rkTargetCode') || {}).value || '').trim();
    if (!codes && mode === 'one' && !targetUrl) {
      host.innerHTML = '<div class="warnbox"><span class="ms">error</span><div>掲載URLを入れてください。</div></div>';
      return;
    }
    const payload = codes ? { mode: 'all', codes }
      : mode === 'missing' || mode === 'all' ? { mode }
      : mode === 'one' ? { item_url: targetUrl, code: targetCode || undefined, limit: 1 }
      : { limit };
    const { data: { session } } = await sb.auth.getSession();
    const call = async (extra) => {
      const r = await fetch(SUPA_URL + '/functions/v1/rakuten-product-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + (session ? session.access_token : '') },
        body: JSON.stringify(Object.assign({}, payload, extra || {}))
      });
      let j = {};
      try { j = await r.json(); } catch (_) { j = {}; }
      return { r, j };
    };
    // ラウンドをまたいだ失敗の集計。
    // 1回目で見つかった商品は2回目の索引には載らないので、後のラウンドで
    // 「見つからない」と出ても、すでに写真が入っていればそれは失敗ではない。
    // 確定した理由（未確認以外）を優先して残す。
    const okCodes = {}, failMap = {};
    const soak = (round) => {
      (round.details || []).forEach(d => { if (d.ok && d.images_added) okCodes[d.code] = true; });
      (round.failures || []).forEach(f => {
        if (okCodes[f.code]) return;
        const cur = failMap[f.code];
        if (!cur || cur.reason === 'not_searched') failMap[f.code] = f;
      });
      Object.keys(okCodes).forEach(c => { delete failMap[c]; });
    };
    // 楽天の商品一覧は1ページ30件・最大100ページ。1回で見きれなかったときは
    // next_page（続きのページ）が返るので、そのまま続きから探す
    let { r: res, j: out } = await call();
    if (res.ok && !out.error) soak(out);
    for (let round = 0; round < 6 && res.ok && out && out.next_page; round++) {
      host.innerHTML = `<div class="status" style="padding:10px 0"><span class="ms">progress_activity</span>
        楽天の商品一覧を確認しています… ${esc(String(out.scanned_pages || 0))}/${esc(String(out.page_count || '—'))}ページ</div>`;
      const nxt = await call({ start_page: out.next_page });
      res = nxt.r;
      // 積み上げる（件数は合算、一覧は後勝ちでなく結合）
      const prev = out;
      out = nxt.j || {};
      if (res.ok && !out.error) soak(out);
      ['images_ok', 'updated', 'unchanged', 'fetched_count', 'api_requests'].forEach(k => {
        out[k] = (Number(prev[k]) || 0) + (Number(out[k]) || 0);
      });
      out.scanned_pages = (Number(prev.scanned_pages) || 0) + (Number(out.scanned_pages) || 0);
      out.details = (prev.details || []).concat(out.details || []);
      out.target_count = prev.target_count ?? out.target_count;
      out.not_found = out.not_found || [];
    }
    if (!res.ok || out.error) {
      host.innerHTML = `<div class="warnbox"><span class="ms">error</span>
        <div>${esc(out.error || ('HTTP ' + res.status))}${out.rakuten_response
          ? '<div class="meta" style="margin-top:6px">楽天からの応答：<code>' + esc(JSON.stringify(out.rakuten_response).slice(0, 300)) + '</code></div>' : ''}
        <div class="meta" style="margin-top:6px">Edge Function「rakuten-product-sync」のデプロイと、RAKUTEN_APPLICATION_ID /
          RAKUTEN_ACCESS_KEY / RAKUTEN_SHOP_CODE の設定をご確認ください。</div></div></div>`;
      return;
    }
    // 商品ごとの理由をまとめたものを、最終結果として使う
    out.failures = RK_FAIL_ORDER.map(r => Object.values(failMap).filter(f => f.reason === r))
      .reduce((a, b) => a.concat(b), [])
      .concat(Object.values(failMap).filter(f => RK_FAIL_ORDER.indexOf(f.reason) < 0));
    out.failed = out.failures.length;
    out.retried = !!codes;
    rakutenLastResult = out;
    await loadAll();
    render();
    host.innerHTML = rakutenSyncResultHtml(out);
    refreshRakutenStats();     // 「写真なし◯商品」を最新の件数にする
    showRakutenDone(out);      // 上部に「同期が完了しました」を出す
    okDone = true;
  } catch (e) {
    host.innerHTML = `<div class="warnbox"><span class="ms">error</span><div>${esc(e && e.message ? e.message : String(e))}</div></div>`;
  } finally {
    if (btn) {
      // 正常に終わったら押せなくする（同じ同期を続けて叩かないように）。
      // やり直したいときは結果の中の「失敗した◯商品のみ再試行」を使う
      btn.disabled = okDone;
      btn.textContent = okDone ? '✓ 同期完了' : '同期する';
    }
  }
}

/* 同期後に件数を取り直して、モーダルの表示を最新にする */
function refreshRakutenStats() {
  const st = rakutenImageStats();
  const set = (id, t, minus) => {
    const el = $(id);
    if (!el) return;
    el.textContent = t;
    if (minus != null) el.classList.toggle('minus', !!minus);
  };
  set('rkStListed', st.listed + '商品');
  set('rkStNoImg', st.noImg + '商品', st.noImg);
  const om = $('rkOptMissing'); if (om) om.textContent = `画像が未取得の商品だけ（${st.noImg}商品）`;
  const oa = $('rkOptAll'); if (oa) oa.textContent = `楽天に掲載している商品すべて（${st.listed}商品）`;
  return st;
}

/* 上部に完了を出す。8ECトップへの反映のしかたもここで伝える */
function showRakutenDone(out) {
  const el = $('rkDone');
  if (!el) return;
  const st = rakutenImageStats();
  el.style.display = '';
  el.innerHTML = `<div class="card" style="background:var(--l100);border:1px solid var(--l400);margin-bottom:14px;
      display:flex;align-items:flex-start;gap:10px">
    <span class="ms" style="font-size:20px;color:#43530E">check_circle</span>
    <div style="flex:1">
      <strong>楽天商品との同期が完了しました</strong>
      <div class="meta" style="margin-top:4px">画像取得 ${out.images_ok ?? 0}件／商品情報更新 ${out.updated ?? 0}件${
        out.failed ? `／失敗 ${out.failed}件` : ''}。写真が無い商品は ${st.noImg}商品になりました。</div>
      <div class="meta">8ECトップ（8ec.jp）の商品カードは、次の読み込みからこの写真が出ます（再デプロイは不要です）。</div>
    </div>
  </div>`;
}

/* 失敗した商品だけをやり直す */
function retryRakutenFailed() {
  const codes = [...new Set(((rakutenLastResult || {}).failures || []).map(f => f.code).filter(Boolean))];
  if (!codes.length) { toast('やり直す商品がありません'); return; }
  runRakutenSync({ codes });
}

/* ---- 楽天の注文を取り込む ----
   商品・画像の同期は Rakuten Developers API だが、注文はそちらでは取れない。
   受注は RMS WEB SERVICE の Order API（Edge Function rakuten-order-sync）で取り、
   在庫の確保は inv_sale_orders_apply → inv_sale_reserve に任せる。
   同じ注文を何度取り込んでも、注文番号×明細番号×連番で冪等になっている。 */
let rakutenOrderResult = null;
function openRakutenOrders() {
  if (!canAdmin()) { toast('注文の取り込みは管理者だけができます'); return; }
  openModal('楽天の注文を取り込む', `
    <p class="meta" style="margin-bottom:12px">楽天RMSの注文を取り込み、売れた台数だけ在庫を
      <strong>在庫 → 販売予約</strong>にします。発送済みで届いた注文はそのまま<strong>売却済</strong>まで進めます。
      同じ注文を何度取り込んでも<strong>在庫は二重に減りません</strong>（注文番号と明細番号で見ています）。
      8RENTで予約中・貸出中の個体は取りません。</p>
    <div class="card" style="background:#FFF4E5;margin-bottom:14px">
      <span class="meta">商品画像の同期（Rakuten Developers API）とは<strong>別のAPI・別の資格情報</strong>です。
        Edge Function <code>rakuten-order-sync</code> のデプロイと、
        <code>RAKUTEN_RMS_SERVICE_SECRET</code> / <code>RAKUTEN_RMS_LICENSE_KEY</code> の設定が要ります。</span>
    </div>
    <label class="field" style="max-width:240px;margin-bottom:10px"><span>さかのぼる日数</span>
      <input class="input num" type="number" id="roDays" value="3" min="1" max="31">
      <span class="meta">注文日でこの日数ぶんを取り込みます。</span></label>
    <label class="bchk" style="margin-bottom:10px"><input type="checkbox" id="roDry">
      取り込まずに中身だけ見る（在庫は動かしません）</label>
    <div id="roResult" style="margin-top:14px"></div>`,
    [['閉じる', 'closeModal()', 'btn ghost'],
     ['注文を取り込む', 'runRakutenOrders()', 'btn lime', 'roGoBtn']]);
}
async function runRakutenOrders() {
  const btn = $('roGoBtn');
  if (btn) { btn.disabled = true; btn.textContent = '取り込み中…'; }
  const host = $('roResult');
  host.innerHTML = '<div class="status" style="padding:10px 0"><span class="ms">progress_activity</span> 楽天RMSから注文を取得しています…</div>';
  let okDone = false;
  try {
    const days = Math.max(1, Math.min(31, parseInt(numField('roDays') || 3, 10) || 3));
    const dry = !!($('roDry') || {}).checked;
    const { data: { session } } = await sb.auth.getSession();
    const r = await fetch(SUPA_URL + '/functions/v1/rakuten-order-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + (session ? session.access_token : '') },
      body: JSON.stringify({ days, dry_run: dry })
    });
    let out = {};
    try { out = await r.json(); } catch (_) { out = {}; }
    if (!r.ok || out.error) {
      host.innerHTML = `<div class="warnbox"><span class="ms">error</span><div>${esc(out.error || ('HTTP ' + r.status))}
        ${out.detail ? `<div class="meta" style="margin-top:6px">${esc(out.detail)}</div>` : ''}
        ${out.rms_response ? `<div class="meta" style="margin-top:6px">楽天RMSの応答：<code>${esc(JSON.stringify(out.rms_response).slice(0, 300))}</code></div>` : ''}
        </div></div>`;
      return;
    }
    rakutenOrderResult = out;
    if (!dry) { await loadAll(); render(); }
    host.innerHTML = rakutenOrderResultHtml(out, dry);
    okDone = !dry;
  } catch (e) {
    host.innerHTML = `<div class="warnbox"><span class="ms">error</span><div>${esc(e && e.message ? e.message : String(e))}</div></div>`;
  } finally {
    if (btn) { btn.disabled = okDone; btn.textContent = okDone ? '✓ 取り込み完了' : '注文を取り込む'; }
  }
}
function rakutenOrderResultHtml(out, dry) {
  if (dry) {
    return `<div class="card" style="margin-bottom:10px"><strong>中身を見ただけで、在庫は動かしていません。</strong>
      <div class="meta">注文 ${out.order_count ?? 0}件／明細 ${out.line_count ?? 0}件</div></div>
      <pre class="pre" style="font-size:12px;max-height:260px;overflow:auto">${esc(JSON.stringify(out.lines || [], null, 2))}</pre>`;
  }
  const um = out.unmatched || [], ns = out.no_stock || [];
  return `
    <div class="card" style="background:var(--l100);border:1px solid var(--l400);margin-bottom:12px;display:flex;gap:10px;align-items:flex-start">
      <span class="ms" style="font-size:20px;color:#43530E">check_circle</span>
      <div><strong>楽天の注文を取り込みました</strong>
        <div class="meta" style="margin-top:4px">注文 ${out.order_count ?? 0}件／明細 ${out.line_count ?? 0}件を確認しました。</div></div>
    </div>
    <div class="prices">
      <div><div class="lbl">在庫を確保</div><div class="v ${out.reserved ? 'plus' : ''}">${out.reserved ?? 0}台</div></div>
      <div><div class="lbl">発送済みへ</div><div class="v">${out.shipped ?? 0}台</div></div>
      <div><div class="lbl">取り込み済み</div><div class="v">${out.already ?? 0}件</div></div>
      <div><div class="lbl">キャンセル</div><div class="v">${out.cancelled ?? 0}件</div></div>
      <div><div class="lbl">要確認</div><div class="v ${um.length + ns.length ? 'minus' : ''}">${um.length + ns.length}件</div></div>
    </div>
    <p class="meta" style="margin:10px 0">同じ注文をもう一度取り込んでも、在庫は二重に減りません。</p>
    ${um.length ? `<div class="sec">商品を特定できなかった注文<span class="secn">${um.length}件</span></div>
      <p class="meta" style="margin-bottom:8px">楽天の商品コードも掲載URLも、登録してある出品情報と一致しませんでした。
        <strong>在庫は動かしていません。</strong>商品コードを入れて割り当てるか、商品詳細の「楽天」行にURLを登録してください。</p>
      <div class="plist">${um.map(u => `<div class="p" style="align-items:center">
        <span class="c">${esc(u.order_number)}</span>
        <span class="meta" style="flex:1;min-width:0;word-break:break-all">${esc(u.item_code || '')} ${esc(u.item_url || '')}</span>
      </div>`).join('')}</div>
      <p class="meta" style="margin-top:8px">割り当ては在庫一覧の「楽天の注文を取り込む」からもう一度行うか、
        商品詳細で掲載URLを直してから取り込み直してください。</p>` : ''}
    ${ns.length ? `<div class="sec">在庫が足りなかった注文<span class="secn">${ns.length}件</span></div>
      <p class="meta" style="margin-bottom:8px">売れたのに、確保できる在庫（status=在庫）がありませんでした。
        在庫の登録漏れか、すでに別の経路で押さえられています。<strong>仮の個体は作っていません。</strong></p>
      <div class="plist">${ns.map(u => `<div class="p">
        <a class="c" href="#" onclick="closeModal();go('prod','${esc(u.product_code)}');return false">${esc(u.product_code)}</a>
        <span class="meta" style="margin-left:auto">注文 ${esc(u.order_number)}</span>
      </div>`).join('')}</div>` : ''}`;
}

/* 掲載URLの更新候補を採用する／そのままにする。
   URLは人が入れた値でもあるので、同期では書き換えず、ここで確認してから反映する。 */
async function acceptListingUrl(code) {
  const { data, error } = await sb.rpc('inv_listing_url_accept', { p_code: code, p_channel: 'rakuten' });
  if (error) { toast('更新できませんでした：' + error.message); return; }
  const row = $('rkurl-' + code);
  if (row) row.innerHTML = `<span class="c">${esc(code)}</span><span class="meta">掲載URLを更新しました：${esc((data || {}).url || '')}</span>`;
  await loadAll();
  toast(`${code} の掲載URLを更新しました`);
}
async function dismissListingUrl(code) {
  const { error } = await sb.rpc('inv_listing_url_dismiss', { p_code: code, p_channel: 'rakuten' });
  if (error) { toast('取り消せませんでした：' + error.message); return; }
  const row = $('rkurl-' + code);
  if (row) row.innerHTML = `<span class="c">${esc(code)}</span><span class="meta">いまのURLのままにしました（次の同期でまた差があれば知らせます）</span>`;
  await loadAll();
}

function rakutenSyncResultHtml(out) {
  // まとめ同期（画像が未取得だけ／全部／1商品）の結果
  if (out.mode) {
    const shots = (out.details || []).filter(d => d.images_added);
    return `
      <div class="prices">
        <div><div class="lbl">画像取得成功</div><div class="v ${out.images_ok ? 'plus' : ''}">${out.images_ok ?? 0}件</div></div>
        <div><div class="lbl">商品情報更新</div><div class="v ${out.updated ? 'plus' : ''}">${out.updated ?? 0}件</div></div>
        <div><div class="lbl">失敗</div><div class="v ${out.failed ? 'minus' : ''}">${out.failed ?? 0}件</div></div>
        ${out.url_mismatches ? `<div><div class="lbl">URL差異</div><div class="v minus">${out.url_mismatches}件</div></div>` : ''}
      </div>
      <p class="meta" style="margin:10px 0">対象 ${out.target_count ?? 0}商品／楽天から取得 ${out.fetched_count ?? 0}件${
        out.scanned_pages ? `（${out.scanned_pages}/${out.page_count ?? '—'}ページ・全${out.total_count ?? '—'}件・API ${out.api_requests ?? 0}回）` : ''}${
        out.unchanged ? `／変更なし ${out.unchanged}件` : ''}</p>
      ${(out.details || []).some(d => d.external_item_code_saved) ? `<p class="meta" style="margin:-4px 0 10px">
        掲載URLしか無かった商品に、楽天の正式な商品コード（itemCode）を保存しました
        （${esc((out.details || []).filter(d => d.external_item_code_saved).map(d => d.code).join('・'))}）。次回からは直接照合します。</p>` : ''}
      ${rakutenFailHtml(out)}
      ${shots.length ? `<div class="sec">写真が入った商品</div>
        <div class="plist">${shots.slice(0, 30).map(d =>
          `<div class="p"><span class="c">${esc(d.code)}</span><span>${esc(d.name || '')}</span>
            <span class="meta" style="margin-left:auto">${d.image_count}枚保存（表示は代表1枚）${
              d.matched_by ? '／' + (d.matched_by === 'url' ? 'URL一致' : 'itemCode一致') : ''}</span></div>`).join('')}</div>` : ''}
      ${(out.details || []).some(d => d.url_mismatch) ? `<div class="sec">掲載URLが楽天側と違う商品</div>
        <p class="meta" style="margin-bottom:8px">楽天が返した正式なURLと、登録してある掲載URLが違います。
          自動では書き換えていません。内容を見て「URLを更新」を押すと差し替わります
          （古いURLのままだと、次に商品を探すときに見つけられないことがあります）。</p>
        <div class="plist" id="rkUrlList">${(out.details || []).filter(d => d.url_mismatch).slice(0, 30).map(d =>
          `<div class="p" id="rkurl-${esc(d.code)}" style="align-items:flex-start">
            <span class="c">${esc(d.code)}</span>
            <span style="flex:1;min-width:0">${esc(d.name || '')}
              <div class="meta" style="word-break:break-all">いま：${esc(d.url_saved || '—')}</div>
              <div class="meta" style="word-break:break-all">楽天：<strong>${esc(d.url_candidate || '')}</strong></div></span>
            <span class="nowrap" style="margin-left:auto;display:flex;gap:6px">
              <button class="btn sm lime" onclick="acceptListingUrl('${esc(d.code)}')">URLを更新</button>
              <button class="btn sm ghost" onclick="dismissListingUrl('${esc(d.code)}')">このまま</button></span>
          </div>`).join('')}</div>` : ''}
      <p class="meta" style="margin-top:10px">公開ページ（8ec.jp）は次の読み込みから反映されます。再デプロイは要りません。</p>`;
  }
  const nums = [
    ['新規登録', out.created_count, 'plus'], ['更新', out.updated_count, 'plus'],
    ['変更なし', out.unchanged_count, ''], ['要確認', out.needs_review_count, out.needs_review_count ? 'minus' : ''],
    ['エラー', out.error_count, out.error_count ? 'minus' : '']
  ];
  return `
    <div class="prices">
      ${nums.map(([l, v, c]) => `<div><div class="lbl">${esc(l)}</div><div class="v ${c}">${v ?? 0}件</div></div>`).join('')}
    </div>
    <p class="meta" style="margin:10px 0">取得 ${out.fetched_count ?? 0}件（自社店舗の全${out.total_available ?? '—'}件中）</p>
    ${(out.needs_review || []).length ? `
      <div class="sec">要確認（候補が複数あり、自動で選べませんでした）</div>
      ${out.needs_review.map((r, i) => `
        <div class="card" style="margin-bottom:8px">
          <div style="font-weight:700">${esc(r.name || r.item_code)}</div>
          <div class="meta">型番候補: ${esc(r.model || '—')}　楽天商品コード: ${esc(r.item_code)}</div>
          <div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">
            <select class="input" id="rkPick-${i}" style="max-width:220px">
              ${(r.candidates || []).map(c => `<option value="${esc(c)}">${esc(c)}　${esc(titleOf(prod(c) || { code: c }))}</option>`).join('')}
            </select>
            <button class="btn sm" onclick="confirmRakutenLink(${i})">この商品に紐付ける</button>
          </div>
        </div>`).join('')}
    ` : ''}
    ${(out.errors || []).length ? `
      <div class="sec">エラー</div>
      ${out.errors.map(e => `<div class="meta">${esc(e.item_code || '—')}：${esc(e.message)}</div>`).join('')}
    ` : ''}
    ${(out.fetched_fields_sample || []).length ? `
      <div class="sec">取得できた項目（先頭${out.fetched_fields_sample.length}件のサンプル）</div>
      <pre class="pre" style="font-size:12px;max-height:220px;overflow:auto">${esc(JSON.stringify(out.fetched_fields_sample, null, 2))}</pre>
    ` : ''}`;
}
/* 失敗した商品の内訳。理由で分けて、商品ごとに原因と直しかたを出す。
   全部やり直さなくていいように、ここから失敗分だけ再試行できる。 */
function rakutenFailHtml(out) {
  const fails = out.failures || [];
  if (!fails.length) return '';
  const groups = [];
  RK_FAIL_ORDER.concat(['unknown']).forEach(r => {
    const list = fails.filter(f => (RK_FAIL[f.reason] ? f.reason : 'unknown') === r);
    if (list.length) groups.push({ r, list });
  });
  return `<div class="sec">同期できなかった商品<span class="secn">${fails.length}商品</span></div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
      <button class="btn sm lime" onclick="retryRakutenFailed()">失敗した${fails.length}商品のみ再試行</button>
      <span class="meta">成功したぶんはやり直しません（全${out.target_count ?? '—'}件の再同期は不要です）。</span>
    </div>
    ${groups.map(g => {
      const meta = RK_FAIL[g.r] || { label: '原因不明', hint: '' };
      return `<div class="card" style="margin-bottom:10px">
        <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
          <strong>${esc(meta.label)}</strong>
          <span class="tag stk-few">${g.list.length}商品</span>
        </div>
        ${meta.hint ? `<div class="meta" style="margin-top:4px">${esc(meta.hint)}</div>` : ''}
        <div class="plist" style="margin-top:8px">${g.list.slice(0, 50).map(f =>
          `<div class="p"><a class="c" href="#" onclick="closeModal();go('prod','${esc(f.code)}');return false">${esc(f.code)}</a>
            <span>${esc(f.name || '')}</span>
            <span class="meta" style="margin-left:auto;word-break:break-all">${esc(f.detail || f.item_code || f.url || '')}</span>
          </div>`).join('')}${g.list.length > 50 ? `<div class="meta">ほか ${g.list.length - 50}商品</div>` : ''}</div>
      </div>`;
    }).join('')}`;
}

async function confirmRakutenLink(i) {
  const r = (rakutenLastResult && rakutenLastResult.needs_review || [])[i];
  const sel = $('rkPick-' + i);
  if (!r || !sel || !sel.value) return;
  const { error } = await sb.rpc('inv_rakuten_link_confirm', { p_code: sel.value, p_item: r.item });
  if (error) { toast(error.message || '紐付けられませんでした'); return; }
  await loadAll();
  render();
  toast(sel.value + ' に紐付けました');
  rakutenLastResult.needs_review = rakutenLastResult.needs_review.filter((_, idx) => idx !== i);
  const host = $('rkResult');
  if (host) host.innerHTML = rakutenSyncResultHtml(rakutenLastResult);
}

/* ---- 商品取込の入口 ----
   使う人から見れば「商品・在庫を足す」1つの操作なので、入口も1つにする。
   同じモーダルの中で「CSVから取り込む」と「1件だけ登録」を切り替える
   （タブを分けるだけで、開くボタンはひとつ）。
   CSVは列の名前を見て自動で見分けるから、どれを持ってきたのかを選ばせない。
     自社落札CSV … 毎週の仕入。ここから商品と個体が増えていく（こちらが基準）
     既存在庫CSV … これまでの在庫表。販売状況や保管場所を補う（初期移行・照合用）
   CSVに載らないものは、同じモーダルの「1件だけ登録」タブで手で入れる。 */
let importTab = 'csv';
function openImport() {
  if (!canAdmin()) { toast('取り込みは管理者だけができます'); return; }
  importTab = 'csv';
  paintImportModal();
}
function setImportTab(t) { importTab = t === 'one' ? 'one' : 'csv'; paintImportModal(); }
function paintImportModal() {
  const csv = importTab !== 'one';
  openModal('商品取込', `
    <div class="seg" style="margin-bottom:16px">
      <button class="${csv ? 'on' : ''}" onclick="setImportTab('csv')">CSVから取り込む</button>
      <button class="${csv ? '' : 'on'}" onclick="setImportTab('one')">1件だけ登録</button>
    </div>
    ${csv ? importCsvBody() : importOneBody()}
  `, csv
    ? [['閉じる', 'closeModal()', 'btn ghost'],
       ...(db.imports.length ? [['取込履歴', 'closeModal();openImportHist()', 'btn ghost']] : [])]
    : [['閉じる', 'closeModal()', 'btn ghost'],
       ['登録してQR発行', 'doQuickRegister()', canAdmin() ? 'btn pri' : 'btn pri disabled']]);
  if (!csv) setTimeout(previewId, 0);
}
function importCsvBody() {
  return `
    <div class="drop" id="drop"
         ondragover="dropOver(event,true)" ondragleave="dropOver(event,false)" ondrop="dropFile(event)">
      <span class="ms">upload_file</span>
      <div class="t">CSVファイルをここにドラッグ＆ドロップ</div>
      <button class="btn lime" onclick="pickImport()">ファイルを選ぶ</button>
    </div>
    <p class="meta" style="margin-top:12px">
      <strong>列の名前を見て、どのCSVかは自動で判別します。</strong>選ぶ必要はありません。
      次の画面で中身を確認してから登録します。<strong>すでに登録した個体は二重に入りません。</strong></p>
    <div class="impkinds">
      <div><span class="ms">shopping_cart</span>
        <div><b>自社落札CSV</b>（<code>開催日</code>・<code>出品番号</code>・<code>個品ID</code>・<code>落札価格</code>）<br>
          毎週の仕入。<strong>ここで登録した商品と個体が、そのまま在庫一覧になります。</strong>
          管理番号とQRは1台ずつ発行します。</div></div>
      <div><span class="ms">inventory</span>
        <div><b>既存在庫CSV</b>（<code>商品ID</code>・<code>型番</code>・<code>管理番号一覧</code>・<code>現在庫</code>）<br>
          これまでの在庫表。出品状態・保管場所などを補います。
          <strong>管理番号・S/N・仕入価格・原価は書き換えません。</strong></div></div>
    </div>
    ${db.imports.length ? `<div class="lbl" style="margin:16px 0 6px">前回の取込</div>
      <div class="meta">${esc(fmtDT(db.imports[0].imported_at))}　${esc(db.imports[0].file_name || '')}
        商品 ${db.imports[0].product_count}／個体 ${db.imports[0].item_count}　${esc(db.imports[0].actor || '')}</div>` : ''}
  `;
}
/* CSVに無いものを、この場で1件だけ登録する。項目は商品登録画面の1件ずつフォームと同じ
   （regFieldsBody を共用）。個体管理／数量管理の切り替えはこのタブだけを描き直す */
function importOneBody() {
  const ind = ui.regKind === 'ind';
  const cats = catsFor(ind ? 'individual' : 'quantity');
  return `
    <p class="meta" style="margin-bottom:2px">CSVに無いものを、この場で1件だけ登録します。</p>
    ${regFieldsBody(ind, cats, 'setQuickKind')}
    <p class="meta" style="margin-top:4px">発行予定の${ind ? '管理番号' : '商品コード'}: <b id="idPreview" class="num">—</b></p>
    ${canAdmin() ? '' : '<div class="card" style="margin-top:10px">商品の登録は管理者だけができます。</div>'}
  `;
}
function setQuickKind(k) { ui.regKind = k === 'qty' ? 'qty' : 'ind'; paintImportModal(); }
/* doRegister() は商品登録画面と同じ関数をそのまま使う。
   成功すると ui.made が立つので、それを見てモーダルだけ閉じる
   （doRegister 自身は一覧の再描画とトーストまでやってくれる） */
async function doQuickRegister() {
  ui.made = null;
  await doRegister();
  if (ui.made) { closeModal(); ui.made = null; }
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
    <span class="meta">最終取込　${esc(fmtDT(last.imported_at))}　${esc(last.file_name || '')}
      商品 ${last.product_count}／個体 ${last.item_count}　${esc(last.actor || '')}</span>
  </div>`;
}
function openImportHist() {
  openModal('CSV取込履歴', db.imports.length ? `
    <div class="table-wrap"><table class="t">
      <thead><tr><th>取込日</th><th>ファイル名</th><th class="r">商品</th><th class="r">個体</th>
        <th class="r">重複スキップ</th><th>登録者</th><th></th></tr></thead>
      <tbody>${db.imports.map(r => `<tr>
        <td class="nowrap num">${esc(fmtDT(r.imported_at))}</td>
        <td>${esc(r.file_name || '—')}${r.summary ? `<div class="meta">${esc(r.summary)}</div>` : ''}</td>
        <td class="r num">${r.product_count}</td>
        <td class="r num">${r.item_count}</td>
        <td class="r num">${(r.skips || []).length
          ? `<button class="btn sm ghost" onclick="showSkips(${r.id})">${r.skip_count || (r.skips || []).length}件</button>`
          : `<span class="meta">${r.skip_count || 0}</span>`}</td>
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
  ui.q = ''; ui.fCat = ''; ui.fMaker = ''; ui.fLoc = ''; ui.fStock = ''; ui.fSt = '';
  ui.fDiff = false; ui.fNoPrice = false; ui.sel = {}; ui.selItems = {};
  // 取り込んだ直後は、いま入れたものが見えないと意味がない。サイト別のタブからは戻す
  if (ui.listMode !== 'model') ui.listMode = 'unit';
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
      ${(b.skips || []).length ? `<div class="meta">重複スキップ ${b.skip_count || b.skips.length}件
        <a href="#" onclick="showSkips(${b.id});return false">詳細を見る</a></div>` : ''}
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

/* 出品状態のことば。読めない書き方（「なし」「-」など）は状態にしない。
   「未出品」は行そのものを作らないことで表すので、状態としては持たせない */
const listState = (s) => {
  const t = String(s == null ? '' : s).trim();
  return LIST_STATES_IN.indexOf(t) >= 0 ? t : null;
};

/* 備考に「楽天コード: R-123」「AmazonSKU B0XXXXXX」のように書かれている販売用コードを、
   販売サイトの情報として切り出す。元の文は消さず、備考にはそのまま残す */
const SKU_WORDS = 'SKU|ＳＫＵ|コード|管理番号|商品管理番号|販売コード|販売用コード';
function skusFromNote(text) {
  const out = [];
  const s = String(text == null ? '' : text);
  if (!s) return out;
  CHANNELS.forEach(c => {
    const m = s.match(new RegExp(c.label + '\\s*(?:' + SKU_WORDS + ')\\s*[:：=＝]?\\s*([A-Za-z0-9][\\w.\\-]{2,})'));
    if (m) out.push({ channel: c.key, sku: m[1] });
  });
  return out;
}
/* 切り出した販売用コードを、出品情報に足す（すでにSKUが入っていればそのまま） */
function mergeSkus(chans, text) {
  skusFromNote(text).forEach(({ channel, sku }) => {
    const c = chans.find(x => x.channel === channel);
    if (!c) chans.push({ channel, state: null, sku });
    else if (!c.sku) c.sku = sku;
  });
  return chans;
}

/* 販売情報。サイト別の列（Amazon出品状態 / Amazon URL / AmazonSKU / Amazon価格 …）と、
   書き出しの「販売状況」（Amazon:出品中 ｜ 楽天:…）のどちらでも読む */
function readChannels(idx, row) {
  const out = [];
  CHANNELS.forEach(c => {
    const st = cellAny(idx, row, [c.label + '出品状態', c.label + '状態', c.label + '出品']);
    const url = cellAny(idx, row, [c.label + ' URL', c.label + 'URL']);
    const sku = cellAny(idx, row, [c.label + 'SKU', c.label + ' SKU', c.label + 'コード', c.label + '商品管理番号']);
    const pr = numOf(cellAny(idx, row, [c.label + '価格', c.label + '販売価格']));
    if (!st && !url && !sku && pr == null) return;
    const e = { channel: c.key, state: listState(st) };
    if (sku) e.sku = sku;
    if (pr != null && !isNaN(pr)) e.price = pr;
    if (/^https?:/i.test(url)) e.url = url;
    else if (url) e.note = url;
    if (st && !e.state && st !== '未出品') e.note = (e.note ? e.note + ' ／ ' : '') + st;
    // 「未出品」しか書かれていない列は、何も持たせない
    if (!e.state && !e.sku && !e.url && !e.note && e.price == null) return;
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
    if (st === '未出品' || st === '未設定') return;
    out.push({ channel: c.key, state: listState(st), note: listState(st) ? null : st });
  });
  return out;
}

/* --- (1) この画面が書き出した形 --- */
function planMaster(H, idx, body, file, encoding, headRow) {
  const add = [], skip = [], bad = [], dups = [];
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

    // 同じ管理番号がCSVの2行に出てくることがある。1台は1回しか入れない。
    // 黙って消さず、飛ばしたものは理由つきで控えておく
    const nos = [];
    (g('管理番号一覧') || '').split('/').map(x => x.trim()).filter(Boolean).forEach(no => {
      if (seenNo[no]) { dups.push({ id: no, why: seenNo[no], line }); return; }
      seenNo[no] = `${line}行目にすでにあります`;
      nos.push(no);
    });
    // 商品はあっても管理番号が入っていないことがある。足りない個体だけ足す。
    // 商品は作らないが、出品状態だけは拾って足す（在庫一覧CSVを補完に使う目的そのもの）
    if (exists && !nos.length) {
      skip.push({ line, key: exists.code, name: titleOf(exists), code: exists.code,
                  channels: mergeSkus(readChannels(idx, row), g('備考')) });
      return;
    }
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
      // 出品状態は、すでにある商品にも足す（入っている値は上書きしない決まりなので安全）。
      // 備考に紛れている販売用コードも、ここで販売サイトの情報に分ける
      channels: mergeSkus(readChannels(idx, row), g('備考'))
    };
    if (!twin) seen[dupKey] = entry;
    add.push(entry);
  });
  return { mode: 'master', add, skip, bad, dups, file, encoding };
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
    const first = rest.split(/[/,]/).map(x => x.trim()).find(x => LIST_STATES_IN.indexOf(x) >= 0) || null;
    out.push({ channel: key, state: first, note: rest });
  });
  return out;
}

function planLegacy(H, idx, body, file, encoding, headRow) {
  const add = [], skip = [], bad = [], dups = [];
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
      if (seenNo[no]) {
        dropped.push(`${no}（${seenNo[no]}）`);
        dups.push({ id: no, why: seenNo[no], line });
        return;
      }
      seenNo[no] = `${line}行目にすでにあります`;
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
      skip.push({ line, key: exists.code, name: titleOf(exists), code: exists.code,
                  channels: mergeSkus(chans, g('備考')) });
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
      channels: mergeSkus(chans, g('備考')),
      dropped: dropped.length,
      repair: !!exists
    };
    if (!twin) seenModel[mk] = entry;
    add.push(entry);
  });
  return { mode: 'legacy', add, skip, bad, dups, file, encoding };
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
  if (!n) return [];
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
  const withId = s.kids.filter(k => k.id);
  const same = qty === withId.length && withId.length === s.kids.length;
  const buy = splitEven(x.lot.buy, qty), fee = splitEven(x.lot.fee, qty);
  const src = withId.map(k => k.id).join(' / ') || null;
  const out = [];
  for (let i = 0; i < qty; i++) {
    const k = same ? s.kids[i] : s.kids[0];
    out.push({
      id: same ? k.id : null,              // null なら取り込むときに採番する
      source_id: same ? null : src,        // 個品IDが無いCSVでは null（残すものが無い）
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
const costPer = (x) => x.lot.qty ? x.lot.cost / x.lot.qty : 0;   // 0台なら0
const gainPer = (x) => x.plan == null ? null : x.plan - costPer(x);
const gainLot = (x) => x.plan == null ? null : x.plan * x.lot.qty - x.lot.cost;

function planPurchase(H, idx, body, file, encoding, headRow) {
  const add = [], skip = [], bad = [], dups = [];
  const seenNo = {}, seenLot = {}, seenSn = {};
  db.items.forEach(i => {
    seenNo[i.id] = 'すでに在庫にあります';
    // 採番して入れたものは、元の個品IDでも二重登録を防げるようにする
    String(i.source_id || '').split('/').forEach(v => {
      const t = v.trim(); if (t) seenNo[t] = 'すでに在庫にあります';
    });
    // 照合は 管理番号・個品ID → S/N → 型番 の順。S/Nは実物1台を指す。
    // 「不明」「-」「N/A」のような未記入の代わりの値は、一致判定に使わない
    const sn = normSn(i.serial);
    if (!isDummySn(sn)) seenSn[sn] = i.id;
  });

  // 出品番号ごとにまとめる。
  //   親  … 総数・構成・落札価格を持つ行
  //   子  … 個品IDや仕様を持つ行
  // 落札価格も個品IDも入っていないCSVがある（在庫側から出した、列だけ同じ形のもの）。
  // 型番と総数さえあれば登録できるので、価格と個品IDは「あれば使う」扱いにする。
  const lots = [], byLot = {};
  body.forEach((row, n) => {
    const line = headRow + 2 + n;
    const g = h => cell(idx, row, h);
    const no = g('出品番号');
    if (!no) return;
    let lot = byLot[no];
    if (!lot) { lot = byLot[no] = { no, line, parent: null, detail: null, kids: [], rows: [] }; lots.push(lot); }
    lot.rows.push({ line, row });
    if (!lot.parent && (g('総数') || g('構成') || g('落札価格'))) lot.parent = { line, row };
    else if (!lot.detail) lot.detail = { line, row };
    if (g('個品ID') || g('個品ID(バーコード)')) lot.kids.push({ line, row });
  });

  lots.forEach(lot => {
    const key = lot.no;
    if (!lot.parent) lot.parent = lot.rows[0];
    if (!lot.detail) lot.detail = lot.kids[0] || lot.parent;
    const line = lot.parent.line;
    const P = h => cell(idx, lot.parent.row, h);
    const D = h => cell(idx, lot.detail.row, h);

    if (seenLot[key]) { bad.push({ line, key, reason: 'dup', why: `${seenLot[key]}行目と出品番号が重複しています` }); return; }
    seenLot[key] = line;

    const model = P('型番') || D('型番') || lot.rows.map(r => cell(idx, r.row, '型番')).find(Boolean) || '';
    if (!model) { bad.push({ line, key, reason: 'no-model', why: '型番が空です' }); return; }

    const kids = [], dropped = [];
    let already = 0;
    lot.kids.forEach(k => {
      const id = cell(idx, k.row, '個品ID(バーコード)') || cell(idx, k.row, '個品ID');
      if (!id) return;
      if (seenNo[id]) {
        dropped.push(`${id}（${seenNo[id]}）`);
        dups.push({ id, why: seenNo[id], line: k.line });
        already++; return;
      }
      // 個品IDが新しくても、S/Nが一致すれば同じ実物。二重に登録しない。
      // ただし「不明」「-」「N/A」のような未記入の代わりの値は判定に使わない
      // （無関係などうしを同じS/Nとして片方だけ登録してしまう事故になるため）
      const sn = normSn(cell(idx, k.row, 'Ｓ／Ｎ'));
      const snUsable = !isDummySn(sn);
      if (snUsable && seenSn[sn]) {
        const why = `S/N ${sn} が ${seenSn[sn]} と同じです`;
        dropped.push(`${id}（${why}）`);
        dups.push({ id, why, line: k.line });
        already++; return;
      }
      seenNo[id] = `${k.line}行目にすでにあります`;
      if (snUsable) seenSn[sn] = `${k.line}行目`;
      kids.push({ id, row: k.row });
    });
    // 同じCSVをもう一度入れたとき。「取り込めない」ではなく「すでにある」として出す
    if (already && !kids.length) { skip.push({ line, key, name: model, units: [] }); return; }

    const maker = P('メーカー') || D('メーカー') || '';
    const buy = numOf(P('落札価格')) || 0;
    const fee = numOf(P('落札料')) || 0;
    const cost = buy + fee;
    const bought = ymd8(P('開催日'));

    // 在庫数の基準は個品IDの数ではなく「総数」。
    // セット出品は個品IDが1つでも現物は9個ある、という形で来るため。
    // 総数0は「在庫なし」。商品は作るが個体は作らない（1台に化かさない）。
    // 総数の欄そのものが無いときだけ、個品IDの数で代用する。
    // ロットの中の一部だけ重複（個品IDやS/Nがすでに登録済み）だったときは、
    // その分だけ総数から差し引く。既存の1台を二重に数えないため
    // （全部が重複のときは already && !kids.length で早く抜けるので、ここには来ない）
    const tt = numOf(P('総数'));
    const csvQty = tt == null || isNaN(tt) ? (kids.length || 1) : Math.max(0, tt - already);
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
        // 個品IDが1つも無いCSVもある。そのときは明細の行から仕様や状態だけもらう
        kids: kids.length ? kids.map(k => ({
          id: k.id,
          serial: cell(idx, k.row, 'Ｓ／Ｎ') || null,
          note: purchaseNote(idx, k.row) || null
        })) : [{ id: null, serial: null, note: purchaseNote(idx, lot.detail.row) || null }]
      },
      sharesWith: known ? known.code : (earlier ? earlier.key : null),
      master: {
        code: known ? known.code : null, name: model, model, maker: maker || null,
        category_id: null, kind: 'individual',
        spec: purchaseSpec(idx, lot.detail.row) || null,
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
  return { mode: 'purchase', add, skip, bad, dups, file, encoding };
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
  if (isNaN(n) || n < 0 || n > 999) return;          // 入力の途中は触らない
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
  'cat-off': 'カテゴリが無効',
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

/* ---- 在庫一覧のカテゴリー絞り込み ----
   子を持つカテゴリー（パソコン）は3通り選べるようにする。
     pc           パソコン（すべて）… 親と子をまとめて
     pc:only      パソコン（未分類）… 親に直接ぶら下がっているものだけ
     notebook-pc  ノートパソコン
   既存のPC商品は親のまま残しているので、「未分類」で拾えるようにしておく。 */
function catFilterOptions(sel) {
  return catsOrdered().map(c => {
    const kids = catHasKids(c.id);
    const pad = '\u3000'.repeat(catDepth(c.id));
    const one = (v, label) => `<option value="${esc(v)}"${sel === v ? ' selected' : ''}>${esc(pad + label)}</option>`;
    if (!kids) return one(c.id, c.name + (catLive(c) ? '' : '（無効）'));
    return one(c.id, c.name + '（すべて）') + one(c.id + ':only', c.name + '（未分類）');
  }).join('');
}
function catFilterHit(id) {
  const f = ui.fCat;
  if (!f) return true;
  if (f.endsWith(':only')) return id === f.slice(0, -5);
  return catTree(f).includes(id);
}

/* 未登録の値に対する読み替えの選択肢 */
function fixSelect(reason, value, kind) {
  const isLoc = reason.indexOf('loc') === 0;
  const cur = isLoc ? impMap.loc[value] : impMap.cat[value];
  const opts = isLoc
    ? locsOrdered().filter(l => locLive(l) || cur === l.id)
        .map(l => `<option value="${esc(l.id)}"${cur === l.id ? ' selected' : ''}>${esc(locLabel(l.id))}</option>`).join('')
    : catsFor(kind || 'individual', cur)
        .map(c => `<option value="${esc(c.id)}"${cur === c.id ? ' selected' : ''}>${esc(catOptLabel(c))}</option>`).join('');
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
          <input class="input num qty" type="number" min="0" max="999" step="1" id="pq-${i}"
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
  const zeroQty = p.add.filter(x => x.lot && x.lot.qty === 0).length;
  const noPrice = buy && p.add.length && p.add.every(x => !x.lot.cost);

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
          ${catsFor('individual').map(c => `<option value="${esc(c.id)}"${catHasKids(c.id) ? ' disabled' : ''}>${
            esc(catOptLabel(c))}</option>`).join('')}
        </select></label>
        <label class="field"><span>保管場所 *</span>
          <select class="input" id="impLoc">${locOptions(defaultImportLoc(), '選択してください')}</select></label>
      </div>
      ${dropped ? `<p class="meta" style="margin:10px 0 0">個品IDが空か重複していた <strong>${dropped}行</strong> は取り込みません。</p>` : ''}
    </div>` : ''}

    ${buy && (zeroQty || noPrice) ? `<div class="card" style="margin-bottom:15px">
      <div class="lbl" style="margin-bottom:5px">このCSVで分かること・分からないこと</div>
      ${noPrice ? `<strong>落札価格が入っていないので、原価は空のまま登録します。</strong>
        値段はあとから個体詳細の「値段を直す」で入れられます。<br>` : ''}
      ${zeroQty ? `総数が0の <strong>${zeroQty}件</strong> は<strong>商品だけ作り、個体は作りません</strong>（在庫なしとして正しい形です）。
        次に仕入れたぶんが、この商品にぶら下がります。<br>` : ''}
      ${p.add.some(x => x.lot.qty > 0 && !x.src.kids.some(k => k.id))
        ? '個品IDが入っていない出品番号は、<strong>総数ぶんの管理番号を発行</strong>します。' : ''}
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
          ${catsFor('individual').map(c => `<option value="${esc(c.id)}"${catHasKids(c.id) ? ' disabled' : ''}>${
            esc(catOptLabel(c))}</option>`).join('')}
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
  // 商品は作らずに飛ばした行でも、出品状態だけは足す。
  // 既存在庫CSVを「補完に使う」のはまさにこの形（商品は自社落札CSVで作られている）
  (p.skip || []).forEach(s => {
    (s.channels || []).forEach(c => chans.push(Object.assign({ product_code: s.code }, c)));
  });

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

  // 飛ばした管理番号は、黙って消えたように見せない。
  // CSVの中で重複していたぶんと、DBにすでにあったぶんをまとめて控える
  const skips = (p.dups || []).map(d => ({ id: d.id, why: d.why, line: d.line || null }))
    .concat(dupIds.map(id => ({ id, why: 'すでに在庫にあります', line: null })));

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
  let chanAdded = 0;
  try {
    if (units.length) await ins('inventory_items', units, 'id');
    // 出品情報はDBの関数に任せる。すでに入っている値は上書きせず、空いている欄だけ埋める
    for (let i = 0; i < chans.length; i += 200) {
      const { data, error } = await sb.rpc('inv_listings_import', { p_rows: chans.slice(i, i + 200) });
      if (error) throw new Error('出品情報を入れられませんでした：' + error.message);
      chanAdded += (data && data.added) || 0;
    }
    if (txs.length) await ins('inventory_transactions', txs);
    // 履歴は最後に入れる。ここまで通ってはじめて「取り込めた」と言えるため
    const { data, error } = await sb.from('inventory_imports').insert({
      actor: me.name, file_name: p.file, kind: p.mode,
      product_count: touched.length, item_count: units.length,
      product_codes: touched,
      item_ids: units.map(u => u.id),      // 今回のQRだけまとめて印刷するのに使う
      skip_count: skips.length,
      skips: skips.slice(0, 2000),         // 履歴からも中身を見られるようにする
      summary: (wasBuy
        ? `新規 ${madeProds}商品／既存へ追加 ${touched.length - madeProds}商品`
          + `／原価 ${yen(t.cost)}／想定利益 ${t.priced ? yen(t.gain) : '—'}`
        : `新規 ${madeProds}商品`)
        + (skips.length ? `／重複スキップ ${skips.length}件` : '')
    }).select();
    if (!error && data && data[0]) batchId = data[0].id;
  } catch (e) { toast(e.message); return; }

  importPlan = null; importSrc = null;
  impMap.loc = {}; impMap.cat = {}; planPrice = {}; planQty = {};
  await loadAll();
  // 取り込んだら商品管理一覧に戻り、今回の分だけを出す。
  // 「今回登録した商品 ○件」の帯（batchBanner）に重複スキップの件数と詳細リンクも出るので、
  // ここでさらにモーダルは開かない（操作を増やしすぎない）
  if (batchId) showBatch(batchId, true); else { ui.fBatch = null; ui.doneBatch = null; go('list'); }
  const listed = chanAdded ? `／出品情報 ${chanAdded}件` : '';
  const skipped = skips.length ? `／重複スキップ ${skips.length}件` : '';
  toast(wasBuy ? `商品 ${touched.length}件・個体 ${units.length}台を登録しました（原価 ${yen(t.cost)}／想定利益 ${t.priced ? yen(t.gain) : '—'}）${skipped}`
               : `${madeProds}商品・${units.length}台を取り込みました${listed}${skipped}`);
}

/* 飛ばした管理番号の一覧。取込直後からも、取込履歴からも同じものを開く */
function showSkips(id) {
  const b = batchOf(id);
  const rows = (b && b.skips) || [];
  openModal(`重複スキップ ${rows.length}件`, rows.length ? `
    <p class="meta" style="margin-bottom:12px">${b ? esc(fmtDT(b.imported_at)) + '　' + esc(b.file_name || '') : ''}</p>
    <div class="table-wrap" style="max-height:52vh;overflow:auto"><table class="t">
      <thead><tr><th>管理番号</th><th>スキップ理由</th><th>CSVの行</th></tr></thead>
      <tbody>${rows.map(s => `<tr>
        <td class="num" style="font-weight:600">${esc(s.id)}</td>
        <td>${esc(s.why || '重複')}</td>
        <td class="meta num">${s.line ? s.line + '行目' : '—'}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <p class="meta" style="margin-top:10px">同じ現物を二重に登録しないために飛ばしています。
      在庫は増えていません。</p>`
    : '<div class="empty">飛ばした管理番号はありません。</div>',
    [['閉じる', 'closeModal()', 'btn ghost'],
     ...(b ? [['取込履歴', 'closeModal();openImportHist()', 'btn ghost']] : [])]);
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
        <span id="itemRentTag">${GONE.includes(it.status) ? '' : rentalTag(it)}</span>
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
        ${op('undo', '予約解除', `sheetUnreserve('${esc(it.id)}')`, false, it.status === '販売予約')}
        ${op('fact_check', '棚卸確認', `checkItem('${esc(it.id)}')`)}
        <span id="itemRentOps" style="display:contents">${rentalOpsHtml(it)}</span>
        ${canAdmin() ? op('delete', '廃棄', `sheetScrap('${esc(it.id)}')`) : ''}
      </div>
    </div>
    <div class="sidebox">
      ${itemPhoto(m)}
      <div class="qrbox">
        <img src="${qr(url)}" alt="${esc(it.id)} のQRコード" width="140" height="140">
        <div class="u">${esc(url)}</div>
      </div>
    </div>
  </div>
  ${itemListings(it)}
  ${m && m.spec ? `<div class="sec">スペック</div><div class="pre">${esc(m.spec)}</div>` : ''}
  ${it.note ? `<div class="sec">備考</div><div class="pre">${esc(it.note)}</div>` : ''}
  ${it.legacy_note ? `<div class="sec">旧データ備考</div><div class="pre legacy">${esc(it.legacy_note)}</div>` : ''}
  <div class="sec">この機器の履歴</div>
  ${hist.length ? hist.map(txRow).join('') : '<div class="empty">まだ記録はありません。</div>'}`;
}

/* ---- その1台の出品 ----
   在庫一覧には「出しているサイト」だけを出し、細かい中身はここで持つ。
   1台ぶんの設定が無いサイトは、商品まるごとの出品情報をそのまま当てて見せる
   （移行前のデータは型番単位でしか無いので、それを個体の画面でも読めるようにする）。 */
function itemListings(it) {
  const rows = CHANNELS.map(c => ({ c, x: listingOf(it, c.key) || {} }));
  const live = rows.filter(r => r.x.state === LISTED);
  const own = listingsOf(it.id).filter(x => x.state === LISTED);
  return `<div class="sec">出品先<span class="secn">${
      live.length ? `出品中 ${live.length}サイト` : '未出品'}</span></div>
    ${GONE.includes(it.status) && own.length ? `<div class="warnbox">
      <span class="ms">warning_amber</span>
      <div style="flex:1;min-width:160px">この1台は<strong>${esc(it.status)}</strong>ですが、
        ${esc(own.map(x => chanLabel(x.channel)).join('・'))}に出品中のままです。出品停止を確認してください。</div>
      <button class="btn sm" onclick="stopListings('${esc(it.id)}')" ${dis()}>販売サイト側の対応済み</button>
    </div>` : ''}
    <div class="table-wrap"><table class="t">
      <thead><tr><th>販売サイト</th><th>出品状態</th><th class="r">販売価格</th>
        <th>SKU・商品管理番号</th><th>商品URL</th>${canEdit() ? '<th></th>' : ''}</tr></thead>
      <tbody>${rows.map(({ c, x }) => `<tr>
        <td class="nowrap"><span class="tag ch ${x.state === LISTED ? 'on' : ''}">${esc(c.short)}</span> ${esc(c.label)}</td>
        <td class="nowrap">${x.state
            ? `<span class="tag ${x.state === LISTED ? 'ch on' : 'act'}">${esc(x.state)}</span>`
            : '<span class="meta">未出品</span>'}${
            x.fromProduct ? '<div class="meta">型番まとめての設定</div>' : ''}</td>
        <td class="num r">${x.price == null ? '<span class="meta">—</span>' : yen(x.price)}</td>
        <td class="num">${esc(x.sku || '') || '<span class="meta">—</span>'}</td>
        <td>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener" class="meta">開く</a>`
                    : '<span class="meta">—</span>'}</td>
        ${canEdit() ? `<td class="nowrap"><button class="btn sm ghost"
          onclick="sheetListing('${esc(it.id)}','${c.key}')">編集</button></td>` : ''}
      </tr>`).join('')}</tbody>
    </table></div>`;
}

function sheetListing(id, ch) {
  const it = item(id); if (!it) return;
  const c = CHANNELS.find(x => x.key === ch) || { label: ch, short: ch };
  const own = listingsOf(id).find(x => x.channel === ch);
  const up = channelsOf(it.product_code).find(x => x.channel === ch);
  const x = own || {};
  const n = (v) => (v == null || v === '') ? '' : String(v);
  openSheet({
    title: c.label + 'の出品', subject: id, cta: '保存',
    hint: `<strong>この1台ぶん</strong>の出品情報です。「未出品」にすると、この1台の設定は消えます。${
      !own && up ? `<br>いまは型番まとめての設定（${esc(up.state || '未設定')}）が当たっています。` : ''}`,
    body: `<label class="field" style="margin-bottom:10px"><span>出品状態</span>
        <select class="input" id="sheetVal"><option value="">未出品</option>
        ${LIST_STATES.map(s => `<option${x.state === s ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
      <label class="field" style="margin-bottom:10px"><span>販売価格</span>
        <input class="input num" type="number" min="0" step="100" id="lsPrice"
               value="${esc(n(x.price))}" placeholder="このサイトでの売値"></label>
      <div class="prow"><span>原価</span><b class="num">${costOf(it) ? yen(costOf(it)) : '—'}</b></div>
      <div class="prow"><span>自社の販売予定価格</span><b class="num">${
        planOf(it) == null ? '—' : yen(planOf(it))}</b></div>
      <label class="field" style="margin:10px 0"><span>SKU・商品管理番号</span>
        <input class="input" id="lsSku" value="${esc(x.sku || '')}" placeholder="そのサイトでの商品コード"></label>
      <label class="field" style="margin-bottom:10px"><span>商品URL</span>
        <input class="input" id="lsUrl" value="${esc(x.url || '')}" placeholder="https://…"></label>
      <label class="field"><span>メモ（任意）</span>
        <input class="input" id="lsNote" value="${esc(x.note || '')}"></label>`,
    run: (state) => saveListing(id, null, ch, state, {
      price: numField('lsPrice'), sku: ($('lsSku') || {}).value,
      url: ($('lsUrl') || {}).value, note: ($('lsNote') || {}).value
    })
  });
}

/* 出品情報の保存はDBの関数を通す。状態が変わったときだけ履歴に残る */
async function saveListing(itemId, code, ch, state, more) {
  const { data, error } = await sb.rpc('inv_listing_set', {
    p_item_id: itemId || null, p_code: code || null, p_channel: ch,
    p_state: state || null, p_sku: (more || {}).sku || null,
    p_price: (more || {}).price == null ? null : (more || {}).price,
    p_url: (more || {}).url || null, p_note: (more || {}).note || null
  });
  if (error) { toast('保存できませんでした：' + error.message); return; }
  // 未出品にしたときは行を消している。中身が空の返りは「消えた」とみなす
  const row = (data && data.id != null) ? data : null;
  const same = (v) => itemId ? v.item_id === itemId && v.channel === ch
                             : !v.item_id && v.product_code === code && v.channel === ch;
  const i = db.channels.findIndex(same);
  if (!row) { if (i >= 0) db.channels.splice(i, 1); }
  else if (i >= 0) db.channels[i] = row;
  else db.channels.push(row);
  reindexChannels();
  await refreshTx();
  render();
  toast(row ? `${chanLabel(ch)}の出品情報を保存しました` : `${chanLabel(ch)}を未出品にしました`);
}

/* 売れた・捨てたのに出たままになっている出品を、まとめて出品停止にする */
async function stopListings(id) {
  const on = listingsOf(id).filter(x => x.state === LISTED);
  if (!on.length) return;
  toast('出品を止めています…');
  for (const x of on) {
    const { error } = await sb.rpc('inv_listing_set', {
      p_item_id: id, p_code: null, p_channel: x.channel, p_state: '出品停止',
      p_sku: x.sku || null, p_price: x.price == null ? null : x.price,
      p_url: x.url || null, p_note: x.note || null
    });
    if (error) { toast('止められませんでした：' + error.message); return; }
    x.state = '出品停止';
  }
  reindexChannels();
  await refreshTx();
  render();
  toast(`${on.length}サイトを出品停止にしました`);
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
      k === 'sales' ? `<span class="n">${prodLiveOn(p).length}</span>` : ''}</button>`).join('')}</div>
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
    ${ind ? rentalBox(p) : ''}
    ${ind ? imagesBox(p) : ''}
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
          <span class="ms">paid</span><span class="t">売れた</span></button>
        <button class="btn" onclick="sheetSaleReserve('${esc(p.code)}')" ${dis()}>
          <span class="ms">local_mall</span><span class="t">楽天等で受注</span></button>`}
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

/* 個体詳細に出す商品写真。
   個体ごとに画像は持たず、商品マスター（inventory_products）の画像を見る。
     個体 00039769953 → 商品 P-00536 → inventory_products.images → 表示
   画面を開くときに楽天APIは呼ばない（楽天同期で保存済みの画像だけを使う）。
   在庫管理の画面なので、8RENT用の画像より一般の商品画像を優先する：
     image_url → images[0] → rental_image_url → rental_images[0] → 画像準備中
   同じ商品の個体が10台あっても、全部この1枚を参照する（画像の重複保存はしない）。 */
function productPhotoUrl(p) {
  if (!p) return null;
  // http(s) かサイト内の絶対パスだけ通す（相対パス・空文字で壊れた画像を出さない）
  const ok = (u) => {
    const v = typeof u === 'string' ? u.trim() : '';
    return v && (/^https?:\/\//i.test(v) || v.startsWith('/')) ? v : null;
  };
  const first = (a) => (Array.isArray(a) ? a : []).map(ok).find(Boolean) || null;
  return ok(p.image_url) || first(p.images) || ok(p.rental_image_url) || first(p.rental_images) || null;
}
function itemPhoto(p) {
  const src = productPhotoUrl(p);
  const listed = p ? channelsOf(p.code).some(c => c.channel === 'rakuten' && (c.external_item_code || c.url)) : false;
  if (!src) {
    return `<div class="photobox">
      <div class="ph"><span class="ms">devices</span><span>画像準備中</span></div>
      ${p ? `<div class="u">${listed && canAdmin()
        ? `楽天に掲載中です。<a href="#" onclick="openRakutenSync();return false">楽天画像を同期</a>`
        : '商品詳細の「商品画像を登録・変更」から登録できます'}</div>` : ''}
    </div>`;
  }
  // 元画像より大きく引き伸ばさない（小さい写真を拡大すると粗く見えるため）
  return `<div class="photobox">
    <img src="${esc(src)}" alt="${esc(titleOf(p))}" loading="lazy" decoding="async"
         onload="itemPhotoFit(this)" onerror="itemPhotoError(this)">
    <div class="u">${esc(p.code)} の商品画像</div>
  </div>`;
}
/* 元画像より大きくしない。枠（CSSの上限）と自然サイズの小さいほうに合わせる
   ＝ 大きい写真は枠なりに縮み、小さい写真は等倍のまま（引き伸ばして粗くしない） */
function itemPhotoFit(img) {
  if (!img || !img.naturalWidth) return;
  img.style.maxWidth = `min(100%, ${img.naturalWidth}px)`;
  img.style.maxHeight = `min(200px, ${img.naturalHeight}px)`;
}
function itemPhotoError(img) {
  const box = img && img.closest ? img.closest('.photobox') : null;
  if (box) box.innerHTML = '<div class="ph"><span class="ms">devices</span><span>画像を読めません</span></div>';
}

/* 8EC（レンタル）と楽天（販売）は同じ実在庫を共有する。貸出中・予約中・販売予約・
   修理中などは status が '在庫' ではないので、どちらの数からも自然に外れる。
   先に確保したほうにその1台が割り当たる（サーバー側の inv_reserve_available_item）。
     在庫       … status='在庫' の個体数（楽天へ出せる台数のもと）
     レンタル可能 … そのうち「8RENTに出す」と選んだ個体（rental_eligible）だけ */
const inStockOf = (code) => itemsOf(code).filter(i => i.status === '在庫').length;
const rentalAvailable = (code) => itemsOf(code).filter(i => i.status === '在庫' && i.rental_eligible).length;
const rentalEligibleOf = (code) => itemsOf(code).filter(i => i.rental_eligible && !GONE.includes(i.status)).length;
/* 販売サイトへ出してよい数量。掲載（出品状態）とは別に持つ。
   掲載していなければ0。掲載していれば在庫の台数（＝発送できる台数）。
   レンタル対象に選んだ個体も、在庫のうちは売れるので数量に含める。
   8ECで貸し出しても掲載は解除せず、この数量だけが減る。 */
const saleListed = (code, ch) =>
  (channelsOf(code).find(v => v.channel === ch) || {}).state === LISTED ||
  itemsOf(code).some(i => (listingOf(i, ch) || {}).state === LISTED);
const saleAvailable = (code, ch) => saleListed(code, ch) ? inStockOf(code) : 0;
/* 在庫にまだ入っていない理由の内訳（販売可能数量に含めない個体） */
const heldCounts = (code) => {
  const c = { 予約中: 0, 貸出中: 0, 販売予約: 0, 修理中: 0 };
  itemsOf(code).forEach(i => { if (c[i.status] != null) c[i.status] += 1; });
  return c;
};

const RENTAL_FORM_LABEL = { notebook: 'ノートPC', desktop: 'デスクトップPC', monitor: 'モニター',
  peripheral: '周辺機器・アクセサリ', other: 'その他' };
const RENTAL_LISTING_LABEL = { standalone: '単品レンタル', option: 'PCレンタルのオプション', not_public: '公開しない' };

/* 商品詳細に出す8RENT設定。/zaikoが基準（source of truth）で、
   ここでrental_enabledをオンにした商品だけが8EC（トップ・8RENT）に公開される。
   楽天は販売チャネルなので、レンタル公開にしても楽天の掲載は解除しない
   （貸し出された1台が、楽天へ出す販売可能数量から外れるだけ）。 */
function rentalBox(p) {
  const on = !!p.rental_enabled;
  const avail = rentalAvailable(p.code);
  const elig = rentalEligibleOf(p.code);
  const tags = (p.rental_tags || []).map(t => RENTAL_TAG_LABEL[t] || t);
  return `<div class="prices" style="margin-top:16px">
    <div><div class="lbl">8RENT</div><div class="v ${on ? 'plus' : ''}">${on ? '公開中' : '非公開'}</div></div>
    <div><div class="lbl">月額料金</div><div class="v">${p.rental_price_month ? yen(p.rental_price_month) : '—'}</div></div>
    <div><div class="lbl">レンタル対象の個体</div><div class="v">${elig}<span class="meta"> / ${itemsOf(p.code).filter(i => !GONE.includes(i.status)).length}台</span></div></div>
    <div><div class="lbl">レンタル可能数</div><div class="v ${on && avail ? 'plus' : ''}">${on ? avail : '—'}</div></div>
    <div><div class="lbl">取り寄せ</div><div class="v">${p.procurement_available ? '可' : '—'}</div></div>
    <div><div class="lbl">かたち</div><div class="v" style="font-size:15px">${esc(RENTAL_FORM_LABEL[p.rental_form] || '未分類')}</div></div>
    <div><div class="lbl">8ECでの出しかた</div><div class="v" style="font-size:15px">${
      esc(RENTAL_LISTING_LABEL[p.rental_listing_type || 'standalone'])}</div></div>
    <div><div class="lbl">最低利用期間</div><div class="v">${p.rental_min_months || 1}ヶ月〜</div></div>
    <button class="btn sm ghost" onclick="sheetRentalSet('${esc(p.code)}')" ${dis()}>8RENT設定を変える</button>
    <button class="btn sm ghost" onclick="sheetRentalText('${esc(p.code)}')" ${dis()}>レンタル向け説明</button>
  </div>
  ${on ? `<p class="meta" style="margin-top:6px">${[
      p.office_supported ? 'Office対応' : '', p.trial_eligible ? 'お試し対象' : '',
      tags.length ? 'タグ：' + tags.join('・') : ''
    ].filter(Boolean).concat([
      'レンタル可能数は「状態が在庫」かつ「8RENTに出すと選んだ個体」の台数です。個体は在庫一覧で選びます。',
      '貸し出しても楽天の掲載は解除せず、販売サイトへ出す数量だけが減ります。'
    ]).join('　')}</p>`
    : `<p class="meta" style="margin-top:6px">非掲載のあいだは、個体を8RENT対象にしても8ECには出ません。</p>`}`;
}

/* 商品画像。8ECトップ・8RENTの公開ページは、ここで登録した
   メイン画像（image_url）→ 画像一覧（images）の順に写真を出す（公開側は次の読み込みで反映、再デプロイ不要）。
   楽天同期は空欄だけ埋めるので、ここで指定したメイン画像は同期で上書きされない。 */
function imagesBox(p) {
  const main = (p.image_url || '').trim();
  const list = Array.isArray(p.images) ? p.images.filter(u => typeof u === 'string' && u.trim()) : [];
  const shown = [main].concat(list.filter(u => u !== main)).filter(Boolean).slice(0, 6);
  return `<div class="sec" style="margin-top:16px">商品画像（公開ページ用）</div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px" id="prodImages">
    ${shown.length ? shown.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener" title="${esc(u)}"
        style="display:block;width:96px;height:72px;border:1px solid ${i === 0 && main ? '#1B1D1A' : 'rgba(27,29,26,.13)'};border-radius:8px;overflow:hidden;background:#fff">
        <img src="${esc(u)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:contain" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'読めません',style:'display:grid;place-items:center;height:100%;font-size:11px;color:#B3261E'}))"></a>`).join('')
      : '<span class="meta">まだ画像がありません。公開ページでは「画像準備中」と出ます。</span>'}
  </div>
  <p class="meta" style="margin-bottom:8px">${main ? 'メイン画像：登録済み' : 'メイン画像：未設定（一覧の1枚目を使います）'}　画像一覧：${list.length}枚</p>
  <button class="btn sm ghost" onclick="sheetProductImages('${esc(p.code)}')" ${dis()}>商品画像を登録・変更</button>`;
}
function sheetProductImages(code) {
  const p = prod(code); if (!p) return;
  const list = Array.isArray(p.images) ? p.images.filter(u => typeof u === 'string' && u.trim()) : [];
  openSheet({
    title: '商品画像', subject: code, cta: '保存',
    hint: '公開ページ（8ECトップ・8RENT）に出す写真です。メイン画像が空なら一覧の1枚目を使います。楽天同期で取り込んだ画像は一覧に入っています。URLは https:// から始まる配信URLを入れてください。',
    body: `<label class="field" style="margin-bottom:10px"><span>メイン画像URL</span>
        <input class="input" id="piMain" value="${esc(p.image_url || '')}" placeholder="https://…/main.jpg"></label>
      <label class="field"><span>画像一覧（1行に1つ・上から順に表示）</span>
        <textarea class="input" id="piList" rows="5" placeholder="https://…/1.jpg&#10;https://…/2.jpg">${esc(list.join('\n'))}</textarea></label>`,
    run: () => saveProductImages(code)
  });
}
async function saveProductImages(code) {
  const main = (($('piMain') || {}).value || '').trim() || null;
  const list = (($('piList') || {}).value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const bad = [main].concat(list).filter(u => u && !/^https?:\/\//i.test(u));
  if (bad.length) { toast('画像URLは https:// から始めてください：' + bad[0]); return; }
  const { data, error } = await sb.rpc('inv_product_images_set', { p_code: code, p_image_url: main, p_images: list });
  if (error) { toast('保存できませんでした：' + error.message); return; }
  const i = db.masters.findIndex(x => x.code === code);
  if (i >= 0 && data) db.masters[i] = data;
  await refreshTx();
  render();
  toast('商品画像を保存しました（公開ページは次の読み込みから反映）');
}

/* 楽天など販売チャネルで受注が入ったときに、在庫を1台「販売予約」で確保する。
   8RENTの申込と同じ在庫を取り合うため、確保処理自体はサーバー側の
   inv_sale_reserve（inv_reserve_available_item を共有）に任せる。
   RMS WEB SERVICE等のAPI連携が無い間は、受注はスタッフがここで手動記録する。 */
function sheetSaleReserve(code) {
  const p = prod(code); if (!p) return;
  const avail = rentalAvailable(code);
  openSheet({
    title: '受注を記録', subject: code, cta: '在庫を1台確保',
    hint: `${esc(titleOf(p))}　いま確保できる在庫 ${avail}台。販売サイトで受注が入ったら、発送前にここで在庫を1台「販売予約」にします。確保した1台は8ECのレンタル可能数からすぐ外れます（商品の掲載は解除しません）。発送したら個体の操作から「売却」で販売済みにしてください。`,
    body: `<label class="field"><span>販売サイト</span>
        <select class="input" id="srChannel">${TAB_CHANNELS.map(c => `<option value="${esc(c.key)}">${esc(c.label)}</option>`).join('')}</select></label>
      <label class="field" style="margin-top:10px"><span>注文番号（任意）</span>
        <input class="input" id="srRef" placeholder="例：楽天の注文番号"></label>
      <label class="field" style="margin-top:10px"><span>メモ（任意）</span>
        <input class="input" id="srNote"></label>`,
    run: async () => {
      const channel = ($('srChannel') || {}).value || 'rakuten';
      const ref = (($('srRef') || {}).value || '').trim() || null;
      const note = (($('srNote') || {}).value || '').trim() || null;
      const { data, error } = await sb.rpc('inv_sale_reserve', { p_code: code, p_channel: channel, p_ref: ref, p_note: note });
      if (error) { toast(error.message || '確保できませんでした'); return; }
      await loadAll();
      render();
      toast(`${esc((data || {}).id || '')} を販売予約にしました`);
    }
  });
}

function sheetRentalSet(code) {
  const p = prod(code); if (!p) return;
  const n = (v) => (v == null || v === '') ? '' : String(v);
  const tags = p.rental_tags || [];
  openSheet({
    title: '8RENT設定', subject: code, cta: '保存',
    hint: '「公開する」にすると、この商品が8RENT（自社在庫のレンタルサイト）に載ります。/zaikoが基準なので、ここで変えるとすぐ反映されます。',
    body: `<label class="field" style="margin-bottom:10px"><span>8RENTへの公開</span>
        <select class="input" id="sheetVal">
          <option value="false"${!p.rental_enabled ? ' selected' : ''}>非公開</option>
          <option value="true"${p.rental_enabled ? ' selected' : ''}>公開する</option>
        </select></label>
      <label class="field" style="margin-bottom:10px"><span>月額料金</span>
        <input class="input num" type="number" min="0" step="100" id="rtPrice" value="${esc(n(p.rental_price_month))}" placeholder="例 4980"></label>
      <label class="field" style="margin-bottom:10px"><span>最低利用期間（ヶ月）</span>
        <input class="input num" type="number" min="1" id="rtMonths" value="${esc(n(p.rental_min_months) || '1')}"></label>
      <label class="field" style="margin-bottom:10px"><span>商品のかたち（レンタル説明のひな形）</span>
        <select class="input" id="rtForm">
          ${[['', '未分類（スペックから推定）'], ['notebook', 'ノートPC'], ['desktop', 'デスクトップPC'],
             ['monitor', 'モニター'], ['peripheral', '周辺機器・アクセサリ'], ['other', 'その他']]
            .map(([v, t]) => `<option value="${v}"${(p.rental_form || '') === v ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
        <span class="meta">PC以外に選ぶと、Office・CPU・カメラなどPC向けの文章を出しません。</span></label>
      <label class="field" style="margin-bottom:10px"><span>8ECでの出しかた</span>
        <select class="input" id="rtListing">
          ${[['standalone', '単品レンタル（商品カードとして公開）'],
             ['option', 'PCレンタルのオプション（単独では公開しない）'],
             ['not_public', '公開しない']]
            .map(([v, t]) => `<option value="${v}"${(p.rental_listing_type || 'standalone') === v ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
        <span class="meta">セキュリティワイヤーのように、PCに付ける前提のものは「オプション」にしてください。</span></label>
      <label class="bchk" style="margin-bottom:8px"><input type="checkbox" id="rtOffice" ${p.office_supported ? 'checked' : ''}> Office付きで用意できると確認ずみ</label>
      <label class="bchk" style="margin-bottom:8px"><input type="checkbox" id="rtOfficeNg" ${p.office_unavailable ? 'checked' : ''}> Officeは付けられない（はっきりしている場合だけ）</label>
      <p class="meta" style="margin:-4px 0 10px">どちらも外れているときは「Officeの有無はお申し込み時にご希望をお知らせください」と出ます
        （8RENTは希望を伺って用意するので、これが既定です）。</p>
      <label class="bchk" style="margin-bottom:8px"><input type="checkbox" id="rtTrial" ${p.trial_eligible ? 'checked' : ''}> お試し対象</label>
      <label class="bchk" style="margin-bottom:10px"><input type="checkbox" id="rtProcure" ${p.procurement_available ? 'checked' : ''}> 取り寄せ可（在庫0でも申込を受ける）</label>
      <p class="meta" style="margin:-4px 0 12px">取り寄せ可にすると、8RENTに「取り寄せ可能」と出て、申込は「調達確認」から始まります。
        仮の個体は作らないので、現物が入って登録してから割り当てます。</p>
      <label class="field" style="margin-bottom:10px"><span>おすすめタグ</span>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:6px">${RENTAL_TAGS.map(t => `
          <label class="bchk"><input type="checkbox" class="rtTag" value="${t.key}" ${tags.includes(t.key) ? 'checked' : ''}> ${esc(t.label)}</label>`).join('')}
        </div></label>
      <label class="field"><span>画像URL</span>
        <input class="input" id="rtImg" value="${esc(p.rental_image_url || '')}" placeholder="https://…"></label>`,
    run: (val) => saveRentalSet(code, val === 'true')
  });
}
async function saveRentalSet(code, enabled) {
  const tags = [...document.querySelectorAll('.rtTag:checked')].map(el => el.value);
  const { data, error } = await sb.rpc('inv_product_rental_set', {
    p_code: code, p_enabled: enabled,
    p_price_month: numField('rtPrice'), p_min_months: numField('rtMonths') || 1,
    p_office: !!($('rtOffice') || {}).checked, p_trial: !!($('rtTrial') || {}).checked,
    p_tags: tags, p_description: (prod(code) || {}).rental_description || null,
    p_image_url: ($('rtImg') || {}).value || null
  });
  if (error) { toast('保存できませんでした：' + error.message); return; }
  let saved = data;
  // 商品のかたち・8ECでの出しかた・Office不可は、説明の作り分けに使う区分なので専用のRPCで保存する
  const r0 = await sb.rpc('inv_product_rental_form_set', {
    p_code: code,
    p_form: (($('rtForm') || {}).value || ''),
    p_listing: (($('rtListing') || {}).value || 'standalone'),
    p_office_ng: !!($('rtOfficeNg') || {}).checked
  });
  if (r0.error) { toast('レンタル区分を保存できませんでした：' + r0.error.message); return; }
  saved = r0.data || saved;
  // 取り寄せの可否は8RENTの公開設定とは別の判断なので、専用のRPCで保存する
  const procure = !!($('rtProcure') || {}).checked;
  if (procure !== !!(prod(code) || {}).procurement_available) {
    const r = await sb.rpc('inv_product_procurement_set', { p_code: code, p_on: procure });
    if (r.error) { toast('取り寄せの設定を保存できませんでした：' + r.error.message); return; }
    saved = r.data || saved;
  }
  const i = db.masters.findIndex(x => x.code === code);
  if (i >= 0 && saved) db.masters[i] = saved;
  await refreshTx();
  render();
  toast(enabled ? '8RENTに公開しました' : '8RENT設定を保存しました');
}

/* ---- レンタル向け説明 ----
   8ECの公開画面はこの文だけを出す。楽天の商品説明（sale_description）は
   販売向けの文言が多いので、そのままは使わない。
   基本は構造化スペックからの自動生成で、直したい商品だけ人が書き換える。
   人が直した文は、生成ボタンでも楽天同期でも上書きしない。 */
function sheetRentalText(code) {
  const p = prod(code); if (!p) return;
  openSheet({
    title: 'レンタル向け説明', subject: code, cta: '保存',
    hint: `8ECの公開画面に出る文です。<strong>楽天の商品説明はそのままでは使いません</strong>
      （領収書・保証・返品などの販売向けの文言が入っているため）。
      ${p.rental_description_manual ? '<br><strong>この商品は人が直した文です。</strong>自動生成や楽天同期では上書きされません。' : ''}`,
    body: `<label class="field" style="margin-bottom:8px"><span>レンタル向け説明</span>
        <textarea class="input" id="rdText" rows="10" style="line-height:1.8"
          placeholder="スペックから自動で作れます">${esc(p.rental_description || '')}</textarea></label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <button type="button" class="btn sm" onclick="genRentalText('${esc(code)}')">レンタル説明を生成</button>
        <span class="meta">用途／主な仕様／Office／付属品／状態／希望の送りかた の順に、
          登録済みのスペックから作ります（分かっている項目だけ書きます）。</span>
      </div>
      ${p.sale_description ? `<div class="sec" style="font-size:15px;margin:14px 0 6px">楽天の商品説明（原文・公開しません）</div>
        <div class="pre legacy" style="max-height:160px;overflow:auto">${esc(p.sale_description)}</div>` : ''}`,
    run: () => saveRentalText(code, (($('rdText') || {}).value || '').trim())
  });
}
/* 生成はサーバー側の inv_rental_text（公開画面と同じ規則）に任せる */
async function genRentalText(code) {
  const { data, error } = await sb.rpc('inv_rental_text', { p_code: code });
  if (error) { toast('作れませんでした：' + error.message); return; }
  const el = $('rdText');
  if (el) { el.value = data || ''; el.focus(); }
  toast('スペックから作りました。必要なら直して保存してください');
}
async function saveRentalText(code, text) {
  const { data, error } = await sb.rpc('inv_product_rental_description_set', {
    p_code: code, p_text: text || null, p_manual: true
  });
  if (error) { toast('保存できませんでした：' + error.message); return; }
  const i = db.masters.findIndex(x => x.code === code);
  if (i >= 0 && data) db.masters[i] = data;
  await refreshTx();
  render();
  toast('レンタル向け説明を保存しました（以後、自動生成や楽天同期では上書きしません）');
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
      <button class="btn" onclick="closeModal();toggleItemRental('${esc(id)}')" ${can(!GONE.includes(it.status))}>
        <span class="ms">devices</span><span class="t">${it.rental_eligible ? '8RENT対象から外す' : '8RENTに出す'}</span></button>
      ${canAdmin() ? `<button class="btn" onclick="closeModal();sheetScrap('${esc(id)}')" ${can(it.status !== '廃棄')}>
        <span class="ms">delete</span><span class="t">廃棄</span></button>` : ''}
    </div>`, [['閉じる', 'closeModal()', 'btn ghost']]);
}

/* 8RENTに出す／外すのボタン。出せる・外せるの判定は在庫一覧の一括操作と同じ規則で、
   外せるのは貸し出していない個体だけ（予約中・貸出中はレンタルの約束が生きている）。
   押せない理由はボタンのツールチップに出す。 */
function rentalOpsHtml(it) {
  const gone = GONE.includes(it.status);
  const held = it.status === '予約中' || it.status === '貸出中';
  const heldWhy = it.status === '予約中'
    ? '予約中 のため8RENTから外せません（先に申込をキャンセルしてください）'
    : '貸出中 のため8RENTから外せません（先に返却してください）';
  const b = (label, icon, on, cls, ok, why) =>
    `<button class="btn ${cls}" onclick="setItemRental('${esc(it.id)}',${on})"` +
    `${ok && canEdit() ? '' : ' disabled'}${why ? ` title="${esc(why)}"` : ''}>` +
    `<span class="ms">${icon}</span><span class="t">${label}</span></button>`;
  return b('8RENTに出す', 'devices', true, 'lime', !gone && !it.rental_eligible,
      gone ? `${it.status} なので8RENTには出せません` : (it.rental_eligible ? 'すでにレンタル対象です' : '')) +
    b('8RENTから外す', 'devices_off', false, '', !gone && !held && it.rental_eligible,
      gone ? `${it.status} なので8RENTには出せません`
        : held ? heldWhy : (it.rental_eligible ? '' : 'すでに対象外です'));
}

/* バッジとボタンだけをその場で描き直す（画面は読み込み直さない） */
function paintItemRental(it) {
  const tag = $('itemRentTag');
  if (tag) tag.innerHTML = GONE.includes(it.status) ? '' : rentalTag(it);
  const ops = $('itemRentOps');
  if (ops) ops.innerHTML = rentalOpsHtml(it);
}

/* 1台だけ8RENT対象を切り替える。処理・検証・履歴は一括操作と同じ（inv_items_bulk_op）で、
   詳細画面のためのロジックは持たない。商品の掲載ONも一括操作と同じ扱いにする。 */
async function setItemRental(id, on) {
  const it = item(id); if (!it) return;
  const { data, error } = await sb.rpc('inv_items_bulk_op', {
    p_ids: [id], p_action: on ? '8RENT対象' : '8RENT対象外',
    p_enable_product: on                       // 最初の1台なら商品の掲載も自動でON
  });
  if (error) { toast('変更できませんでした：' + error.message); return; }
  const ng = ((data || {}).ng || [])[0];
  if (ng) { toast(ng.reason); return; }
  it.rental_eligible = on;                     // 待たせずにその場で直す
  paintItemRental(it);
  const empty = (((data || {}).products_empty) || [])[0];
  toast(on
    ? '✓ 8RENTのレンタル対象にしました' + ((data || {}).products_enabled ? '（商品も8RENTに掲載しました）' : '')
    : '✓ 8RENTの対象から外しました' + (empty ? '（この商品は対象の個体が0台になりました）' : ''));
  await loadAll();                             // 裏で取り直す
  const fresh = item(id);
  if (fresh && ui.screen === 'item' && ui.itemId === id) paintItemRental(fresh);
  else render();
}

/* 一覧の操作メニューからも同じ処理を使う */
function toggleItemRental(id) {
  const it = item(id);
  if (it) setItemRental(id, !it.rental_eligible);
}

/* --- 販売情報 ---
   出品は実物1台ごとに持つ。ここではサイトごとの数と、1台ずつの出品先を見る。
   「型番まとめての設定」は、1台ぶんの設定が無い個体すべてに当たる控えの設定。
   移行前のデータは型番単位でしか無いので、その受け皿でもある。 */
function tabSales(p) {
  const ind = p.kind === 'individual';
  const units = ind ? itemsOf(p.code).filter(i => !GONE.includes(i.status)) : [];
  return `${guardNote()}
    <p class="meta" style="margin-bottom:12px">${ind
      ? '出品は<strong>実物1台ごと</strong>に持ちます。1台ずつの中身は、下の管理番号をクリックしてください。'
      : '数量管理の品目なので、出品情報は品目まるごとで持ちます。'}</p>
    ${ind ? saleQtyNote(p) : ''}
    ${listingUrlNote(p)}
    <div class="table-wrap"><table class="t">
      <thead><tr><th>販売サイト</th>${ind ? '<th class="r">出品中</th><th class="r">販売できる数量</th>' : ''}
        <th>型番まとめての設定</th><th>SKU</th><th class="r">販売価格</th><th>商品URL</th>
        ${canEdit() ? '<th></th>' : ''}</tr></thead>
      <tbody>${CHANNELS.map(c => {
        const x = channelsOf(p.code).find(v => v.channel === c.key) || {};
        const n = units.filter(i => (listingOf(i, c.key) || {}).state === LISTED).length;
        const q = saleAvailable(p.code, c.key);
        return `<tr>
          <td class="nowrap"><span class="tag ch ${n || x.state === LISTED ? 'on' : ''}">${esc(c.short)}</span> ${esc(c.label)}</td>
          ${ind ? `<td class="num r${n ? '' : ' meta'}">${n || '—'}</td>
          <td class="num r${saleListed(p.code, c.key) ? (q ? '' : ' minus') : ' meta'}">${saleListed(p.code, c.key) ? q + '台' : '—'}</td>` : ''}
          <td class="nowrap">${x.state
            ? `<span class="tag ${x.state === LISTED ? 'ch on' : 'act'}">${esc(x.state)}</span>`
            : (n && canEdit()
                // 個体には出品情報があるのに、商品まるごとの行が無い状態。
                // 楽天APIの画像同期は商品単位の行を見るので、ここから作れるようにする
                ? `<button class="btn sm" title="個体の出品情報（URL・価格）から商品まるごとの行を作ります"
                     onclick="makeListingFromItems('${esc(p.code)}','${c.key}')">個体から作る</button>`
                : '<span class="meta">—</span>')}</td>
          <td class="num">${esc(x.sku || '') || '<span class="meta">—</span>'}</td>
          <td class="num r">${x.price == null ? '<span class="meta">—</span>' : yen(x.price)}</td>
          <td>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener" class="meta" style="word-break:break-all">開く</a>` : '<span class="meta">—</span>'}</td>
          ${canEdit() ? `<td class="nowrap"><button class="btn sm ghost" onclick="sheetChannel('${esc(p.code)}','${c.key}')">編集</button></td>` : ''}
        </tr>`;
      }).join('')}</tbody></table></div>
    ${ind ? (units.length ? `<div class="sec">1台ずつの出品先</div>
      <div class="table-wrap"><table class="t">
        <thead><tr><th>管理番号</th><th>状態</th><th>出品先</th><th></th></tr></thead>
        <tbody>${units.map(i => `<tr class="clk" onclick="go('item','${esc(i.id)}')">
          <td class="num" style="font-weight:600">${esc(i.id)}</td>
          <td>${statusTag(i.status)}</td>
          <td class="mall">${listingChips(liveOn(i))}</td>
          <td class="nowrap"><button class="btn sm ghost"
            onclick="event.stopPropagation();go('item','${esc(i.id)}')">開く</button></td>
        </tr>`).join('')}</tbody></table></div>`
      : '<div class="empty" style="margin-top:14px">個体がまだ登録されていません。</div>') : ''}`;
}

/* 販売サイトへ出す数量の説明。「掲載しているか」と「いま売れる数量」は別物、
   という運用をこの画面で明示する（8ECでレンタル中でも掲載は消さない）。 */
function saleQtyNote(p) {
  const avail = rentalAvailable(p.code);
  const h = heldCounts(p.code);
  const held = Object.keys(h).filter(k => h[k] > 0).map(k => `${k} ${h[k]}台`);
  return `<div class="card" style="margin-bottom:12px">
    <div>販売サイトへ出す数量：<strong>${avail}台</strong>（在庫の台数）
      ${held.length ? `<span class="meta">　除外：${esc(held.join('・'))}</span>` : ''}</div>
    <div class="meta" style="margin-top:4px">発送できない個体（予約中・貸出中・販売予約・修理中）は数量に含めません。
      ${p.rental_enabled ? '8ECでレンタル中でも' : ''}販売サイトの商品ページ（掲載）はそのまま残し、在庫数だけを0にしてください。</div>
  </div>`;
}

/* 個体別の出品情報から、商品まるごとの出品情報を作る。
   中古は1台ごとの出品が基本だが、同じ商品ページに複数台をぶら下げていると
   商品単位の行が無く、楽天APIの画像同期の対象から漏れてしまうため。 */
async function makeListingFromItems(code, ch) {
  const { data, error } = await sb.rpc('inv_listing_from_items', { p_code: code, p_channel: ch || 'rakuten' });
  if (error) { toast('作成できませんでした：' + error.message); return; }
  await loadAll();
  render();
  toast(`${chanLabel(ch)}の出品情報を作りました（${(data || {}).url || (data || {}).sku || ''}）。楽天商品を同期すると画像が入ります`);
}

/* 掲載URLの更新候補。API同期で「楽天側の正式URLと違う」と分かった商品にだけ出す */
function listingUrlNote(p) {
  const rows = channelsOf(p.code).filter(x => (x.url_candidate || '').trim());
  if (!rows.length) return '';
  return rows.map(x => `<div class="warnbox" style="margin-bottom:12px">
    <span class="ms">link_off</span>
    <div style="flex:1;min-width:0">
      <div style="font-weight:500">${esc(chanLabel(x.channel))}の掲載URLが変わっているようです</div>
      <div class="meta" style="word-break:break-all">いま：${esc(x.url || '—')}</div>
      <div class="meta" style="word-break:break-all">${esc(chanLabel(x.channel))}：<strong>${esc(x.url_candidate)}</strong></div>
      <div class="meta" style="margin-top:4px">API同期で見つかった正式なURLです。自動では書き換えていません。</div>
    </div>
    ${canEdit() ? `<span class="nowrap" style="display:flex;gap:6px">
      <button class="btn sm lime" onclick="acceptListingUrlAndRender('${esc(p.code)}','${esc(x.channel)}')">URLを更新</button>
      <button class="btn sm ghost" onclick="dismissListingUrlAndRender('${esc(p.code)}','${esc(x.channel)}')">このまま</button></span>` : ''}
  </div>`).join('');
}
async function acceptListingUrlAndRender(code, ch) {
  const { error } = await sb.rpc('inv_listing_url_accept', { p_code: code, p_channel: ch || 'rakuten' });
  if (error) { toast('更新できませんでした：' + error.message); return; }
  await loadAll(); render(); toast('掲載URLを更新しました');
}
async function dismissListingUrlAndRender(code, ch) {
  const { error } = await sb.rpc('inv_listing_url_dismiss', { p_code: code, p_channel: ch || 'rakuten' });
  if (error) { toast('取り消せませんでした：' + error.message); return; }
  await loadAll(); render(); toast('いまのURLのままにしました');
}

/* 型番まとめての出品設定。1台ぶんの設定が無い個体に当たる */
function sheetChannel(code, ch) {
  const c = CHANNELS.find(x => x.key === ch) || { label: ch };
  const x = channelsOf(code).find(v => v.channel === ch) || {};
  const n = (v) => (v == null || v === '') ? '' : String(v);
  openSheet({
    title: c.label + '（型番まとめて）', subject: code, cta: '保存',
    hint: 'この型番に共通の出品情報です。<strong>1台ぶんの設定があるものは、そちらが優先されます。</strong>空にすると未出品になります。',
    body: `<label class="field" style="margin-bottom:10px"><span>出品状態</span>
        <select class="input" id="sheetVal"><option value="">未出品</option>
        ${LIST_STATES.map(s => `<option${x.state === s ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
      <label class="field" style="margin-bottom:10px"><span>販売価格</span>
        <input class="input num" type="number" min="0" step="100" id="lsPrice" value="${esc(n(x.price))}"></label>
      <label class="field" style="margin-bottom:10px"><span>SKU・商品管理番号</span>
        <input class="input" id="lsSku" value="${esc(x.sku || '')}" placeholder="そのサイトでの商品コード"></label>
      <label class="field" style="margin-bottom:10px"><span>商品URL</span>
        <input class="input" id="lsUrl" value="${esc(x.url || '')}" placeholder="https://…"></label>
      <label class="field" style="margin-bottom:10px"><span>管理画面URL（任意）</span>
        <input class="input" id="lsAdmin" value="${esc(x.admin_url || '')}" placeholder="https://…（販売サイトの管理画面で開いたURL）">
        <span class="meta">売れたあとに在庫を直しにいく先です。<strong>実際に管理画面で開いたURLを貼ってください。</strong>
          空なら販売サイトごとの設定（管理画面のトップ・ひな形）を使います。</span></label>
      <label class="field"><span>メモ</span>
        <input class="input" id="lsNote" value="${esc(x.note || '')}"></label>`,
    run: async (state) => {
      await saveListing(null, code, ch, state, {
        price: numField('lsPrice'), sku: ($('lsSku') || {}).value,
        url: ($('lsUrl') || {}).value, note: ($('lsNote') || {}).value
      });
      // 管理画面URLは出品情報とは別の列なので、専用のRPCで入れ直す
      const admin = (($('lsAdmin') || {}).value || '').trim();
      const cur = ((channelsOf(code).find(v => v.channel === ch) || {}).admin_url || '').trim();
      if (admin !== cur) {
        const { error } = await sb.rpc('inv_listing_admin_url_set', { p_code: code, p_channel: ch, p_url: admin || null });
        if (error) { toast('管理画面URLを保存できませんでした：' + error.message); return; }
        await loadAll();
        render();
      }
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

/* ---- 売却先 ----
   選択式にして打ち間違いを減らす。販売サイトに出しているものは、その個体の
   出品先をいちばん上に出して初期選択する（たいていそこで売れるため）。
   「その他」のときだけ自由入力を出す。 */
const SELL_DESTS = [
  { key: 'rakuten', label: '楽天', channel: 'rakuten' },
  { key: 'amazon', label: 'Amazon', channel: 'amazon' },
  { key: 'mercari', label: 'メルカリ', channel: 'mercari' },
  { key: 'yahuoku', label: 'ヤフオク', channel: 'yahuoku' },
  { key: 'yahoo_free', label: 'Yahoo!フリマ', channel: 'yahoo_free' },
  { key: 'store', label: '8EC / 店頭', channel: null },
  { key: 'corp', label: '法人販売', channel: null },
  { key: 'other', label: 'その他', channel: null }
];

/* 売却価格の候補。出品している各サイトの値段と、自社の販売予定価格を並べる。
   どれも無ければ手入力だけにする（0円を既定にして事故らせない） */
function sellPriceOptions(it) {
  const out = [];
  CHANNELS.forEach(c => {
    const x = listingOf(it, c.key);
    if (x && x.price != null && x.price !== '') {
      out.push({ key: 'ch:' + c.key, channel: c.key, label: `${c.label} ${yen(x.price)}`, price: Number(x.price) });
    }
  });
  const plan = planOf(it);
  if (plan != null) out.push({ key: 'plan', channel: null, label: `販売予定価格 ${yen(plan)}`, price: Number(plan) });
  return out;
}

function sheetSell(id) {
  const it = item(id); if (!it) return;
  const cost = costOf(it);
  const live = liveOn(it);                       // いま出品しているサイト
  // 出品しているサイトを上に。並びは変えるが、選べるものは減らさない
  const dests = SELL_DESTS.slice().sort((a, b) =>
    (live.indexOf(b.channel) >= 0 ? 1 : 0) - (live.indexOf(a.channel) >= 0 ? 1 : 0));
  const firstLive = dests.find(d => d.channel && live.indexOf(d.channel) >= 0);
  const opts = sellPriceOptions(it);
  const sel = firstLive || dests[0];
  openSheet({
    title: '売却', subject: id, cta: '売却を記録',
    hint: `${esc(titleOf(prod(it.product_code)) || it.name)} を売却済にします。現在庫からも登録数からも外れますが、履歴は残ります。${
      live.length ? `<br><span class="meta">いま ${esc(live.map(chanLabel).join('・'))} に出品中です。</span>` : ''}`,
    body: `<label class="field" style="margin-bottom:10px"><span>売却先</span>
        <select class="input" id="slDest" onchange="paintSellSheet('${esc(id)}')">
          ${dests.map(d => `<option value="${esc(d.key)}"${d.key === sel.key ? ' selected' : ''}>${esc(d.label)}${
            d.channel && live.indexOf(d.channel) >= 0 ? '（出品中）' : ''}</option>`).join('')}
        </select></label>
      <label class="field" id="slOtherWrap" style="margin-bottom:10px;display:none"><span>売却先（自由入力）</span>
        <input class="input" id="slOther" placeholder="例 リサイクル業者" oninput="paintSellSheet('${esc(id)}')"></label>
      <label class="field" style="margin-bottom:10px"><span>売却価格</span>
        <select class="input" id="slPrice" onchange="paintSellSheet('${esc(id)}')">
          ${opts.map(o => `<option value="${esc(o.key)}" data-price="${o.price}">${esc(o.label)}</option>`).join('')}
          <option value="manual">手入力</option>
        </select></label>
      <label class="field" id="slManualWrap" style="margin-bottom:10px;display:none"><span>販売価格（手入力）</span>
        <input class="input num" type="number" min="0" id="sheetVal" placeholder="0"
               oninput="paintSellSheet('${esc(id)}')"></label>
      <div class="prow"><span>原価</span><b class="num">${cost ? yen(cost) : '—'}</b></div>
      <div class="prow"><span>売却価格</span><b class="num" id="slShow">—</b></div>
      <div class="prow"><span>利益</span><b class="num" id="slGain">—</b></div>
      <label class="field" style="margin-top:12px"><span>メモ（任意）</span>
        <input class="input" id="sellNote" placeholder="例 元箱あり・付属品なし"></label>`,
    validate: () => {
      const d = SELL_DESTS.find(x => x.key === (($('slDest') || {}).value || '')) || {};
      if (d.key === 'other' && !((($('slOther') || {}).value || '').trim())) {
        toast('売却先を入力してください'); return false;
      }
      if (sellPick(id).price == null) { toast('売却価格を入れてください'); return false; }
      return true;
    },
    run: () => {
      const pick = sellPick(id);
      return sellItem(id, pick.dest, pick.price, (($('sellNote') || {}).value || '').trim() || null);
    }
  });
  paintSellSheet(id);
}

/* いま選ばれている売却先と価格を1か所で決める（表示も保存も同じものを見る） */
function sellPick(id) {
  const it = item(id) || {};
  const dkey = (($('slDest') || {}).value || '');
  const d = SELL_DESTS.find(x => x.key === dkey) || {};
  const dest = d.key === 'other' ? ((($('slOther') || {}).value || '').trim() || null) : (d.label || null);
  const pkey = (($('slPrice') || {}).value || '');
  let price = null;
  if (pkey === 'manual') {
    const v = (($('sheetVal') || {}).value || '').trim();
    price = v === '' ? null : Number(v);
  } else {
    const o = sellPriceOptions(it).find(x => x.key === pkey);
    price = o ? o.price : null;
  }
  return { dest, channel: d.channel || null, price };
}

/* 売却先を選んだら、そのサイトの値段を初期選択する。原価・売値・利益もここで出す */
function paintSellSheet(id) {
  const it = item(id); if (!it) return;
  const d = SELL_DESTS.find(x => x.key === (($('slDest') || {}).value || '')) || {};
  const other = $('slOtherWrap'); if (other) other.style.display = d.key === 'other' ? '' : 'none';

  const sel = $('slPrice');
  if (sel && d.channel && sel.dataset.lastDest !== d.key) {
    const want = 'ch:' + d.channel;                      // 売却先に対応するサイトの値段
    if ([...sel.options].some(o => o.value === want)) sel.value = want;
    else if (sellPriceOptions(it).length === 0) sel.value = 'manual';
  }
  if (sel) sel.dataset.lastDest = d.key;
  const manual = sel && sel.value === 'manual';
  const mw = $('slManualWrap'); if (mw) mw.style.display = manual ? '' : 'none';

  const { price } = sellPick(id);
  const cost = costOf(it);
  const show = $('slShow'); if (show) show.textContent = price == null ? '—' : yen(price);
  const gain = $('slGain');
  if (gain) {
    // 原価が入っていないものは、売値をそのまま利益と書くと嘘になるので出さない
    gain.textContent = (price == null || !cost) ? '—' : yen(price - cost);
    gain.classList.toggle('minus', price != null && cost > 0 && price - cost < 0);
  }
}

/* 売却の実行。売却先つきで記録し、出品したままのサイトがあれば続けて知らせる */
async function sellItem(id, dest, price, note) {
  const { data, error } = await sb.rpc('inv_item_sell', {
    p_item_id: id, p_channel: dest, p_price: price == null ? null : String(price), p_note: note
  });
  if (error) { toast(error.message || '記録できませんでした'); return; }
  const i = db.items.findIndex(x => x.id === id);
  if (i >= 0 && data) db.items[i] = data;
  await refreshTx();
  render();
  toast(`${id} を売却済にしました${dest ? `（${dest}）` : ''}`);
  warnStillListed([id], '売却済');
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
      const sold = [];
      for (const it of avail.slice(0, n)) {
        const { data, error } = await sb.rpc('inv_item_op',
          { p_item_id: it.id, p_action: '売却', p_value: v || null, p_note: '一覧から売却' });
        if (error) { toast(error.message || '記録できませんでした'); break; }
        const i = db.items.findIndex(x => x.id === it.id);
        if (i >= 0 && data) db.items[i] = data;
        sold.push(it.id);
        ok++;
      }
      await refreshTx();
      render();
      toast(`${ok}台を売却しました（残り ${avail.length - ok}台）`);
      warnStillListed(sold, '売却済');
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
          ${locsOrdered().filter(l => locLive(l) || scope === l.id)
              .map(l => `<option value="${esc(l.id)}"${scope === l.id ? ' selected' : ''}>${esc(locLabel(l.id))}</option>`).join('')}
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
  const icon = { site: 'apartment', room: 'warehouse', shelf: 'shelves', other: 'inventory_2' };
  return `<div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap">
      <h1>保管場所</h1>
      ${canAdmin() ? `<button class="btn sm ghost" onclick="go('master')" style="margin-left:auto">
        <span class="ms">tune</span>保管場所を管理</button>` : ''}
    </div>
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

/* ===== 9b. マスター管理（保管場所・カテゴリー） =====
   これまで保管場所もカテゴリーも、最初に入れたきりで画面から増やせなかった。
   拠点が増えても、カテゴリーを分けたくても、SQLを書くしかない。
   管理者だけがここから直せるようにする。

   公開側（8ECトップの「カテゴリーから探す」）も同じ inventory_categories を
   見ているので、ここで直したものがそのまま公開側にも出る。
   公開用の別マスターは持たない（二重に持つと必ずずれる）。 */

/* 保存・削除の最中かどうか。二重送信を防ぐ */
let masterBusy = false;

const MASTER_TABS = [['loc', 'warehouse', '保管場所'], ['cat', 'category', 'カテゴリー']];
const LOC_KINDS = [['site', '拠点'], ['room', '倉庫・部屋'], ['shelf', '棚'], ['other', 'その他']];
const LOC_KIND_LABEL = (k) => (LOC_KINDS.find(x => x[0] === k) || [k, k])[1];
const LOC_ICON = { site: 'apartment', room: 'warehouse', shelf: 'shelves', other: 'inventory_2' };

function viewMaster() {
  if (!canAdmin()) {
    return `<h1>マスター管理</h1>
      <div class="card" style="margin-top:15px">保管場所とカテゴリーを直せるのは管理者だけです。
        <span class="meta">閲覧は <button class="btn sm ghost" onclick="go('locs')">保管場所</button> からできます。</span></div>`;
  }
  const tab = ui.mTab === 'cat' ? 'cat' : 'loc';
  return `<h1>マスター管理</h1>
    <p class="meta" style="margin:12px 0 0">保管場所とカテゴリーは、在庫一覧・商品登録・個体編集・移動・
      <strong>8ECトップの「カテゴリーから探す」</strong>が同じものを見ています。ここで直すと全部に反映されます。</p>
    <div class="seg" style="margin:16px 0 4px">
      ${MASTER_TABS.map(([k, ic, label]) =>
        `<button class="${tab === k ? 'on' : ''}" onclick="setMasterTab('${k}')">
          <span class="ms">${ic}</span>${esc(label)}</button>`).join('')}
    </div>
    ${tab === 'loc' ? masterLocBody() : masterCatBody()}`;
}
function setMasterTab(t) { ui.mTab = t; render(); }

/* ---- 保管場所 ---- */
function masterLocBody() {
  const rows = locsOrdered();
  return `
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:14px 0 6px">
      <p class="meta" style="flex:1 1 240px;margin:0">拠点 → 倉庫 → 棚 の順に並べています。
        使い終わった場所は<strong>消さずに無効</strong>にしてください（消すと移動や棚卸の履歴が読めなくなります）。</p>
      <button class="btn sm lime" onclick="sheetLocEdit(null)"><span class="ms">add</span>保管場所を足す</button>
    </div>
    <div class="mtree">${rows.map(l => {
      const d = locDepth(l.id);
      const tree = locTree(l.id);
      const ni = db.items.filter(i => tree.includes(i.location_id) && i.status !== '廃棄').length;
      const np = db.masters.filter(p => p.kind !== 'individual' && tree.includes(p.location_id)).length;
      return `<div class="r${locLive(l) ? '' : ' off'}" style="padding-left:${12 + d * 20}px">
        <span class="ms">${LOC_ICON[l.kind] || 'shelves'}</span>
        <div style="min-width:0;flex:1 1 auto">
          <div class="n">${esc(l.name)}${locLive(l) ? '' : '<span class="tag off">無効</span>'}</div>
          <div class="c">${esc(LOC_KIND_LABEL(l.kind))}　個体 ${ni}件／数量品 ${np}種　<span class="num">並び ${l.sort_no || 0}</span></div>
        </div>
        <div class="ops">
          <button class="btn sm ghost" onclick="moveMasterLoc('${esc(l.id)}',-1)" title="上へ"><span class="ms">arrow_upward</span></button>
          <button class="btn sm ghost" onclick="moveMasterLoc('${esc(l.id)}',1)" title="下へ"><span class="ms">arrow_downward</span></button>
          <button class="btn sm ghost" onclick="sheetLocEdit('${esc(l.id)}')">編集</button>
          <button class="btn sm ghost" onclick="toggleLoc('${esc(l.id)}')">${locLive(l) ? '無効にする' : '有効に戻す'}</button>
          <button class="btn sm ghost danger" onclick="sheetLocDelete('${esc(l.id)}')">削除</button>
        </div></div>`;
    }).join('')}</div>`;
}

function locParentOptions(sel, selfId) {
  // 自分自身と自分の子孫は親にできない（入れ子が輪になる）
  const ban = selfId ? locTree(selfId) : [];
  return `<option value="">（拠点：親なし）</option>` + locsOrdered()
    .filter(l => !ban.includes(l.id))
    .map(l => `<option value="${esc(l.id)}"${sel === l.id ? ' selected' : ''}>${esc(locPath(l.id))}</option>`).join('');
}

function sheetLocEdit(id) {
  const l = id ? loc(id) : null;
  openSheet({
    title: l ? '保管場所を直す' : '保管場所を足す', subject: l ? l.id : '新規', cta: '保存',
    hint: l ? '名前を変えても、置いてあるものとの紐付けは切れません（IDで紐づいています）。'
            : '拠点を足すときは「親」を空のままにします。倉庫や棚は、その上の場所を親に選んでください。',
    body: `
      <label class="field" style="margin-bottom:10px"><span>名称</span>
        <input class="input" id="mlName" value="${esc(l ? l.name : '')}" autocomplete="off" placeholder="例 SB C&S"></label>
      <div class="ie2">
        <label class="field"><span>種別</span>
          <select class="input" id="mlKind">${LOC_KINDS.map(([k, t]) =>
            `<option value="${k}"${(l ? l.kind : 'site') === k ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
        <label class="field"><span>表示順</span>
          <input class="input num" type="number" id="mlSort" value="${esc(l ? (l.sort_no || 0) : '')}" placeholder="空なら最後"></label>
      </div>
      <label class="field" style="margin-bottom:10px"><span>親の保管場所</span>
        <select class="input" id="mlParent">${locParentOptions(l ? l.parent_id : null, id)}</select></label>
      <label class="chk"><input type="checkbox" id="mlOn" ${!l || locLive(l) ? 'checked' : ''}>
        <span>使える状態にする（外すと新規登録・移動の候補に出なくなります）</span></label>`,
    validate: () => {
      if (!(($('mlName') || {}).value || '').trim()) { toast('名称を入れてください'); return false; }
      return true;
    },
    run: () => saveMasterLoc(id)
  });
}
async function saveMasterLoc(id) {
  if (masterBusy) return;
  masterBusy = true;
  try {
    const sort = (($('mlSort') || {}).value || '').trim();
    const { error } = await sb.rpc('inv_location_save', {
      p_id: id || null,
      p_name: (($('mlName') || {}).value || '').trim(),
      p_kind: ($('mlKind') || {}).value || 'shelf',
      p_parent: ($('mlParent') || {}).value || null,
      p_sort: sort === '' ? null : Number(sort),
      p_enabled: !!(($('mlOn') || {}).checked)
    });
    if (error) { toast(error.message || '保存できませんでした'); return; }
    await reloadMasters();
    toast(id ? '保管場所を直しました' : '保管場所を足しました');
  } finally { masterBusy = false; }
}
async function toggleLoc(id) {
  const l = loc(id); if (!l) return;
  const { error } = await sb.rpc('inv_location_save', {
    p_id: id, p_name: l.name, p_kind: l.kind, p_parent: l.parent_id || null,
    p_sort: l.sort_no, p_enabled: !locLive(l)
  });
  if (error) { toast(error.message || '変えられませんでした'); return; }
  await reloadMasters();
  toast(locLive(loc(id)) ? '有効に戻しました' : '無効にしました');
}
/* 並べ替え。同じ親の中で、ひとつ上（下）の場所と表示順を入れ替える */
async function moveMasterLoc(id, dir) {
  const l = loc(id); if (!l) return;
  const sibs = db.locs.filter(x => (x.parent_id || null) === (l.parent_id || null))
    .sort((a, b) => ((a.sort_no || 0) - (b.sort_no || 0)) || String(a.name).localeCompare(String(b.name), 'ja'));
  const i = sibs.findIndex(x => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= sibs.length) return;
  const other = sibs[j];
  const a = (l.sort_no || 0), b = (other.sort_no || 0);
  const send = (x, sort) => sb.rpc('inv_location_save',
    { p_id: x.id, p_name: x.name, p_kind: x.kind, p_parent: x.parent_id || null, p_sort: sort, p_enabled: x.enabled !== false });
  const r1 = await send(l, b === a ? a + dir * 10 : b);
  if (r1.error) { toast(r1.error.message); return; }
  const r2 = await send(other, b === a ? a : a);
  if (r2.error) { toast(r2.error.message); return; }
  await reloadMasters();
}

async function sheetLocDelete(id) {
  const l = loc(id); if (!l) return;
  const { data, error } = await sb.rpc('inv_location_delete_check', { p_id: id });
  if (error) { toast(error.message || '確認できませんでした'); return; }
  const chk = data || {};
  const head = `<div class="delhead"><div class="n">${esc(l.name)}</div>
    <div class="meta">${esc(locPath(id))}　${esc(LOC_KIND_LABEL(l.kind))}</div></div>`;
  if (!chk.ok) {
    openSheet({
      title: '保管場所を削除', subject: id, cta: '閉じる',
      hint: 'この保管場所は削除できません。',
      body: head + `<ul class="delwhy">${(chk.reasons || []).map(r => `<li>${esc(r)}</li>`).join('')}</ul>
        <div class="meta">使い終わった場所は、削除ではなく<b>無効</b>にすると履歴が残ります。</div>`,
      run: () => {}
    });
    lockDeleteSheet();
    return;
  }
  openSheet({
    title: '保管場所を削除', subject: id, cta: '削除する',
    hint: `<b>${esc(l.name)}</b> を消します。中身が無く、履歴にも出てこない場所なので消せます。`,
    body: head,
    run: () => delMasterLoc(id)
  });
}
async function delMasterLoc(id) {
  if (masterBusy) return;
  masterBusy = true;
  try {
    const { data, error } = await sb.rpc('inv_location_delete', { p_id: id });
    if (error) { toast(error.message || '削除できませんでした'); return; }
    await reloadMasters();
    toast(`${(data && data.name) || id} を削除しました`);
  } finally { masterBusy = false; }
}

/* ---- カテゴリー ---- */
function masterCatBody() {
  const rows = catsOrdered();
  return `
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:14px 0 6px">
      <p class="meta" style="flex:1 1 240px;margin:0">ここが<strong>唯一のカテゴリーマスター</strong>です。
        /zaiko も 8ECトップも同じものを見ています。<strong>公開</strong>の印が付いたものが
        トップの「カテゴリーから探す」に出ます（商品が0件でも出ます）。</p>
      <button class="btn sm lime" onclick="sheetCatEdit(null)"><span class="ms">add</span>カテゴリーを足す</button>
    </div>
    <div class="mtree">${rows.map(c => {
      const tree = catTree(c.id);
      const np = db.masters.filter(p => tree.includes(p.category_id)).length;
      const own = db.masters.filter(p => p.category_id === c.id).length;
      return `<div class="r${catLive(c) ? '' : ' off'}" style="padding-left:${12 + catDepth(c.id) * 20}px">
        <span class="ms">${esc(c.public_icon || 'category')}</span>
        <div style="min-width:0;flex:1 1 auto">
          <div class="n">${esc(c.name)}
            ${catLive(c) ? '' : '<span class="tag off">無効</span>'}
            ${c.public_listed ? '<span class="tag pub">公開</span>' : ''}</div>
          <div class="c"><span class="num">${esc(c.id)}</span>　${c.kind === 'individual' ? '個体管理' : '数量管理'}　商品 ${
            catHasKids(c.id) ? `${np}件（直下 ${own}件）` : `${own}件`}　<span class="num">並び ${c.sort_no || 0}</span></div>
        </div>
        <div class="ops">
          <button class="btn sm ghost" onclick="moveMasterCat('${esc(c.id)}',-1)" title="上へ"><span class="ms">arrow_upward</span></button>
          <button class="btn sm ghost" onclick="moveMasterCat('${esc(c.id)}',1)" title="下へ"><span class="ms">arrow_downward</span></button>
          <button class="btn sm ghost" onclick="sheetCatEdit('${esc(c.id)}')">編集</button>
          <button class="btn sm ghost" onclick="toggleCat('${esc(c.id)}')">${catLive(c) ? '無効にする' : '有効に戻す'}</button>
          <button class="btn sm ghost danger" onclick="sheetCatDelete('${esc(c.id)}')">削除</button>
        </div></div>`;
    }).join('')}</div>`;
}

function catParentOptions(sel, selfId) {
  const ban = selfId ? catTree(selfId) : [];
  return `<option value="">（いちばん上：親なし）</option>` + catsOrdered()
    .filter(c => !ban.includes(c.id))
    .map(c => `<option value="${esc(c.id)}"${sel === c.id ? ' selected' : ''}>${esc(catOptLabel(c))}</option>`).join('');
}

function sheetCatEdit(id) {
  const c = id ? cat(id) : null;
  openSheet({
    title: c ? 'カテゴリーを直す' : 'カテゴリーを足す', subject: c ? c.id : '新規', cta: '保存',
    hint: c
      ? `<b class="num">${esc(c.id)}</b> は変えられません。商品はこのIDで紐づいているので、
         <strong>表示名を変えても紐付けは切れません</strong>。`
      : 'IDは名前から作ります（英数字とハイフン）。日本語だけの名前のときは自動で番号を振ります。作ったあとIDは変えられません。',
    body: `
      <label class="field" style="margin-bottom:10px"><span>表示名</span>
        <input class="input" id="mcName" value="${esc(c ? c.name : '')}" autocomplete="off" placeholder="例 ノートパソコン"></label>
      <div class="ie2">
        <label class="field"><span>管理方式</span>
          <select class="input" id="mcKind">
            <option value="individual"${!c || c.kind === 'individual' ? ' selected' : ''}>個体管理（1台ずつ）</option>
            <option value="quantity"${c && c.kind === 'quantity' ? ' selected' : ''}>数量管理（数が増減）</option>
          </select></label>
        <label class="field"><span>表示順</span>
          <input class="input num" type="number" id="mcSort" value="${esc(c ? (c.sort_no || 0) : '')}" placeholder="空なら最後"></label>
      </div>
      <label class="field" style="margin-bottom:10px"><span>親カテゴリー</span>
        <select class="input" id="mcParent">${catParentOptions(c ? c.parent_id : null, id)}</select></label>
      <div class="ie2">
        <label class="field"><span>アイコン（Material Symbols）</span>
          <input class="input" id="mcIcon" value="${esc(c ? (c.public_icon || '') : '')}" autocomplete="off" placeholder="laptop_mac"></label>
        <label class="field"><span>管理番号の記号</span>
          <input class="input" id="mcPrefix" value="${esc(c ? (c.code_prefix || '') : '')}" autocomplete="off" placeholder="PC"></label>
      </div>
      ${c ? '' : `<label class="field" style="margin-bottom:10px"><span>カテゴリーID（空なら名前から作ります）</span>
        <input class="input num" id="mcId" autocomplete="off" placeholder="notebook-pc"></label>`}
      <label class="chk"><input type="checkbox" id="mcOn" ${!c || catLive(c) ? 'checked' : ''}>
        <span>使える状態にする（外すと新規登録の候補に出なくなります）</span></label>
      <label class="chk"><input type="checkbox" id="mcPub" ${c && c.public_listed ? 'checked' : ''}>
        <span>公開サイトに表示する（8ECトップの「カテゴリーから探す」に出ます）</span></label>`,
    validate: () => {
      if (!(($('mcName') || {}).value || '').trim()) { toast('表示名を入れてください'); return false; }
      return true;
    },
    run: () => saveMasterCat(id)
  });
}
async function saveMasterCat(id) {
  if (masterBusy) return;
  masterBusy = true;
  try {
    const sort = (($('mcSort') || {}).value || '').trim();
    const { error } = await sb.rpc('inv_category_save', {
      p_id: id || (($('mcId') || {}).value || '').trim() || null,
      p_name: (($('mcName') || {}).value || '').trim(),
      p_kind: ($('mcKind') || {}).value || 'individual',
      p_parent: ($('mcParent') || {}).value || null,
      p_icon: (($('mcIcon') || {}).value || '').trim() || null,
      p_sort: sort === '' ? null : Number(sort),
      p_enabled: !!(($('mcOn') || {}).checked),
      p_public: !!(($('mcPub') || {}).checked),
      p_prefix: (($('mcPrefix') || {}).value || '').trim() || null
    });
    if (error) { toast(error.message || '保存できませんでした'); return; }
    await reloadMasters();
    toast(id ? 'カテゴリーを直しました' : 'カテゴリーを足しました');
  } finally { masterBusy = false; }
}
async function toggleCat(id) {
  const c = cat(id); if (!c) return;
  const { error } = await sb.rpc('inv_category_save', {
    p_id: id, p_name: c.name, p_kind: c.kind, p_parent: c.parent_id || null,
    p_icon: c.public_icon || null, p_sort: c.sort_no,
    p_enabled: !catLive(c), p_public: !!c.public_listed, p_prefix: c.code_prefix || null
  });
  if (error) { toast(error.message || '変えられませんでした'); return; }
  await reloadMasters();
  toast(catLive(cat(id)) ? '有効に戻しました' : '無効にしました');
}
async function moveMasterCat(id, dir) {
  const c = cat(id); if (!c) return;
  const sibs = db.cats.filter(x => (x.parent_id || null) === (c.parent_id || null))
    .sort((a, b) => ((a.sort_no || 0) - (b.sort_no || 0)) || String(a.name).localeCompare(String(b.name), 'ja'));
  const i = sibs.findIndex(x => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= sibs.length) return;
  const other = sibs[j];
  const a = (c.sort_no || 0), b = (other.sort_no || 0);
  const send = (x, sort) => sb.rpc('inv_category_save',
    { p_id: x.id, p_name: x.name, p_kind: x.kind, p_parent: x.parent_id || null,
      p_icon: x.public_icon || null, p_sort: sort, p_enabled: x.enabled !== false,
      p_public: !!x.public_listed, p_prefix: x.code_prefix || null });
  const r1 = await send(c, b === a ? a + dir * 10 : b);
  if (r1.error) { toast(r1.error.message); return; }
  const r2 = await send(other, a);
  if (r2.error) { toast(r2.error.message); return; }
  await reloadMasters();
}

async function sheetCatDelete(id) {
  const c = cat(id); if (!c) return;
  const { data, error } = await sb.rpc('inv_category_delete_check', { p_id: id });
  if (error) { toast(error.message || '確認できませんでした'); return; }
  const chk = data || {};
  const head = `<div class="delhead"><div class="n">${esc(c.name)}</div>
    <div class="meta"><span class="num">${esc(c.id)}</span>　${c.kind === 'individual' ? '個体管理' : '数量管理'}</div></div>`;
  if (!chk.ok) {
    const n = Number(chk.products || 0);
    openSheet({
      title: 'カテゴリーを削除', subject: id, cta: '閉じる',
      hint: 'このカテゴリーは削除できません。',
      body: head + `<ul class="delwhy">${(chk.reasons || []).map(r => `<li>${esc(r)}</li>`).join('')}</ul>
        ${n ? `<div class="meta" style="margin-bottom:8px">紐付いている商品を別のカテゴリーへ移すには、
          <button class="btn sm ghost" onclick="closeSheet();ui.fCat='${esc(id)}';go('list')">この ${n}件を一覧で開く</button>
          → 選んで「まとめて直す」から変えられます。</div>` : ''}
        <div class="meta">使い終わったカテゴリーは、削除ではなく<b>無効</b>にすると商品の表示が保てます。</div>`,
      run: () => {}
    });
    lockDeleteSheet();
    return;
  }
  openSheet({
    title: 'カテゴリーを削除', subject: id, cta: '削除する',
    hint: `<b>${esc(c.name)}</b> を消します。ぶら下がる商品も子カテゴリーも無いので消せます。`,
    body: head,
    run: () => delMasterCat(id)
  });
}
async function delMasterCat(id) {
  if (masterBusy) return;
  masterBusy = true;
  try {
    const { data, error } = await sb.rpc('inv_category_delete', { p_id: id });
    if (error) { toast(error.message || '削除できませんでした'); return; }
    await reloadMasters();
    toast(`${(data && data.name) || id} を削除しました`);
  } finally { masterBusy = false; }
}

/* 削除できないときのシート。押せるのは「閉じる」だけにする */
function lockDeleteSheet() {
  const cta = document.querySelector('#sheetPanel .acts .cta');
  if (cta) { cta.classList.remove('lime'); cta.classList.add('ghost'); }
  const cancel = document.querySelector('#sheetPanel .acts .cancel');
  if (cancel) cancel.style.display = 'none';
}

/* マスターを取り直して描き直す。商品・個体の件数表示にも効くので、
   画面のキャッシュを直すのではなくDBから読み直す */
async function reloadMasters() {
  const [c, l] = await Promise.all([
    sb.from('inventory_categories').select('*').order('sort_no'),
    sb.from('inventory_locations').select('*').order('sort_no')
  ]);
  if (!c.error) db.cats = c.data || [];
  if (!l.error) db.locs = l.data || [];
  render();
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
        <div class="meta">個体 ${done.items}台　${esc(done.file)}${
          done.skips ? `　／　重複スキップ ${done.skips}件 <a href="#" onclick="showSkips(${done.id});return false">詳細を見る</a>` : ''}</div>
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
  return { id: b.id, prods: (b.product_codes || []).length, items: b.item_count, file: b.file_name || '',
           skips: (b.skips || []).length || b.skip_count || 0 };
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
  const cats = catsFor(ind ? 'individual' : 'quantity');

  return `<h1>商品登録</h1>
    ${canAdmin() ? '' : '<div class="card" style="margin:15px 0">商品の登録は管理者だけができます。</div>'}

    ${regCsvMain()}

    <div class="sec regsub">1件ずつ商品登録</div>
    <p class="meta" style="margin:-8px 0 0">CSVに載らないものを手で足すときに使います。
      商品取込の画面からも同じ内容を入れられます。</p>
    ${regFieldsBody(ind, cats, 'setRegKind')}
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:18px">
      <button class="btn pri" onclick="doRegister()" ${canAdmin() ? '' : 'disabled'}>
        <span class="ms">add</span>登録してQR発行</button>
      <span class="meta">発行予定の${ind ? '管理番号' : '商品コード'}: <b id="idPreview" class="num">—</b></span>
    </div>`;
}

/* 1件ずつの登録フォーム。商品登録画面と、商品取込モーダルの「1件だけ登録」タブの
   両方から使う（項目がずれないよう1か所にまとめる）。kindFn は個体管理／数量管理の
   切り替えボタンが呼ぶ関数名（呼び出し側で描き直しかたが違うため） */
const regField = (id, label, type, extra) =>
  `<label class="field"><span>${esc(label)}</span><input class="input" id="r-${id}" ${type ? `type="${type}"` : ''} ${extra || ''}></label>`;
const regTextarea = (id, label) =>
  `<label class="field" style="grid-column:1/-1"><span>${esc(label)}</span><textarea class="input" id="r-${id}" rows="2"></textarea></label>`;
function regFieldsBody(ind, cats, kindFn) {
  return `
    <div class="seg" style="margin:15px 0">
      <button class="${ind ? 'on' : ''}" onclick="${kindFn}('ind')">個体管理</button>
      <button class="${!ind ? 'on' : ''}" onclick="${kindFn}('qty')">数量管理</button>
    </div>
    <p class="meta" style="margin-bottom:12px">${ind
      ? '1台＝1レコードで登録します。同じ型番がすでにあれば、その商品にぶら下がる個体として足します。'
      : '数が増減する消耗品などです。1品目＝1レコードで、在庫数を持ちます。'}</p>
    <div class="fields">
      ${regField('name', '商品名 *')}
      <label class="field"><span>カテゴリ *</span><select class="input" id="r-cat" onchange="previewId()">
        <option value="">選択してください</option>
        ${cats.map(c => `<option value="${esc(c.id)}"${catHasKids(c.id) ? ' disabled' : ''}>${
          esc(catOptLabel(c))}${catHasKids(c.id) ? '（下から選んでください）' : ''}</option>`).join('')}</select></label>
      <label class="field"><span>保管場所 *</span><select class="input" id="r-loc">${locOptions('', '選択してください')}</select></label>
      ${regField('maker', 'メーカー')}
      ${regField('model', '型番')}
      ${regTextarea('spec', 'スペック')}
      ${ind ? regField('serial', 'シリアル番号') + regField('buy', '購入日', 'date') + regField('price', '購入価格', 'number')
            : regField('qty', '初期在庫数 *', 'number') + regField('min', '最低在庫数 *', 'number') + regField('unit', '購入単価', 'number')}
      ${regTextarea('note', '備考')}
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
  // 入力が足りないときは閉じない（閉じてから知らせると入れ直しになるため）
  if (sheetState.validate && !sheetState.validate(val)) return;
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
function sheetUnreserve(id) {
  const it = item(id); if (!it) return;
  openSheet({
    title: '予約解除', subject: id, cta: '予約を解除',
    hint: `${esc(it.name)}の販売予約を取り消し、在庫に戻します（発送前のキャンセル用。発送済みは「売却」で記録してください）。`,
    run: () => itemOp(id, '予約解除', null)
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
  if (GONE.includes((data || {}).status)) warnStillListed([id], data.status);
}

/* ---- 販売サイトの管理画面 ----
   売れたあと、そのサイトの在庫を直しにいく導線。モールの管理画面URLは
   店舗の契約や画面改定で変わるので、コードに直書きせず設定として持つ。
     1) その商品の直リンク（listing.admin_url）
     2) チャネルのひな形（{manage} {sku} {item_code} を差し替える）
     3) 管理画面のトップ（商品は管理番号で探してもらう）
   どれも無ければ「未設定」と出して、設定画面へ案内する。 */
const chanSetting = (ch) => db.chanSettings.find(x => x.channel === ch) || {};

/* 管理画面で商品を探す手がかり。どれも登録済みの値から取り、URLは推測しない */
function manageKeys(x) {
  const ext = ((x || {}).external_item_code || '').trim();
  // 楽天の external_item_code は「店舗コード:商品番号」。商品番号だけを取り出す
  const itemCode = ext.indexOf(':') >= 0 ? ext.split(':').pop() : ext;
  let manage = '';
  const u = ((x || {}).url || '').trim();
  if (u) {
    const seg = u.split('?')[0].replace(/\/+$/, '').split('/');
    manage = seg[seg.length - 1] || '';          // 掲載URLの末尾＝商品管理番号
  }
  return { manage, sku: ((x || {}).sku || '').trim(), item_code: itemCode };
}
function adminUrlOf(x, ch) {
  const st = chanSetting(ch);
  const direct = ((x || {}).admin_url || '').trim();
  if (direct) return { url: direct, kind: 'direct' };
  const k = manageKeys(x);
  const tpl = (st.admin_item_url_template || '').trim();
  if (tpl && (k.manage || k.sku || k.item_code)) {
    return {
      url: tpl.replace(/\{manage\}/g, encodeURIComponent(k.manage))
              .replace(/\{sku\}/g, encodeURIComponent(k.sku))
              .replace(/\{item_code\}/g, encodeURIComponent(k.item_code)),
      kind: 'template'
    };
  }
  const home = (st.admin_home_url || '').trim();
  if (home) return { url: home, kind: 'home' };
  return { url: null, kind: 'none' };
}
function copyText(t, msg) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(() => toast(msg || 'コピーしました'), () => toast('コピーできませんでした'));
  } else { toast('コピーできませんでした'); }
}

/* 手元から出た1台が、まだどこかに出品中のまま残っていたら知らせる。
   自社在庫が正なので、販売サイト側を直してもらう。
   管理画面を開いただけでは終わりにせず、直したあとに人が
   「販売サイト側の対応済み」を押す。 */
function warnStillListed(ids, action) {
  // 出品情報は「1台ぶん」と「型番まとめて」の2通りある。どちらで出していても
  // 販売サイトには載ったままなので、一覧と同じ見かた（listingOf）で拾う
  const liveOf = (id) => {
    const it = item(id);
    if (!it) return [];
    return CHANNELS.map(c => listingOf(it, c.key)).filter(x => x && x.state === LISTED);
  };
  const live = ids.filter(id => liveOf(id).length);
  if (!live.length) return;
  const rows = live.map(id => {
    const on = liveOf(id);
    const links = on.map(x => {
      const a = adminUrlOf(x, x.channel);
      const k = manageKeys(x);
      const hint = k.manage || k.item_code || k.sku;
      return `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px">
        ${a.url
          ? `<a class="btn sm" href="${esc(a.url)}" target="_blank" rel="noopener">
               <span class="ms">open_in_new</span>${esc(chanLabel(x.channel))}管理画面を開く</a>`
          : `<span class="meta">${esc(chanLabel(x.channel))}の管理画面URLが未設定です</span>
             ${canAdmin() ? `<button class="btn sm ghost" onclick="openChannelAdminSetup('${esc(x.channel)}')">設定する</button>` : ''}`}
        ${a.kind === 'home' ? '<span class="meta">（トップが開きます。商品は管理番号で探してください）</span>' : ''}
        ${hint ? `<span class="meta num" style="word-break:break-all">${esc(hint)}</span>
          <button class="btn sm ghost" onclick="copyText('${esc(hint)}','商品管理番号をコピーしました')">コピー</button>` : ''}
        ${x.fromProduct && inStockOf((item(id) || {}).product_code) > 0
          ? `<span class="meta">この商品はまだ在庫 ${inStockOf((item(id) || {}).product_code)}台。
               <strong>掲載は残したまま数量だけ</strong>直してください</span>` : ''}
      </div>`;
    }).join('');
    return `<div class="card" style="margin-bottom:8px">
      <div><span class="c num" style="font-weight:600">${esc(id)}</span>
        <span class="meta">　${esc(on.map(x => chanLabel(x.channel)).join('・'))}に出品中</span></div>
      ${links}
    </div>`;
  }).join('');
  openModal('出品したままです', `
    <div class="card" style="background:#FFF4E5;margin-bottom:14px">
      ${live.length}台が<strong>${esc(action || '在庫から外れた状態')}</strong>ですが、
      販売サイトではまだ<strong>出品中</strong>のままです。<br>
      <span class="meta">在庫の数は自社のデータが正です。次の順で進めてください。<br>
        ①管理画面を開く　②販売サイト側の在庫を0（または必要数量）に直す　
        ③ここへ戻って「販売サイト側の対応済み」を押す</span>
    </div>
    ${rows}
    <p class="meta" style="margin-top:10px">「販売サイト側の対応済み」は、<strong>/zaiko の記録を出品停止にするだけ</strong>です。
      販売サイト側は自動では変わらないので、先に管理画面で直してください。</p>`,
    [['あとで', 'closeModal()', 'btn ghost'],
     ['販売サイト側の対応済み', `closeModal();markChannelsHandled(${JSON.stringify(live).replace(/"/g, '&quot;')})`, 'btn lime']]);
}

/* 「販売サイト側の対応済み」。/zaikoの記録を合わせるだけで、販売サイトは触らない。
     1台ぶんの出品      … その1台を出品停止にする
     型番まとめての出品 … 在庫が残っているうちは掲載を落とさない。
                          楽天などは「掲載は維持・数量だけ減らす」考えかたなので、
                          最後の1台が出たときにだけ出品停止にする */
async function markChannelsHandled(ids) {
  let stoppedUnit = 0, stoppedProd = 0, kept = 0;
  for (const id of ids) {
    const it = item(id);
    if (!it) continue;
    for (const c of CHANNELS) {
      const x = listingOf(it, c.key);
      if (!x || x.state !== LISTED) continue;
      if (!x.fromProduct) {
        const { error } = await sb.rpc('inv_listing_set', {
          p_item_id: id, p_code: null, p_channel: c.key, p_state: '出品停止',
          p_sku: x.sku || null, p_price: x.price == null ? null : x.price,
          p_url: x.url || null, p_note: x.note || null
        });
        if (error) { toast('記録できませんでした：' + error.message); return; }
        stoppedUnit++;
      } else if (inStockOf(it.product_code) === 0) {
        const { error } = await sb.rpc('inv_listing_set', {
          p_item_id: null, p_code: it.product_code, p_channel: c.key, p_state: '出品停止',
          p_sku: x.sku || null, p_price: x.price == null ? null : x.price,
          p_url: x.url || null, p_note: x.note || null
        });
        if (error) { toast('記録できませんでした：' + error.message); return; }
        stoppedProd++;
      } else {
        kept++;   // 在庫が残っているので掲載はそのまま（数量だけ直してもらう）
      }
    }
  }
  await loadAll();
  render();
  toast([stoppedUnit + stoppedProd ? `${stoppedUnit + stoppedProd}件を出品停止にしました` : '',
         kept ? `${kept}件は在庫が残っているので掲載はそのままです（数量だけ直してください）` : '']
        .filter(Boolean).join('／') || '変更はありませんでした');
}

/* 販売サイトの管理画面URLを設定する（管理者だけ）。
   モールごとに画面が違うので、実際のURLを見て入れてもらう。
   将来モールのAPIで在庫数を直せるようになったら、この設定行に接続情報を足す。 */
function openChannelAdminSetup(ch) {
  if (!canAdmin()) { toast('設定は管理者だけができます'); return; }
  const c = CHANNELS.find(x => x.key === ch) || { key: ch, label: ch };
  const st = chanSetting(ch);
  openModal(`${c.label}の管理画面URL`, `
    <p class="meta" style="margin-bottom:12px">売れたあとに在庫を直しにいく先です。
      <strong>実際に管理画面で対象商品を開いて、そのURLを貼ってください。</strong>
      画面の作りは変わることがあるので、コード側では決め打ちにしていません。</p>
    <label class="field" style="margin-bottom:10px"><span>管理画面のトップ（ログイン先）</span>
      <input class="input" id="caHome" value="${esc(st.admin_home_url || '')}" placeholder="https://…">
      <span class="meta">商品ごとのURLが分からないときは、ここが開きます。</span></label>
    <label class="field" style="margin-bottom:10px"><span>商品ごとのURL（ひな形・任意）</span>
      <input class="input" id="caTpl" value="${esc(st.admin_item_url_template || '')}" placeholder="https://…?manageNumber={manage}">
      <span class="meta"><code>{manage}</code>（商品管理番号）<code>{sku}</code><code>{item_code}</code> が差し替わります。
        1商品だけ確実なURLがあるときは、商品詳細の出品編集で「管理画面URL」に直接入れてください。</span></label>
    ${st.note ? `<p class="meta">${esc(st.note)}</p>` : ''}`,
    [['閉じる', 'closeModal()', 'btn ghost'],
     ['保存', `saveChannelAdmin('${esc(ch)}')`, 'btn lime']]);
}
async function saveChannelAdmin(ch) {
  const { data, error } = await sb.rpc('inv_channel_settings_set', {
    p_channel: ch,
    p_home: (($('caHome') || {}).value || '').trim() || null,
    p_template: (($('caTpl') || {}).value || '').trim() || null
  });
  if (error) { toast('保存できませんでした：' + error.message); return; }
  const i = db.chanSettings.findIndex(x => x.channel === ch);
  if (data) { if (i >= 0) db.chanSettings[i] = data; else db.chanSettings.push(data); }
  closeModal();
  toast(`${chanLabel(ch)}の管理画面URLを保存しました`);
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

/* ===== 13. 8RENT申込 =====
   8RENT（サイトトップ /）から入ったレンタル申込を扱う。個体の割り当ては申込時に
   inv_rental_request() が自動でやっている（在庫の個体を1台「予約中」にする）ので、
   ここでの操作は状態を進めるだけ：発送する（予約中→貸出中）／返却済みにする（貸出中→在庫）／
   キャンセル（予約中→在庫）。個体の状態と申込の状態は常に連動する。 */
const RENTAL_STATES = ['希望受付', '在庫・調達確認', '個体割当', 'レンタル確定', '貸出中', '返却済み', 'キャンセル'];
function onRentalFilter() {
  ui.fRental = ($('rf-status') || {}).value || '';
  renderRentalBody();
}
function renderRentalBody() {
  const el = $('rentalBody');
  if (el) el.innerHTML = rentalBodyHtml();
}
function viewRentalRequests() {
  const open = db.rentalReqs.filter(r => r.status === '希望受付').length;
  const procure = db.rentalReqs.filter(r => ['在庫・調達確認', '個体割当', 'レンタル確定'].includes(r.status)).length;
  return `<h1>8RENT申込</h1>
    <p class="sub" style="margin:8px 0 15px">8RENTから届いた<strong>ご希望</strong>です。お客様は個体を選びません。条件と台数だけが届きます。<br>
      <strong>希望受付</strong>の時点では在庫を押さえていません。
      <strong>確認を始める</strong>→<strong>個体を割り当てる</strong>（ここではじめて個体が「予約中」になります）→
      <strong>レンタル確定</strong>→<strong>発送する</strong>→<strong>返却済みにする</strong>の順で進めてください。<br>
      在庫が足りないぶんは「在庫・調達確認」のまま残ります。仮の個体は作らないので、取り寄せた現物を登録して
      8RENT対象にしてから、もう一度「個体を割り当てる」を押してください。</p>
    ${open || procure ? `<div class="card" style="background:#FFF4E5;margin-bottom:15px;display:flex;align-items:center;gap:10px">
      <span class="ms" style="font-size:20px;color:#B26A00">notifications_active</span>
      <div>${[open ? `未対応のご希望が <b>${open}件</b>` : '', procure ? `対応中が <b>${procure}件</b>` : '']
        .filter(Boolean).join('、')} あります。</div>
    </div>` : ''}
    <div style="max-width:260px;margin-bottom:12px">
      <select class="input" id="rf-status" onchange="onRentalFilter()">
        <option value="">すべての状態</option>
        ${RENTAL_STATES.map(s => `<option${ui.fRental === s ? ' selected' : ''}>${esc(s)}</option>`).join('')}
      </select>
    </div>
    <div id="rentalBody">${rentalBodyHtml()}</div>`;
}
const rentalStatusTag = (s) => {
  const cls = { '希望受付': 'few', '在庫・調達確認': 'few', '個体割当': 'few',
                'レンタル確定': 'ok', '貸出中': 'ok', '返却済み': 'none', 'キャンセル': 'none' }[s] || 'none';
  return `<span class="tag stk-${cls}">${esc(s)}</span>`;
};
/* お客様が送ってきた条件を1行にする（公開側の申込フォームと同じ並び） */
function rentalCondText(r) {
  const c = r.conditions || {};
  return [
    c.cpu, c.memory_gb ? `メモリ${c.memory_gb}GB以上` : '',
    c.storage_gb ? (c.storage_gb >= 1024 ? 'SSD 1TB以上' : `SSD ${c.storage_gb}GB以上`) : '',
    { small: '13型以下', mid: '14型前後', large: '15型以上' }[c.screen] || '',
    c.office === 'yes' ? 'Officeあり' : (c.office === 'no' ? 'Officeなし' : ''),
    c.webcam ? 'カメラ必須' : '', c.numpad ? 'テンキー必須' : ''
  ].filter(Boolean).join('／');
}

/* 申込に割り当てられた個体。複数台に対応する前の申込は item_id にだけ入っている */
const reqItems = (r) => (r.item_ids && r.item_ids.length ? r.item_ids : (r.item_id ? [r.item_id] : []));
function rentalBodyHtml() {
  const rows = db.rentalReqs.filter(r => !ui.fRental || r.status === ui.fRental);
  if (!rows.length) return '<div class="empty" style="margin-top:15px">該当する申込はありません。</div>';
  return `<div class="table-wrap"><table class="t">
    <thead><tr>
      <th>申込日</th><th>お客様</th><th>商品</th><th class="r">台数</th><th>個体</th>
      <th>希望開始日</th><th class="r">利用月数</th><th>状態</th>${canEdit() ? '<th></th>' : ''}
    </tr></thead>
    <tbody>${rows.map(r => {
      const p = prod(r.product_code);
      const ids = reqItems(r);
      return `<tr class="clk" onclick="showRentalDetail(${r.id})">
        <td class="meta nowrap num">${esc(fmtDT(r.created_at))}</td>
        <td>${esc(r.customer_name)}${r.company ? `<div class="meta">${esc(r.company)}</div>` : ''}</td>
        <td class="nowrap">${esc(p ? titleOf(p) : r.product_code)}${r.office ? '<div class="meta">Office付き</div>' : ''}</td>
        <td class="num r">${r.qty || 1}${r.procure_qty ? `<div class="meta">取り寄せ ${r.procure_qty}</div>` : ''}</td>
        <td class="num">${ids.length ? esc(ids.join('、')) : '—'}</td>
        <td class="meta nowrap">${r.start_date ? fmtD(r.start_date) : '—'}</td>
        <td class="num r">${r.months || '—'}</td>
        <td>${rentalStatusTag(r.status)}</td>
        ${canEdit() ? `<td class="nowrap ops2" onclick="event.stopPropagation()">${rentalActionBtns(r)}</td>` : ''}
      </tr>`;
    }).join('')}</tbody></table></div>`;
}
/* 希望受付 → 在庫・調達確認 → 個体割当 → レンタル確定 → 貸出中 → 返却済み。
   個体を押さえるのは「個体を割り当てる」を押したときだけ。 */
function rentalActionBtns(r) {
  const cancel = `<button class="btn sm ghost" onclick="doRentalStatus(${r.id},'キャンセル')">キャンセル</button>`;
  if (r.status === '希望受付') return `
    <button class="btn sm" onclick="doRentalStatus(${r.id},'在庫・調達確認')">確認を始める</button>${cancel}`;
  if (r.status === '在庫・調達確認') return `
    <button class="btn sm" onclick="doRentalAllocate(${r.id})">個体を割り当てる</button>${cancel}`;
  if (r.status === '個体割当') return `
    <button class="btn sm" onclick="doRentalStatus(${r.id},'レンタル確定')">レンタル確定</button>${cancel}`;
  if (r.status === 'レンタル確定') return `
    <button class="btn sm" onclick="doRentalStatus(${r.id},'貸出中')">発送する</button>${cancel}`;
  if (r.status === '貸出中') return `<button class="btn sm" onclick="doRentalStatus(${r.id},'返却済み')">返却済みにする</button>`;
  return '';
}
function showRentalDetail(id) {
  const r = db.rentalReqs.find(x => x.id === id);
  if (!r) return;
  const p = prod(r.product_code);
  openModal(`申込 #${r.id}`, `
    <div class="info" style="margin-bottom:14px">
      <div><span class="k">お客様</span>${esc(r.customer_name)}</div>
      <div><span class="k">会社名</span>${esc(r.company || '—')}</div>
      <div><span class="k">メール</span>${esc(r.email || '—')}</div>
      <div><span class="k">電話</span>${esc(r.phone || '—')}</div>
      <div><span class="k">商品</span>${esc(p ? titleOf(p) : r.product_code)}</div>
      <div><span class="k">台数</span>${r.qty || 1}台${r.procure_qty ? `（うち取り寄せ ${r.procure_qty}台）` : ''}</div>
      <div><span class="k">Office</span>${r.office ? '希望あり' : '—'}</div>
      <div><span class="k">ご希望の条件</span>${esc(rentalCondText(r)) || '—'}</div>
      <div><span class="k">割り当てた個体</span>${reqItems(r).length
        ? reqItems(r).map(id => `<a href="#" onclick="closeModal();go('item','${esc(id)}');return false">${esc(id)}</a>`).join('、')
        : '—'}</div>
      <div><span class="k">希望開始日</span>${r.start_date ? fmtD(r.start_date) : '—'}</div>
      <div><span class="k">希望利用月数</span>${r.months || '—'}</div>
      <div><span class="k">申込日</span>${esc(fmtDT(r.created_at))}</div>
      <div><span class="k">状態</span>${rentalStatusTag(r.status)}</div>
    </div>
    ${r.message ? `<div class="sec" style="font-size:16px;margin:16px 0 6px">お問い合わせ内容</div><div class="pre">${esc(r.message)}</div>` : ''}
  `, [['閉じる', 'closeModal()', 'btn ghost'],
      ...(canEdit() && r.status === '希望受付' ? [
        ['キャンセル', `doRentalStatus(${r.id},'キャンセル');closeModal()`, 'btn ghost'],
        ['確認を始める', `doRentalStatus(${r.id},'在庫・調達確認');closeModal()`, 'btn lime']
      ] : []),
      ...(canEdit() && r.status === '在庫・調達確認' ? [
        ['キャンセル', `doRentalStatus(${r.id},'キャンセル');closeModal()`, 'btn ghost'],
        ['個体を割り当てる', `doRentalAllocate(${r.id});closeModal()`, 'btn lime']
      ] : []),
      ...(canEdit() && r.status === '個体割当' ? [
        ['キャンセル', `doRentalStatus(${r.id},'キャンセル');closeModal()`, 'btn ghost'],
        ['レンタル確定', `doRentalStatus(${r.id},'レンタル確定');closeModal()`, 'btn lime']
      ] : []),
      ...(canEdit() && r.status === 'レンタル確定' ? [
        ['キャンセル', `doRentalStatus(${r.id},'キャンセル');closeModal()`, 'btn ghost'],
        ['発送する', `doRentalStatus(${r.id},'貸出中');closeModal()`, 'btn lime']
      ] : []),
      ...(canEdit() && r.status === '貸出中' ? [
        ['返却済みにする', `doRentalStatus(${r.id},'返却済み');closeModal()`, 'btn lime']
      ] : [])]);
}
async function doRentalStatus(id, status) {
  const { data, error } = await sb.rpc('inv_rental_set_status', { p_request_id: id, p_status: status });
  if (error) { toast('進められませんでした：' + error.message); return; }
  const i = db.rentalReqs.findIndex(x => x.id === id);
  if (i >= 0 && data) db.rentalReqs[i] = data;
  await loadAll();
  render();
  toast(`申込 #${id} を「${status}」にしました`);
}

/* 取り寄せぶんに現物を割り当てる。在庫が無ければ仮の個体は作らず、足りないぶんを残す */
async function doRentalAllocate(id) {
  const { data, error } = await sb.rpc('inv_rental_allocate', { p_request_id: id });
  if (error) { toast('割り当てられませんでした：' + error.message); return; }
  await loadAll();
  render();
  const r = data || {};
  const got = (r.item_ids || []).length;
  toast(r.status === '個体割当'
    ? `申込 #${id} に${got}台そろいました。レンタル確定に進めます`
    : `申込 #${id} に${got}台まで割り当てました（あと${r.procure_qty}台は在庫・調達待ちです）`);
}

/* Escapeで、開いているものを手前から順に閉じる */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('modal').classList.contains('on')) { closeModal(); return; }
  if ($('sheet').classList.contains('on')) { closeSheet(); return; }
  if (scan.on) closeScan();
});
