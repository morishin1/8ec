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
   行クリック（商品詳細を開く）と二重に反応しないよう、伝播を止める。

   itemId を渡すと、いちばん右に［¥］（この1台の販売価格を計算）を足す。
   相場を見に行くのは外のサイト、値付けは自分の原価から、という並びにしている。
   押しても在庫・販売予定価格・出品情報は変えない（計算して見せるだけ）。 */
function marketBtns(maker, model, compact, itemId) {
  const q = marketQuery(maker, model);
  const btns = MARKETS.map(k => q
    ? `<a class="mchk" href="${esc(k.url(q))}" target="_blank" rel="noopener noreferrer"
         onclick="event.stopPropagation()" title="${esc(k.label + '：' + q)}"
         aria-label="${esc(k.label + '：' + q)}">${esc(k.mark)}</a>`
    : `<span class="mchk off" aria-disabled="true" role="img"
         title="型番を登録すると検索できます"
         aria-label="${esc(k.label)}（型番を登録すると検索できます）">${esc(k.mark)}</span>`).join('')
    + (itemId ? `<button type="button" class="mchk calc"
         onclick="event.stopPropagation();openStockPricing(['${esc(itemId)}'])"
         title="この1台の販売価格を計算（保存しません）"
         aria-label="この1台の販売価格を計算">¥</button>` : '');
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
  ['deals', 'request_quote', '案件', '/deals'],
  ['rental', 'car_rental', '8RENT申込', '/rental-requests'],
  // マスター管理はメニューにも管理者だけ出す（画面側でも権限を見る）
  ['master', 'tune', 'マスター管理', '/masters', 'admin']
];

let sb = null;
let me = { email: '', name: '', role: 'viewer' };
const db = {
  cats: [], locs: [], masters: [], items: [], channels: [],
  tx: [], stocktake: null, stChecked: [], stPast: [], stSummary: [],  // stSummary は inv_stocktake_summary（1棚卸1行の照合結果）
  members: [], imports: [], rentalReqs: [],
  chanSettings: [],         // 販売サイトごとの管理画面URL（inventory_channel_settings）
  deals: [],                // 3分診断（/quote）から届いた案件
  quotes: [], qItems: [], qTotals: [],   // 見積・明細・合計
  contracts: [], cItems: [],             // 契約・契約明細（Phase 3-a）
  invoices: [], payments: [],            // 請求・入金（Phase 3-b）
  fulLines: [], fulfillments: [],        // 手配の一覧・確保した実物（Phase 3-c）
  shipTariffs: [],          // いま使っている運賃表（inventory_shipping_tariffs）
  stats: null               // 今月の経営数値（inv_dashboard_stats）
};
const ui = {
  screen: 'dash', itemId: null, prodId: null, locId: null,
  q: '', fCat: '', fMaker: '', fLoc: '', fStock: '',
  fAction: '', hq: '', regKind: 'ind', made: null, tab: 'info',
  drafts: {}, labelSel: {}, stScope: '', loaded: false, sel: {}, selItems: {}, fBatch: null, doneBatch: null,
  // 一覧のタブ。individual / model のほかに、販売サイトのキーと 'none'（未出品）を取る
  listMode: 'unit', fSt: '', fDiff: false, fNoPrice: false, fRental: '', fRentEl: '',
  fCheck: '',                // 棚卸の絞り込み。'' すべて / 'done' 確認済み / 'todo' 未確認
  fQr: '',                   // QR印刷の絞り込み。'' すべて / 'yes' 印刷済み / 'no' 未印刷
  stTab: 'todo',             // 棚卸画面のタブ。'todo' 未確認 / 'done' 確認済み / 'extra' 帳簿外現物
  mTab: 'loc',               // マスター管理のタブ（保管場所／カテゴリー）
  quoteId: null,             // いま開いている見積
  contractId: null,          // いま開いている契約
  fDeal: ''                  // 案件の状態の絞り込み
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
    sb.rpc('inv_dashboard_stats'),
    sb.from('inventory_deals').select('*').order('created_at', { ascending: false }).limit(300),
    sb.from('inventory_quotes').select('*').order('id', { ascending: false }).limit(500),
    sb.from('inventory_quote_items').select('*').limit(LOAD_LIMIT),
    sb.from('inv_quote_totals').select('*').limit(500),
    sb.from('inventory_contracts').select('*').order('id', { ascending: false }).limit(500),
    sb.from('inventory_contract_items').select('*').limit(LOAD_LIMIT),
    sb.from('inv_contract_invoice_list').select('*').order('id', { ascending: true }).limit(LOAD_LIMIT),
    sb.from('inventory_contract_payments').select('*').limit(LOAD_LIMIT),
    sb.from('inv_contract_fulfillment_list').select('*').limit(LOAD_LIMIT),
    sb.from('inventory_contract_fulfillments').select('*').limit(LOAD_LIMIT),
    sb.from('inventory_shipping_tariffs').select('*').eq('active', true).limit(5),
    sb.from('inv_stocktake_summary').select('*').order('started_at', { ascending: false }).limit(24)
  ];
  const [c, l, i, p, t, s, ch, im, rr, cl, cs, ds, dl, qh, qi, qt, kh, ki, vh, vp, fl, fm, sh, ss] = await Promise.all(q);
  const bad = [c, l, i, p, t, s, ch, im].find(r => r.error);
  if (bad) { showSetup(bad.error); return false; }
  db.imports = im.data || [];
  db.rentalReqs = rr.error ? [] : (rr.data || []);   // 未実行(setup.sql未更新)でも他が動くよう静かに空にする
  db.chanSettings = cs.error ? [] : (cs.data || []);
  // 経営数値。migration未適用でも他の画面が動くよう、取れなければnullにする
  db.stats = ds.error ? null : (ds.data || null);
  // 案件。migration未適用でも他の画面が動くよう、取れなければ空にする
  db.deals = dl.error ? [] : (dl.data || []);
  // 見積。migration未適用でも他の画面が動くよう、取れなければ空にする
  db.quotes = qh.error ? [] : (qh.data || []);
  db.qItems = qi.error ? [] : (qi.data || []);
  db.qTotals = qt.error ? [] : (qt.data || []);
  // 契約。migration未適用でも他の画面が動くよう、取れなければ空にする
  db.contracts = kh.error ? [] : (kh.data || []);
  db.cItems = ki.error ? [] : (ki.data || []);
  // 請求・入金。migration未適用でも他の画面が動くよう、取れなければ空にする
  db.invoices = vh.error ? [] : (vh.data || []);
  db.payments = vp.error ? [] : (vp.data || []);
  // 手配。migration未適用でも他の画面が動くよう、取れなければ空にする
  db.fulLines = fl.error ? [] : (fl.data || []);
  db.fulfillments = fm.error ? [] : (fm.data || []);
  // 運賃表。migration未適用でも他の画面が動くよう、取れなければ null にする
  db.shipTariffs = sh.error ? [] : (sh.data || []);
  // 棚卸の照合結果。DB側で数えたものをそのまま使う（ブラウザで何千行も数えない）。
  // migration未適用でも他の画面が動くよう、取れなければ空にする
  db.stSummary = ss.error ? [] : (ss.data || []);

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
  if (seg[0] === 'quotes' && seg[1]) return { screen: 'quote', quoteId: Number(seg[1]) || null };
  if (seg[0] === 'contracts' && seg[1]) return { screen: 'contract', contractId: Number(seg[1]) || null };
  const byPath = { list: 'list', in: 'in', out: 'out', loan: 'loan', stock: 'stock', locations: 'locs',
                   masters: 'master', history: 'hist', register: 'reg', labels: 'labels',
                   deals: 'deals', 'rental-requests': 'rental' };
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
  if (screen === 'deals') return BASE + '/deals';
  if (screen === 'quote') return BASE + '/quotes/' + encodeURIComponent(id);
  if (screen === 'contract') return BASE + '/contracts/' + encodeURIComponent(id);
  if (screen === 'loc') return BASE + '/locations/' + encodeURIComponent(id);
  const m = MENU.find(x => x[0] === screen);
  return BASE + (m ? m[3] : '') + (screen === 'list' ? listQuery() : '');
}

function go(screen, id) {
  const path = pathFor(screen, id);
  if (path !== location.pathname + location.search) history.pushState(null, '', path);
  closeSheet();
  applyRoute({ screen, itemId: screen === 'item' ? id : null, prodId: screen === 'prod' ? id : null,
               locId: screen === 'loc' ? id : null, quoteId: screen === 'quote' ? Number(id) : null,
               contractId: screen === 'contract' ? Number(id) : null });
  window.scrollTo(0, 0);
}
window.addEventListener('popstate', () => route(false));

function applyRoute(r) {
  ui.screen = r.screen;
  ui.itemId = r.itemId || null;
  ui.prodId = r.prodId || null;
  ui.locId = r.locId || null;
  ui.quoteId = r.quoteId || null;
  ui.contractId = r.contractId || null;
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
    deals: viewDeals, rental: viewRentalRequests, quote: viewQuote, contract: viewContract
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
  // 棚卸で「まだ確認していない」件数。棚卸画面・在庫一覧と同じ数え方を通す
  const stLeft = stocktakeProgress().left;
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
  ui.fCheck = ($('f-check') || {}).value || '';
  ui.fQr = ($('f-qr') || {}).value || '';
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
    ${stocktakeBar()}
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
          </select>
          <select class="input" id="f-check" onchange="onFilter()"
                  title="${db.stocktake ? '実施中の棚卸で現物を確認できているかで絞る' : '今月のうちに現物を確認できているかで絞る'}">
            <option value="">棚卸 すべて</option>
            <option value="done"${ui.fCheck === 'done' ? ' selected' : ''}>${
              db.stocktake ? '今回の棚卸：確認済み' : '今月：確認済みだけ'}</option>
            <option value="todo"${ui.fCheck === 'todo' ? ' selected' : ''}>${
              db.stocktake ? '今回の棚卸：未確認' : '今月：未確認だけ'}</option>
          </select>
          <select class="input" id="f-qr" onchange="onFilter()" title="QRラベルを印刷したかで絞る">
            <option value="">QR すべて</option>
            <option value="no"${ui.fQr === 'no' ? ' selected' : ''}>未印刷だけ</option>
            <option value="yes"${ui.fQr === 'yes' ? ' selected' : ''}>QR印刷済みだけ</option>
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
  const ckIdx = stocktakeIndex();      // 棚卸の絞り込み用。1行ずつ探さず1回で作る
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
    if (!checkFilterHit(i, ckIdx)) return false;
    if (!qrFilterHit(i)) return false;
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

/* 在庫一覧（個体別）の表。
   列が13あって横に間延びし、右の 状態・棚卸・8RENT が切れていたので、
   **関係の近いものを同じセルの2段にまとめて10列**にした。情報は減らしていない。

     管理番号 ← 仕入元ID・仕入日
     型番     ← メーカー
     価格     ← 原価・販売予定価格

   価格調査のボタンは型番セルにも出ていて二重だったので、専用の列だけにした。

   幅は `table-layout: fixed` ＋ colgroup の％で配り、**表の幅が親の幅と必ず一致**する
   ようにしている（横スクロールを隠すのではなく、出ないようにする）。
   狭い画面ではカードに切り替える（index.html の table.t.unittbl のところ）。 */
/*            ☑    管理番号 型番   価格   価格調査 出品先 保管場所 状態  棚卸   8RENT */
const UNIT_COLS_PICK = ['3%', '12%', '14%', '10%', '13%', '9%', '8%', '9%', '11%', '11%'];
const UNIT_COLS      = ['12%', '15%', '10%', '13%', '9%', '9%', '9%', '12%', '11%'];

function unitsBodyHtml() {
  const rows = unitsFiltered();
  if (!rows.length) return `<div class="empty" style="margin-top:15px">該当する在庫はありません。</div>`;
  const ckIdx = stocktakeIndex();      // 棚卸の確認状況。1行ずつ探さず1回で作る
  const live = rows.filter(r => r.kind === 'item' && IN_STOCK.includes(r.i.status)).length;
  const qty = rows.filter(r => r.kind === 'qty').reduce((n, r) => n + (r.m.qty || 0), 0);
  const pick = canEdit();
  const rentN = rows.filter(r => r.kind === 'item' && isRentalOn(r.i)).length;
  // 棚卸の数え方は棚卸画面と同じ（db.stChecked）。この行は「いま出ている行のうち」を数える
  const ckDone = db.stocktake
    ? rows.filter(r => r.kind === 'item' && checkState(r.i, ckIdx).now).length : 0;
  const ckTodo = db.stocktake
    ? rows.filter(r => r.kind === 'item' && checkState(r.i, ckIdx).todo).length : 0;
  return `<div class="meta" style="margin:12px 0 4px">${rows.length} 件${
      live ? `／うち在庫・出品中 ${live}台` : ''}${rentN ? `／8RENT対象 ${rentN}台` : ''}${qty ? `／数量品 ${qty}` : ''}${
      db.stocktake ? `／この絞り込みの中では 棚卸確認済 ${ckDone}・未確認 ${ckTodo}` : ''}</div>
    <div class="table-wrap"><table class="t unittbl">
    <colgroup>${(pick ? UNIT_COLS_PICK : UNIT_COLS).map(w => `<col style="width:${w}">`).join('')}</colgroup>
    <thead><tr>
      ${pick ? `<th class="ck"><input type="checkbox" id="selAllItems" onclick="toggleAllItems(this.checked)"
        ${allItemsSelected(rows) ? 'checked' : ''} title="表示中の個体をすべて選ぶ"></th>` : ''}
      <th class="col-id">管理番号</th><th class="col-model">型番・メーカー</th>
      <th class="col-price r">価格</th>
      <th class="col-market">価格調査</th>
      <th class="col-listing">出品先</th><th class="col-loc">保管場所</th>
      <th class="col-status">状態</th><th class="col-check">棚卸</th><th class="col-rental">8RENT</th>
    </tr></thead>
    <tbody>${rows.slice(0, 600).map(r => {
      const { i, m } = r;
      // 数量管理は現物1台を指す管理番号を持たない。「—」と出し、
      // 状態も「在庫 42」と数で出して、個体管理の行と取り違えないようにする。
      // 列の数は個体管理の行と必ずそろえる（ずれると見出しと中身が合わなくなる）
      if (r.kind === 'qty') return `<tr class="clk qty" onclick="go('prod','${esc(m.code)}')">
        ${pick ? '<td class="ck"></td>' : ''}
        <td class="col-id" data-label="管理番号"><span class="meta">—</span>
          <div class="meta">数量管理</div></td>
        <td class="col-model" data-label="型番"><div class="mdl">${esc(m.model || titleOf(m))}</div>
          ${m.maker ? `<div class="meta">${esc(m.maker)}</div>` : ''}
          <div class="meta num">${esc(m.code)}</div></td>
        <td class="col-price r" data-label="価格"><div class="num meta">${yen(m.unit_price)}</div>
          <div class="meta">単価</div></td>
        <td class="col-market" data-label="価格調査">${marketBtns(m.maker, m.model)}</td>
        <td class="col-listing mall" data-label="出品先">${listingChips(liveOnProd(m.code))}</td>
        <td class="col-loc meta" data-label="保管場所">${esc(locPath(m.location_id))}</td>
        <td class="col-status" data-label="状態">${qtyTag(m)}</td>
        <td class="col-check meta" data-label="棚卸">—</td>
        <td class="col-rental meta" data-label="8RENT">—</td>
      </tr>`;
      const cost = costOf(i), plan = planOf(i);
      // 型番・メーカーは商品マスターを優先。価格調査の検索語にも同じものを使う
      const mk = { model: (m && m.model) || i.model || '', maker: (m && m.maker) || i.maker || '' };
      return `<tr class="clk${isMismatch(i) ? ' warn' : ''}${ui.selItems[i.id] ? ' on' : ''}" data-item="${esc(i.id)}" onclick="go('item','${esc(i.id)}')">
        ${pick ? `<td class="ck" onclick="event.stopPropagation()">
          <input type="checkbox" ${ui.selItems[i.id] ? 'checked' : ''} onchange="toggleItem('${esc(i.id)}',this.checked)"></td>` : ''}
        <td class="col-id num" data-label="管理番号">
          <div class="idline">
            <a class="idlink" href="/zaiko/items/${encodeURIComponent(i.id)}"
               onclick="event.stopPropagation();event.preventDefault();go('item','${esc(i.id)}')"
               title="この1台の詳細と履歴">${esc(i.id)}</a>
            ${qrIcon(i)}
          </div>
          ${i.source_id ? `<div class="meta">仕入元 ${esc(i.source_id)}</div>` : ''}
          ${i.purchased_on ? `<div class="meta">${esc(fmtD(i.purchased_on))}</div>` : ''}</td>
        <td class="col-model" data-label="型番"><div class="mdl">${esc(mk.model)}</div>
          ${mk.maker ? `<div class="meta">${esc(mk.maker)}</div>` : ''}</td>
        <td class="col-price r num" data-label="価格">
          <div>${cost ? yen(cost) : '<span class="meta">—</span>'}</div>
          <div class="meta">予定 ${plan == null ? '—' : yen(plan)}</div></td>
        <td class="col-market" data-label="価格調査">${marketBtns(mk.maker, mk.model, false, i.id)}</td>
        <td class="col-listing mall" data-label="出品先">${listingChips(liveOn(i))}</td>
        <td class="col-loc meta" data-label="保管場所">${esc(locPath(i.location_id))}</td>
        <td class="col-status" data-label="状態">${statusTag(i.status, false, stockStale(i, ckIdx))}</td>
        <td class="col-check" data-label="棚卸">${checkCell(i, ckIdx)}</td>
        <td class="col-rental" data-label="8RENT">${rentalTag(i)}</td>
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

/* ---- QRラベルの印刷状態 ------------------------------------------------------
   **在庫一覧と棚卸は、この1つの関数を通して同じ色を出す。** 別々に判定すると
   「一覧では緑なのに棚卸では灰」というズレが起きるため。

   ブラウザは「実際に紙が出たか」を保証できない（印刷ダイアログをキャンセルしても
   afterprint は発火する）。なので**印刷操作をした時点**を発行済みとして記録し、
   出なかったときは押し直してもらう（再印刷は止めない。回数と日時が更新される）。

     ふつうの色の印刷アイコン … 未印刷
     色付きの印刷アイコン     … QR印刷済み

   文字は常時出さない。詳しいこと（初回・回数・最終）はホバーとタップで見せる。 */
const qrPrinted = (i) => !!(i && (i.qr_print_count || 0) > 0);

/* アイコンに出す説明。PCはホバー、スマホはタップでシートに同じ内容を出す */
function qrHint(i) {
  if (!qrPrinted(i)) return 'QR未印刷　押すとQRラベルを印刷できます';
  const n = i.qr_print_count || 1;
  const first = i.qr_printed_at ? fmtDT(i.qr_printed_at) : '—';
  const last = i.qr_printed_last ? fmtDT(i.qr_printed_last) : first;
  return n > 1
    ? `QR印刷済み　印刷回数 ${n}回　最終印刷 ${last}`
    : `QR印刷済み　${first}`;
}
/* 在庫一覧でも棚卸でも、出すのはこの1つ。列も文字も増やさない */
function qrIcon(i) {
  if (!i) return '';
  const on = qrPrinted(i);
  return `<button type="button" class="qrp${on ? ' on' : ''}" title="${esc(qrHint(i))}"
    aria-label="${esc(qrHint(i))}"
    onclick="event.stopPropagation();openQrPrint('${esc(i.id)}')"><span class="ms">print</span></button>`;
}
/* 絞り込み。'' すべて / 'no' 未印刷 / 'yes' 印刷済み */
function qrFilterHit(i) {
  if (!ui.fQr) return true;
  return ui.fQr === 'yes' ? qrPrinted(i) : !qrPrinted(i);
}

/* ---- 棚卸の確認状況 --------------------------------------------------------
   棚卸は「現物を確認した記録」でしかない。**在庫の状態・在庫数・出品状態・8RENTは
   1つも変えない**（サーバー側の inv_item_op も last_checked_at しか書き換えない）。

   もとになるのは次の2つだけで、DBには列を1つも足していない。
     inventory_items.last_checked_at   … いちばん最後に現物を見た日時
     inventory_stocktake_items         … 実施中の棚卸で、対象と確認済みを持つ

   **棚卸画面と在庫一覧は、同じ db.stChecked を数える。** 別々に数えると
   「棚卸では178なのに一覧では177」ということが起きるため。

   **「まだ確認していない」と「現物が無いことを確認した」は別もの。**
   `checked_at` は**現物があった**の意味だけを持ち、見つからないことには流用しない
   （それは `missing_at`）。数え方は expected と2つの日時で分ける。

     帳簿在庫     expected = true                      … 棚卸開始時の 在庫・出品中
     現物確認済み expected = true  かつ checked_at あり … 現物を見つけた
     差異確定     expected = true  かつ checked_at なし かつ missing_at あり
                                                        … 現物が無いことを人が確認した
     未確認       expected = true  かつ どちらも なし   … まだ処理していない
     帳簿外現物   expected = false かつ checked_at あり … 帳簿に無いのに現物があった

   **行の総数を帳簿在庫にしない。** 途中で帳簿外の現物を読んでも
   帳簿在庫 241台が 242台へ増えないようにするため。
   月次棚卸の完了条件は**未確認が0**＝全台が「現物あり」か「現物なしを確認済み」のどちらかになること。 */

/* 実施中の棚卸の進み具合。棚卸画面も在庫一覧もQR読取の件数もこれを呼ぶ。
   expected は棚卸開始時に true で入る。帳簿外現物だけ false（inv_item_op が足す）。
   古いデータで expected が入っていない行は、帳簿在庫として数える（=== false で見る） */
function stocktakeBuckets() {
  const all = db.stocktake ? (db.stChecked || []) : [];
  const book = all.filter(x => x.expected !== false);
  return {
    book,
    done:    book.filter(x => x.checked_at),                       // 現物確認済み
    missing: book.filter(x => !x.checked_at && x.missing_at),      // 差異確定
    todo:    book.filter(x => !x.checked_at && !x.missing_at),     // 未確認
    extra:   all.filter(x => x.expected === false && x.checked_at) // 帳簿外現物
  };
}
function stocktakeProgress() {
  const { book, done, missing, todo, extra } = stocktakeBuckets();
  const handled = done.length + missing.length;
  return {
    open: !!db.stocktake,
    total: book.length,       // 帳簿在庫
    done: done.length,        // 現物確認済み
    missing: missing.length,  // 差異確定
    left: todo.length,        // 未確認（まだ処理していない）
    extra: extra.length,      // 帳簿外現物
    handled,                  // 棚卸処理済み＝現物確認済み＋差異確定
    pct: book.length ? Math.round(handled / book.length * 100) : 0,
    rate: book.length ? (handled / book.length * 100).toFixed(1) : '0.0',
    doneIds: done.map(x => x.item_id),
    missingIds: missing.map(x => x.item_id),
    todoIds: todo.map(x => x.item_id),
    extraIds: extra.map(x => x.item_id)
  };
}
/* 実施中の棚卸の状況を引くための索引。1行ずつ探すと重いので1回で作る。
   **日時だけでなく expected も持つ。** 持たないと帳簿外現物（expected=false）が
   在庫一覧で「今回確認済み」に混ざってしまう。 */
function stocktakeIndex() {
  const idx = {};
  if (db.stocktake) (db.stChecked || []).forEach(x => {
    idx[x.item_id] = { checkedAt: x.checked_at || null,
                       missingAt: x.missing_at || null,
                       expected: x.expected !== false };
  });
  return idx;
}
/* 1台ぶんの確認状況。
     now     … 実施中の棚卸で現物を確認できた（今回見た）
     todo    … 実施中の棚卸の帳簿在庫だが、まだ処理していない
     missing … 実施中の棚卸で差異確定した（現物が無いことを確認した）
     at      … いちばん最後に現物を見た日時（過去の棚卸ぶんも含む）
   **帳簿外現物（expected=false）は帳簿在庫とは別軸**なので inScope に入れない。
   今回確認済み・今回未確認のどちらにも数えない。 */
function checkState(i, idx) {
  const map = idx || stocktakeIndex();
  const row = db.stocktake ? map[i.id] : null;
  const inScope = !!(row && row.expected);
  return { now: !!(inScope && row.checkedAt),
           todo: !!(inScope && !row.checkedAt && !row.missingAt),
           missing: !!(inScope && !row.checkedAt && row.missingAt),
           inScope, at: i.last_checked_at || null,
           thisMonth: isThisMonth(i.last_checked_at) };
}

/* 棚卸は月に1回まわす運用なので、「今月見たかどうか」を基準にする。
   先月見たきりのものは、今月まだ見ていない扱いにする */
function isThisMonth(v) {
  if (!v) return false;
  const d = new Date(v), n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth();
}

/* **今月の棚卸で現物を見たか。画面の色・「棚卸」欄・絞り込みはすべてこれ1つを通す。**
   別々に判定すると「棚卸欄では未確認なのに状態タグは確認済」というズレが起きるため。

     true  … 見た（状態タグは現在色のまま）
     false … まだ見ていない（状態タグを薄い赤にする）
     null  … 判断しない。色も付けず、絞り込みにも出さない
             ・実施中の棚卸の対象外（無理に未確認扱いしない）
             ・帳簿外現物（帳簿在庫とは別軸。どちらにも数えない）
             ・差異確定（現物が無いことを確認済み。「まだ見ていない」ではない）
             ・売却済・廃棄（手元に無いので棚卸の対象ではない） */
function checkedThisMonth(i, idx) {
  if (!i || GONE.includes(i.status)) return null;
  const s = checkState(i, idx);
  if (db.stocktake) {
    if (!s.inScope) return null;
    if (s.missing) return null;   // 処理は済んでいる。未確認に混ぜない
    return s.now;
  }
  return s.thisMonth;
}
/* 一覧の「棚卸」欄。実施中は今回の結果を、していないときは今月見たかどうかを出す。
   最後に見た日時もあわせて出すので、いつのものかが分かる */
function checkCell(i, idx) {
  const v = checkedThisMonth(i, idx);
  const at = i.last_checked_at || null;
  const when = at ? `<div class="meta nowrap">${esc(fmtDT(at))}</div>` : '';
  const last = at ? `<div class="meta nowrap">前回 ${esc(fmtDT(at))}</div>` : '';
  // 差異確定は「未確認」ではなく「処理済み」。そうと分かるように別の印を出す
  if (db.stocktake && checkState(i, idx).missing)
    return `<span class="tag chk miss">差異確定</span>${last}`;
  // 判断しないもの（実施中の棚卸の対象外・帳簿外現物・売却済・廃棄）は「未確認」とは言わない
  if (v === null) return `<span class="meta">—</span>${when}`;
  if (v) return `<span class="tag chk on">${db.stocktake ? '今回確認済' : '今月確認済'}</span>${when}`;
  if (db.stocktake) return `<span class="tag chk todo">未確認</span>${last}`;
  return at ? `<span class="tag chk todo">今月は未確認</span>${last}`
            : '<span class="tag chk none">未確認</span>';
}
/* 「棚卸」の絞り込み。欄の表示も状態タグの色も同じ checkedThisMonth() を通すので、
   「欄では未確認なのに絞り込みには出ない」というズレが起きない。
   判断しないもの（実施中の棚卸の対象外・売却済・廃棄）は確認済み・未確認の
   どちらにも出さない。「棚卸 すべて」のときは今までどおり一覧に出る。 */
function checkFilterHit(i, idx) {
  if (!ui.fCheck) return true;
  const v = checkedThisMonth(i, idx);
  if (v === null) return false;
  return ui.fCheck === 'done' ? v : !v;
}
/* 状態タグを薄い赤にするか。**「在庫」だけ**が対象で、ほかの状態の色は変えない。
   status そのものは変えない（色を変えているだけ）。
     true  … 今月まだ見ていない 在庫 → 薄い赤
     false … 今月見た 在庫        → いまの色のまま
     null  … 色も title も付けない */
function stockStale(i, idx) {
  if (!i || i.status !== '在庫') return null;
  const v = checkedThisMonth(i, idx);
  return v === null ? null : !v;
}
/* 在庫一覧の上に出す棚卸の進み具合。棚卸画面と同じ数字 */
function stocktakeBar() {
  const p = stocktakeProgress();
  if (!p.open) return '';
  return `<div class="stbar">
    <span class="ms">fact_check</span>
    <div style="flex:1;min-width:0">
      <div class="t">棚卸実施中　帳簿在庫 ${p.total}　現物確認済み ${p.done}　差異確定 ${p.missing}　未確認 ${p.left}${
        p.extra ? `　帳簿外現物 ${p.extra}` : ''}　処理済み ${p.handled} / ${p.total}</div>
      <div class="prog" style="margin-top:6px"><i style="width:${p.pct}%"></i></div>
    </div>
    <button class="btn sm ghost" onclick="ui.fCheck='todo';go('list')">未確認だけ見る</button>
    <button class="btn sm ghost" onclick="ui.fCheck='done';go('list')">確認済みだけ見る</button>
    <button class="btn sm ghost" onclick="go('stock')">棚卸の画面へ</button>
  </div>`;
}

/* ---- 選んだ個体のQRラベルを印刷 ----
   QRは作り直さない。**管理番号 → 個体URL → QR** といういまの仕組みのまま、
   すでにある管理番号のラベルをもう一度出すだけ。管理番号もURLも変えない。
   ラベルの作りは QRラベル画面（labelKey / selectedLabels / viewLabels）に任せる。 */
function printLabelsFor(ids, what) {
  const live = [...new Set((ids || []).filter(Boolean))].filter(x => item(x));
  if (!live.length) { toast('印刷できるQRがありません'); return; }
  ui.labelSel = {};
  live.forEach(x => { ui.labelSel[labelKey('item', x)] = true; });
  go('labels');
  if (live.length < ids.length) toast(`${ids.length - live.length}件は見つからないため除きました`);
  else toast(`${what || '選んだ個体'} ${live.length}件のQRを出しました`);
}
/* ---- QR印刷アイコンを押したとき --------------------------------------------
   未印刷 … そのままQRラベル画面へ（印刷すれば印刷済みになる）
   印刷済み … すぐ再印刷せず、まず印刷情報を見せる。そこから［再印刷］できる。
   **再印刷は止めない。** 紙が出なかったときのために、何度でも押し直せる。 */
function openQrPrint(id) {
  const it = item(id);
  if (!it) { toast('個体が見つかりません'); return; }
  if (!qrPrinted(it)) { printLabelsFor([id], 'この1台'); return; }
  const n = it.qr_print_count || 1;
  openModal('QR印刷済み', `
    <div class="card" style="margin-bottom:12px">
      <div><span class="k">管理番号</span>${esc(id)}</div>
      <div><span class="k">型番</span>${esc(it.model || it.name || '—')}</div>
      <div><span class="k">初回印刷</span>${it.qr_printed_at ? fmtDT(it.qr_printed_at) : '—'}</div>
      ${n > 1 ? `<div><span class="k">印刷回数</span>${n}回</div>
        <div><span class="k">最終印刷</span>${it.qr_printed_last ? fmtDT(it.qr_printed_last) : '—'}</div>` : ''}
      <div><span class="k">印刷者</span>${esc(qrPrinters(id) || '—')}</div>
    </div>
    <p class="meta">記録しているのは<strong>印刷ボタンを押した時点</strong>です。
      実際に紙が出たかはブラウザからは分からないので、出ていなければ［再印刷］してください。
      管理番号もQRのURLも変わりません。</p>
  `, [['閉じる', 'closeModal()', 'btn ghost'],
      ...(canEdit() ? [['再印刷', `closeModal();printLabelsFor(['${esc(id)}'],'この1台')`, 'btn lime']] : [])]);
}
/* 印刷した人は履歴（inventory_transactions）から拾う。列には持たない */
function qrPrinters(id) {
  const names = db.tx
    .filter(t => t.ref_kind === 'item' && t.ref_id === id && String(t.action).indexOf('QR') === 0)
    .map(t => t.actor).filter(Boolean);
  return [...new Set(names)].join('、');
}

/* ---- 印刷状態を書き換える唯一の入口（画面側） ----
   mode は 'print'（印刷操作）／'set'（既存の貼付済みを合わせる・管理者）／
   'clear'（未印刷に戻す・管理者）。サーバー側の inv_qr_print_mark と同じ。 */
async function markQrPrinted(ids, mode, note) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return false;
  const { data, error } = await sb.rpc('inv_qr_print_mark',
    { p_item_ids: list, p_mode: mode || 'print', p_note: note || null });
  if (error) { toast(error.message || '記録できませんでした'); return false; }
  (data || []).forEach(row => {
    const k = db.items.findIndex(x => x.id === row.id);
    if (k >= 0) db.items[k] = row;
  });
  return true;
}
/* すでに現物へQRが貼ってある既存在庫を、印刷済みに合わせる（実際の印刷はしない） */
function openQrMark(on) {
  const ids = selItemIds();
  if (!ids.length) { toast('個体を選んでください'); return; }
  if (!canAdmin()) { toast('この操作は管理者だけができます'); return; }
  const n = ids.filter(id => qrPrinted(item(id))).length;
  openModal(on ? 'QR印刷済みにしますか' : 'QR未印刷に戻しますか', `
    <p>選んだ <strong>${ids.length}台</strong> を${on ? '「QR印刷済み」にします' : '「未印刷」に戻します'}。</p>
    <p class="meta">${on
      ? `<strong>実際の印刷はしません。</strong>すでに現物へQRが貼ってある既存在庫を、
         画面の表示に合わせるための操作です。
         ${n ? `このうち ${n}台 はすでに印刷済みなので、そのままにします（回数は増やしません）。` : ''}`
      : '押し間違えたときの取り消しです。初回・最終・回数をすべて消します。'}
      在庫の状態・在庫数・管理番号・QRのURL・棚卸は変わりません。履歴には残します。</p>
  `, [['やめる', 'closeModal()', 'btn ghost'],
      [on ? 'QR印刷済みにする' : '未印刷に戻す',
       `closeModal();doQrMark(${on ? 'true' : 'false'})`, on ? 'btn lime' : 'btn danger']]);
}
async function doQrMark(on) {
  const ids = selItemIds();
  if (!await markQrPrinted(ids, on ? 'set' : 'clear',
      on ? '既存QRの貼付済みを登録' : null)) return;
  await refreshTx();
  render();
  toast(`${ids.length}台を${on ? 'QR印刷済みにしました' : '未印刷に戻しました'}`);
}

/* 在庫一覧で選んだ個体 */
function printSelectedLabels() {
  const ids = selItemIds();
  if (!ids.length) { toast('個体を選んでください'); return; }
  printLabelsFor(ids, '選んだ個体');
}
/* いま実施中の棚卸で確認済みになった個体だけ（過去に確認した個体は入れない） */
function printCheckedLabels() {
  const p = stocktakeProgress();
  if (!p.open) { toast('棚卸を実施していません'); return; }
  if (!p.doneIds.length) { toast('まだ確認済みの個体がありません'); return; }
  printLabelsFor(p.doneIds, '今回の棚卸で確認済み');
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
      ${b('QRラベルを印刷', 'qr_code_2', 'printSelectedLabels()')}
      ${b('販売価格を計算', 'calculate', 'openStockPricing()')}
      ${b('8RENTに出す', 'devices', 'openBulkRental()', 'lime')}
      ${b('8RENTから外す', 'devices_off', 'openBulkRentalOff()')}
      ${b('貸出', 'assignment_ind', 'openBulkLoan()')}
      ${b('売却', 'paid', 'openBulkSell()')}
      ${b('修理', 'build', 'openBulkRepair()')}
      ${b('棚卸', 'fact_check', 'openBulkCheck()')}
      ${canAdmin() ? b('QR印刷済みにする', 'print', 'openQrMark(true)') : ''}
      ${canAdmin() ? b('QR未印刷に戻す', 'print_disabled', 'openQrMark(false)') : ''}
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

/* 状態のタグ。stale を渡したときだけ、今月の棚卸の結果を色とtitleで添える。
     true  … 今月まだ現物を見ていない → 薄い赤
     false … 今月見た                 → いまの色のまま
     渡さない/null … これまでどおり（在庫一覧以外の呼び出しは何も変わらない） */
function statusTag(s, big, stale) {
  const red = stale === true;
  const title = stale == null ? ''
    : ` title="今月の棚卸：${red ? '未確認' : '確認済'}"`;
  return `<span class="tag st-${esc(s)}${big ? ' big' : ''}${red ? ' stale' : ''}"${title}><span class="ms">${
    STATUS_ICON[s] || 'inventory_2'}</span>${esc(s)}</span>`;
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
      <strong>在庫 → 販売予約</strong>にします。
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
    <label class="field" style="margin-bottom:10px"><span>注文番号（1件だけ試すとき）</span>
      <input class="input" id="roOrder" placeholder="123456-20260920-0000000001">
      <span class="meta">入れると、その注文だけを取り込みます（日数は使いません）。
        はじめての確認はこれで1件だけ試してください。</span></label>
    <label class="bchk" style="margin-bottom:8px"><input type="checkbox" id="roDry" checked>
      取り込まずに中身だけ見る（在庫は動かしません）</label>
    <label class="bchk" style="margin-bottom:10px"><input type="checkbox" id="roShip">
      発送済みの注文は<strong>売却済</strong>まで進める</label>
    <p class="meta" style="margin:-4px 0 10px">既定では、注文を取り込んでも<strong>販売予約で止めます</strong>。
      楽天側が発送完了でも、こちらのチェックを入れないかぎり売却済みにはしません。</p>
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
    const ship = !!($('roShip') || {}).checked;
    const one = (($('roOrder') || {}).value || '').trim();
    const { data: { session } } = await sb.auth.getSession();
    const r = await fetch(SUPA_URL + '/functions/v1/rakuten-order-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + (session ? session.access_token : '') },
      body: JSON.stringify(one
        ? { order_numbers: [one], dryRun: dry, ship }
        : { days, dryRun: dry, ship })
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
    const lines = out.lines || [];
    return `<div class="card" style="margin-bottom:10px"><strong>中身を見ただけで、在庫は動かしていません。</strong>
      <div class="meta">注文 ${out.order_count ?? 0}件／明細 ${out.line_count ?? 0}件${
        out.matched == null ? '' : `　商品が当たった ${out.matched}件／当たらなかった ${out.unmatched ?? 0}件`}
        ${out.shop_code ? '　店舗コード ' + esc(out.shop_code) : ''}</div></div>
      ${out.warning ? `<div class="warnbox" style="margin-bottom:10px"><span class="ms">info</span><div>${esc(out.warning)}</div></div>` : ''}
      ${lines.length ? `<table class="t"><thead><tr>
          <th>注文番号</th><th>明細</th><th>楽天の商品コード</th><th>数量</th>
          <th>商品</th><th>発送</th></tr></thead><tbody>${lines.map(l => `<tr>
          <td class="num">${esc(l.order_number)}</td>
          <td class="num">${esc(l.line_number)}</td>
          <td class="meta" style="word-break:break-all">${esc(l.item_code || l.item_url || '—')}</td>
          <td class="num">${l.qty}</td>
          <td>${l.product_code
                ? `<span class="tag st-在庫">${esc(l.product_code)}</span>`
                : (l.matched === null ? '<span class="meta">—</span>'
                                      : '<span class="tag act">当たりません</span>')}</td>
          <td class="meta">${l.cancelled ? 'キャンセル' : (l.shipped ? '発送済として渡す' : '販売予約で止める')}</td>
        </tr>`).join('')}</tbody></table>` : ''}
      <p class="meta" style="margin-top:8px">${esc(out.note || '')}
        「当たりません」の行は、商品詳細の「楽天」出品に商品コードか掲載URLを登録してから取り込んでください。</p>`;
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
    ${regFieldsBody(ind, cats, 'setQuickKind', 'import')}
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
  const qrLeft = (b.item_ids || []).filter(x => item(x)).length;
  return `<div class="batchbar${now ? ' done' : ''}">
    <span class="ms">${now ? 'check_circle' : 'filter_alt'}</span>
    <div style="flex:1;min-width:0">
      <div class="bt">${now ? `今回登録した商品 ${alive}件` : `この取込で登録した商品 ${alive}件`}</div>
      <div class="meta">個体 ${b.item_count}台　${esc(fmtDT(b.imported_at))}　${esc(b.file_name || '')}${
        alive !== codes.length ? `　（${codes.length - alive}件は削除済み）` : ''}</div>
      ${(b.skips || []).length ? `<div class="meta">重複スキップ ${b.skip_count || b.skips.length}件
        <a href="#" onclick="showSkips(${b.id});return false">詳細を見る</a></div>` : ''}
    </div>
    ${batchQrBtn(b, now ? 'lime' : 'sm')}
    <button class="btn sm ghost" onclick="clearBatch()">すべて表示</button>
  </div>
  ${now && qrLeft ? `<div class="nextstep">
    <span class="ms">qr_code_2</span>
    <div style="flex:1;min-width:0">
      <div class="t">次にやること：QRを ${qrLeft}枚 印刷して、実物1台ずつに貼ってください</div>
      <div class="meta">登録はまだ「データだけ」です。<strong>現物にQRを貼って保管するまでが1回の仕入作業</strong>です。
        QRを貼ると、現物からこの画面をすぐ開けるようになります。</div>
    </div>
  </div>` : ''}`;
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
  impPick.cat = {}; impPick.size = {}; impPick.loc = {};
  importSrc = { mode, H, idx, body, file: file.name, encoding, headRow: head };
  replan();
  showImportPreview();
}

/* 読み替えを変えたら組み直す。件数がその場で変わるので、何が通るようになるか分かる */
function replan() {
  const s = importSrc;
  if (!s) return;
  const fn = { purchase: planPurchase, legacy: planLegacy, master: planMaster }[s.mode] || planMaster;
  importPlan = decideImportPicks(fn(s.H, s.idx, s.body, s.file, s.encoding, s.headRow));
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
      // CSVの「商品名」列は出品カテゴリ（NTPC / LCD / PJ / ｻﾌﾟﾗｲ …）。
      // 商品名には使わないが、カテゴリの自動判定にはこれが唯一の手がかりになる
      auctionCat: P('商品名') || D('商品名') || '',
      // 出品価格のCSVで元の行を書き戻すため。取込の判断には使わない
      rawLine: line, rawRow: (lot.parent || lot.detail || {}).row || null,
      lot: { no: key, buy, fee, cost, qty, csvQty, kumi: P('構成') || '' },
      plan,
      idPrefix: idPrefixOf(model),
      src: {
        bought,
        // 個品IDが1つも無いCSVもある。そのときは明細の行から仕様や状態だけもらう
        kids: kids.length ? kids.map(k => ({
          id: k.id,
          serial: cell(idx, k.row, 'Ｓ／Ｎ') || null,
          note: purchaseNote(idx, k.row) || null,
          // 出品価格のCSVで元の行をそのまま書き戻すために持っておく（取込では使わない）
          line: k.line, row: k.row
        })) : [{ id: null, serial: null, note: purchaseNote(idx, lot.detail.row) || null,
                 line: lot.detail.line, row: lot.detail.row }]
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

/* ---- 仕入CSVの自動分類（カテゴリ・配送サイズ・保管場所）--------------------
   仕入CSVには1本の中に何種類もの商品が入っている（NTPC / LCD / PJ / レンズ …）。
   全件に同じカテゴリを当てると誤登録になるので、**出品番号ごとに**決める。

   決めかたの順番（上ほど強い）
     1. 既存商品          … 型番がそろう商品がすでにあれば、その category_id と
                             shipping_size をそのまま引き継ぐ（いちばん確かな根拠）
     2. CSV内の同じ型番    … 先に決めた行と同じにする（1本のCSVの中でぶれない）
     3. カテゴリの別名     … findCat() が引ければそれ（aliases・表示名・IDのどれでも）
     4. 組み込みルール     … NTPC / LCD / PJ の3つだけ。増やすのは別名でやる
     5. 配送サイズの実績   … 同じカテゴリで過去に決めたサイズが十分に偏っていれば、その値
     6. どれでもない       … **要確認**。勝手に決めない

   決めないもの
     ・数量管理のカテゴリ（消耗品・入力機器など）には自動で寄せない。
       仕入CSVの取込は個体管理（管理番号＋QR）が前提なので、選べるのは個体管理だけ
     ・「レンズ」のように、ことばだけでは行き先が決まらないものは要確認のまま */

/* 出品カテゴリ（仕入CSVの「商品名」列）→ 在庫カテゴリ。
   ここに書くのは確実なものだけにする。増やしたいときは、
   カテゴリマスターの別名（aliases）に足すほうが安全（コードを直さなくてよい）。 */
const AUCTION_CAT_RULES = [
  { words: ['NTPC'],                       cat: 'pc' },       // パソコン
  { words: ['LCD', 'LCDセット', 'LCDSET'], cat: 'monitor' },  // ディスプレイ・モニター
  { words: ['PJ'],                         cat: 'printer' }   // プリンター・プロジェクター
];

/* 取込の確認画面で行ごとに決めた値。出品番号をキーにする。
   読み替え（impMap）を変えて組み直しても、手で直したものが消えないよう外に置く */
const impPick = { cat: {}, loc: {}, size: {} };

/* 自動分類で選べるカテゴリ。仕入CSVは個体管理しか作らないので個体管理だけ。
   数量管理（消耗品・ケーブルなど）は、当たっても採用せず要確認にする */
const pickableCat = (id) => {
  const c = cat(id);
  return !!(c && c.kind === 'individual' && catLive(c) && !catHasKids(id));
};

/* 出品カテゴリのことばから、組み込みルールでカテゴリを引く。
   全角半角・大文字小文字・空白のゆれは normModel と同じ要領でそろえる */
function ruleCat(word) {
  const n = normModel(word);
  if (!n) return null;
  const hit = AUCTION_CAT_RULES.find(r => r.words.some(w => normModel(w) === n));
  return hit && cat(hit.cat) ? hit.cat : null;
}

/* そのカテゴリで、これまでに実際に決められた配送サイズ。
   十分に偏っている（過半数）ときだけ候補にする。割れていたら決めない。
   推測ではなく「過去に担当者が選んだ実績」なので、勝手な値は入らない。 */
const SIZE_MIN_SAMPLES = 3;            // これ未満は実績と呼べない
function sizeFromHistory(catId) {
  if (!catId) return null;
  const tally = {};
  let total = 0;
  (db.masters || []).forEach(p => {
    if (p.category_id !== catId) return;
    const z = String(p.shipping_size || '').trim();
    if (!z || z === 'custom') return;   // 未設定と「その他（要確認）」は実績に数えない
    tally[z] = (tally[z] || 0) + 1;
    total++;
  });
  if (total < SIZE_MIN_SAMPLES) return null;
  const top = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
  if (!top || tally[top] * 2 <= total) return null;   // 過半数に届かない＝割れている
  return { size: top, n: tally[top], total };
}

/* 1行ぶんの初期候補。byModel には、このCSVで先に決まった行が型番ごとに入っている */
function guessPick(x, byModel) {
  const out = { cat: null, catWhy: '要確認', size: null, sizeWhy: '要確認' };

  // 1) 既存商品から引き継ぐ。型番がそろえば同じ商品なので、いちばん確かな根拠
  const known = x.sharesWith ? prod(x.sharesWith) : null;
  if (known) {
    if (known.category_id) { out.cat = known.category_id; out.catWhy = '既存商品から'; }
    const z = String(known.shipping_size || '').trim();
    if (z) { out.size = z; out.sizeWhy = '既存商品から'; }
  }

  // 2) 同じCSVの中の同じ型番。1本のCSVの中で行ごとに違う答えにならないようにする
  const key = normModel(x.master.model || x.master.name);
  const twin = key ? byModel[key] : null;
  if (twin && twin !== x) {
    if (!out.cat && twin.pickCat) { out.cat = twin.pickCat; out.catWhy = 'CSV内の同じ型番から'; }
    if (!out.size && twin.pickSize) { out.size = twin.pickSize; out.sizeWhy = 'CSV内の同じ型番から'; }
  }

  // 3-4) 出品カテゴリのことばから。別名（aliases）が先、無ければ組み込みルール
  if (!out.cat) {
    const word = String(x.auctionCat || '').trim();
    if (word) {
      const byAlias = findCat(word, 'individual');
      if (byAlias.id && pickableCat(byAlias.id)) { out.cat = byAlias.id; out.catWhy = 'CSVカテゴリから'; }
      else {
        const byRule = ruleCat(word);
        // ルールに当たっても、数量管理・無効・子ありのカテゴリには寄せない
        if (byRule && pickableCat(byRule)) { out.cat = byRule; out.catWhy = 'CSVカテゴリから'; }
      }
    }
  }

  // 5) 配送サイズは、そのカテゴリの過去の実績が偏っているときだけ
  if (!out.size && out.cat) {
    const h = sizeFromHistory(out.cat);
    if (h) { out.size = h.size; out.sizeWhy = `過去の登録から（${h.n}/${h.total}件）`; }
  }
  return out;
}

/* 取込プランに、行ごとの分類を入れる。読み替えを変えるたびに呼び直す。
   手で選んだものは impPick に残っているので、組み直しても消えない */
function decideImportPicks(p) {
  if (!p || p.mode !== 'purchase') return p;
  const byModel = {};
  const fallbackLoc = defaultImportLoc();
  (p.add || []).forEach(x => {
    const g = guessPick(x, byModel);
    const mc = impPick.cat[x.key], ms = impPick.size[x.key], ml = impPick.loc[x.key];
    // 空にする（要確認に戻す）のも手で選んだうちなので、impPick には残す。
    // ただし表示は「手で選択」ではなく「要確認」にする（値が無いのだから）
    x.pickCat = mc != null ? (mc || null) : g.cat;
    x.pickCatWhy = mc ? '手で選択' : (mc != null ? '要確認' : g.catWhy);
    x.pickSize = ms != null ? (ms || null) : g.size;
    x.pickSizeWhy = ms ? '手で選択' : (ms != null ? '要確認' : g.sizeWhy);
    x.pickLoc = ml != null ? (ml || null) : (fallbackLoc || null);
    const key = normModel(x.master.model || x.master.name);
    if (key && !byModel[key]) byModel[key] = x;
  });
  return p;
}

/* 要確認の件数。カテゴリが1件でも残っていたら一括登録は止める */
function pickTodo(p) {
  const add = (p && p.add) || [];
  return {
    cat: add.filter(x => !x.pickCat).length,
    size: add.filter(x => !x.pickSize).length,
    loc: add.filter(x => !x.pickLoc).length
  };
}

/* 行ごとに手で直す。表と上のまとめを描き直す */
function setPickCat(i, v) {
  const x = (importPlan.add || [])[i]; if (!x) return;
  impPick.cat[x.key] = v || '';
  decideImportPicks(importPlan);
  repaintPurchaseTable();
}
function setPickSize(i, v) {
  const x = (importPlan.add || [])[i]; if (!x) return;
  impPick.size[x.key] = v || '';
  decideImportPicks(importPlan);
  repaintPurchaseTable();
}
function setPickLoc(i, v) {
  const x = (importPlan.add || [])[i]; if (!x) return;
  impPick.loc[x.key] = v || '';
  decideImportPicks(importPlan);
  repaintPurchaseTable();
}
/* 上の欄で選んだものを全行に当てる。1種類しか入っていないCSVは、これで今までどおり */
function applyPickToAll(kind) {
  const p = importPlan; if (!p || !p.add.length) return;
  const v = (($(kind === 'cat' ? 'impCat' : kind === 'size' ? 'impSize' : 'impLoc') || {}).value) || '';
  if (!v) { toast('先に上の欄で選んでください'); return; }
  p.add.forEach(x => { impPick[kind][x.key] = v; });
  decideImportPicks(p);
  repaintPurchaseTable();
  toast(`${p.add.length}件に当てました`);
}
/* 自動判定に戻す。手で直したものを全部忘れる */
function resetPicks() {
  if (!importPlan) return;
  impPick.cat = {}; impPick.size = {}; impPick.loc = {};
  decideImportPicks(importPlan);
  repaintPurchaseTable();
  toast('自動判定に戻しました');
}

/* 取込確認画面の表とまとめを描き直す。モーダルを開き直すと
   スクロール位置も入力中の数量も飛ぶので、必要なところだけ入れ替える */
function repaintPurchaseTable() {
  if (!importPlan) return;
  const host = $('impTable');
  if (host) host.innerHTML = purchaseTable(importPlan.add);
  const todo = pickTodo(importPlan);
  const bar = $('impTodo');
  if (bar) bar.innerHTML = todoHtml(todo);
  const btn = $('btnApply');
  if (btn) {
    btn.disabled = todo.cat > 0;
    btn.title = todo.cat > 0 ? 'カテゴリが要確認の行があります' : '';
  }
}
function todoHtml(todo) {
  return `<span class="tg${todo.cat ? ' ng' : ' ok'}">カテゴリ要確認 ${todo.cat}件</span>
    <span class="tg${todo.size ? ' warn' : ' ok'}">配送サイズ要確認 ${todo.size}件</span>
    ${todo.cat ? '<span class="meta">カテゴリが決まるまで一括登録はできません。</span>'
               : todo.size ? '<span class="meta">配送サイズが未確定でも登録できます（価格計算では「送料未設定」になります）。</span>'
                           : '<span class="meta">すべて確定しています。</span>'}`;
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

/* ---- 出品価格の自動計算（Phase 1）----------------------------------------
   仕入CSVから読んだ配賦原価をもとに、販売サイトごとの出品価格を計算する。

   していること
     ・計算はぜんぶこのJavaScript。外部のAIサービスは使わない（APIキーも無い）
     ・原価は**取込で配賦済みのものをそのまま使う**。ここで割り直さない
       （個品IDの数で割り直すと、登録される原価と食い違うため）
     ・相場は見ない。市場データが無いので「原価基準」でだけ出す
     ・DBには一切書かない。在庫の状態も出品情報も変えない。
       「価格を計算した」ことと「出品した」ことは別物

   していないこと（Phase 2 以降）
     ・楽天・Amazonなどの検索結果を読んで相場に寄せること
     ・ローカルAIによる商品名・状態の整理（normalizeUnit() が差し込み口）
   ------------------------------------------------------------------------ */

/* 価格を計算する販売サイト。ヤフオクとヤフーフリマは手数料も出しかたも
   別物なので、1つの「Yahoo」にまとめない。
   自社EC（own）は**価格計算だけ**に使う。出品先タブには出さず、
   inventory_channel_listings の実際の出品処理にもつないでいない。 */
const PRICING_CHANNELS = [
  { key: 'rakuten',    label: '楽天',         group: '' },
  { key: 'amazon',     label: 'Amazon',       group: '' },
  { key: 'mercari',    label: 'メルカリ',     group: '' },
  { key: 'yahuoku',    label: 'ヤフオク',     group: 'Yahoo' },
  { key: 'yahoo_free', label: 'ヤフーフリマ', group: 'Yahoo' },
  { key: 'own',        label: '自社EC',       group: '' }
];
const PRICING_FIELDS = [
  ['fee_rate',           '手数料率',   '%',  true],
  ['fixed_cost',         '固定費',     '円', false],
  ['shipping_cost',      '送料',       '円', false],
  ['target_profit_rate', '目標利益率', '%',  true],
  ['minimum_profit_yen', '最低利益額', '円', false]
];
/* 率（0.077）を画面用の％（7.7）にする。掛け算の誤差をそのまま出さない */
const pctOf = (v) => (v == null || v === '') ? '' : String(Math.round(Number(v) * 1000000) / 10000);

const pricingLabel = (ch) =>
  (PRICING_CHANNELS.find(c => c.key === ch) || {}).label || chanLabel(ch);

/* 見やすい価格に切り上げる。最低販売価格より下がらないよう、必ず切り上げ。
     10,000円未満      → 100円単位
     10,000〜49,999円 → 500円単位
     50,000円以上      → 1,000円単位 */
function roundUpPrice(v) {
  if (!(v > 0)) return null;
  const unit = v < 10000 ? 100 : v < 50000 ? 500 : 1000;
  return Math.ceil(v / unit) * unit;
}

/* 状態のランク。CSVの 状態・症状・詳細・備考・補足・付属品 の文字だけで決める。
   **書いていないことを補わない**。文が空なら判定せず「要確認」にする。 */
const CONDITION_RULES = [
  ['J', ['ジャンク', '部品取り', 'NCNR', '通電しない', '動作不可', 'ノークレーム']],
  ['D', ['機能未検査', '未検査', '重大', '不具合', '故障', '起動しない']],
  ['C', ['LCD劣化', 'ドット抜け', '液晶ムラ', '割れ', 'われ', 'ヘコミ', 'へこみ',
         '凹み', '傷', 'キズ', 'バッテリー劣化', '欠品', '変色', '剥がれ', 'はがれ']],
  ['A', ['美品', '未使用', '新品同様', '極上']]
];
const CONDITION_LABEL = {
  A: 'A 使用感少', B: 'B 通常中古', C: 'C 傷・劣化・欠品',
  D: 'D 未検査・重大不具合', J: 'J ジャンク'
};
function conditionOf(text) {
  const t = String(text || '').replace(/\s+/g, '');
  if (!t) return { rank: null, hits: [], why: '状態の記載がありません' };
  for (const [rank, words] of CONDITION_RULES) {
    const hits = words.filter(w => t.indexOf(w) >= 0);
    if (hits.length) return { rank, hits, why: hits.join('・') + ' の記載' };
  }
  return { rank: 'B', hits: [], why: '値下げ要因の語句は見つかりませんでした' };
}

/* ローカルAIの差し込み口（Phase 3）。
   いまはルールだけで整える。AIが無くても全部動く、が必須条件。 */
function normalizeUnit(u) {
  return {
    maker:    (u.maker || '').trim(),
    model:    normModel(u.model || ''),
    // カテゴリは分かるときだけ入れる。仕入CSVには無く、在庫からの計算では商品マスタにある
    category: (u.category || '').trim(),
    listTitle: [ (u.maker || '').trim(), (u.model || '').trim(), u.spec || '' ]
                 .filter(Boolean).join(' ').trim()
  };
}

/* 配送（佐川急便）。送料は販売サイトではなく「配送会社 × サイズ × 地域」で決まる。
   運賃表は inventory_shipping_tariffs に持ち、**税別**で入っている。
   価格計算に使うのは、実際に負担する**税込**の送料。 */
const SHIP_SIZES_FALLBACK = ['60', '80', '100', '140', '160', '170', '180', '200', '220', '240', '260'];
const SHIP_BASE_REGION = '関東';      // 仕入の時点では届け先が決まっていないので、ここを基準にする
const SHIP_ASK = '要確認';            // 沖縄・離島など、自動計算しないもの

const shipTariff = () => (db.shipTariffs || []).find(t => t.carrier === 'sagawa') || null;
const shipSizes = () => {
  const t = shipTariff();
  const a = t && Array.isArray(t.sizes) && t.sizes.length ? t.sizes : SHIP_SIZES_FALLBACK;
  return a.concat(['custom']);
};
const shipRegions = () => {
  const t = shipTariff();
  const first = t && t.sizes && t.sizes.length ? (t.rates || {})[t.sizes[0]] : null;
  return first ? Object.keys(first) : [];
};
const shipSizeLabel = (v) => !v ? '未設定' : (v === 'custom' ? 'その他（要確認）' : v + 'サイズ');
const regionOfPref = (pref) => ((shipTariff() || {}).regions || {})[pref] || null;
const shipPrefs = () => Object.keys((shipTariff() || {}).regions || {});

/* 税別 → 税込。掛け算の誤差で1円ずれないよう、いったん丸めてから切り上げる。
   利益を多く見せないよう、端数は切り上げ（負担する側なので安全側）。 */
function taxIn(ex, taxRate) {
  if (ex == null || ex === '') return null;
  const r = (taxRate == null || taxRate === '') ? 0.10 : Number(taxRate);
  return Math.ceil(Math.round(Number(ex) * (1 + r) * 1000) / 1000);
}
/* 運賃表から引く。サイズと地域がそろっていなければ null（0円にはしない） */
function tariffRate(size, region) {
  const t = shipTariff();
  if (!t || !size || size === 'custom' || !region || region === SHIP_ASK) return null;
  const ex = ((t.rates || {})[size] || {})[region];
  if (ex == null) return null;
  return { ex: Number(ex), taxRate: Number(t.tax_rate == null ? 0.10 : t.tax_rate),
           inTax: taxIn(ex, t.tax_rate), status: t.rate_status, label: t.label, size, region };
}
const RATE_STATUS_LABEL = { provisional: '暫定（過去資料）', contract: '現行契約' };

/* 元資料の注意書き（沖縄は別途料金、着払は正規運賃、消費税は別途 など）と、
   サイズごとの重量上限。価格は重量では決めないが、**分かっている重量が上限を超えていたら
   要確認にする**ために持っている。重量が分からないときは止めない。 */
const shipMeta = () => (shipTariff() || {}).source_meta || {};
function shipWeightCheck(size, weightKg) {
  const m = shipMeta();
  const w = Number(weightKg);
  if (!weightKg || isNaN(w) || w <= 0) return null;          // 分からなければ何も言わない
  const max = Number(m.max_weight_kg);
  if (max && w > max) return `重量${w}kgは上限${max}kgを超えます（要確認）`;
  const lim = Number((m.size_weight_kg || {})[size]);
  if (lim && w > lim) return `重量${w}kgは${shipSizeLabel(size)}の上限${lim}kgを超えます（要確認）`;
  return null;
}

/* 実際の注文の送料。届け先の都道府県から地域を引いて、運賃表から出す。
   価格提案（仕入の時点）は届け先が決まっていないので関東を基準にしているが、
   注文が決まったらここで出し直す。**沖縄・離島・着払・即日・夜間割増は出さない**。
     shippingForOrder({ size: '100', pref: '大阪' })
       → { ok:true, region:'関西', ex:1090, taxRate:0.1, cost:1199, status:'provisional' }
     出せないときは { ok:false, why:'…' } を返す（0円にはしない）。 */
function shippingForOrder(o) {
  const size = (o || {}).size || '';
  // 「北海道」の道、「京都」の都を落とすと引けなくなるので、まず書かれたとおりで引く
  const raw = String((o || {}).pref || '').trim();
  let pref = raw;
  if (raw && !regionOfPref(pref)) {
    const cut = raw.replace(/[都道府県]$/, '');
    if (regionOfPref(cut)) pref = cut;
  }
  const t = shipTariff();
  if (!t) return { ok: false, why: '運賃表が登録されていません' };
  if (!size) return { ok: false, why: '配送サイズが決まっていません' };
  if (size === 'custom') return { ok: false, why: '運賃表にないサイズです（要確認）' };
  if (!pref) return { ok: false, why: '届け先の都道府県が決まっていません' };
  const region = regionOfPref(pref);
  if (!region) return { ok: false, why: `${pref}は運賃表にありません（沖縄・離島は要確認）` };
  const x = tariffRate(size, region);
  if (!x) return { ok: false, why: `${shipSizeLabel(size)}・${region}の運賃が表にありません` };
  const warn = shipWeightCheck(size, (o || {}).weightKg);
  return { ok: true, carrier: t.carrier, service: t.service, payment: t.payment,
           effectiveFrom: t.effective_from, effectiveTo: t.effective_to,
           pref, region, size, ex: x.ex, taxRate: x.taxRate, cost: x.inTax, status: x.status,
           warn: warn || null };
}

/* 設定。DBに入っている値が正。試算用の一時入力があればそれを上に重ねるが、
   DBには保存しない（ページを閉じたら消える）。 */
let pricingDraft = {};                 // { channel: { fee_rate: '…', … } } 画面だけの値
let shipDraft = {};                    // { サイズ: 金額 } 画面だけの送料。保存しない
let shipRegion = SHIP_BASE_REGION;     // 価格提案で使う基準の配送先地域。仕入の時点では関東
let pricingRows = null;                // 価格提案の行
let pricingFile = '';                  // 元のCSVファイル名（取込から開いたときだけ）
/* 価格計算の入口。計算そのものは同じ関数を通し、画面の言いかたと出し先だけ変える。
     import … 仕入CSV取込の確認画面から。登録前の価格チェック
     stock  … 在庫一覧から。登録後の価格計算・再計算 */
let pricingSource = 'import';

/* 実効手数料率の決めかた。
     ① plans[plan]        … 契約プランが決まっているとき（ヤフオクのストア契約など）
     ② fee_parts の合算   … 手数料が何本かに分かれているとき（楽天）
     ③ fee_rate 列        … 1つの率だけのとき
   pricing_mode が conservative_estimate のときは、内訳の **上限** を足した
   「安全側の試算値」で、実契約料率ではない。画面にもCSVにもそう書く。 */
function effectiveFee(ch) {
  const st = chanSetting(ch) || {};
  const rules = st.pricing_rules || {};
  const mode = rules.pricing_mode || 'contract';
  const plans = rules.plans || {};
  if (rules.plan && typeof plans[rules.plan] === 'number') {
    return { rate: plans[rules.plan], mode, how: `プラン「${rules.plan}」の料率`, parts: null };
  }
  const parts = rules.fee_parts || {};
  const names = Object.keys(parts);
  if (names.length) {
    const hi = mode === 'conservative_estimate';
    let sum = 0, ok = true;
    names.forEach(k => {
      const v = Number((parts[k] || {})[hi ? 'max' : 'min']);
      if (isNaN(v)) ok = false; else sum += v;
    });
    if (ok) return { rate: sum, mode, parts,
      how: hi ? `内訳${names.length}項目の上限を合算（保守的試算）` : `内訳${names.length}項目を合算` };
  }
  return { rate: st.fee_rate == null ? null : Number(st.fee_rate), mode, how: '設定した手数料率', parts: null };
}
const FEE_MODE_LABEL = {
  contract: '実契約', conservative_estimate: '保守的試算', weighted_actual: '実績で重みづけ'
};

function pricingSetting(ch) {
  const db0 = chanSetting(ch) || {};
  const d = pricingDraft[ch] || {};
  const fee = effectiveFee(ch);
  const out = { channel: ch, fromDraft: [], feeHow: fee.how, feeMode: fee.mode, feeParts: fee.parts };
  PRICING_FIELDS.forEach(([k]) => {
    const raw = d[k];
    if (raw != null && String(raw).trim() !== '') {
      const n = PRICING_FIELDS.find(f => f[0] === k)[3]
        ? Math.round(Number(String(raw).trim()) * 10000) / 1000000   // ％で入るので率に戻す
        : Number(String(raw).trim());
      if (!isNaN(n)) {
        out[k] = n; out.fromDraft.push(k);
        if (k === 'fee_rate') { out.feeHow = '試算で入れた率'; out.feeMode = 'draft'; out.feeParts = null; }
        return;
      }
    }
    out[k] = k === 'fee_rate' ? fee.rate : (db0[k] == null ? null : Number(db0[k]));
  });
  return out;
}

/* その個体の送料（税込）。人が入れた金額 → 運賃表 → サイトの既定、の順で見る。
     ① この個体に入れた金額（税込として扱う）
     ② サイズごとの試算値（税込として扱う）
     ③ 運賃表（サイズ × 配送先地域）の税別運賃を税込にしたもの
     ④ サイトの既定送料（Phase 1 の shipping_cost 列）
   どれも無ければ null＝「送料未設定」。**0円とはみなさない**。 */
function shipFor(r, ch) {
  const size = r.shipSize || '';
  const region = r.shipRegion || shipRegion;
  const own = r.shipCost;
  if (own != null && String(own).trim() !== '' && !isNaN(Number(own))) {
    return { cost: Number(own), how: 'この個体に入れた金額（税込）', size, region };
  }
  const v = shipDraft[size];
  if (size && v != null && String(v).trim() !== '' && !isNaN(Number(v))) {
    return { cost: Number(v), how: `${shipSizeLabel(size)}の試算値（税込）`, size, region };
  }
  const t = tariffRate(size, region);
  if (t) return { cost: t.inTax, ex: t.ex, taxRate: t.taxRate, status: t.status, size, region,
    how: `運賃表 ${region}・${shipSizeLabel(size)}　税別${yen(t.ex)} → 税込${yen(t.inTax)}` +
         (t.status === 'provisional' ? '（暫定）' : '') };
  const st = chanSetting(ch) || {};
  if (st.shipping_cost != null) return { cost: Number(st.shipping_cost), how: 'サイトの既定送料', size, region };
  return { cost: null, size, region,
    how: region === SHIP_ASK ? '沖縄・離島などは自動計算しません（要確認）'
       : !size ? '配送サイズが未設定'
       : size === 'custom' ? '運賃表にないサイズです（要確認）'
       : `${shipSizeLabel(size)}・${region}の運賃が表にありません` };
}

/* 1チャネルぶんの計算。設定がひとつでも未入力なら、0とみなさず計算しない。 */
function priceForChannel(cost, st) {
  const missing = PRICING_FIELDS.filter(([k]) => st[k] == null).map(([, label]) => label);
  if (missing.length) return { ok: false, missing };
  if (!(cost > 0)) return { ok: false, missing: [], noCost: true };
  const target = Math.max(cost * st.target_profit_rate, st.minimum_profit_yen);
  const floor = (cost + st.fixed_cost + st.shipping_cost + target) / (1 - st.fee_rate);
  const price = roundUpPrice(floor);
  return { ok: true, missing: [], target, floor, price, ...profitAt(price, cost, st) };
}
/* 価格を担当者が直したときも、同じ式で利益を出し直す */
function profitAt(price, cost, st) {
  if (!(price > 0)) return { profit: null, rate: null };
  const profit = price * (1 - st.fee_rate) - cost - st.fixed_cost - st.shipping_cost;
  return { profit, rate: price ? profit / price : null };
}

/* 出品判定。市場データが無いので「売れやすさ」は推測しない。
   赤字・状態・要確認だけで決める。 */
function judgeFor(calc, rank, flags, ch) {
  if (!calc.ok) return { judge: '—', why: calc.noCost ? '原価が0円です' : (calc.missing.join('・') + ' が未設定') };
  if (!(calc.profit > 0)) return { judge: '非推奨', why: '想定利益が出ません（赤字）' };
  if (rank === 'J') return ch === 'own'
    ? { judge: '条件付き', why: 'ジャンク。自社ECなら状態を説明して出せます' }
    : { judge: '非推奨', why: 'ジャンクはモールに向きません' };
  if (rank === 'D') return { judge: '条件付き', why: '未検査・重大不具合。検品してから判断してください' };
  if (rank == null) return { judge: '条件付き', why: '状態が分かりません' };
  if (flags.length) return { judge: '条件付き', why: flags[0] };
  if (calc.rate != null && calc.rate < 0.10) return { judge: '条件付き', why: '利益率が10%未満です' };
  return { judge: '出品推奨', why: '原価基準で利益が出ます' };
}

/* 最優先チャネル。いちばん高い価格ではなく、想定利益で選ぶ。
   差が小さいときは決めつけず「要確認」にする。
   すでに出品しているサイトがあれば、差が小さいときだけそちらを立てる。 */
const PRIORITY_GAP_YEN = 500;
function pickPriority(cells, listedOn) {
  const ok = PRICING_CHANNELS.map(c => cells[c.key]).filter(x => x.calc.ok && x.calc.profit > 0);
  const rank = { '出品推奨': 0, '条件付き': 1, '非推奨': 2, '—': 3 };
  const sorted = ok.slice().sort((a, b) =>
    (rank[a.judge] - rank[b.judge]) || (b.calc.profit - a.calc.profit));
  if (!sorted.length) return { first: '', second: '', why: '利益が出るサイトがありません', ask: '' };
  const first = sorted[0], second = sorted[1];
  const gap = second ? first.calc.profit - second.calc.profit : null;
  let head = first, why = `想定利益がいちばん大きい（${yen(Math.round(first.calc.profit))}）`;
  let ask = '';
  if (second && gap != null && gap < PRIORITY_GAP_YEN) {
    const already = [first, second].find(x => listedOn.indexOf(x.ch) >= 0);
    if (already) { head = already; why = `利益の差が${yen(Math.round(gap))}と小さく、すでに出品中のサイトを優先`; }
    else { why = `利益の差が${yen(Math.round(gap))}と小さく、決め手がありません`; ask = '最優先チャネルの差が小さい'; }
  }
  const rest = sorted.filter(x => x !== head);
  return { first: head.ch, second: rest.length ? rest[0].ch : '', why, ask };
}

/* 取込で読んだデータから、1個体1行の価格提案を作る。
   原価は取込が配賦したものをそのまま使い、ここで割り直さない。 */
function buildPricing(p) {
  const rows = [];
  (p.add || []).forEach(x => {
    const kids = (x.src.kids || []).filter(k => k.id);
    // 総数と個品IDの数が違うのは普通にあること（セット出品）。取込は止めないが、
    // 1台ずつの原価の根拠が弱いので、ここでは要確認にする
    const mismatch = kids.length > 0 && kids.length !== x.lot.qty;
    (x.units || []).forEach((u, n) => {
      const cost = Number(u.price || 0) + Number(u.purchase_fee || 0);
      const cond = conditionOf([u.note || '', x.extraNote || ''].join('\n'));
      const flags = [];
      if (mismatch) flags.push(`総数${x.lot.qty}台と個品ID${kids.length}件が違います（原価は総数で配賦済み）`);
      if (cond.rank == null) flags.push('状態の記載がありません');
      if (!(cost > 0)) flags.push('原価が0円です');
      const norm = normalizeUnit({ maker: x.master.maker, model: x.master.model, spec: x.master.spec,
                                  category: catName(x.pickCat) });
      const row = {
        from: 'import',
        key: x.key, unitNo: n + 1, lotQty: x.lot.qty, code: x.sharesWith || null,
        name: x.master.name, model: x.master.model, maker: x.master.maker || '',
        spec: x.master.spec || '', serial: u.serial || '', manageId: u.id || '',
        sourceId: u.source_id || '', note: u.note || '',
        cost, lot: x.lot, bought: u.purchased_on || '',
        cond, norm, flags,
        // 配送サイズは、取込の確認画面で決めたものを先に使う。
        // 新規商品はまだ商品マスタが無いので、これが無いと必ず「送料未設定」になる
        shipSize: x.pickSize || (prod(x.sharesWith) || {}).shipping_size || '',
        shipCost: null,                       // 個体ごとの上書き。空なら試算値を使う
        rawLine: (kids[n] && kids[n].line) || x.rawLine || '',
        rawRow: (kids[n] && kids[n].row) || x.rawRow || null
      };
      buildCells(row, listedChannelsOf(x.sharesWith));
      rows.push(row);
    });
  });
  return rows;
}

/* その1行ぶんの、サイトごとの計算。送料やサイズを変えたときも、ここだけ作り直す。
   基本の要確認（原価・状態・総数）は消さず、送料まわりのぶんだけ入れ替える。 */
function buildCells(r, listedOn) {
  const keep = (r.flags || []).filter(f => !/送料|配送サイズ|最優先チャネルの差/.test(f));
  const flags = keep.slice();
  const cells = {};
  let noShip = 0;
  PRICING_CHANNELS.forEach(c => {
    const ship = shipFor(r, c.key);
    if (ship.cost == null) noShip++;
    const st = Object.assign(pricingSetting(c.key), { shipping_cost: ship.cost, shipHow: ship.how });
    const calc = priceForChannel(r.cost, st);
    const j = judgeFor(calc, r.cond.rank, flags, c.key);
    cells[c.key] = { ch: c.key, st, calc, judge: j.judge, why: j.why,
                     price: calc.ok ? calc.price : null, edited: false };
  });
  if (noShip) flags.push(noShip === PRICING_CHANNELS.length
    ? (r.shipSize ? `${shipSizeLabel(r.shipSize)}の送料が未設定です` : '配送サイズが未設定です')
    : `${noShip}サイトで送料が未設定です`);
  r.cells = cells;
  r.priority = pickPriority(cells, listedOn || r.listedOn || []);
  r.listedOn = listedOn || r.listedOn || [];
  if (r.priority.ask) flags.push(r.priority.ask);
  r.flags = flags;
  return r;
}
/* すでにそのサイトへ出しているか（既存商品への追加のとき使う）。
   新規商品（まだ商品コードが無い）のときは空。 */
function listedChannelsOf(code) {
  if (!code) return [];
  return channelsOf(code).filter(x => x.state === LISTED).map(x => x.channel);
}

/* ---- 在庫からの価格計算 ---------------------------------------------------
   価格計算の入口は2つある。**計算そのものは同じ関数を通す**（二重実装しない）。

     取込のとき  … 登録前の価格チェック。原価はCSVの配賦結果、サイズは取込画面で決めた値
     在庫のとき  … 登録後の価格計算・再計算。原価も分類も配送サイズもDBから読む

   どちらも buildCells() → shipFor() → priceForChannel() → effectiveFee() を使う。
   ここでやるのは「1個体ぶんの材料をそろえる」ことだけ。

   **この画面は在庫も販売価格も出品情報も変えない。** サイズを変えても商品マスタは
   書き換えない（変えたのはこの画面の中だけ、という状態を保つ）。 */
const PRICING_MAX_ITEMS = 300;         // いちどに計算する上限。表が重くなりすぎないように

function buildPricingFromItems(ids) {
  const rows = [];
  (ids || []).forEach(id => {
    const i = item(id);
    if (!i) return;
    const m = prod(i.product_code) || {};
    const cost = costOf(i);
    const model = m.model || i.model || '';
    const maker = m.maker || i.maker || '';
    // 状態は個体の備考から読む（取込のときと同じ CONDITION_RULES）
    const cond = conditionOf(i.note || '');
    const flags = [];
    if (cond.rank == null) flags.push('状態の記載がありません');
    if (!(cost > 0)) flags.push('原価が未入力です（仕入価格・手数料が空）');
    if (GONE.includes(i.status)) flags.push(`${i.status}の個体です`);
    const catId = i.category_id || m.category_id || null;
    if (!catId) flags.push('商品カテゴリが未設定です');
    const row = {
      from: 'stock',
      key: i.id, unitNo: 1, lotQty: 1, code: i.product_code || null,
      name: m.name || i.name || model || i.id, model, maker,
      spec: m.spec || '', serial: i.serial || '', manageId: i.id,
      sourceId: i.source_id || '', note: i.note || '',
      cost,
      // 取込の行と同じ形にしておく（根拠の画面やCSVが同じコードで動くように）。
      // 在庫からの計算では配賦は起きないので、そのまま1台ぶんの内訳になる
      lot: { no: i.id, buy: Number(i.price || 0), fee: Number(i.purchase_fee || 0),
             cost, qty: 1, csvQty: 1, kumi: '' },
      bought: i.purchased_on || '',
      cond,
      norm: normalizeUnit({ maker, model, spec: m.spec, category: catName(catId) }),
      flags,
      catId,
      status: i.status,
      planPrice: planOf(i),               // いま入っている販売予定価格。比べるために持つだけ
      // 配送サイズは商品マスタの既定。未設定ならこの画面で選んで計算し直せる
      shipSize: m.shipping_size || '',
      shipCost: null,                     // 個体ごとの上書き。空なら運賃表・試算値を使う
      rawLine: '', rawRow: null
    };
    // 既存の出品先は個体の出品情報から読む（最優先チャネルの判断に使う）
    buildCells(row, liveOn(i));
    rows.push(row);
  });
  return rows;
}

/* 在庫一覧から開く。選んだ個体（または1台）の推奨価格を出すだけで、何も保存しない */
function openStockPricing(ids) {
  // 同じ管理番号が2度来ても1行にする（1台を二重に数えない）
  const list = [...new Set((ids && ids.length ? ids : selItemIds()).filter(Boolean))];
  if (!list.length) { toast('個体を選んでください'); return; }
  if (list.length > PRICING_MAX_ITEMS) {
    toast(`いちどに計算できるのは ${PRICING_MAX_ITEMS}台までです（いまは ${list.length}台）`); return;
  }
  const rows = buildPricingFromItems(list);
  if (!rows.length) { toast('価格を出せる個体がありません'); return; }
  pricingSource = 'stock';
  pricingFile = '';
  pricingRows = rows;
  paintPricing(true);
}

/* ---- 画面 ---------------------------------------------------------------- */

function openPricing() {
  if (!importPlan || importPlan.mode !== 'purchase') { toast('先に仕入CSVを取り込んでください'); return; }
  pricingSource = 'import';
  pricingFile = (importSrc || {}).file || '';
  pricingRows = buildPricing(importPlan);
  if (!pricingRows.length) { toast('価格を出せる個体がありません'); return; }
  paintPricing(true);
}

/* 未設定のチャネルがいくつあるか。1つでもあれば、画面の頭で知らせる */
function pricingUnset() {
  return PRICING_CHANNELS.filter(c =>
    PRICING_FIELDS.some(([k]) => k !== 'shipping_cost' && pricingSetting(c.key)[k] == null));
}

function paintPricing(open) {
  const unset = pricingUnset();
  const stock = pricingSource === 'stock';
  const body = `
    ${stock ? stockPricingHead() : ''}
    ${unset.length ? `<div class="card" style="margin-bottom:12px;background:var(--l100);border:1px solid var(--l400)">
      <strong>手数料が未設定です</strong>：${esc(unset.map(c => c.label).join('・'))}<br>
      <span class="meta">手数料率・固定費・目標利益率・最低利益額がそろったサイトだけ価格を出します。
        推測の数字は入れていません。下の［手数料などの設定］から入れてください。</span></div>` : ''}
    <details style="margin-bottom:12px"${unset.length ? ' open' : ''}>
      <summary style="cursor:pointer"><strong>手数料などの設定</strong>
        <span class="meta">　サイトごとに入れます</span></summary>
      <p class="meta" style="margin:8px 0">
        <strong>試算</strong>はこの画面だけの値です（保存しません。閉じると消えます）。
        ${canAdmin() ? '正式な設定は［保存］でDBに入ります。' : '保存できるのは管理者だけです。'}
        手数料率と<strong>原価に対する目標利益率</strong>は<strong>％で</strong>入れてください（10% なら <code>10</code>）。</p>
      <div class="table-wrap" style="margin-bottom:10px"><table class="t"><thead><tr>
        <th>販売サイト</th><th>いま使う手数料率</th><th>その根拠</th></tr></thead><tbody>
        ${PRICING_CHANNELS.map(c => {
          const st = pricingSetting(c.key);
          return `<tr><td>${esc(c.label)}</td>
            <td class="num">${st.fee_rate == null ? '<span class="meta">未設定</span>'
              : (st.fee_rate * 100).toFixed(1) + '%'}</td>
            <td><span class="tag ${st.feeMode === 'conservative_estimate' ? 'act' : 'ok'}">${
                esc(FEE_MODE_LABEL[st.feeMode] || st.feeMode)}</span>
              <span class="meta">　${esc(st.feeHow)}</span>
              ${st.feeParts ? `<div class="meta">${Object.keys(st.feeParts).map(k =>
                  `${esc(k)} ${(Number(st.feeParts[k].max) * 100).toFixed(1)}%`).join('／')}</div>` : ''}
              ${st.feeMode === 'conservative_estimate'
                ? '<div class="meta"><strong>実契約料率ではありません。</strong>内訳の上限を足した安全側の数字です。</div>' : ''}
              ${canAdmin() ? `<button class="btn sm ghost" style="margin-top:4px"
                  onclick="openFeeRules('${esc(c.key)}')">内訳・プランを直す</button>` : ''}</td>
          </tr>`;
        }).join('')}
      </tbody></table></div>
      <div class="table-wrap"><table class="t"><thead><tr>
        <th>販売サイト</th>${PRICING_FIELDS.map(([, label, unit]) =>
          `<th>${esc(label)}<span class="meta">（${esc(unit)}）</span></th>`).join('')}
        <th></th></tr></thead><tbody>
        ${PRICING_CHANNELS.map(c => {
          const st = pricingSetting(c.key);
          return `<tr><td>${esc(c.label)}${c.group ? `<div class="meta">${esc(c.group)}</div>` : ''}</td>
            ${PRICING_FIELDS.map(([k, , , isRate]) => {
              const d = (pricingDraft[c.key] || {})[k];
              const saved = (chanSetting(c.key) || {})[k];
              const shown = d != null && String(d) !== '' ? d
                : (saved == null ? '' : (isRate ? pctOf(saved) : Number(saved)));
              return `<td><input class="input" style="min-width:86px" inputmode="decimal"
                  value="${esc(String(shown))}"
                  oninput="setPricingDraft('${esc(c.key)}','${esc(k)}',this.value)">
                ${saved == null ? '<div class="meta">未設定</div>'
                  : `<div class="meta">保存済 ${esc(String(isRate ? pctOf(saved) : Number(saved)))}</div>`}</td>`;
            }).join('')}
            <td>${canAdmin()
              ? `<button class="btn sm ghost" onclick="savePricingSetting('${esc(c.key)}')">保存</button>`
              : '<span class="meta">試算のみ</span>'}</td></tr>`;
        }).join('')}
      </tbody></table></div>
    </details>
    ${shippingPanelHtml()}
    <div id="pricingTable">${pricingTableHtml()}</div>`;

  if (open) {
    openModal(stock ? '販売価格を計算（在庫から）' : '販売価格を自動計算', body, [
      stock ? ['閉じる', 'closeModal()', 'btn ghost']
            : ['取込の確認にもどる', 'showImportPreview()', 'btn ghost'],
      ['出品用CSVを出力', 'downloadPricingCsv()', 'btn lime', 'btnPriceCsv']
    ]);
  } else {
    const host = $('modalBody');
    if (host) host.innerHTML = body;
  }
}

/* 在庫から開いたときの見出し。**DBから何を読んだか**と、**何も保存しない**ことを先に言う。
   足りないもの（原価・カテゴリ・配送サイズ）は件数で出して、直す先まで書く。 */
function stockPricingHead() {
  const rows = pricingRows || [];
  const noCost = rows.filter(r => !(r.cost > 0)).length;
  const noCat  = rows.filter(r => !r.catId).length;
  const noSize = rows.filter(r => !r.shipSize).length;
  const listed = rows.filter(r => (r.listedOn || []).length).length;
  const gone   = rows.filter(r => GONE.includes(r.status)).length;
  const miss = (n, what, how) => n
    ? `<div>・<strong>${what} ${n}台</strong>　${how}</div>` : '';
  return `<div class="card" style="margin-bottom:12px">
    <div class="lbl" style="margin-bottom:5px">在庫から計算しています</div>
    選んだ <strong>${rows.length}台</strong>について、いま登録されている
    <strong>原価・商品カテゴリ・配送サイズ・既存の出品先</strong>をDBから読み、
    <strong>佐川運賃表・各サイトの手数料・目標利益率</strong>で推奨価格を出しています。<br>
    <strong>この画面は在庫も販売予定価格も出品情報も変えません。</strong>
    配送サイズをここで変えても<strong>商品マスタは書き換えません</strong>
    （変えたのはこの画面の中だけです）。
    ${noCost || noCat || noSize ? `<div class="meta" style="margin-top:8px">
      ${miss(noCost, '原価が未入力', '個体詳細の［値段を直す］で入れてください')}
      ${miss(noCat, '商品カテゴリが未設定', '商品詳細で選んでください')}
      ${miss(noSize, '配送サイズが未設定', 'この画面で選ぶとすぐ計算し直します。商品詳細で決めると次回から自動で入ります')}
    </div>` : ''}
    <div class="meta" style="margin-top:8px">
      すでに出品しているサイトがある個体 ${listed}台${
        gone ? `／手元にない個体（売却済・廃棄） ${gone}台` : ''}</div>
  </div>`;
}

/* 配送のパネル。運賃表があればそれを見せ、無ければ手で入れてもらう */
function shippingPanelHtml() {
  const t = shipTariff();
  const regions = shipRegions();
  const sizes = shipSizes();
  return `<details style="margin-bottom:12px"${t ? '' : ' open'}>
    <summary style="cursor:pointer"><strong>配送（佐川急便）</strong>
      <span class="meta">　${t ? esc(`${t.service}・${t.payment}の運賃表`) : '運賃表がまだありません'}</span></summary>
    ${t && t.rate_status === 'provisional' ? `<div class="card"
      style="margin:8px 0;background:var(--l100);border:1px solid var(--l400)">
      <strong>この運賃表は暫定です。</strong>
      <span class="meta">${esc(t.source_note || '')}　現行契約の表が確認できたら差し替えてください。</span></div>` : ''}
    <p class="meta" style="margin:8px 0">
      運賃表は<strong>税別</strong>で持っています。価格計算には<strong>税込</strong>（税率
      ${t ? (Number(t.tax_rate) * 100).toFixed(0) : '10'}%）にした金額を使います。
      <strong>沖縄・離島・着払・即日配送・夜間割増は自動計算しません</strong>（要確認）。</p>

    <label class="field" style="margin-bottom:10px;max-width:420px">
      <span>価格提案で使う配送先（基準）</span>
      <select class="input" onchange="setShipRegion(this.value)">
        ${regions.map(z => `<option value="${esc(z)}"${shipRegion === z ? ' selected' : ''}>${
          esc(z)}${z === SHIP_BASE_REGION ? '（基準）' : ''}</option>`).join('')}
        <option value="${SHIP_ASK}"${shipRegion === SHIP_ASK ? ' selected' : ''}>沖縄・離島など（要確認）</option>
      </select>
      <span class="meta">${pricingSource === 'stock'
        ? `届け先が決まっていない段階なので、<strong>${esc(SHIP_BASE_REGION)}向け</strong>を基準にしています。`
        : `仕入の時点では届け先が決まっていないので、<strong>${esc(SHIP_BASE_REGION)}向け</strong>を基準にしています。`}
        実際の注文では届け先の都道府県から引き直します。</span></label>

    ${t ? `<div class="table-wrap"><table class="t"><thead><tr>
      <th>サイズ</th>${regions.map(z => `<th>${esc(z)}</th>`).join('')}</tr></thead><tbody>
      ${(t.sizes || []).map(z => `<tr${shipRegion === z ? '' : ''}>
        <td>${esc(shipSizeLabel(z))}</td>
        ${regions.map(g => {
          const x = tariffRate(z, g);
          return `<td class="num"${g === shipRegion ? ' style="font-weight:700"' : ''}>${
            x ? yen(x.inTax) : '—'}<div class="meta">税別 ${x ? yen(x.ex) : '—'}</div></td>`;
        }).join('')}
      </tr>`).join('')}
    </tbody></table></div>` : ''}

    <div class="lbl" style="margin:12px 0 6px">運賃表で出せないサイズの送料（試算）</div>
    <p class="meta" style="margin-bottom:6px">ここに入れた金額は<strong>税込</strong>として扱い、
      運賃表より優先します。<strong>この画面だけ</strong>のもので保存しません。</p>
    <div class="table-wrap"><table class="t"><thead><tr>
      ${sizes.map(z => `<th>${esc(shipSizeLabel(z))}</th>`).join('')}
    </tr></thead><tbody><tr>
      ${sizes.map(z => `<td><input class="input" style="min-width:76px" inputmode="numeric"
          value="${esc(String(shipDraft[z] == null ? '' : shipDraft[z]))}"
          oninput="setShipDraft('${esc(z)}',this.value)"></td>`).join('')}
    </tr></tbody></table></div>

    ${(() => {
      const m = shipMeta(), notes = m.notes || {}, w = m.size_weight_kg || {};
      if (!Object.keys(notes).length && !Object.keys(w).length) return '';
      return `<details style="margin-top:10px">
        <summary class="meta" style="cursor:pointer">元の運賃表に書かれていること</summary>
        ${Object.keys(notes).length ? `<div class="meta" style="margin-top:6px">${
          Object.keys(notes).map(k => `<div>・<strong>${esc(k)}</strong>：${esc(notes[k])}</div>`).join('')
        }</div>` : ''}
        ${Object.keys(w).length ? `<div class="meta" style="margin-top:6px">
          ・<strong>サイズごとの重量上限</strong>：${
            Object.keys(w).map(k => `${esc(shipSizeLabel(k))} ${esc(String(w[k]))}kg`).join('／')}
          <br>　重量が分からないときは価格計算を止めません。分かっていて上限を超えるときだけ要確認にします。</div>` : ''}
      </details>`;
    })()}
    <p class="meta" style="margin:8px 0 0">${t && t.effective_from
      ? `この版は <strong>${esc(t.effective_from)}〜${esc(t.effective_to || '（未定）')}</strong> のものです。
         新しい表は<strong>別の版として足す</strong>ので、古い表は残ります。<br>` : ''}
      将来は<strong>配送会社（佐川急便）・発送元（柏倉庫）・配送サイズ・配送先地域</strong>から
      自動で引きます。いまは<strong>発送元は柏倉庫</strong>を前提にしています。</p>
  </details>`;
}

/* 基準の配送先を変える。保存はしない */
function setShipRegion(v) {
  shipRegion = v || SHIP_BASE_REGION;
  if (pricingRows) pricingRows.forEach(r => buildCells(r));
  paintPricing(false);
}

function pricingTableHtml() {
  const rows = pricingRows || [];
  const ask = rows.filter(r => r.flags.length).length;
  const stock = pricingSource === 'stock';
  return `<div class="sum">
      <div><div class="lbl">個体</div><div class="v">${rows.length}<span class="u">台</span></div></div>
      <div><div class="lbl">${stock ? '原価の合計' : '配賦原価の合計'}</div>
        <div class="v">${yen(rows.reduce((a, r) => a + r.cost, 0))}</div></div>
      <div><div class="lbl">要確認</div><div class="v${ask ? ' err' : ''}">${ask}</div></div>
      <div><div class="lbl">価格算定方式</div><div class="v" style="font-size:15px">原価基準</div></div>
    </div>
    <p class="meta" style="margin:10px 0">
      相場は見ていません（市場データなし）。原価・手数料・送料・目標利益だけで出しています。
      <strong>この画面では出品も在庫の変更もしません。</strong></p>
    <div class="table-wrap"><table class="t"><thead><tr>
      <th>商品</th><th>型番</th><th>管理番号</th><th>S/N</th><th>状態</th>
      <th>${stock ? '原価' : '配賦原価'}</th>
      <th>配送サイズ</th><th>送料</th>
      ${PRICING_CHANNELS.map(c => `<th>${esc(c.label)}</th>`).join('')}
      <th>最優先</th><th>要確認</th><th></th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr>
        <td>${esc(r.name)}<div class="meta">${stock
            ? esc(catName(r.catId) || 'カテゴリ未設定') + (r.status ? '／' + esc(r.status) : '')
            : esc(r.key) + '／' + r.unitNo + '台目'}</div></td>
        <td class="num">${esc(r.model)}</td>
        <td class="num">${r.manageId
          ? (stock ? `<a class="idlink" href="/zaiko/items/${encodeURIComponent(r.manageId)}"
               onclick="event.preventDefault();closeModal();go('item','${esc(r.manageId)}')"
               title="この1台の詳細と履歴">${esc(r.manageId)}</a>` : esc(r.manageId))
          : '<span class="meta">（取込時に採番）</span>'}</td>
        <td class="num">${esc(r.serial || '—')}</td>
        <td>${r.cond.rank ? esc(CONDITION_LABEL[r.cond.rank]) : '<span class="tag">要確認</span>'}
          <div class="meta">${esc(r.cond.why)}</div></td>
        <td class="num">${yen(r.cost)}</td>
        <td><select class="input" style="min-width:92px" onchange="setPricingShipSize(${i},this.value)">
            <option value=""${r.shipSize ? '' : ' selected'}>未設定</option>
            ${shipSizes().map(z => `<option value="${esc(z)}"${r.shipSize === z ? ' selected' : ''}>${
              esc(shipSizeLabel(z))}</option>`).join('')}
          </select>${sizeNote(r)}</td>
        <td><input class="input" style="min-width:86px" inputmode="numeric"
            placeholder="${esc(shipPlaceholder(r))}"
            value="${esc(String(r.shipCost == null ? '' : r.shipCost))}"
            oninput="setPricingShipCost(${i},this.value)">
          <div class="meta">${esc(shipNote(r))}</div></td>
        ${PRICING_CHANNELS.map(c => pricingCellHtml(r, i, c.key)).join('')}
        <td>${r.priority.first ? esc(pricingLabel(r.priority.first)) : '—'}
          ${r.priority.second ? `<div class="meta">次 ${esc(pricingLabel(r.priority.second))}</div>` : ''}</td>
        <td>${r.flags.length
          ? `<span class="tag act" title="${esc(r.flags.join('／'))}">要確認 ${r.flags.length}</span>`
          : '—'}</td>
        <td><button class="btn sm ghost" onclick="openPricingDetail(${i})">根拠</button></td>
      </tr>`).join('')}
    </tbody></table></div>`;
}

const JUDGE_CLASS = { '出品推奨': 'ok', '条件付き': 'act', '非推奨': 'none', '—': 'none' };
function pricingCellHtml(r, i, ch) {
  const c = r.cells[ch];
  if (!c.calc.ok) {
    return `<td><span class="meta">${esc(c.why)}</span></td>`;
  }
  const st = c.st;
  const p = profitAt(c.price, r.cost, st);
  return `<td>
    <input class="input" style="min-width:94px" inputmode="numeric" value="${esc(String(c.price == null ? '' : c.price))}"
      oninput="setPricingPrice(${i},'${esc(ch)}',this.value)">
    <div class="meta">利益 ${p.profit == null ? '—' : yen(Math.round(p.profit))}
      ${p.rate == null ? '' : `（${(p.rate * 100).toFixed(1)}%）`}</div>
    <div><span class="tag ${JUDGE_CLASS[c.judge] || 'act'}">${esc(c.judge)}</span></div>
    <div class="meta">最低 ${yen(Math.ceil(c.calc.floor))}${c.edited ? '／手で直しました' : ''}</div>
  </td>`;
}

/* 配送サイズの欄に出す一言。**商品マスタを書き換えないこと**が分かるようにする */
function sizeNote(r) {
  if (r.from !== 'stock') return r.code ? '' : '<div class="meta">新規商品</div>';
  const saved = String((prod(r.code) || {}).shipping_size || '');
  if (!r.shipSize) return '<div class="meta">商品マスタも未設定</div>';
  if (saved === r.shipSize) return '<div class="meta">商品マスタの既定</div>';
  return `<div class="meta"><strong>この画面だけ</strong>（マスタは ${esc(shipSizeLabel(saved))}のまま）</div>`;
}

/* 送料の欄に出す案内。どこから来た金額かが分かるようにする */
function shipPlaceholder(r) {
  const z = r.shipSize, v = z ? shipDraft[z] : null;
  if (v != null && String(v).trim() !== '') return String(v);
  const t = tariffRate(z, r.shipRegion || shipRegion);
  return t ? String(t.inTax) : '';
}
function shipNote(r) {
  const s = shipFor(r, PRICING_CHANNELS[0].key);
  if (s.cost == null) return s.how;
  return s.ex == null ? `${yen(s.cost)}（${s.how}）`
    : `${yen(s.cost)} 税込／${esc(s.region)}${s.status === 'provisional' ? '・暫定' : ''}`;
}

/* サイズごとの送料（試算）。入れ直すたびに全行を計算し直す */
function setShipDraft(size, v) {
  const t = String(v == null ? '' : v).trim();
  if (t === '') delete shipDraft[size]; else shipDraft[size] = t;
  if (pricingRows) {
    pricingRows.forEach(r => buildCells(r));
    repaintPricingTable();
  }
}
/* 表を描き直す。詳細画面を開いているあいだは表が無いので、そのときは何もしない */
function repaintPricingTable() {
  const host = $('pricingTable');
  if (host) host.innerHTML = pricingTableHtml();
  return host;
}
/* 個体の配送サイズを変える。商品マスタは書き換えない（この画面だけ） */
function setPricingShipSize(i, v) {
  const r = (pricingRows || [])[i]; if (!r) return;
  r.shipSize = v || '';
  buildCells(r);
  repaintPricingTable();
}
/* 個体ごとの送料の上書き。サイズの試算値より優先する */
function setPricingShipCost(i, v) {
  const r = (pricingRows || [])[i]; if (!r) return;
  const t = String(v == null ? '' : v).trim();
  r.shipCost = t === '' ? null : t;
  buildCells(r);
  // 作り直すと入力中の欄からフォーカスが外れるので、同じ欄へ戻す
  const host = $('pricingTable');
  if (!host) return;
  const before = host.querySelectorAll('.t tbody tr')[i];
  const keep = before ? before.querySelector('input[inputmode=numeric]') : null;
  const at = keep ? keep.selectionStart : null;
  host.innerHTML = pricingTableHtml();
  const back = host.querySelectorAll('.t tbody tr')[i];
  const el = back ? back.querySelector('input[inputmode=numeric]') : null;
  if (el) { el.focus(); try { el.setSelectionRange(at, at); } catch (e) { /* 数値欄では効かないことがある */ } }
}

/* 試算の値を入れ替える。DBには保存しない */
function setPricingDraft(ch, field, v) {
  const d = (pricingDraft[ch] = pricingDraft[ch] || {});
  const t = String(v == null ? '' : v).trim();
  d[field] = t;                       // 打った数字のまま持つ（％→率は pricingSetting で1回だけ）
  if (pricingRows) {
    pricingRows.forEach(r => buildCells(r));    // 配送サイズや個体の送料は保つ
    repaintPricingTable();
  }
}

/* 担当者が価格を直す。利益と判定はその場で出し直す（表は作り直さない） */
function setPricingPrice(i, ch, v) {
  const r = (pricingRows || [])[i]; if (!r) return;
  const c = r.cells[ch]; if (!c || !c.calc.ok) return;
  const n = Number(String(v || '').replace(/[^0-9.-]/g, ''));
  c.price = isNaN(n) || n <= 0 ? null : n;
  c.edited = true;
  const p = profitAt(c.price, r.cost, c.st);
  c.judge = c.price == null ? '—' : (p.profit > 0 ? (c.price < c.calc.floor ? '条件付き' : c.judge) : '非推奨');
}

async function savePricingSetting(ch) {
  if (!canAdmin()) { toast('設定は管理者だけができます'); return; }
  const st = pricingSetting(ch);
  const miss = PRICING_FIELDS.filter(([k]) => k !== 'shipping_cost' && st[k] == null).map(([, l]) => l);
  if (miss.length) { toast(miss.join('・') + ' が空です'); return; }
  const { data, error } = await sb.rpc('inv_channel_pricing_settings_set', {
    p_channel: ch,
    p_fee_rate: st.fee_rate,
    p_fixed_cost: st.fixed_cost,
    p_shipping_cost: st.shipping_cost,
    p_target_profit_rate: st.target_profit_rate,
    p_minimum_profit_yen: st.minimum_profit_yen
  });
  if (error) { toast('保存できませんでした：' + error.message); return; }
  const i = db.chanSettings.findIndex(x => x.channel === ch);
  if (data) { if (i >= 0) db.chanSettings[i] = data; else db.chanSettings.push(data); }
  delete pricingDraft[ch];                 // 保存したら試算の値は要らない
  if (pricingRows) pricingRows.forEach(r => buildCells(r));
  paintPricing(false);
  toast(`${pricingLabel(ch)}の手数料などを保存しました`);
}

/* 1個体の「なぜこの価格になったか」。仕入 → 原価 → 手数料 → 最低販売価格 → 推奨価格 を順に出す */
function openPricingDetail(i) {
  const r = (pricingRows || [])[i];
  if (!r) return;
  const row = (label, v) => `<div><div class="lbl">${esc(label)}</div><div class="v" style="font-size:15px">${v}</div></div>`;
  const stock = r.from === 'stock';
  openModal(stock ? `${r.manageId} の値付け` : `${r.name}　${r.unitNo}台目の値付け`, `
    <div class="sum" style="margin-bottom:12px">
      ${stock ? row('管理番号', esc(r.manageId)) : row('出品番号', esc(r.key))}
      ${stock ? row('商品', esc(r.code || '—'))
              : row('管理番号・個品ID', esc(r.manageId || r.sourceId || '（取込時に採番）'))}
      ${row('S/N', esc(r.serial || '—'))}
      ${row('仕入日', esc(r.bought || '—'))}
    </div>
    <div class="lbl" style="margin-bottom:6px">仕入と原価</div>
    ${stock ? `<div class="sum" style="margin-bottom:12px">
      ${row('仕入価格', yen(r.lot.buy))}
      ${row('手数料', yen(r.lot.fee))}
      ${row('原価', `<strong>${yen(r.cost)}</strong>`)}
      ${row('いまの販売予定価格', r.planPrice == null ? '<span class="meta">未定</span>' : yen(r.planPrice))}
    </div>
    <p class="meta" style="margin:-4px 0 12px">
      <strong>DBに入っている原価をそのまま使っています。</strong>この画面では書き換えません。
      直すときは個体詳細の［値段を直す］から入れてください。</p>`
    : `<div class="sum" style="margin-bottom:12px">
      ${row('落札価格', yen(r.lot.buy))}
      ${row('落札料', yen(r.lot.fee))}
      ${row('ロット仕入原価', yen(r.lot.cost))}
      ${row('配賦原価', `<strong>${yen(r.cost)}</strong>`)}
    </div>
    <p class="meta" style="margin:-4px 0 12px">
      ${esc(r.lot.qty)}台で等分（端数は先頭の1台）。<strong>取込が配賦した原価をそのまま使っています。</strong>
      個品IDの数で割り直すと、登録される原価と食い違うためです。</p>`}

    <div class="lbl" style="margin-bottom:6px">商品の整理（ルールだけ。AIは使っていません）</div>
    <div class="sum" style="margin-bottom:12px">
      ${row('メーカー', esc(r.norm.maker || '要確認'))}
      ${row('型番', esc(r.norm.model || '要確認'))}
      ${row('カテゴリ', r.norm.category ? esc(r.norm.category) : '<span class="tag">要確認</span>')}
      ${row('検索用', esc(marketQuery(r.maker, r.model) || '—'))}
    </div>
    <div class="card" style="margin-bottom:12px">
      <div class="lbl" style="margin-bottom:3px">状態</div>
      ${r.cond.rank ? `<strong>${esc(CONDITION_LABEL[r.cond.rank])}</strong>` : '<span class="tag">要確認</span>'}
      <span class="meta">　${esc(r.cond.why)}</span>
      ${r.note ? `<div class="pre" style="margin-top:8px">${esc(r.note)}</div>` : ''}
    </div>

    <div class="lbl" style="margin-bottom:6px">配送（佐川急便）</div>
    ${(() => {
      const sp = shipFor(r, PRICING_CHANNELS[0].key);
      const t = shipTariff() || {};
      return `<div class="sum" style="margin-bottom:12px">
        ${row('配送サイズ', esc(shipSizeLabel(r.shipSize)))}
        ${row('配送先（基準）', esc(sp.region || shipRegion))}
        ${row('送料（税別）', sp.ex == null ? '—' : yen(sp.ex))}
        ${row('送料（税込）', sp.cost == null ? '<span class="tag">送料未設定</span>' : `<strong>${yen(sp.cost)}</strong>`)}
      </div>
      <div class="sum" style="margin-bottom:12px">
        ${row('どこから来た値か', esc(sp.how))}
        ${row('運賃表', esc(t.label || '未登録'))}
        ${row('表の状態', esc(RATE_STATUS_LABEL[sp.status || t.rate_status] || '—')
          + (t.effective_from ? `　${t.effective_from}〜${t.effective_to || '（未定）'}` : ''))}
        ${row('商品マスタの既定', r.code
          ? esc(shipSizeLabel((prod(r.code) || {}).shipping_size || ''))
            + (stock ? '<div class="meta">この画面で変えてもマスタは書き換えません</div>' : '')
          : '<span class="meta">新規商品（登録時に取込画面で決めたサイズが入ります）</span>')}
      </div>
      ${(sp.status || t.rate_status) === 'provisional' ? `<div class="card"
        style="margin-bottom:12px;background:var(--l100);border:1px solid var(--l400)">
        <strong>この運賃表は暫定です</strong>（過去の契約資料）。
        <span class="meta">現行契約の表が確認できたら差し替えてください。</span></div>` : ''}`;
    })()}
    <p class="meta" style="margin:-4px 0 12px">運賃表は<strong>税別</strong>で持ち、価格計算には
      <strong>税込</strong>にした金額を使います（端数は切り上げ）。
      仕入の時点では届け先が決まっていないので<strong>${esc(SHIP_BASE_REGION)}向け</strong>を基準にしています。
      <strong>沖縄・離島・着払・即日配送・夜間割増は自動計算しません。</strong></p>

    ${r.shipSize && r.shipSize !== 'custom' && shipTariff() ? `
      <details style="margin-bottom:12px">
        <summary class="meta" style="cursor:pointer">届け先ごとの送料を見る（${
          esc(shipSizeLabel(r.shipSize))}）</summary>
        <div class="table-wrap" style="margin-top:8px"><table class="t"><thead><tr>
          <th>地域</th><th>税別</th><th>税込</th><th>都道府県</th></tr></thead><tbody>
          ${shipRegions().map(g => {
            const x = tariffRate(r.shipSize, g);
            const prefs = shipPrefs().filter(p2 => regionOfPref(p2) === g);
            return `<tr><td>${esc(g)}${g === (r.shipRegion || shipRegion) ? '<div class="meta">いまの基準</div>' : ''}</td>
              <td class="num">${x ? yen(x.ex) : '—'}</td>
              <td class="num"${g === (r.shipRegion || shipRegion) ? ' style="font-weight:700"' : ''}>${
                x ? yen(x.inTax) : '—'}</td>
              <td class="meta">${esc(prefs.join('・'))}</td></tr>`;
          }).join('')}
          <tr><td>沖縄・離島</td><td class="num">—</td><td class="num">—</td>
            <td class="meta">運賃表に無いので自動計算しません（要確認）</td></tr>
        </tbody></table></div>
        <p class="meta" style="margin-top:6px">実際の注文では、届け先の都道府県からこの表を引いて
          正式な送料を出し直します。</p>
      </details>` : ''}

    <div class="lbl" style="margin-bottom:6px">販売サイトごとの計算</div>
    <div class="table-wrap"><table class="t"><thead><tr>
      <th>販売サイト</th><th>手数料</th><th>固定費</th><th>送料</th>
      <th>目標利益額</th><th>最低販売価格</th><th>推奨価格</th><th>想定利益</th><th>判定</th>
    </tr></thead><tbody>
      ${PRICING_CHANNELS.map(c => {
        const x = r.cells[c.key];
        if (!x.calc.ok) return `<tr><td>${esc(c.label)}</td>
          <td colspan="8"><span class="meta">${esc(x.why)}</span></td></tr>`;
        const p = profitAt(x.price, r.cost, x.st);
        return `<tr>
          <td>${esc(c.label)}${x.st.fromDraft.length ? '<div class="meta">試算の値</div>' : ''}</td>
          <td class="num">${(x.st.fee_rate * 100).toFixed(1)}%
            <div class="meta">${esc(FEE_MODE_LABEL[x.st.feeMode] || x.st.feeMode)}</div>
            <div class="meta">${esc(x.st.feeHow)}</div>
            ${x.st.feeParts ? `<div class="meta">${Object.keys(x.st.feeParts).map(k =>
                `${esc(k)} ${(Number(x.st.feeParts[k].max) * 100).toFixed(1)}%`).join('＋')}</div>` : ''}</td>
          <td class="num">${yen(x.st.fixed_cost)}</td>
          <td class="num">${x.st.shipping_cost == null ? '<span class="tag">未設定</span>' : yen(x.st.shipping_cost)}
            <div class="meta">${esc(x.st.shipHow || '')}</div></td>
          <td class="num">${yen(Math.round(x.calc.target))}</td>
          <td class="num">${yen(Math.ceil(x.calc.floor))}</td>
          <td class="num"><strong>${x.price == null ? '—' : yen(x.price)}</strong>${
            x.edited ? '<div class="meta">手で直しました</div>' : ''}</td>
          <td class="num">${p.profit == null ? '—' : yen(Math.round(p.profit))}${
            p.rate == null ? '' : `<div class="meta">${(p.rate * 100).toFixed(1)}%</div>`}</td>
          <td><span class="tag ${JUDGE_CLASS[x.judge] || 'act'}">${esc(x.judge)}</span>
            <div class="meta">${esc(x.why)}</div></td>
        </tr>`;
      }).join('')}
    </tbody></table></div>
    <p class="meta" style="margin:10px 0">
      目標利益額 ＝ max(配賦原価 × <strong>原価に対する目標利益率</strong>, 最低利益額)<br>
      最低販売価格 ＝ (配賦原価 ＋ 固定費 ＋ 送料 ＋ 目標利益額) ÷ (1 − 手数料率)<br>
      推奨価格 ＝ 最低販売価格を切り上げ（1万円未満は100円／5万円未満は500円／それ以上は1,000円単位）<br>
      <strong>相場は見ていません</strong>（市場データなし・原価基準）。<br>
      「保守的試算」と出ているサイトの手数料率は<strong>実契約料率ではなく</strong>、内訳の上限を足した
      安全側の数字です（実際の手数料はこれより低くなることがあります）。</p>

    <div class="card">
      <div class="lbl" style="margin-bottom:3px">最優先チャネル</div>
      ${r.priority.first ? `<strong>${esc(pricingLabel(r.priority.first))}</strong>` : '—'}
      ${r.priority.second ? `<span class="meta">　第2候補 ${esc(pricingLabel(r.priority.second))}</span>` : ''}
      <div class="meta">${esc(r.priority.why)}</div>
      <div class="meta">いちばん高い価格ではなく<strong>想定利益</strong>で選びます。
        売れやすさは市場データが無いので推測していません。</div>
    </div>
    ${r.flags.length ? `<div class="card" style="margin-top:10px;background:var(--l100);border:1px solid var(--l400)">
      <div class="lbl" style="margin-bottom:3px">要確認</div>
      ${r.flags.map(f => `<div class="meta">・${esc(f)}</div>`).join('')}</div>` : ''}`,
    [['価格の一覧にもどる', 'paintPricing(true)', 'btn ghost']]);
}

/* 手数料の内訳・プランを直す（管理者だけ）。
   ここで変えると実効手数料率が変わるので、何がどう効くかを画面に書いておく。 */
function openFeeRules(ch) {
  if (!canAdmin()) { toast('設定は管理者だけができます'); return; }
  const rules = JSON.parse(JSON.stringify((chanSetting(ch) || {}).pricing_rules || {}));
  feeRulesEdit = { ch, rules };
  const parts = rules.fee_parts || {};
  const plans = rules.plans || {};
  openModal(`${pricingLabel(ch)}の手数料`, `
    <p class="meta" style="margin-bottom:12px">実効手数料率は
      <strong>① プランの料率 ② 内訳の合算 ③ 設定した手数料率</strong> の順で決まります。</p>

    <label class="field" style="margin-bottom:12px"><span>この率の扱い</span>
      <select class="input" id="frMode">
        ${['contract', 'conservative_estimate', 'weighted_actual'].map(m =>
          `<option value="${m}"${(rules.pricing_mode || 'contract') === m ? ' selected' : ''}>${
            esc(FEE_MODE_LABEL[m])}</option>`).join('')}
      </select>
      <span class="meta"><strong>保守的試算</strong>を選ぶと、内訳の<strong>上限</strong>を足した安全側の率を使い、
        画面とCSVに「実契約料率ではない」と出ます。</span></label>

    ${Object.keys(plans).length ? `<label class="field" style="margin-bottom:12px"><span>契約プラン</span>
      <select class="input" id="frPlan">
        <option value="">使わない</option>
        ${Object.keys(plans).map(k => `<option value="${esc(k)}"${rules.plan === k ? ' selected' : ''}>${
          esc(k)}（${(Number(plans[k]) * 100).toFixed(1)}%）</option>`).join('')}
      </select>
      <span class="meta">プランを選ぶと、その料率が内訳より優先されます。</span></label>` : ''}

    ${Object.keys(parts).length ? `<div class="lbl" style="margin-bottom:6px">手数料の内訳</div>
      <div class="table-wrap" style="margin-bottom:10px"><table class="t"><thead><tr>
        <th>項目</th><th>下限（%）</th><th>上限（%）</th></tr></thead><tbody>
        ${Object.keys(parts).map((k, n) => `<tr>
          <td>${esc(k)}${parts[k].note ? `<div class="meta">${esc(parts[k].note)}</div>` : ''}</td>
          <td><input class="input" style="min-width:80px" inputmode="decimal" id="frMin${n}"
              value="${esc(pctOf(parts[k].min))}"></td>
          <td><input class="input" style="min-width:80px" inputmode="decimal" id="frMax${n}"
              value="${esc(pctOf(parts[k].max))}"></td>
        </tr>`).join('')}
      </tbody></table></div>` : ''}

    ${rules.excluded ? `<div class="card" style="margin-bottom:10px">
      <div class="lbl" style="margin-bottom:3px">わざと入れていないもの</div>
      ${Object.keys(rules.excluded).map(k =>
        `<div class="meta">・<strong>${esc(k)}</strong>：${esc(rules.excluded[k])}</div>`).join('')}
      </div>` : ''}
    ${rules.monthly_fixed_yen ? `<p class="meta">月額の固定費 ${yen(rules.monthly_fixed_yen)} は
      <strong>1件あたりに割っていません</strong>。画面の想定利益は、これを回収する前の数字です。</p>` : ''}`,
    [['もどる', 'paintPricing(true)', 'btn ghost'],
     ['保存', `saveFeeRules()`, 'btn lime']]);
}
let feeRulesEdit = null;

async function saveFeeRules() {
  if (!feeRulesEdit) return;
  const { ch, rules } = feeRulesEdit;
  const out = JSON.parse(JSON.stringify(rules));
  out.pricing_mode = (($('frMode') || {}).value || 'contract');
  if ($('frPlan')) {
    const v = ($('frPlan').value || '').trim();
    if (v) out.plan = v; else delete out.plan;
  }
  const parts = out.fee_parts || null;
  if (parts) {
    const keys = Object.keys(parts);
    for (let n = 0; n < keys.length; n++) {
      const lo = Number((($(`frMin${n}`) || {}).value || '').trim());
      const hi = Number((($(`frMax${n}`) || {}).value || '').trim());
      if (isNaN(lo) || isNaN(hi)) { toast(`${keys[n]} は数で入れてください`); return; }
      if (lo < 0 || hi < lo) { toast(`${keys[n]} は 0 ≦ 下限 ≦ 上限 で入れてください`); return; }
      parts[keys[n]].min = Math.round(lo * 10000) / 1000000;
      parts[keys[n]].max = Math.round(hi * 10000) / 1000000;
    }
  }
  const { data, error } = await sb.rpc('inv_channel_pricing_rules_set', { p_channel: ch, p_rules: out });
  if (error) { toast('保存できませんでした：' + error.message); return; }
  const i = db.chanSettings.findIndex(x => x.channel === ch);
  if (data) { if (i >= 0) db.chanSettings[i] = data; else db.chanSettings.push(data); }
  if (pricingRows) pricingRows.forEach(r => buildCells(r));
  paintPricing(true);
  toast(`${pricingLabel(ch)}の手数料を保存しました`);
}

/* ---- 出品用CSV ------------------------------------------------------------
   元のCSVの列をそのまま左に残し、右に計算した列を足す。UTF-8＋BOM。 */
function pricingCsvRows() {
  const stock = pricingSource === 'stock';
  // 取込から出すときは元CSVの列をそのまま左に残す。
  // 在庫から出すときは元CSVが無いので、DBの列（管理番号・商品コードなど）を左に置く
  const H = stock ? [] : ((importSrc || {}).H || []);
  const left = stock
    ? ['管理番号', '商品コード', '商品名', '型番', 'メーカー', 'S/N', '仕入元ID',
       '保管場所', '在庫状態', '商品カテゴリ', '仕入日',
       '仕入価格', '手数料', '原価', 'いまの販売予定価格', '既存の出品先']
    : ['元CSVの行', '親_落札価格', '親_落札料', 'ロット仕入原価', '原価配賦方法', '配賦原価'];
  const head = H.concat(left).concat([
    '正規化メーカー', '正規化カテゴリ', '正規化型番', '検索用商品名', '出品用商品名',
    '状態ランク', '状態要約',
    '配送会社', '配送サービス', '支払', '標準配送地域', '配送サイズ',
    '標準送料_税別', '標準送料_税込', '送料の出どころ', '運賃表の状態', '運賃表の版']);
  PRICING_CHANNELS.forEach(c => head.push(
    `${c.label}_出品判定`, `${c.label}_手数料率`, `${c.label}_手数料の根拠`,
    `${c.label}_最低価格`, `${c.label}_推奨価格`, `${c.label}_想定利益`));
  head.push('最優先チャネル', '第2候補チャネル', '価格算定方式', '値付け根拠', '要確認');

  const out = [head];
  (pricingRows || []).forEach(r => {
    const raw = H.map((_, i) => (r.rawRow ? (r.rawRow[i] == null ? '' : r.rawRow[i]) : ''));
    const it = stock ? (item(r.manageId) || {}) : {};
    const line = [].concat(raw, stock ? [
      r.manageId, r.code || '', r.name, r.model, r.maker, r.serial || '', r.sourceId || '',
      locPath(it.location_id) || '', r.status || '', catName(r.catId) || '未設定',
      r.bought || '',
      r.lot.buy, r.lot.fee, r.cost,
      r.planPrice == null ? '' : r.planPrice,
      (r.listedOn || []).map(k => pricingLabel(k)).join('／')
    ] : [
      r.rawLine === '' ? '' : String(r.rawLine),
      r.lot.buy, r.lot.fee, r.lot.cost,
      r.flags.some(f => f.indexOf('総数') === 0)
        ? '要確認：総数と個品IDの件数が違います（取込と同じく総数で等分）'
        : `総数${r.lot.qty}台で等分（端数は先頭の1台）`,
      r.cost
    ], [
      r.norm.maker || '要確認', r.norm.category || '要確認', r.norm.model || '要確認',
      marketQuery(r.maker, r.model), r.norm.listTitle,
      r.cond.rank || '要確認', r.cond.why
    ]);
    const t = shipTariff() || {};
    const sp = shipFor(r, PRICING_CHANNELS[0].key);
    line.push('佐川急便', t.service || '', t.payment || '',
      sp.region || shipRegion, shipSizeLabel(r.shipSize),
      sp.ex == null ? '' : sp.ex,
      sp.cost == null ? '送料未設定' : sp.cost,
      sp.how,
      RATE_STATUS_LABEL[sp.status || t.rate_status] || '',
      t.effective_from ? `${t.effective_from}〜${t.effective_to || ''}` : '');
    PRICING_CHANNELS.forEach(c => {
      const x = r.cells[c.key];
      const rate = x.st.fee_rate == null ? '' : (x.st.fee_rate * 100).toFixed(1) + '%';
      const how = (FEE_MODE_LABEL[x.st.feeMode] || x.st.feeMode || '') + '：' + (x.st.feeHow || '');
      if (!x.calc.ok) { line.push(x.why, rate, how, '', '', ''); return; }
      const p = profitAt(x.price, r.cost, x.st);
      line.push(x.judge, rate, how, Math.ceil(x.calc.floor),
                x.price == null ? '' : x.price,
                p.profit == null ? '' : Math.round(p.profit));
    });
    line.push(r.priority.first ? pricingLabel(r.priority.first) : '',
              r.priority.second ? pricingLabel(r.priority.second) : '',
              '原価基準', r.priority.why, r.flags.join('／'));
    out.push(line.map(v => v == null ? '' : String(v)));
  });
  return out;
}
function downloadPricingCsv() {
  if (!pricingRows || !pricingRows.length) { toast('出せる行がありません'); return; }
  const d = new Date();
  const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const name = pricingSource === 'stock'
    ? `${ymd}_在庫_出品価格提案.csv`
    : `${ymd}_自社落札_出品価格提案.csv`;
  window.EightCsv.download(name, window.EightCsv.blob(window.EightCsv.build(pricingCsvRows())));
  toast(`${name} を出しました（${pricingRows.length}行）`);
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

/* 判定根拠の印。何をもってこの値になったのかが、一目で分かるようにする */
const WHY_CLASS = { '既存商品から': 'w1', 'CSV内の同じ型番から': 'w1',
                    'CSVカテゴリから': 'w2', '手で選択': 'w3' };
const whyTag = (why) => why === '要確認'
  ? '<span class="why ng">要確認</span>'
  : `<span class="why ${WHY_CLASS[why] || 'w2'}">${esc(why)}</span>`;

/* 取込確認画面の表。出品番号（＝1商品）ごとに1行。
   カテゴリ・配送サイズ・保管場所をここで確認して直す。
   数量・販売予定価格・原価の扱いはこれまでどおり（触っていない）。 */
function purchaseTable(add) {
  const t = purchaseTotals(add);
  const cats = catsFor('individual');
  const sizes = shipSizes().filter(z => z !== 'custom');   // 取込では「その他」は選ばせない
  return `<div class="table-wrap"><table class="t buy">
    <thead><tr>
      <th>商品・型番</th><th>カテゴリ</th><th>配送サイズ</th><th>保管場所</th>
      <th class="r">数量</th>
      <th class="r">1台あたり原価</th><th class="r">販売予定価格</th><th class="r">想定利益</th>
    </tr></thead>
    <tbody>${add.map((x, i) => {
      const g = gainPer(x), gl = gainLot(x);
      const set = x.lot.csvQty > x.src.kids.length;
      const ng = !x.pickCat;
      return `<tr${ng ? ' class="warn"' : ''}>
        <td>${esc(x.master.name)}
          <div class="meta">${x.master.model && x.master.model !== x.master.name ? esc(x.master.model) + '　' : ''}${
            x.auctionCat ? `CSV「${esc(x.auctionCat)}」` : ''}</div>${set
              ? `<div class="meta">${esc(x.lot.kumi || 'セット')}　個品ID ${x.src.kids.length}件 → 管理番号は1台ずつ発行</div>` : ''}</td>
        <td class="pick">
          <select class="input" onchange="setPickCat(${i},this.value)">
            <option value=""${x.pickCat ? '' : ' selected'}>要確認（選んでください）</option>
            ${cats.map(c => `<option value="${esc(c.id)}"${x.pickCat === c.id ? ' selected' : ''}${
              catHasKids(c.id) ? ' disabled' : ''}>${esc(catOptLabel(c))}</option>`).join('')}
          </select>
          ${whyTag(x.pickCatWhy)}</td>
        <td class="pick">
          <select class="input" onchange="setPickSize(${i},this.value)">
            <option value=""${x.pickSize ? '' : ' selected'}>要確認</option>
            ${sizes.map(z => `<option value="${esc(z)}"${x.pickSize === z ? ' selected' : ''}>${
              esc(shipSizeLabel(z))}</option>`).join('')}
          </select>
          ${whyTag(x.pickSizeWhy)}</td>
        <td class="pick">
          <select class="input" onchange="setPickLoc(${i},this.value)">
            ${locOptions(x.pickLoc || '', '選択してください')}
          </select></td>
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
      <th colspan="4">合計</th>
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
  const todo = pickTodo(p);

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
      <div class="impTodo" id="impTodo">${todoHtml(todo)}</div>
      <div id="impTable">${purchaseTable(p.add)}</div>
      <p class="meta" style="margin:-4px 0 14px">
        <strong>カテゴリ・配送サイズ・保管場所は行ごとに直せます。</strong>
        初期値は 既存商品 → CSV内の同じ型番 → CSVのカテゴリ → 過去の登録 の順に決めています。
        決められなかったものは<strong>要確認</strong>にしてあり、勝手に当てはめていません。<br>
        <strong>数量もその場で直せます。</strong>直すと個体数・QRの発行枚数・1台あたり原価・想定利益がすぐ付いてきます。<br>
        1台あたり原価 ＝（落札価格 ＋ 落札料）÷ 数量。端数は先頭の1台に寄せるので、合計は仕入額と一致します。
        販売予定価格は1台あたり原価の1.3倍を目安に入れてあります（手で直したものはそのまま残します）。
        ${p.add.some(x => x.lot.csvQty > x.src.kids.length)
          ? '<br>個品IDより総数が多いものは、<strong>管理番号を1台ずつ発行して別々のQRにします</strong>。元の個品IDは仕入元IDとして全台に残します。' : ''}
        ${shared ? `<br>同じ型番の <strong>${shared}件</strong> は、商品を分けずに個体だけ足します（値段は1台ずつ持ちます）。` : ''}</p>` : ''}

    ${buy && p.add.length ? `<div class="card" style="margin-bottom:15px">
      <div class="lbl" style="margin-bottom:5px">まとめて当てる</div>
      1種類しか入っていないCSVは、ここで選んで<strong>全行に当てる</strong>のが早いです。
      当てたあとも行ごとに直せます。保管場所は<strong>${esc(DEFAULT_IMPORT_LOC)}</strong>を初期値にしています。
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin-top:12px">
        <label class="field"><span>カテゴリ</span><select class="input" id="impCat">
          <option value="">選択してください</option>
          ${catsFor('individual').map(c => `<option value="${esc(c.id)}"${catHasKids(c.id) ? ' disabled' : ''}>${
            esc(catOptLabel(c))}</option>`).join('')}
        </select></label>
        <label class="field"><span>配送サイズ</span><select class="input" id="impSize">
          <option value="">選択してください</option>
          ${shipSizes().filter(z => z !== 'custom').map(z =>
            `<option value="${esc(z)}">${esc(shipSizeLabel(z))}</option>`).join('')}
        </select></label>
        <label class="field"><span>保管場所</span>
          <select class="input" id="impLoc">${locOptions(defaultImportLoc(), '選択してください')}</select></label>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
        <button class="btn sm ghost" onclick="applyPickToAll('cat')">カテゴリを全行に当てる</button>
        <button class="btn sm ghost" onclick="applyPickToAll('size')">配送サイズを全行に当てる</button>
        <button class="btn sm ghost" onclick="applyPickToAll('loc')">保管場所を全行に当てる</button>
        <button class="btn sm ghost" onclick="resetPicks()">自動判定に戻す</button>
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
    // 価格を出すだけ。登録もDBへの保存もしないので、権限に関係なく押せる
    ...(buy && p.add.length ? [['販売価格を自動計算', 'openPricing()', 'btn ghost', 'btnPricing']] : []),
    ...(p.add.length && canAdmin() ? [[buy ? `一括登録（商品 ${c.prods}・個体 ${units}）` : `${p.add.length}商品・${units}台を追加`,
                                       'applyInventoryImport()', 'btn lime', 'btnApply']] : [])
  ]);
  // カテゴリが要確認のまま登録すると分類の無い商品ができてしまうので、ここで止める。
  // 配送サイズは未確定でも登録できる（価格計算で「送料未設定」になるだけ）
  if (buy && todo.cat > 0) {
    const btn = $('btnApply');
    if (btn) { btn.disabled = true; btn.title = 'カテゴリが要確認の行があります'; }
  }
}

async function applyInventoryImport() {
  const p = importPlan;
  if (!p || !p.add.length) return;
  const catId = ($('impCat') || {}).value || null;
  const locId = ($('impLoc') || {}).value || null;
  const pickHere = p.mode === 'legacy' || p.mode === 'purchase';   // カテゴリと保管場所が元データに無い形
  if (p.mode === 'purchase') {
    // 仕入CSVは行ごとに決める。1件でも要確認が残っていたら止める
    // （分類の無い商品ができると、あとから見分けがつかなくなる）
    const todo = pickTodo(p);
    if (todo.cat) { toast(`カテゴリが要確認の行が ${todo.cat}件あります`); return; }
    if (todo.loc) { toast(`保管場所が空の行が ${todo.loc}件あります`); return; }
  } else if (pickHere && (!catId || !locId)) {
    toast('カテゴリと保管場所を選んでください'); return;
  }
  closeModal();
  toast(p.mode === 'purchase' ? `仕入 ${p.add.length}件を登録しています…` : `${p.add.length}商品を取り込んでいます…`);

  let units = [], txs = [];
  const chans = [];
  const touched = [];                      // 今回さわった商品。取込履歴に残して一覧を絞れるようにする
  let madeProds = 0;                       // 実際に新しく作った商品の数
  let sizedProds = 0;                      // 配送サイズを入れた商品の数
  for (const x of p.add) {
    const m = Object.assign({}, x.master);
    // 仕入CSVは行ごとに決めたものを使う。上の「まとめて当てる」欄は、
    // 万一行に値が無かったときの受け皿としてだけ残す
    if (p.mode === 'purchase') { m.category_id = x.pickCat || catId; m.location_id = x.pickLoc || locId; }
    else if (pickHere) { m.category_id = catId; m.location_id = locId; }
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

    // 配送サイズは**今回新しく作った商品だけ**に入れる。
    // すでにある商品のサイズは担当者が決めた値なので、取込では絶対に書き換えない。
    // 入れられなくても取込は止めない（サイズはあとから商品詳細で入れられる）
    if (p.mode === 'purchase' && up.data.created && x.pickSize) {
      const sz = await sb.rpc('inv_product_shipping_size_set', { p_code: m.code, p_size: x.pickSize });
      if (sz.error) toast(`${m.name} の配送サイズを入れられませんでした：${sz.error.message}`);
      else sizedProds++;
    }

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
          + (sizedProds ? `／配送サイズ ${sizedProds}商品` : '')
        : `新規 ${madeProds}商品`)
        + (skips.length ? `／重複スキップ ${skips.length}件` : '')
    }).select();
    if (!error && data && data[0]) batchId = data[0].id;
  } catch (e) { toast(e.message); return; }

  importPlan = null; importSrc = null;
  impMap.loc = {}; impMap.cat = {}; planPrice = {}; planQty = {};
  impPick.cat = {}; impPick.size = {}; impPick.loc = {};
  await loadAll();
  // 取り込んだら商品管理一覧に戻り、今回の分だけを出す。
  // 「今回登録した商品 ○件」の帯（batchBanner）に重複スキップの件数と詳細リンクも出るので、
  // ここでさらにモーダルは開かない（操作を増やしすぎない）
  if (batchId) showBatch(batchId, true); else { ui.fBatch = null; ui.doneBatch = null; go('list'); }
  const listed = chanAdded ? `／出品情報 ${chanAdded}件` : '';
  const skipped = skips.length ? `／重複スキップ ${skips.length}件` : '';
  // 「登録できた」で終わらせず、次にやること（QR）まで言い切る
  toast(wasBuy ? `商品 ${touched.length}件・個体 ${units.length}台を登録しました（原価 ${yen(t.cost)}／想定利益 ${t.priced ? yen(t.gain) : '—'}）${skipped}`
                 + `　次はQRを${units.length}枚印刷して現物に貼ってください`
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
        <th>SKU・商品管理番号</th><th>商品URL<div class="meta">お客様が見るページ</div></th>
        ${canEdit() ? '<th>管理画面<div class="meta">担当者が登録・更新する画面</div></th><th></th>' : ''}</tr></thead>
      <tbody>${rows.map(({ c, x }) => `<tr>
        <td class="nowrap"><span class="tag ch ${x.state === LISTED ? 'on' : ''}">${esc(c.short)}</span> ${esc(c.label)}</td>
        <td class="nowrap">${x.state
            ? `<span class="tag ${x.state === LISTED ? 'ch on' : 'act'}">${esc(x.state)}</span>`
            : '<span class="meta">未出品</span>'}${
            x.fromProduct ? '<div class="meta">型番まとめての設定</div>' : ''}</td>
        <td class="num r">${x.price == null ? '<span class="meta">—</span>' : yen(x.price)}</td>
        <td class="num">${esc(x.sku || '') || '<span class="meta">—</span>'}</td>
        <td>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer" class="meta">開く</a>`
                    : '<span class="meta">—</span>'}</td>
        ${canEdit() ? `<td>${adminCell(it.product_code, c.key)}</td>
        <td class="nowrap"><button class="btn sm ghost"
          onclick="sheetListing('${esc(it.id)}','${c.key}')">編集</button></td>` : ''}
      </tr>`).join('')}</tbody>
    </table></div>`;
}

function sheetListing(id, ch) {
  const it = item(id); if (!it) return;
  const c = CHANNELS.find(x => x.key === ch) || { label: ch, short: ch };
  const own = listingsOf(id).find(x => x.channel === ch);
  const up = channelsOf(it.product_code).find(x => x.channel === ch);
  const up2 = up || {};          // 管理画面URLは型番×販売サイトに1つ
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
      <label class="field" style="margin-bottom:10px"><span>商品URL（お客様が見るページ）</span>
        <input class="input" id="lsUrl" value="${esc(x.url || '')}" placeholder="https://…"></label>
      <label class="field"><span>メモ（任意）</span>
        <input class="input" id="lsNote" value="${esc(x.note || '')}"></label>
      ${ADMIN_SEARCH_CHANNELS.indexOf(ch) >= 0 ? `<p class="meta" style="margin-top:8px">
        管理画面URLは、表の［管理URLを${up2.admin_url ? '直す' : '登録'}］から（別に保存します）。</p>` : ''}`,
    run: (state) => saveListing(id, null, ch, state, {
      price: numField('lsPrice'), sku: ($('lsSku') || {}).value,
      url: ($('lsUrl') || {}).value, note: ($('lsNote') || {}).value
    })
  });
}

/* 出品情報の保存はDBの関数を通す。状態が変わったときだけ履歴に残る */
async function saveListing(itemId, code, ch, state, more) {
  // 返り値は「保存できたか」。呼ぶ側はこれを見てから次へ進む
  const { data, error } = await sb.rpc('inv_listing_set', {
    p_item_id: itemId || null, p_code: code || null, p_channel: ch,
    p_state: state || null, p_sku: (more || {}).sku || null,
    p_price: (more || {}).price == null ? null : (more || {}).price,
    p_url: (more || {}).url || null, p_note: (more || {}).note || null
  });
  if (error) { toast('保存できませんでした：' + error.message); return false; }
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
  return true;
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
    ${ind ? saleBox(p) : ''}
    ${ind ? shippingBox(p) : ''}
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

const SALE_CONDITIONS = ['新品', '整備済み', '中古'];

/* 販売設定に出す「参考価格」。
   楽天の出品価格と、個体に入っている販売予定価格（plan_price）を見るだけで、
   公開する販売価格（sale_price）へ自動ではコピーしない。
   楽天は個人向け・送料込みの値段で、plan_price は社内の見込みなので、
   どちらも法人向けの公開価格とは別物。 */
function saleRefPrices(code) {
  const rk = channelsOf(code)
    .concat(itemsOf(code).reduce((a, i) => a.concat(listingsOf(i.id)), []))
    .filter(c => c.channel === 'rakuten' && c.price > 0).map(c => c.price);
  const plans = itemsOf(code).filter(i => !GONE.includes(i.status) && i.plan_price > 0)
    .map(i => i.plan_price);
  return { rakuten: rk.length ? Math.min.apply(null, rk) : null,
           plan:    plans.length ? Math.min.apply(null, plans) : null };
}

/* 商品詳細に出す販売設定（8EC BUY）。
   レンタル（8RENT）とは別の判断で、同じ商品を 販売だけ・レンタルだけ・両方 にできる。
   ここで「販売する」にした商品だけが /buy と公開トップの販売欄に出る。
   楽天の掲載とは関係しない（楽天は裏側の販売チャネルのまま）。 */
function saleBox(p) {
  // 販売の列がまだ無いDB（migration未適用）では出さない
  if (p.sale_enabled === undefined) return '';
  const on = !!p.sale_enabled;
  const ref = saleRefPrices(p.code);
  return `<div class="prices" style="margin-top:16px">
    <div><div class="lbl">販売（8EC BUY）</div><div class="v ${on ? 'plus' : ''}">${on ? '公開中' : '非公開'}</div></div>
    <div><div class="lbl">法人向け販売価格</div><div class="v">${p.sale_price ? yen(p.sale_price) : 'お見積り'}</div></div>
    <div><div class="lbl">状態</div><div class="v" style="font-size:15px">${esc(p.sale_condition || '未設定')}</div></div>
    <div><div class="lbl">取り寄せ</div><div class="v">${p.sale_procurement_available ? '可' : '—'}</div></div>
    <button class="btn sm ghost" onclick="sheetSaleSet('${esc(p.code)}')" ${dis()}>販売設定を変える</button>
  </div>
  <p class="meta" style="margin-top:6px">${[
      on && !p.sale_price ? '価格が未設定なので、公開画面では「販売価格はお見積り」と出ます。' : '',
      ref.rakuten ? '参考：楽天の出品 ' + yen(ref.rakuten) : '',
      ref.plan ? '参考：販売予定価格 ' + yen(ref.plan) : '',
      '参考価格は自動で入りません。法人向けに出す価格はここで決めてください。'
    ].filter(Boolean).join('　')}</p>`;
}

/* 商品詳細に出す配送サイズ（佐川急便）。
   送料は「配送会社 × サイズ × 地域」で決まるので、販売サイトの設定とは分けて
   商品に持たせる。金額はここでは持たない（契約運賃表ができてから別に持つ）。 */
function shippingBox(p) {
  if (p.shipping_size === undefined) return '';   // migration未適用のDBでは出さない
  return `<div class="prices" style="margin-top:16px">
    <div><div class="lbl">配送サイズ（佐川急便）</div>
      <div class="v" style="font-size:15px">${esc(shipSizeLabel(p.shipping_size || ''))}</div></div>
    <button class="btn sm ghost" onclick="sheetShipSize('${esc(p.code)}')" ${dis()}>配送サイズを変える</button>
  </div>
  <p class="meta" style="margin-top:6px">出品価格を計算するときの<strong>既定のサイズ</strong>です。
    送料の金額はまだ登録していないので、価格提案の画面で入れてください。</p>`;
}
function sheetShipSize(code) {
  const p = prod(code); if (!p) return;
  openSheet({
    title: '配送サイズ', subject: code, cta: '保存',
    hint: '佐川急便の規格です。運賃は契約・地域・重量で変わるので、金額はここでは持ちません。',
    body: `<label class="field"><span>サイズ</span>
      <select class="input" id="sheetVal">
        <option value=""${p.shipping_size ? '' : ' selected'}>未設定</option>
        ${shipSizes().map(z => `<option value="${esc(z)}"${p.shipping_size === z ? ' selected' : ''}>${
          esc(shipSizeLabel(z))}</option>`).join('')}
      </select></label>`,
    run: async (v) => {
      const { data, error } = await sb.rpc('inv_product_shipping_size_set', {
        p_code: code, p_size: v || null
      });
      if (error) { toast('保存できませんでした：' + error.message); return; }
      const m = prod(code); if (m && data) m.shipping_size = data.shipping_size;
      await refreshTx();
      render();
      toast(`配送サイズを ${shipSizeLabel(v)} にしました`);
    }
  });
}

function sheetSaleSet(code) {
  const p = prod(code); if (!p) return;
  const ref = saleRefPrices(code);
  openSheet({
    title: '販売設定', subject: code, cta: '保存',
    hint: '「販売する」にすると、この商品が /buy（法人IT機器販売）と公開トップの販売欄に出ます。レンタル（8RENT）の設定とは別なので、両方に出すこともできます。',
    body: `<label class="field" style="margin-bottom:10px"><span>販売</span>
        <select class="input" id="sheetVal">
          <option value="false"${!p.sale_enabled ? ' selected' : ''}>販売しない</option>
          <option value="true"${p.sale_enabled ? ' selected' : ''}>販売する</option>
        </select></label>
      <label class="field" style="margin-bottom:6px"><span>法人向け販売価格（税抜・円）</span>
        <input class="input num" type="number" min="1" step="100" id="slPrice"
               value="${esc(p.sale_price == null ? '' : String(p.sale_price))}" placeholder="空欄なら「お見積り」"></label>
      <p class="meta" style="margin:-2px 0 12px">${[
          ref.rakuten ? '楽天の出品価格 ' + yen(ref.rakuten) : '',
          ref.plan ? '社内の販売予定価格 ' + yen(ref.plan) : ''
        ].filter(Boolean).join('／') || '参考にできる価格はまだありません。'}
        <br>どちらも参考値です（楽天は個人向け・送料込み、販売予定価格は社内の見込み）。
        そのまま公開価格にはしないでください。</p>
      <label class="field" style="margin-bottom:10px"><span>商品の状態</span>
        <select class="input" id="slCond">
          <option value=""${!p.sale_condition ? ' selected' : ''}>未設定（公開画面に状態を出さない）</option>
          ${SALE_CONDITIONS.map(c => `<option value="${c}"${p.sale_condition === c ? ' selected' : ''}>${c}</option>`).join('')}
        </select></label>
      <label class="bchk" style="margin-bottom:8px"><input type="checkbox" id="slProcure" ${p.sale_procurement_available ? 'checked' : ''}> 取り寄せ可（在庫0でも販売の相談を受ける）</label>
      <p class="meta" style="margin:-4px 0 4px">在庫があれば「在庫あり」、無くて取り寄せ可なら「取り寄せ可能」と出ます。
        残り何台かは公開しません。仕入先の社名も出しません。</p>`,
    // 入れ直しにならないよう、閉じる前に見る（閉じてから知らせると入力が消える）
    validate: () => {
      const v = numField('slPrice');
      if (v != null && (!(v > 0) || v > 100000000)) {
        toast('販売価格は1円〜1億円の範囲で入れてください'); return false;
      }
      return true;
    },
    run: (val) => saveSaleSet(code, val === 'true')
  });
}

async function saveSaleSet(code, enabled) {
  const { data, error } = await sb.rpc('inv_product_sale_set', {
    p_code: code, p_enabled: enabled,
    p_price: numField('slPrice'),
    p_condition: (($('slCond') || {}).value || null),
    p_procurement: !!($('slProcure') || {}).checked
  });
  if (error) { toast('保存できませんでした：' + error.message); return; }
  const i = db.masters.findIndex(x => x.code === code);
  if (i >= 0 && data) db.masters[i] = data;
  await refreshTx();
  render();
  toast(enabled ? '販売する商品にしました' : '販売設定を保存しました');
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
        <th>型番まとめての設定</th><th>SKU</th><th class="r">販売価格</th>
        <th>商品URL<div class="meta">お客様が見るページ</div></th>
        ${canEdit() ? '<th>管理画面<div class="meta">担当者が登録・更新する画面</div></th><th></th>' : ''}</tr></thead>
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
          <td>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer" class="meta" style="word-break:break-all">開く</a>` : '<span class="meta">—</span>'}</td>
          ${canEdit() ? `<td>${adminCell(p.code, c.key)}</td>
          <td class="nowrap"><button class="btn sm ghost" onclick="sheetChannel('${esc(p.code)}','${c.key}')">編集</button></td>` : ''}
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
      <label class="field"><span>メモ</span>
        <input class="input" id="lsNote" value="${esc(x.note || '')}"></label>
      <p class="meta" style="margin-top:8px">管理画面URLは、表の
        ［管理URLを${x.admin_url ? '直す' : '登録'}］から（別に保存します）。</p>`,
    run: (state) => saveListing(null, code, ch, state, {
      price: numField('lsPrice'), sku: ($('lsSku') || {}).value,
      url: ($('lsUrl') || {}).value, note: ($('lsNote') || {}).value
    })
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

/* ===== 8. 棚卸 =====
   月次の棚卸は「帳簿在庫と現物の照合」。
   **システム上は売れる在庫なのに、現物が無い**ものを見つけて、残さないための画面。

   帳簿在庫     … 棚卸を始めた時点の 在庫・出品中（inv_start_stocktake が expected=true で並べる）
   現物確認済み … そのうち現物を見つけたもの（checked_at）
   差異確定     … 現物が無いことを人が確認したもの（missing_at・状態は不明になる）
   未確認       … まだどちらにも処理していないもの
   帳簿外現物   … 帳簿に無いのに現物があったもの（QR等で読むと expected=false で足される）

   **未確認が0になれば、帳簿在庫の全台が「現物あり」か「現物なしを確認済み」の
   どちらかに確定した**ということ。これを月次棚卸の完了条件にしている。
   帳簿在庫の数は棚卸の途中で増えない。帳簿外の現物を読んでも別枠で数える。
   QRが貼られていない個体は［確認］ボタンで確認する。QRを読むのと同じ
   inv_item_op('棚卸確認') を通るので、どちらでも同じ記録になる。
   この画面は在庫の状態・在庫数・出品状態・8RENT・価格を1つも変えない。 */

/* 棚卸の一覧の1行。型番・管理番号・メーカー・保管場所・状態と、右にボタン */
function stRow(itemId, note, acts) {
  const it = item(itemId);
  const head = it ? (it.model || it.name || itemId) : itemId;
  const bits = it
    ? [esc(itemId), esc(it.maker || ''), esc(locPath(it.location_id))].filter(Boolean)
    : [esc(itemId), '（この個体は見つかりません）'];
  return `<div class="r">
    <div class="b">
      <div class="n">${esc(head)}${it ? qrIcon(it) : ''}</div>
      <div class="m">${bits.join('　')}${note ? `　${note}` : ''}</div>
    </div>
    ${it ? statusTag(it.status) : ''}
    <div class="acts">${acts}</div>
  </div>`;
}

/* これまでの棚卸。数えるのはDB側（inv_stocktake_summary）。
   ブラウザで stocktake_items を何千行も読んで数えたりはしない */
function pastStocktakeTable() {
  const rows = (db.stSummary || []).filter(x => x.status !== 'open');
  if (!rows.length) {
    return db.stPast.length
      ? `<div class="empty">集計（inv_stocktake_summary）がまだ読めません。migrationの適用後に出ます。</div>`
      : '<div class="empty">まだ実施していません。</div>';
  }
  return `<div class="table-wrap"><table class="t">
    <thead><tr><th>実施</th><th>範囲</th><th>担当</th>
      <th class="r num">帳簿在庫</th><th class="r num">現物確認済み</th><th class="r num">差異確定</th>
      <th class="r num">未確認</th><th class="r num">帳簿外現物</th></tr></thead>
    <tbody>${rows.map(s => `<tr>
      <td class="nowrap meta">${fmtDT(s.started_at)}</td>
      <td>${esc(s.scope_location_id ? locPath(s.scope_location_id) : 'すべて')}</td>
      <td class="meta">${esc(s.actor || '')}</td>
      <td class="r num">${s.book_count}</td>
      <td class="r num">${s.checked_count}</td>
      <td class="r num${s.missing_count ? ' minus' : ''}">${s.missing_count}</td>
      <td class="r num${s.unchecked_count ? ' minus' : ''}">${s.unchecked_count}</td>
      <td class="r num">${s.extra_count}</td></tr>`).join('')}</tbody></table></div>
    <p class="meta" style="margin:8px 0 0">「差異確定」は、その棚卸で現物が無いことを人が確認した台数です
      （<code>missing_at</code> から数えています。履歴を期間で切った推測ではありません）。
      「未確認」が0なら、帳簿在庫の全台が現物ありか現物なし確認済みのどちらかに確定しています。</p>`;
}

function viewStock() {
  if (!db.stocktake) {
    const scope = ui.stScope;
    // 対象は帳簿在庫（在庫・出品中）。貸出中・予約中・販売予約・売却済・廃棄は
    // そもそも現物を確認しに行けないので数えない（inv_start_stocktake と同じ条件）
    const n = db.items.filter(i => IN_STOCK.includes(i.status)
      && (!scope || locTree(scope).includes(i.location_id))).length;
    return `<h1>棚卸</h1>
      <p class="sub" style="margin:8px 0 18px">帳簿の在庫（<strong>在庫・出品中</strong>）が
        本当に手元にあるかを照合します。始めると、その範囲が「未確認」に並びます。
        QRを連続で読み取るか、［確認］を押して潰していきます。</p>
      ${guardNote()}
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;max-width:620px">
        <select class="input" style="flex:1 1 220px" onchange="ui.stScope=this.value;render()">
          <option value="">すべて</option>
          ${locsOrdered().filter(l => locLive(l) || scope === l.id)
              .map(l => `<option value="${esc(l.id)}"${scope === l.id ? ' selected' : ''}>${esc(locLabel(l.id))}</option>`).join('')}
        </select>
      </div>
      <button class="btn lime" style="min-height:56px;margin-top:12px" onclick="startStocktake()" ${dis()}>
        <span class="ms">play_circle</span>棚卸開始（帳簿在庫 ${n}台）</button>
      <p class="meta" style="margin:8px 0 0">貸出中・予約中・販売予約・売却済・廃棄は対象に入りません
        （現物を確認しに行けないため）。未確認の数にも混ざりません。</p>

      <div class="sec">これまでの棚卸</div>
      ${pastStocktakeTable()}`;
  }

  const st = db.stocktake;
  // 数え方も一覧の仕分けも stocktakeBuckets / stocktakeProgress 1本に通す
  const p = stocktakeProgress();
  const b = stocktakeBuckets();
  const tab = ['done', 'missing', 'extra'].includes(ui.stTab) ? ui.stTab : 'todo';
  const when = new Date(st.started_at);

  const list = tab === 'todo'
    ? (b.todo.length ? `<div class="stlist">${b.todo.map(x => {
        const it = item(x.item_id);
        const last = it && it.last_checked_at ? `前回確認 ${fmtDT(it.last_checked_at)}` : '前回確認なし';
        return stRow(x.item_id, `<span class="meta">${last}</span>`,
          `<button class="btn sm lime" onclick="checkItem('${esc(x.item_id)}')" ${dis()}>確認</button>
           <button class="btn sm ghost" onclick="openMissing('${esc(x.item_id)}')" ${dis()}>見つからない</button>`);
      }).join('')}</div>`
      : `<div class="empty">未確認は0台です。帳簿在庫 ${p.total}台すべてについて、
          現物があったか、現物が無いことを確認したかのどちらかに確定しました。
          「棚卸を終了」を押してください。</div>`)
    : tab === 'done'
    ? (b.done.length ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <button class="btn sm" onclick="printCheckedLabels()">
          <span class="ms">qr_code_2</span>この${b.done.length}台のQRを印刷</button>
        <button class="btn sm ghost" onclick="ui.fCheck='done';go('list')">在庫一覧で見る</button>
      </div>
      <div class="stlist">${b.done.map(x => stRow(x.item_id,
        `<span class="meta">確認 ${fmtDT(x.checked_at)}</span>`,
        `<button class="btn sm ghost" onclick="openUncheck('${esc(x.item_id)}')" ${dis()}>未確認に戻す</button>`
      )).join('')}</div>`
      : '<div class="empty">まだありません。</div>')
    : tab === 'missing'
    ? (b.missing.length ? `<p class="meta" style="margin:0 0 10px">現物が無いことを人が確認したものです。
        <strong>状態は「不明」になっています</strong>（販売可能数・8RENT可能数・販売予約可能数から外れます）。
        見つかったら［差異確定を取り消す］で元の状態へ戻せます。</p>
      <div class="stlist">${b.missing.map(x => stRow(x.item_id,
        `<span class="meta">差異確定 ${fmtDT(x.missing_at)}</span>`,
        `<button class="btn sm ghost" onclick="openUnmissing('${esc(x.item_id)}')" ${dis()}>差異確定を取り消す</button>`
      )).join('')}</div>`
      : '<div class="empty">ありません。</div>')
    : (b.extra.length ? `<p class="meta" style="margin:0 0 10px">帳簿（在庫・出品中）に無いのに現物があったものです。
        <strong>帳簿在庫 ${p.total}台には数えていません。</strong>状態が違っていないか個体詳細で確かめてください。</p>
      <div class="stlist">${b.extra.map(x => stRow(x.item_id,
        `<span class="meta">確認 ${fmtDT(x.checked_at)}</span>`,
        `<button class="btn sm ghost" onclick="openUncheck('${esc(x.item_id)}')" ${dis()}>この読み取りを取り消す</button>`
      )).join('')}</div>`
      : '<div class="empty">ありません。</div>');

  return `<h1>${when.getMonth() + 1}月の棚卸</h1>
    <div class="sum" style="margin:14px 0 10px">
      <div><div class="lbl">帳簿在庫</div><div class="v">${p.total}<span class="u">台</span></div></div>
      <div><div class="lbl">現物確認済み</div><div class="v add">${p.done}<span class="u">台</span></div></div>
      <div><div class="lbl">差異確定</div><div class="v${p.missing ? ' minus' : ''}">${p.missing}<span class="u">台</span></div></div>
      <div><div class="lbl">未確認</div><div class="v${p.left ? ' err' : ''}">${p.left}<span class="u">台</span></div></div>
      <div><div class="lbl">帳簿外現物</div><div class="v">${p.extra}<span class="u">台</span></div></div>
    </div>
    <div class="prog"><i style="width:${p.pct}%"></i></div>
    <div class="meta" style="margin:6px 0 2px">
      <strong>棚卸処理済み ${p.handled} / ${p.total}（${p.rate}%）</strong>　
      ${esc(st.scope_location_id ? locPath(st.scope_location_id) : 'すべて')}　開始 ${fmtDT(st.started_at)}<br>
      残り <strong>${p.left}台</strong>。未確認は「まだ現物を確認できていない帳簿在庫」で、紛失という意味ではありません。
      現物が無いと確定したものは［見つからない］で差異確定にしてください（自動では不明にしません）。</div>
    ${guardNote()}
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">
      <button class="btn lime" style="min-height:56px;flex:1 1 220px" onclick="openScan('stocktake')" ${dis()}>
        <span class="ms">qr_code_scanner</span>連続読取</button>
      <button class="btn" style="min-height:56px" onclick="printCheckedLabels()" ${p.done ? '' : 'disabled'}
        title="${p.done ? '今回の棚卸で確認済みになった帳簿在庫だけをQRラベル画面へ渡します' : 'まだ確認済みの個体がありません'}">
        <span class="ms">qr_code_2</span>確認済み${p.done}台のQRを印刷</button>
      <button class="btn" style="min-height:56px" onclick="openCloseStocktake()" ${dis()}>棚卸を終了</button>
    </div>
    <p class="meta" style="margin:8px 0 0">QRは<strong>新しく発行しません</strong>。
      いまの管理番号のラベルをもう一度出すだけで、管理番号もQRのURLも変わりません。
      棚卸は<strong>現物を確認した記録</strong>なので、在庫の状態・在庫数・出品状態・8RENTは変わりません。</p>

    <div class="tabs2 sttabs" style="margin-top:22px">
      <button class="${tab === 'todo' ? 'on' : ''}" onclick="setStTab('todo')">
        <span class="ms">help</span>未確認<span class="n">${b.todo.length}</span></button>
      <button class="${tab === 'done' ? 'on' : ''}" onclick="setStTab('done')">
        <span class="ms">check_circle</span>確認済み<span class="n">${b.done.length}</span></button>
      <button class="${tab === 'missing' ? 'on' : ''}" onclick="setStTab('missing')">
        <span class="ms">search_off</span>差異<span class="n">${b.missing.length}</span></button>
      <button class="${tab === 'extra' ? 'on' : ''}" onclick="setStTab('extra')">
        <span class="ms">new_releases</span>帳簿外<span class="n">${b.extra.length}</span></button>
    </div>
    ${list}`;
}
function setStTab(k) { ui.stTab = k; render(); }

/* 終了する前に、対象・確認済み・未確認を必ず見せる。
   未確認が残っているときは、そのまま終わってよいかを念のためもう一度きく */
function openCloseStocktake() {
  const p = stocktakeProgress();
  if (!p.open) return;
  const todo = stocktakeBuckets().todo;
  openModal('棚卸を終了しますか', `
    <div class="sum" style="margin-bottom:12px">
      <div><div class="lbl">帳簿在庫</div><div class="v">${p.total}<span class="u">台</span></div></div>
      <div><div class="lbl">現物確認済み</div><div class="v add">${p.done}<span class="u">台</span></div></div>
      <div><div class="lbl">差異確定</div><div class="v${p.missing ? ' minus' : ''}">${p.missing}<span class="u">台</span></div></div>
      <div><div class="lbl">未確認</div><div class="v${p.left ? ' err' : ''}">${p.left}<span class="u">台</span></div></div>
      ${p.extra ? `<div><div class="lbl">帳簿外現物</div><div class="v">${p.extra}<span class="u">台</span></div></div>` : ''}
    </div>
    ${p.left ? `<div class="card" style="margin-bottom:12px;background:#FDECEA;border:1px solid #B3261E">
      <strong>未確認が ${p.left}台 残っています。</strong>
      <span class="meta">未確認は「まだ現物を確認できていない帳簿在庫」で、紛失とは限りません。
        ここで探し直して［確認］するか、現物が無いと確定したものだけ［見つからない］で
        差異確定（状態は「不明」）にしてください。<strong>自動では不明にしません。</strong>
        終了しても<strong>在庫数・出品状態・8RENTは変わりません</strong>
        （差異確定で「不明」にしたぶんだけ、販売可能数から外れます）。</span></div>`
      : `<div class="card" style="margin-bottom:12px">
      <strong>帳簿在庫 ${p.total}台すべてを確定しました（現物確認 ${p.done}台・差異確定 ${p.missing}台）。</strong>
      <span class="meta">未確認は0台です。終了しても在庫数は変わりません。確認した日時（最終棚卸確認）は個体に残ります。</span></div>`}
    ${todo.length ? `<div class="stlist" style="max-height:320px;overflow:auto;margin-bottom:12px">${
      todo.map(x => {
        const it = item(x.item_id);
        const last = it && it.last_checked_at ? `前回確認 ${fmtDT(it.last_checked_at)}` : '前回確認なし';
        return stRow(x.item_id, `<span class="meta">${last}</span>`,
          `<button class="btn sm lime" onclick="checkItem('${esc(x.item_id)}')" ${dis()}>確認</button>
           <button class="btn sm ghost" onclick="openMissing('${esc(x.item_id)}')" ${dis()}>見つからない</button>`);
      }).join('')}</div>` : ''}
    ${p.done ? `<p class="meta">終了する前に、今回確認した ${p.done}台のQRをまとめて印刷できます。</p>` : ''}
  `, [
    ['やめる', 'closeModal()', 'btn ghost'],
    ...(p.done ? [['確認済みのQRを印刷', 'closeModal();printCheckedLabels()', 'btn ghost']] : []),
    [p.left ? `未確認 ${p.left}台を残して終了する` : '棚卸を終了する',
     'closeModal();closeStocktake(true)', p.left ? 'btn danger' : 'btn lime']
  ]);
}

async function startStocktake() {
  const { data, error } = await sb.rpc('inv_start_stocktake', { p_scope: ui.stScope || null });
  if (error) { toast('棚卸を開始できませんでした：' + error.message); return; }
  db.stocktake = data;
  ui.stTab = 'todo';                 // 始めたら必ず「未確認」から
  await loadStocktakeItems();
  render();
  toast('棚卸を開始しました');
}
async function closeStocktake(confirmed) {
  if (!db.stocktake) return;
  const left = stocktakeProgress().left;   // 数え方は1本に統一（差異確定は未確認に入れない）
  // 確認のモーダル（openCloseStocktake）を通っていれば、そこで見せているので聞き直さない
  if (!confirmed && left && !confirm(`未確認が ${left} 件あります。このまま終了しますか？`)) return;
  const { error } = await sb.rpc('inv_close_stocktake', { p_id: db.stocktake.id });
  if (error) { toast('終了できませんでした：' + error.message); return; }
  db.stocktake = null; db.stChecked = [];
  const s = await sb.from('inventory_stocktakes').select('*').order('started_at', { ascending: false }).limit(20);
  if (!s.error) { db.stPast = (s.data || []).filter(x => x.status !== 'open'); }
  // 「これまでの棚卸」に今回の結果を出す。数えるのはDB側（inv_stocktake_summary）
  const sm = await sb.from('inv_stocktake_summary').select('*')
    .order('started_at', { ascending: false }).limit(24);
  if (!sm.error) db.stSummary = sm.data || [];
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

/* opt.defKind … 新規のときの管理方式の初期値（商品登録から足したとき、その画面に合わせる）
   opt.after   … 保存したあとに呼ぶ。引数は保存されたカテゴリーID
   どちらも省略できる。マスター管理からはこれまでどおり sheetCatEdit(id) で呼ぶ。 */
function sheetCatEdit(id, opt) {
  opt = opt || {};
  const c = id ? cat(id) : null;
  const defKind = c ? c.kind : (opt.defKind || 'individual');
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
            <option value="individual"${defKind === 'individual' ? ' selected' : ''}>個体管理（1台ずつ）</option>
            <option value="quantity"${defKind === 'quantity' ? ' selected' : ''}>数量管理（数が増減）</option>
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
    run: async () => {
      const savedId = await saveMasterCat(id);
      if (opt.after) opt.after(savedId);
    }
  });
}
/* 保存したカテゴリーIDを返す（新規のときはDB側で作られたID）。
   商品登録フォームがそれを自動で選ぶために使う。失敗したときは null。 */
async function saveMasterCat(id) {
  if (masterBusy) return;
  masterBusy = true;
  try {
    const sort = (($('mcSort') || {}).value || '').trim();
    const { data, error } = await sb.rpc('inv_category_save', {
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
    if (error) { toast(error.message || '保存できませんでした'); return null; }
    await reloadMasters();
    toast(id ? 'カテゴリーを直しました' : 'カテゴリーを足しました');
    return (data && data.id) || id || null;
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
      ${batchQrBtn(batchOf(done.id), 'lime')}
      <button class="btn sm ghost" onclick="showBatch(${done.id},true)">一覧で見る</button>
    </div>
    ${done.items ? `<div class="rmnext"><span class="ms">qr_code_2</span>
      <span>登録はまだデータだけです。<strong>QRを印刷して実物1台ずつに貼り、保管するまで</strong>が1回の仕入作業です。</span>
    </div>` : ''}` : ''}
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
    ${regFieldsBody(ind, cats, 'setRegKind', 'reg')}
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:18px">
      <button class="btn pri" onclick="doRegister()" ${canAdmin() ? '' : 'disabled'}>
        <span class="ms">add</span>登録してQR発行</button>
      <span class="meta">発行予定の${ind ? '管理番号' : '商品コード'}: <b id="idPreview" class="num">—</b></span>
    </div>`;
}

/* ---- 1件ずつの登録フォーム ------------------------------------------------
   商品登録画面と、商品取込モーダルの「1件だけ登録」タブの両方から使う
   （項目がずれないよう1か所にまとめる）。kindFn は個体管理／数量管理の
   切り替えボタンが呼ぶ関数名、where は描き直しかたの違い（'reg' / 'import'）。

   **同じ id の入力欄が画面に2つ出ることがある。** 商品登録画面から商品取込を開くと、
   モーダルの後ろに登録フォームが残ったままなので `r-name` などが2つになる。
   `document.getElementById` は先に出てくるほう（＝後ろの画面側）を返すので、
   モーダルが開いているあいだはモーダルの中を見るようにする。 */
function regRoot() {
  const m = $('modal');
  return (m && m.classList.contains('on') && m.querySelector('#r-cat')) ? m : document;
}
const regEl = (id) => regRoot().querySelector('#r-' + id);

/* 登録フォームに入っている内容。カテゴリを足す・直すと reloadMasters() から
   render() が走ってフォームが描き直されるので、いったんここへ退避して戻す。
   **入力途中の内容を消さないための要**。 */
const REG_FIELDS = ['name', 'cat', 'loc', 'maker', 'model', 'spec',
                    'serial', 'buy', 'price', 'qty', 'min', 'unit', 'note'];
function regSnapshot() {
  const d = {};
  REG_FIELDS.forEach(k => { const e = regEl(k); if (e) d[k] = e.value; });
  return d;
}
function regRestore(draft, wantCat) {
  if (!draft) return;
  REG_FIELDS.forEach(k => {
    const e = regEl(k);
    if (e && draft[k] !== undefined && k !== 'cat') e.value = draft[k];
  });
  const sel = regEl('cat');
  if (sel) {
    const want = wantCat || draft.cat || '';
    sel.value = want;
    // 管理方式を変えて保存すると、いまのフォーム（個体／数量）の候補に出てこない
    if (want && sel.value !== want) {
      sel.value = draft.cat || '';
      toast('このフォームの管理方式と違うので、カテゴリは選び直してください');
    }
  }
  paintRegCatBtn();
  previewId();
}
/* ［選択中を編集］はカテゴリを選んでいるときだけ押せる */
function paintRegCatBtn() {
  const sel = regEl('cat');
  const btn = regRoot().querySelector('#r-catEdit');
  if (btn) btn.disabled = !canAdmin() || !(sel && sel.value);
}
/* カテゴリを足す・直す。マスター管理と同じ sheetCatEdit / saveMasterCat / inv_category_save を
   そのまま使う（カテゴリ管理の処理を2つ持たない）。画面は移動しない。 */
function openRegCat(where, id) {
  if (!canAdmin()) { toast('カテゴリーを足せるのは管理者だけです'); return; }
  if (id === '') { toast('先にカテゴリを選んでください'); return; }
  const draft = regSnapshot();                 // 入力途中の内容を退避
  sheetCatEdit(id || null, {
    // 個体管理の画面から足したら個体管理、数量管理の画面からなら数量管理を初期値にする
    defKind: ui.regKind === 'ind' ? 'individual' : 'quantity',
    after: (savedId) => {
      // モーダル側はここで描き直す（render() は後ろの画面しか直さない）
      if (where === 'import') paintImportModal();
      regRestore(draft, savedId || id || draft.cat);
    }
  });
}

const regField = (id, label, type, extra) =>
  `<label class="field"><span>${esc(label)}</span><input class="input" id="r-${id}" ${type ? `type="${type}"` : ''} ${extra || ''}></label>`;
const regTextarea = (id, label) =>
  `<label class="field" style="grid-column:1/-1"><span>${esc(label)}</span><textarea class="input" id="r-${id}" rows="2"></textarea></label>`;
function regFieldsBody(ind, cats, kindFn, where) {
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
      <label class="field"><span>カテゴリ *</span>
        <select class="input" id="r-cat" onchange="previewId();paintRegCatBtn()">
        <option value="">選択してください</option>
        ${cats.map(c => `<option value="${esc(c.id)}"${catHasKids(c.id) ? ' disabled' : ''}>${
          esc(catOptLabel(c))}${catHasKids(c.id) ? '（下から選んでください）' : ''}</option>`).join('')}</select>
        ${canAdmin() ? `<div class="catbtns">
          <button type="button" class="btn sm ghost" onclick="openRegCat('${where || 'reg'}', null)">
            <span class="ms">add</span>カテゴリを追加</button>
          <button type="button" class="btn sm ghost" id="r-catEdit" disabled
            onclick="openRegCat('${where || 'reg'}', (regEl('cat')||{}).value)">選択中を編集</button>
        </div>` : ''}</label>
      <label class="field"><span>保管場所 *</span><select class="input" id="r-loc">${locOptions('', '選択してください')}</select></label>
      ${regField('maker', 'メーカー')}
      ${regField('model', '型番')}
      ${regTextarea('spec', 'スペック')}
      ${ind ? regField('serial', 'シリアル番号') + regField('buy', '購入日', 'date') + regField('price', '購入価格', 'number')
            : regField('qty', '初期在庫数 *', 'number') + regField('min', '最低在庫数 *', 'number') + regField('unit', '購入単価', 'number')}
      ${regTextarea('note', '備考')}
    </div>`;
}

/* 採番カウンタは読むだけで予告する。実際の採番は登録のときに1回だけ。
   同じ id が2つ出ることがあるので、いま操作しているフォームの中だけを見る */
async function previewId() {
  const el = regRoot().querySelector('#idPreview'); if (!el) return;
  const pre = ui.regKind === 'ind' ? ((cat((regEl('cat') || {}).value) || {}).code_prefix || 'IT') : 'SKU';
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
  // いま操作しているフォーム（モーダルが開いていればモーダル側）から読む
  const g = id => ((regEl(id) || {}).value || '').trim();
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

/* ===== 14. 案件（法人ITまるごと見積） =====
   公開側の /quote から届く「こういうものが要る」というご希望。
   商品も台数も決まっていないことがある。機種を指定した申込
   （8RENT申込）とは別の入口で、こちらのほうが手前の段階。

   この画面でできるのは、中身を見る・状態を進める・メモを書くまで。
   見積の明細と契約・請求は、まだ作っていない（Phase 2以降）。 */

const DEAL_STATES = ['希望受付', '在庫・調達確認', '見積', '顧客承認', '契約準備',
                     '契約', '支払条件確定', '手配', '完了', 'ご縁なし'];
/* このうち、担当者がボタンで進めてよいのはこれだけ。
     顧客承認・契約準備 … お客様が見積を承認すると自動で進む
     契約から先        … ［見積から契約を作る］→ 契約の画面で進む
   ここを全部ボタンにすると、契約書が無いまま状態だけ「契約」になり、
   支払条件を入れる画面へたどり着けない。 */
const DEAL_STATES_MANUAL = ['希望受付', '在庫・調達確認', '見積', 'ご縁なし'];
const GRADE_LABEL = {
  budget: 'コスト重視（整備済み中心）', standard: '標準', latest: '最新・高性能（新品）', any: 'おまかせ'
};
const SPEC_LABEL = { cpu: 'CPU', memory: 'メモリ', storage: 'ストレージ',
                     screen: '画面', office: 'Office', webcam: 'カメラ・テンキー', numpad: 'テンキー' };

function viewDeals() {
  const open = db.deals.filter(d => d.status === '希望受付').length;
  const doing = db.deals.filter(d => ['在庫・調達確認', '見積', '顧客承認'].includes(d.status)).length;
  return `<h1>案件</h1>
    <p class="sub" style="margin:8px 0 15px">公開サイトの<strong>「法人ITまるごと見積」</strong>（/quote）から届いたご希望です。
      商品も台数も決まっていないことがあります。<br>
      <strong>この時点では在庫を押さえていませんし、お支払いも発生していません。</strong>
      中身を見て、購入・レンタル・組み合わせのどれにするかを決めてから、お見積りをお送りしてください。<br>
      機種を指定した申込は <button class="btn sm ghost" onclick="go('rental')">8RENT申込</button> にあります。</p>
    ${open || doing ? `<div class="card" style="background:#FFF4E5;margin-bottom:15px;display:flex;align-items:center;gap:10px">
      <span class="ms" style="font-size:20px;color:#B26A00">notifications_active</span>
      <div>${[open ? `未対応のご希望が <b>${open}件</b>` : '', doing ? `対応中が <b>${doing}件</b>` : '']
        .filter(Boolean).join('、')} あります。</div>
    </div>` : ''}
    <div style="max-width:260px;margin-bottom:12px">
      <select class="input" id="df-status" onchange="ui.fDeal=this.value;renderDealBody()">
        <option value="">すべての状態</option>
        ${DEAL_STATES.map(s => `<option${ui.fDeal === s ? ' selected' : ''}>${esc(s)}</option>`).join('')}
      </select>
    </div>
    <div id="dealBody">${dealBodyHtml()}</div>`;
}
function renderDealBody() {
  const el = $('dealBody');
  if (el) el.innerHTML = dealBodyHtml();
}
const dealStatusTag = (s) => {
  const cls = { '希望受付': 'few', '在庫・調達確認': 'few', '見積': 'few',
                '顧客承認': 'ok', '契約': 'ok', 'ご縁なし': 'none' }[s] || 'none';
  return `<span class="tag stk-${cls}">${esc(s)}</span>`;
};
/* 購入かレンタルか。公開フォームで選ばずに送られたら、こちらで決めたことにせず
   「まだ決まっていない」とそのまま出す（/quote の画面と同じ言いかたにそろえる）。
   利用期間の「ずっと使う」は購入の希望とは別の設問なので、混ぜて書かない。 */
function wantText(w) {
  const v = (w || '').trim();
  return (!v || v === '未定') ? '購入／レンタル未定（提案してほしい）' : v;
}

/* お客様が書いた規模を1行にする。空の項目は出さない（「—名 —台」を並べない） */
function dealSizeText(d) {
  return [d.purpose, d.headcount ? d.headcount + '名' : '', d.qty ? d.qty + '台' : '',
          d.months == null ? '' : (d.months === 0 ? 'ずっと使う（購入を検討）' : d.months + 'ヶ月'),
          d.start_date ? fmtD(d.start_date) + '開始' : '']
    .filter(Boolean).join('　') || '規模の指定なし';
}
function dealSpecText(d) {
  const sp = d.spec || {};
  return Object.keys(sp).map(k => `${SPEC_LABEL[k] || k} ${sp[k]}`).join('／');
}

function dealBodyHtml() {
  const rows = db.deals.filter(d => !ui.fDeal || d.status === ui.fDeal);
  if (!rows.length) return `<div class="empty" style="margin-top:15px">${
    ui.fDeal ? 'この状態の案件はありません。' : 'まだ案件は届いていません。'}</div>`;
  return `<div class="meta" style="margin:12px 0 4px">${rows.length} 件</div>` + rows.map(d => `
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
        <span class="num meta">#${d.id}</span>
        <b style="font-size:16px">${esc(d.company || d.customer_name)}</b>
        ${d.company ? `<span class="meta">${esc(d.customer_name)} 様</span>` : ''}
        ${dealStatusTag(d.status)}
        <span class="tag">${esc(wantText(d.want))}</span>
        <span class="meta" style="margin-left:auto">${fmtDT(d.created_at)}</span>
      </div>
      ${d.product_code ? `<div style="margin-top:8px;font-size:13.5px">
        ご覧の商品：<a class="c" href="/zaiko/products/${encodeURIComponent(d.product_code)}"
          onclick="go('prod','${esc(d.product_code)}');return false">${esc(d.product_code)}${(prod(d.product_code) || {}).name ? '　' + esc(prod(d.product_code).name) : ''}</a>
        <span class="meta">（お客様のご希望です。購入と決まったわけではありません）</span></div>` : ''}
      <div style="margin-top:8px;font-size:14px">${esc(dealSizeText(d))}</div>
      ${d.grade ? `<div class="meta" style="margin-top:4px">ご希望の方針：${esc(GRADE_LABEL[d.grade] || d.grade)}</div>` : ''}
      ${dealSpecText(d) ? `<div class="meta" style="margin-top:4px">スペック：${esc(dealSpecText(d))}</div>` : ''}
      ${(d.services || []).length ? `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:8px">${
        d.services.map(x => `<span class="tag">${esc(x)}</span>`).join('')}</div>` : ''}
      ${d.message ? `<div class="pre" style="margin-top:10px">${esc(d.message)}</div>` : ''}
      <div class="meta" style="margin-top:10px">
        ${[d.email ? `<a href="mailto:${esc(d.email)}">${esc(d.email)}</a>` : '',
           d.phone ? esc(d.phone) : ''].filter(Boolean).join('　') || '連絡先の記入なし'}
      </div>
      ${d.note ? `<div class="card" style="margin-top:10px;background:var(--n100)">
        <div class="meta" style="margin-bottom:3px">社内メモ${d.actor ? '（' + esc(d.actor) + '）' : ''}</div>
        <div style="font-size:13.5px;white-space:pre-wrap">${esc(d.note)}</div></div>` : ''}
      ${quotesOf(d.id).some(q => q.status === '承認')
          && ['希望受付', '在庫・調達確認', '見積'].includes(d.status)
        ? `<div class="card" style="margin-top:8px;background:var(--l100);border:1px solid var(--l400)">
             <div class="meta">お客様は見積を承認済みですが、案件の状態が「${esc(d.status)}」のままです。
             画面を再読み込みしても直らないときは、担当者へ連絡してください。</div></div>` : ''}
      ${dealQuotesHtml(d)}
      ${dealContractsHtml(d)}
      ${canEdit() ? `<div style="margin-top:12px">
        <div style="display:flex;gap:7px;flex-wrap:wrap">
          ${DEAL_STATES_MANUAL.filter(x => x !== d.status).map(x =>
            `<button class="btn sm ghost" onclick="setDealStatus(${d.id},'${esc(x)}')">${esc(x)}にする</button>`).join('')}
          <button class="btn sm ghost" onclick="sheetDealNote(${d.id})">メモ</button>
        </div>
        <details style="margin-top:8px">
          <summary class="meta" style="cursor:pointer">状態を手で直す（ふだんは使いません）</summary>
          <div class="meta" style="margin:6px 0">
            <b>顧客承認・契約準備</b>は、お客様が見積を承認すると自動で進みます。
            <b>契約から先</b>は、上の［見積から契約を作る］で契約書を作ってから、契約の画面で進めます。
            ここのボタンは状態だけを書き換えるので、契約書のないまま先へ進んでしまいます。
          </div>
          <div style="display:flex;gap:7px;flex-wrap:wrap">
            ${DEAL_STATES.filter(x => x !== d.status && !DEAL_STATES_MANUAL.includes(x)).map(x =>
              `<button class="btn sm ghost" onclick="setDealStatus(${d.id},'${esc(x)}')">${esc(x)}にする</button>`).join('')}
          </div>
        </details>
      </div>` : ''}
    </div>`).join('');
}

/* ================================================================
   見積（Phase 2）

   案件1件に、版（rev）を持つ見積をぶら下げる。
     ・提示済みの見積は直せない。直すときは［複製して新しい版］
     ・新しい版を提示すると、前の提示済みの版は自動で失効する
       （お客様が古いURLから承認する事故を防ぐため）
     ・明細はそのときの内容を写して持つので、商品マスタを直しても見積は変わらない
     ・顧客の［この内容で進める］は契約ではない。在庫はここでは動かさない
   ================================================================ */
const QUOTE_KINDS = [
  ['sale',            '販売（機器）',        'one_time'],
  ['rental',          'レンタル（機器）',    'monthly'],
  ['setup',           '初期設定費',          'one_time'],
  ['kitting',         'キッティング費',      'one_time'],
  ['install',         '現地設置・配線費',    'one_time'],
  ['network',         'ネットワーク構築費',  'one_time'],
  ['service_monthly', '月額サービス',        'monthly'],
  ['training',        'AI・Office研修',      'one_time'],
  ['other',           'その他',              'one_time']
];
const kindLabel = (k) => (QUOTE_KINDS.find(x => x[0] === k) || [])[1] || k;
const QUOTE_STATE_CLASS = { '作成中': 'act', '提示済み': 'st-在庫', '承認': 'st-在庫',
                            '相談中': 'act', '失効': 'st-廃棄', '取消': 'st-廃棄' };

const quotesOf = (dealId) => db.quotes.filter(q => q.deal_id === dealId).sort((a, b) => b.rev - a.rev);
const quoteOf = (id) => db.quotes.find(q => q.id === id) || null;
const qItemsOf = (id) => db.qItems.filter(x => x.quote_id === id).sort((a, b) => (a.sort_no - b.sort_no) || (a.id - b.id));
const qTotalOf = (id) => db.qTotals.find(x => x.quote_id === id) || null;
const quoteNo = (q) => 'Q-' + String(q.deal_id).padStart(5, '0') + '-' + q.rev;
const quoteUrl = (q) => location.origin + '/q/' + (q.token || '');

/* 案件カードに出す見積の一覧 */
function dealQuotesHtml(d) {
  const qs = quotesOf(d.id);
  return `<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--rule)">
    <div class="meta" style="margin-bottom:6px">見積</div>
    ${qs.length ? qs.map(q => {
      const t = qTotalOf(q.id) || {};
      return `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
        <a class="c" href="/zaiko/quotes/${q.id}" onclick="go('quote',${q.id});return false">${esc(quoteNo(q))}</a>
        <span class="tag ${QUOTE_STATE_CLASS[q.status] || 'act'}">${esc(q.status)}</span>
        <span class="meta">初期 ${yen(t.initial_total || 0)}${
          t.monthly_total ? ' ／ 月額 ' + yen(t.monthly_total) + (t.months ? ' ×' + t.months + 'ヶ月' : '') : ''}</span>
        ${q.valid_until ? `<span class="meta">期限 ${esc(q.valid_until)}</span>` : ''}
      </div>`;
    }).join('') : '<div class="meta" style="margin-bottom:6px">まだ見積はありません。</div>'}
    ${canEdit() ? `<button class="btn sm ghost" onclick="createQuote(${d.id})">見積を作る</button>` : ''}
  </div>`;
}

async function createQuote(dealId, fromId) {
  const { data, error } = await sb.rpc('inv_quote_create', {
    p_deal_id: dealId, p_title: null, p_from: fromId || null
  });
  if (error) { toast(error.message || '見積を作れませんでした'); return; }
  await loadAll();
  go('quote', data.id);
  toast(fromId ? '複製して新しい版を作りました' : '見積を作りました');
}

/* ---- 見積の画面 ---- */
function viewQuote() {
  const q = quoteOf(ui.quoteId);
  if (!q) return `<div class="empty" style="margin-top:20px">見積が見つかりません。
    <button class="btn sm ghost" onclick="go('deals')">案件一覧へ</button></div>`;
  const d = db.deals.find(x => x.id === q.deal_id) || {};
  const items = qItemsOf(q.id);
  const t = qTotalOf(q.id) || {};
  const editable = canEdit() && q.status === '作成中';
  const tax = Number(q.tax_rate || 10);

  return `
  <div class="head">
    <div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <h1 class="num">${esc(quoteNo(q))}</h1>
        <span class="tag ${QUOTE_STATE_CLASS[q.status] || 'act'} big">${esc(q.status)}</span>
        ${q.rev > 1 ? `<span class="meta">第${q.rev}版</span>` : ''}
      </div>
      <div class="meta" style="margin-top:6px">
        案件 <a class="c" href="/zaiko/deals" onclick="go('deals');return false">#${q.deal_id}</a>
        ／ ${esc(d.company || d.customer_name || '')} ${d.company && d.customer_name ? esc(d.customer_name) + ' 様' : ''}
        ${q.presented_at ? '／ 提示 ' + fmtDT(q.presented_at) : ''}
        ${q.decided_at ? '／ お客様の操作 ' + fmtDT(q.decided_at) + '（' + esc(q.decided_by || '') + '）' : ''}
      </div>
    </div>
  </div>

  ${q.status === '提示済み' || q.status === '承認' || q.status === '相談中' ? `
    <div class="card" style="background:var(--l100);border:1px solid var(--l400);margin-bottom:14px">
      <div class="meta" style="margin-bottom:6px">お客様に見せるURL（担当者がメール等でお送りします）</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <code style="font-size:12.5px;word-break:break-all;flex:1 1 320px">${esc(quoteUrl(q))}</code>
        <button class="btn sm" onclick="copyQuoteUrl(${q.id})">顧客URLをコピー</button>
        <a class="btn sm ghost" href="${esc(quoteUrl(q))}" target="_blank" rel="noopener noreferrer">顧客画面を開く</a>
        <button class="btn sm ghost" onclick="window.print()">印刷 / PDF保存</button>
      </div>
      ${q.customer_message ? `<div class="pre" style="margin-top:10px">お客様からのご相談：${esc(q.customer_message)}</div>` : ''}
    </div>` : ''}

  ${q.status === '作成中' ? `<p class="meta" style="margin-bottom:12px">まだお客様には見えていません。
      明細を入れて［お客様に提示する］を押すと、顧客URLができます。</p>`
    : `<p class="meta" style="margin-bottom:12px">この版は提示済みなので編集できません。
      直すときは［複製して新しい版を作る］を押してください（提示すると、この版は自動で失効します）。</p>`}

  <div class="prices" style="margin-bottom:16px">
    <div><div class="lbl">件名</div><div class="v" style="font-size:15px">${esc(q.title || '（未設定）')}</div></div>
    <div><div class="lbl">有効期限</div><div class="v" style="font-size:15px">${esc(q.valid_until || '提示時に14日後')}</div></div>
    <div><div class="lbl">消費税率</div><div class="v">${tax}%</div></div>
    ${editable ? `<button class="btn sm ghost" onclick="sheetQuoteHead(${q.id})">件名・期限・税率</button>` : ''}
  </div>

  <div class="sec">明細<span class="secn">${items.length}件</span></div>
  ${items.length ? `<div class="table-wrap"><table class="t"><thead><tr>
      <th>種類</th><th>品名</th><th>数量</th><th>単価</th><th>期間</th><th>金額（税抜）</th>${editable ? '<th></th>' : ''}
    </tr></thead><tbody>
    ${items.map(x => `<tr>
      <td class="meta">${esc(kindLabel(x.kind))}</td>
      <td><b>${esc(x.name)}</b>${x.spec ? `<div class="meta">${esc(x.spec)}</div>` : ''}${
        x.note ? `<div class="meta">${esc(x.note)}</div>` : ''}</td>
      <td class="num">${x.qty}</td>
      <td class="num">${yen(x.unit_price)}</td>
      <td class="meta">${x.billing === 'monthly' ? (x.months || 1) + 'ヶ月' : '—'}</td>
      <td class="num"><b>${yen(x.amount)}</b>${x.billing === 'monthly' ? '<div class="meta">月額</div>' : ''}</td>
      ${editable ? `<td style="white-space:nowrap">
        <button class="btn sm ghost" onclick="sheetQuoteItem(${q.id},${x.id})">直す</button>
        <button class="btn sm ghost" onclick="deleteQuoteItem(${q.id},${x.id})">消す</button></td>` : ''}
    </tr>`).join('')}
  </tbody></table></div>` : '<div class="empty">明細がまだありません。</div>'}

  ${editable ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
    <button class="btn sm" onclick="sheetQuoteItem(${q.id})">明細を追加</button>
    <button class="btn sm ghost" onclick="sheetQuoteFromProduct(${q.id})">商品から追加</button>
    <button class="btn sm ghost" onclick="quoteFromDeal(${q.id})">案件の希望から作る</button>
  </div>` : ''}

  <div class="prices" style="margin-top:18px">
    <div><div class="lbl">初期費用（税抜）</div><div class="v">${yen(t.initial_total || 0)}</div></div>
    <div><div class="lbl">月額費用（税抜）</div><div class="v">${t.monthly_total ? yen(t.monthly_total) : '—'}</div></div>
    <div><div class="lbl">利用期間</div><div class="v" style="font-size:15px">${t.months ? t.months + 'ヶ月' : '—'}</div></div>
    <div><div class="lbl">期間総額</div><div class="v">${t.monthly_period_total ? yen(t.monthly_period_total) : '—'}</div></div>
    <div><div class="lbl">小計</div><div class="v">${yen(t.subtotal || 0)}</div></div>
    <div><div class="lbl">消費税</div><div class="v">${yen(t.tax || 0)}</div></div>
    <div><div class="lbl">税込総額</div><div class="v plus">${yen(t.total || 0)}</div></div>
  </div>

  ${q.note ? `<div class="sec">お客様向けの但し書き</div><div class="pre">${esc(q.note)}</div>` : ''}
  ${q.internal_note ? `<div class="sec">社内メモ<span class="secn">顧客ページには出ません</span></div>
    <div class="pre legacy">${esc(q.internal_note)}</div>` : ''}

  ${canEdit() ? `<div class="ops" style="max-width:560px;margin-top:20px">
    ${q.status === '作成中' ? `
      <button class="btn pri" onclick="presentQuote(${q.id})" ${items.length ? '' : 'disabled'}>
        <span class="ms">send</span><span class="t">お客様に提示する</span></button>` : ''}
    <button class="btn" onclick="createQuote(${q.deal_id}, ${q.id})">
      <span class="ms">content_copy</span><span class="t">複製して新しい版を作る</span></button>
    ${q.status !== '取消' ? `<button class="btn" onclick="cancelQuote(${q.id})">
      <span class="ms">block</span><span class="t">この見積を取り消す</span></button>` : ''}
  </div>` : ''}
  <p class="meta" style="margin-top:14px">お客様が［この内容で進める］を押しても、契約・決済・機器の確保は行われません。
    案件が「契約準備」に進むだけです。個体の確保は、契約と支払方法が決まってから行います。</p>`;
}

/* ================================================================
   契約（Phase 3-a）
     承認済みの見積から契約を作り、確定 → 支払条件確定 → 後払い社内承認
     まで進める。ここでは在庫を一切動かさない。

     大事なところ：契約・入金・手配は別々の状態として持つ。
       契約が決まった      status
       支払い方が決まった  terms_confirmed_at
       お金が入った        payment_status
       モノを押さえた      fulfillment_status

     請求書払い（後払い）は、入金前でも手配できる。
     「入金されないと在庫を押さえられない」という作りにはしない。
   ================================================================ */
const CONTRACT_STATE_CLASS = { '作成中': 'act', '確定': 'st-在庫', '履行中': 'st-在庫',
                               '完了': 'st-在庫', '取消': 'st-廃棄' };
const PAY_STATE_CLASS = { '未請求': 'act', '発行済み': 'act', '一部入金': 'act',
                          '入金済み': 'st-在庫', '期限超過': 'st-廃棄',
                          '決済失敗': 'st-廃棄', '取消': 'st-廃棄' };
const FUL_STATE_CLASS = { '未手配': 'act', '手配可': 'act', '手配中': 'act',
                          '準備完了': 'st-在庫', '発送済み': 'st-在庫', '貸出中': 'st-貸出中',
                          '完了': 'st-在庫', '返却待ち': 'act', '返却済み': 'st-在庫' };
const PAY_METHODS = ['カード', '請求書払い', '銀行振込'];
const PAY_TIMINGS = ['前払い', '後払い'];
/* よく使う支払条件。選ぶだけで入るようにしておく */
const PAY_TERM_SAMPLES = ['月末締め翌月末払い', '月末締め翌々月末払い', '納品後30日',
                          '前金100%', 'カード決済（即時）'];
/* 案件の進み具合。画面の上に一列で出す */
const DEAL_FLOW = ['希望受付', '見積', '顧客承認', '契約準備', '契約', '支払条件確定', '手配'];

const contractsOf = (dealId) => db.contracts.filter(c => c.deal_id === dealId)
  .sort((a, b) => b.seq - a.seq);
const contractOf = (id) => db.contracts.find(c => c.id === id) || null;
const cItemsOf = (id) => db.cItems.filter(x => x.contract_id === id)
  .sort((a, b) => (a.sort_no - b.sort_no) || (a.id - b.id));
const contractNo = (c) => 'C-' + String(c.deal_id).padStart(5, '0') + '-' + c.seq;

/* 手配してよいか。SQLの inv_contract_can_fulfill と同じ判断を画面でも出す
   （押せない理由をその場に見せるため。実際の手配は Phase 3-c） */
function canFulfill(c) {
  if (!c) return { ok: false, reason: '契約がありません' };
  if (c.status === '取消') return { ok: false, reason: 'この契約は取消です' };
  if (c.status === '作成中') return { ok: false, reason: '契約を確定してください' };
  if (!c.terms_confirmed_at) return { ok: false, reason: '支払条件を確定してください' };
  if (c.payment_timing === '後払い' && !c.credit_approved_at) {
    return { ok: false, reason: '後払いなので、管理者の社内承認が要ります（入金前に手配してよいかの判断です）' };
  }
  if (c.payment_timing === '前払い' && c.payment_status !== '入金済み') {
    return { ok: false, reason: '前払いの契約です。入金が確認できてから手配してください（いまは「' + c.payment_status + '」）' };
  }
  return { ok: true, reason: c.payment_timing === '後払い'
    ? '後払い・社内承認済みなので、入金前でも手配できます' : '入金済みなので手配できます' };
}

/* 案件カードに出す契約の一覧 */
function dealContractsHtml(d) {
  const cs = contractsOf(d.id);
  const approved = quotesOf(d.id).filter(q => q.status === '承認'
    && !db.contracts.some(c => c.quote_id === q.id && c.status !== '取消'));
  // 契約の段まで進んでいる案件では、契約がまだ無くても「次に何をするか」を出す。
  // （状態だけ「契約」にして契約書を作り忘れる、を防ぐ）
  const reached = ['顧客承認', '契約準備', '契約', '支払条件確定', '手配', '完了'].includes(d.status);
  if (!cs.length && !approved.length && !reached) return '';
  return `<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--rule)">
    <div class="meta" style="margin-bottom:6px">契約</div>
    ${cs.map(c => `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
      <a class="c" href="/zaiko/contracts/${c.id}" onclick="go('contract',${c.id});return false">${esc(contractNo(c))}</a>
      <span class="tag ${CONTRACT_STATE_CLASS[c.status] || 'act'}">${esc(c.status)}</span>
      <span class="meta">${esc(c.payment_method || '支払方法まだ')}${
        c.payment_timing ? '（' + esc(c.payment_timing) + '）' : ''}</span>
      <span class="tag ${PAY_STATE_CLASS[c.payment_status] || 'act'}">入金 ${esc(c.payment_status)}</span>
      <span class="tag ${FUL_STATE_CLASS[c.fulfillment_status] || 'act'}">手配 ${esc(c.fulfillment_status)}</span>
      <span class="meta">${yen(c.total || 0)}（税込）</span>
      ${c.start_date ? `<span class="meta">納期 ${esc(c.start_date)}</span>` : ''}
    </div>`).join('')}
    ${cs.length ? `<div class="meta" style="margin-bottom:6px">
      支払方法・支払条件・入金・手配は、上の契約番号をひらいて進めます。</div>` : ''}
    ${canEdit() && approved.length ? `<div class="meta" style="margin-bottom:6px">
        お客様の承認が届いています。ここから契約書を作ってください。</div>
      ${approved.map(q => `<button class="btn sm lime" onclick="createContract(${q.id})">
        ${esc(quoteNo(q))} から契約を作る</button>`).join(' ')}` : ''}
    ${!cs.length && !approved.length ? `<div class="meta">
      まだ契約書はありません。契約書は<b>お客様が承認した見積から作ります</b>
      （見積を提示 → お客様が［この内容で進める］→ ここに［契約を作る］が出ます）。</div>` : ''}
  </div>`;
}

async function createContract(quoteId) {
  const { data, error } = await sb.rpc('inv_contract_create', { p_quote_id: quoteId });
  if (error) { toast(error.message || '契約を作れませんでした'); return; }
  await loadAll();
  go('contract', data.id);
  toast('見積の内容を写して契約を作りました');
}

/* 案件・契約の進み具合を一列で出す */
function flowHtml(dealStatus) {
  const at = DEAL_FLOW.indexOf(dealStatus);
  return `<div class="flow">${DEAL_FLOW.map((s, n) => {
    const cls = at < 0 ? '' : (n < at ? ' done' : (n === at ? ' now' : ''));
    return `<span class="fstep${cls}">${esc(s)}</span>`;
  }).join('<span class="farrow">›</span>')}</div>`;
}

/* ---- 契約の画面 ---- */
/* 契約画面を開いたら、支払期限を過ぎた請求がないか見直す。
   日が変わると結果が変わるので、開いたときに計算しなおす（1契約ぶんだけ） */
let lastRefreshed = null;
async function refreshInvoices(contractId) {
  if (!contractId || lastRefreshed === contractId) return;
  lastRefreshed = contractId;
  const { error } = await sb.rpc('inv_contract_invoices_refresh', { p_contract_id: contractId });
  if (error) return;                       // migration未適用でも画面は動かす
  await loadAll();
  if (ui.screen === 'contract' && ui.contractId === contractId) render();
}

function viewContract() {
  const c = contractOf(ui.contractId);
  if (c && canEdit()) refreshInvoices(c.id);
  if (!c) return `<div class="empty" style="margin-top:20px">契約が見つかりません。
    <button class="btn sm ghost" onclick="go('deals')">案件一覧へ</button></div>`;
  const d = db.deals.find(x => x.id === c.deal_id) || {};
  const items = cItemsOf(c.id);
  const editable = canEdit() && c.status === '作成中';
  const ff = canFulfill(c);
  const needCredit = c.payment_timing === '後払い' && !c.credit_approved_at;

  return `
  <div class="head">
    <div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <h1 class="num">${esc(contractNo(c))}</h1>
        <span class="tag ${CONTRACT_STATE_CLASS[c.status] || 'act'} big">${esc(c.status)}</span>
      </div>
      <div class="meta" style="margin-top:6px">
        案件 <a class="c" href="/zaiko/deals" onclick="go('deals');return false">#${c.deal_id}</a>
        ／ ${esc(c.company || c.customer_name || '')} ${c.company && c.customer_name ? esc(c.customer_name) + ' 様' : ''}
        ${c.quote_id ? `／ <a class="c" href="/zaiko/quotes/${c.quote_id}" onclick="go('quote',${c.quote_id});return false">元の見積</a>` : ''}
        ${c.confirmed_at ? '／ 確定 ' + fmtDT(c.confirmed_at) + '（' + esc(c.confirmed_by || '') + '）' : ''}
      </div>
    </div>
  </div>

  ${flowHtml(d.status)}

  <div class="prices" style="margin-bottom:16px">
    <div><div class="lbl">契約の状態</div><div class="v" style="font-size:15px">${esc(c.status)}</div></div>
    <div><div class="lbl">入金</div><div class="v" style="font-size:15px">${esc(c.payment_status)}</div></div>
    <div><div class="lbl">手配</div><div class="v" style="font-size:15px">${esc(c.fulfillment_status)}</div></div>
    <div><div class="lbl">納期（利用開始）</div><div class="v" style="font-size:15px">${esc(c.start_date || '未定')}</div></div>
  </div>
  <p class="meta" style="margin:-6px 0 16px">契約・入金・手配は別々に進みます。
    契約が決まっていても入金はこれから、ということが普通に起きます（請求書払いなど）。</p>

  <div class="card" style="margin-bottom:16px;${ff.ok ? 'background:var(--l100);border:1px solid var(--l400)' : ''}">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span class="ms">${ff.ok ? 'check_circle' : 'schedule'}</span>
      <b>${ff.ok ? '手配に進めます' : 'まだ手配できません'}</b>
      <span class="meta">${esc(ff.reason)}</span>
    </div>
    <p class="meta" style="margin:8px 0 0">実際に在庫を押さえるのは、下の「手配」で［手配に進む］を押したときだけです。</p>
  </div>

  <div class="sec">件名・日付</div>
  <div class="prices" style="margin-bottom:16px">
    <div><div class="lbl">件名</div><div class="v" style="font-size:15px">${esc(c.title || '（未設定）')}</div></div>
    <div><div class="lbl">契約日</div><div class="v" style="font-size:15px">${esc(c.contract_date || '未設定')}</div></div>
    <div><div class="lbl">利用開始</div><div class="v" style="font-size:15px">${esc(c.start_date || '未設定')}</div></div>
    <div><div class="lbl">利用終了</div><div class="v" style="font-size:15px">${esc(c.end_date || '未設定')}</div></div>
    ${editable ? `<button class="btn sm ghost" onclick="sheetContractHead(${c.id})">件名・日付を直す</button>` : ''}
  </div>

  <div class="sec">支払条件${c.terms_confirmed_at ? '<span class="secn">確定済み</span>' : ''}</div>
  <div class="prices" style="margin-bottom:10px">
    <div><div class="lbl">支払方法</div><div class="v" style="font-size:15px">${esc(c.payment_method || '未設定')}</div></div>
    <div><div class="lbl">前払い / 後払い</div><div class="v" style="font-size:15px">${esc(c.payment_timing || '未設定')}</div></div>
    <div><div class="lbl">支払条件</div><div class="v" style="font-size:15px">${esc(c.payment_terms || '未設定')}</div></div>
    <div><div class="lbl">毎月の請求日</div><div class="v" style="font-size:15px">${c.billing_day ? c.billing_day + '日' : '—'}</div></div>
  </div>
  ${c.terms_confirmed_at
    ? `<p class="meta" style="margin-bottom:16px">${fmtDT(c.terms_confirmed_at)}　${esc(c.terms_confirmed_by || '')} が確定しました。</p>`
    : `<p class="meta" style="margin-bottom:16px">支払条件は、契約が決まったこととは別に確定します。
        ${canEdit() ? '［支払条件を入れる］→［支払条件を確定］の順に進めてください。' : ''}</p>`}
  ${canEdit() && !c.terms_confirmed_at && c.status !== '取消' ? `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
      <button class="btn sm" onclick="sheetContractTerms(${c.id})">支払条件を入れる</button>
      <button class="btn sm ghost" onclick="confirmContractTerms(${c.id})"
        ${c.payment_method && c.payment_timing && c.payment_terms ? '' : 'disabled'}>支払条件を確定</button>
    </div>` : ''}

  ${c.payment_timing === '後払い' ? `
    <div class="card" style="margin-bottom:16px${c.credit_approved_at ? '' : ';border:1px solid #E8A33D'}">
      <div class="sec" style="margin-top:0">後払いの社内承認<span class="secn">管理者だけ</span></div>
      ${c.credit_approved_at
        ? `<div class="meta">${fmtDT(c.credit_approved_at)}　${esc(c.credit_approved_by || '')} が承認しました。
             ${c.credit_note ? '<br>' + esc(c.credit_note) : ''}</div>`
        : `<p class="meta" style="margin:0 0 10px">この契約は<b>後払い</b>です。入金より先にモノを出すことになるので、
             「入金前に手配してよいか」を管理者が判断します。承認があれば、入金前でも手配できます。</p>
           ${canAdmin() ? `<button class="btn sm" onclick="sheetContractCredit(${c.id})"
                ${c.status === '確定' && c.terms_confirmed_at ? '' : 'disabled'}>入金前の手配を承認する</button>
              ${c.status === '確定' && c.terms_confirmed_at ? '' :
                '<div class="meta" style="margin-top:6px">契約と支払条件を確定してから承認できます。</div>'}`
             : '<div class="meta">承認できるのは管理者だけです。管理者に依頼してください。</div>'}`}
    </div>` : ''}

  <div class="sec">請求先<span class="secn">${c.billing_company ? '契約先と別' : '契約先と同じ'}</span></div>
  ${c.billing_company ? `<div class="prices" style="margin-bottom:10px">
      <div><div class="lbl">請求先</div><div class="v" style="font-size:15px">${esc(c.billing_company)}</div></div>
      ${c.billing_department ? `<div><div class="lbl">部署</div><div class="v" style="font-size:15px">${esc(c.billing_department)}</div></div>` : ''}
      ${c.billing_person ? `<div><div class="lbl">ご担当</div><div class="v" style="font-size:15px">${esc(c.billing_person)}</div></div>` : ''}
      ${c.billing_postal_code || c.billing_address ? `<div><div class="lbl">住所</div><div class="v" style="font-size:14px">${
        esc([c.billing_postal_code ? '〒' + c.billing_postal_code : '', c.billing_address].filter(Boolean).join(' '))}</div></div>` : ''}
      ${c.billing_email ? `<div><div class="lbl">請求先メール</div><div class="v" style="font-size:14px">${esc(c.billing_email)}</div></div>` : ''}
    </div>${c.billing_note ? `<div class="pre" style="margin-bottom:10px">${esc(c.billing_note)}</div>` : ''}`
    : `<p class="meta" style="margin-bottom:10px">契約先へそのまま請求します。
        自治体・学校法人・親会社一括請求・経理部指定などで請求先が違うときは、ここに入れてください。</p>`}
  ${canEdit() && c.status !== '取消' && c.status !== '完了'
    ? `<button class="btn sm ghost" style="margin-bottom:16px" onclick="sheetContractBilling(${c.id})">請求先を直す</button>` : ''}

  <div class="sec">明細<span class="secn">${items.length}件</span></div>
  ${items.length ? `<div class="table-wrap"><table class="t"><thead><tr>
      <th>種類</th><th>品名</th><th>数量</th><th>単価</th><th>期間</th><th>金額（税抜）</th><th>手配</th>${editable ? '<th></th>' : ''}
    </tr></thead><tbody>
    ${items.map(x => `<tr>
      <td class="meta">${esc(kindLabel(x.kind))}</td>
      <td><b>${esc(x.name)}</b>${x.spec ? `<div class="meta">${esc(x.spec)}</div>` : ''}${
        x.note ? `<div class="meta">${esc(x.note)}</div>` : ''}</td>
      <td class="num">${x.qty}</td>
      <td class="num">${yen(x.unit_price)}</td>
      <td class="meta">${x.billing === 'monthly' ? (x.months || 1) + 'ヶ月' : '—'}</td>
      <td class="num"><b>${yen(x.amount)}</b>${x.billing === 'monthly' ? '<div class="meta">月額</div>' : ''}</td>
      <td class="meta">${esc(x.fulfillment_status)}${
        x.procure_qty ? `<div class="meta">調達 ${x.procure_qty}台</div>` : ''}${
        x.allocated_qty ? `<div class="meta">確保 ${x.allocated_qty}台</div>` : ''}</td>
      ${editable ? `<td style="white-space:nowrap">
        <button class="btn sm ghost" onclick="sheetContractItem(${c.id},${x.id})">直す</button>
        <button class="btn sm ghost" onclick="deleteContractItem(${c.id},${x.id})">消す</button></td>` : ''}
    </tr>`).join('')}
  </tbody></table></div>` : '<div class="empty">明細がまだありません。</div>'}
  <p class="meta" style="margin-top:8px">手配の状態は明細ごとに持ちます。
    1つの契約の中で「レンタルは割当済み・販売は調達待ち・キッティングは作業待ち」が同時に起きるためです。</p>

  ${editable ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
    <button class="btn sm" onclick="sheetContractItem(${c.id})">明細を追加</button>
  </div>` : ''}

  <div class="prices" style="margin-top:18px">
    <div><div class="lbl">初期費用（税抜）</div><div class="v">${yen(c.initial_total || 0)}</div></div>
    <div><div class="lbl">月額費用（税抜）</div><div class="v">${c.monthly_total ? yen(c.monthly_total) : '—'}</div></div>
    <div><div class="lbl">利用期間</div><div class="v" style="font-size:15px">${c.months ? c.months + 'ヶ月' : '—'}</div></div>
    <div><div class="lbl">期間総額</div><div class="v">${c.monthly_period_total ? yen(c.monthly_period_total) : '—'}</div></div>
    <div><div class="lbl">小計</div><div class="v">${yen(c.subtotal || 0)}</div></div>
    <div><div class="lbl">消費税</div><div class="v">${yen(c.tax || 0)}</div></div>
    <div><div class="lbl">税込総額</div><div class="v plus">${yen(c.total || 0)}</div></div>
  </div>

  ${contractCustomerHtml(c)}

  ${contractFulfillHtml(c)}

  ${contractInvoicesHtml(c)}

  ${c.note ? `<div class="sec">お客様向けの但し書き</div><div class="pre">${esc(c.note)}</div>` : ''}
  ${c.internal_note ? `<div class="sec">社内メモ<span class="secn">顧客には出ません</span></div>
    <div class="pre legacy">${esc(c.internal_note)}</div>` : ''}

  ${canEdit() ? `<div class="ops" style="max-width:560px;margin-top:20px">
    ${c.status === '作成中' ? `<button class="btn pri" onclick="confirmContract(${c.id})" ${items.length ? '' : 'disabled'}>
      <span class="ms">task_alt</span><span class="t">契約を確定する</span></button>` : ''}
    ${c.status !== '取消' ? `<button class="btn" onclick="cancelContract(${c.id})">
      <span class="ms">block</span><span class="t">この契約を取り消す</span></button>` : ''}
  </div>` : ''}
  <p class="meta" style="margin-top:14px">契約を確定しても、<b>機器は確保されません</b>。
    在庫の確保は［手配に進む］を押したときだけ行います。
    ${needCredit ? '後払いなので、その前に管理者の社内承認が要ります。' : ''}</p>`;
}

/* ---- 顧客手続き（Phase 3-d） ----
     担当者が顧客URLを発行し、お客様が /c/:token で
     契約内容・請求先・お届け先・お支払い方法を確認して送り返す。
     お客様が送っても契約は確定しない。担当者が中身を見てから確定する。 */
const contractUrl = (c) => location.origin + '/c/' + (c.public_token || '');
const PAY_ALLOW = ['請求書払い', '銀行振込', 'カード'];

/* 顧客が入れた内容と、社内の確定値がずれていないか */
function methodMismatch(c) {
  if (!c.requested_payment_method || !c.payment_method) return null;
  if (c.requested_payment_method === c.payment_method) return null;
  return 'お客様のご希望は「' + c.requested_payment_method + '」ですが、社内の設定は「'
    + c.payment_method + '」です。どちらで進めるか確認してください。';
}

function contractCustomerHtml(c) {
  const has = !!c.public_token;
  const expired = c.public_token_expires_at && new Date(c.public_token_expires_at) < new Date();
  const mm = methodMismatch(c);

  return `
  <div class="sec">顧客手続き<span class="secn">${c.customer_confirmed_at ? 'お客様の確認ずみ' : (has ? 'URL発行ずみ' : '未発行')}</span></div>

  ${has ? `<div class="card" style="background:var(--l100);border:1px solid var(--l400);margin-bottom:12px">
    <div class="meta" style="margin-bottom:6px">お客様に見せるURL（担当者がメール等でお送りします）</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <code style="font-size:12.5px;word-break:break-all;flex:1 1 320px">${esc(contractUrl(c))}</code>
      ${canEdit() ? `<button class="btn sm" onclick="copyContractUrl(${c.id})">顧客URLをコピー</button>` : ''}
      <a class="btn sm ghost" href="${esc(contractUrl(c))}" target="_blank" rel="noopener noreferrer">顧客画面を開く</a>
      ${canEdit() ? `<button class="btn sm ghost" onclick="sheetContractToken(${c.id}, true)">URLを再発行</button>` : ''}
    </div>
    <div class="meta" style="margin-top:8px">
      有効期限 ${esc((c.public_token_expires_at || '').slice(0, 10) || '—')}
      ${expired ? '（期限切れです。再発行してください）' : ''}
    </div>
  </div>` : `<p class="meta" style="margin-bottom:10px">まだ顧客URLを発行していません。
    発行すると、お客様が契約内容・請求先・お届け先・お支払い方法を確認できるようになります。</p>
    ${canEdit() && c.status !== '取消' ? `<button class="btn sm" style="margin-bottom:12px"
      onclick="sheetContractToken(${c.id})">顧客URLを発行</button>` : ''}`}

  <div class="prices" style="margin-bottom:12px">
    <div><div class="lbl">お客様の確認</div><div class="v" style="font-size:15px">${
      c.customer_confirmed_at ? fmtDT(c.customer_confirmed_at) : 'まだ'}</div>
      ${c.customer_confirmed_by ? `<div class="meta">${esc(c.customer_confirmed_by)} 様</div>` : ''}</div>
    <div><div class="lbl">支払希望</div><div class="v" style="font-size:15px">${
      esc(c.requested_payment_method || '—')}</div>
      ${c.payment_method ? `<div class="meta">社内の設定：${esc(c.payment_method)}</div>` : ''}</div>
    <div><div class="lbl">お届け希望日</div><div class="v" style="font-size:15px">${
      esc(c.desired_delivery_date || '—')}</div></div>
    <div><div class="lbl">顧客ページの支払方法</div><div class="v" style="font-size:14px">${
      (c.allowed_payment_methods || []).length ? esc((c.allowed_payment_methods || []).join('・')) : '未設定'}</div>
      ${canEdit() && c.status !== '取消' ? `<button class="btn sm ghost" style="margin-top:6px"
        onclick="sheetAllowedMethods(${c.id})">選べるものを決める</button>` : ''}</div>
  </div>

  ${mm ? `<div class="card" style="border:1px solid #E8A33D;margin-bottom:12px">
    <b>支払方法が一致していません</b><div class="meta">${esc(mm)}</div></div>` : ''}

  ${c.customer_confirmed_at ? `
    <div class="sec" style="margin-top:14px">お客様が入れた内容<span class="secn">顧客ページから</span></div>
    <div class="table-wrap"><table class="t"><tbody>
      <tr><td style="width:120px" class="meta">請求先</td><td>${
        c.billing_company ? esc([c.billing_company, c.billing_department, c.billing_person].filter(Boolean).join('／'))
          + (c.billing_postal_code || c.billing_address
            ? `<div class="meta">${esc([c.billing_postal_code ? '〒' + c.billing_postal_code : '', c.billing_address].filter(Boolean).join(' '))}</div>` : '')
          + (c.billing_email ? `<div class="meta">${esc(c.billing_email)}</div>` : '')
          + (c.billing_note ? `<div class="meta">${esc(c.billing_note)}</div>` : '')
        : '<span class="meta">契約先と同じ</span>'}</td></tr>
      <tr><td class="meta">お届け先</td><td>${
        c.shipping_company ? esc([c.shipping_company, c.shipping_department, c.shipping_person].filter(Boolean).join('／'))
          + (c.shipping_postal_code || c.shipping_address
            ? `<div class="meta">${esc([c.shipping_postal_code ? '〒' + c.shipping_postal_code : '', c.shipping_address].filter(Boolean).join(' '))}</div>` : '')
          + (c.shipping_phone ? `<div class="meta">${esc(c.shipping_phone)}</div>` : '')
          + (c.shipping_note ? `<div class="meta">${esc(c.shipping_note)}</div>` : '')
        : '<span class="meta">契約先と同じ</span>'}</td></tr>
      ${c.customer_message ? `<tr><td class="meta">ご連絡事項</td><td class="pre">${esc(c.customer_message)}</td></tr>` : ''}
    </tbody></table></div>
    ${c.status === '作成中' || c.status === '確定' ? `<p class="meta" style="margin-top:8px">
      お客様は「この内容で進めたい」と送ってきています。
      <b>契約はまだ確定していません。</b>中身を確認して［契約を確定する］を押してください。</p>` : ''}` : ''}`;
}

function copyContractUrl(id) {
  const c = contractOf(id); if (!c || !c.public_token) return;
  const url = contractUrl(c);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => toast('顧客URLをコピーしました'),
                                            () => toast('コピーできませんでした：' + url));
  } else {
    toast(url);
  }
}

function sheetContractToken(id, again) {
  const c = contractOf(id); if (!c) return;
  openSheet({
    title: again ? '顧客URLを再発行する' : '顧客URLを発行する', subject: contractNo(c),
    cta: again ? '再発行する' : '発行する',
    hint: again
      ? `<strong>いまのURLは使えなくなります。</strong>すでにお送りしているURLをお客様が開くと
         「このURLは無効になっています」と出ます。新しいURLをお送りください。`
      : `お客様が契約内容・請求先・お届け先・お支払い方法を確認できるURLを作ります。
         <strong>お客様が送信しても契約は確定しません。</strong>担当者が中身を見てから確定します。`,
    body: `<label class="field" style="max-width:220px"><span>有効期限（何日間）</span>
        <input class="input num" type="number" id="ctDays" min="1" max="365" value="60"></label>
      <p class="meta" style="margin-top:10px">メールでお送りするのは担当者の操作です（自動送信はしません）。</p>
      ${(c.allowed_payment_methods || []).length ? '' :
        '<div class="meta" style="margin-top:8px">顧客ページで選べる支払方法がまだ未設定です。' +
        '未設定のままだと、お客様の画面には「お支払い方法は担当者からご案内します」とだけ出ます。</div>'}`,
    run: async () => {
      const { error } = await sb.rpc('inv_contract_token_issue',
        { p_id: id, p_days: numField('ctDays') || 60 });
      if (error) { toast(error.message || '発行できませんでした'); return; }
      await loadAll(); render();
      toast(again ? '再発行しました。新しいURLをお送りください' : '発行しました。顧客URLをコピーしてお送りください');
      copyContractUrl(id);
    }
  });
}

function sheetAllowedMethods(id) {
  const c = contractOf(id); if (!c) return;
  const now = c.allowed_payment_methods || [];
  openSheet({
    title: '顧客ページで選べる支払方法', subject: contractNo(c), cta: '保存',
    hint: `ここで選んだものだけが、お客様の画面に出ます。
      <strong>3つとも無条件に出すことはしません。</strong>
      カードは Stripe をまだつないでいないので、「契約確定後にURLをご案内します」と出るだけです。`,
    body: PAY_ALLOW.map((m, n) => `<label class="bchk" style="display:block;margin-bottom:8px">
        <input type="checkbox" id="am${n}" ${now.includes(m) ? 'checked' : ''}> ${esc(m)}</label>`).join('')
      + `<p class="meta" style="margin-top:10px">お客様が選んだものは「ご希望」として記録され、
        社内の確定値（支払条件）は担当者が別に決めます。</p>`,
    run: async () => {
      const picked = PAY_ALLOW.filter((m, n) => ($('am' + n) || {}).checked);
      const { error } = await sb.rpc('inv_contract_allowed_methods_set',
        { p_id: id, p_methods: picked });
      if (error) { toast(error.message || '保存できませんでした'); return; }
      await loadAll(); render();
      toast(picked.length ? picked.join('・') + ' を出します' : '顧客ページでは選べなくなりました');
    }
  });
}

/* ---- 手配（Phase 3-c） ----
     ［手配に進む］を押したときだけ、実在庫を押さえる。
     販売は販売予約、レンタルはレンタル申込 → 個体割当。
     足りないぶんは「調達待ち」として残し、仮の個体は作らない。
     ここで完成するのは受注から手配・在庫確保まで。発送・納品・返却はまだ。 */
const ITEM_FUL_CLASS = { '手配不要': 'act', '未手配': 'act', '手配中': 'act',
                         '確保済み': 'st-在庫', '調達待ち': 'st-廃棄',
                         '発送済み': 'st-在庫', '貸出中': 'st-貸出中',
                         '返却済み': 'st-在庫', '完了': 'st-在庫' };

const fulLinesOf = (contractId) => db.fulLines.filter(x => x.contract_id === contractId)
  .sort((a, b) => (a.sort_no - b.sort_no) || (a.contract_item_id - b.contract_item_id));
const fulItemsOf = (contractItemId) => db.fulfillments
  .filter(x => x.contract_item_id === contractItemId && x.status !== '解除');

/* 契約画面の「手配」欄 */
function contractFulfillHtml(c) {
  const lines = fulLinesOf(c.id);
  const stock = lines.filter(x => x.kind === 'sale' || x.kind === 'rental');
  const ff = canFulfill(c);
  const got = stock.reduce((a, x) => a + (x.allocated_qty || 0), 0);
  const short = stock.reduce((a, x) => a + (x.procure_qty || 0), 0);
  const shipped = ['発送済み', '貸出中', '完了', '返却待ち', '返却済み'].includes(c.fulfillment_status);
  const started = got > 0 || stock.some(x => x.fulfillment_status === '調達待ち');

  return `
  <div class="sec">手配<span class="secn">${stock.length ? stock.length + '明細' : '在庫を伴う明細なし'}</span></div>
  <div class="prices" style="margin-bottom:12px">
    <div><div class="lbl">手配状態</div><div class="v" style="font-size:15px">${esc(c.fulfillment_status)}</div></div>
    <div><div class="lbl">自社在庫から確保</div><div class="v">${got}台</div></div>
    <div><div class="lbl">調達待ち</div><div class="v${short ? ' plus' : ''}">${short}台</div></div>
  </div>

  ${stock.length ? `<div class="table-wrap"><table class="t"><thead><tr>
      <th>明細</th><th>必要</th><th>確保</th><th>調達待ち</th><th>状態</th><th>押さえた個体</th>
    </tr></thead><tbody>
    ${lines.map(x => {
      const ids = fulItemsOf(x.contract_item_id);
      return `<tr${x.fulfillment_status === '調達待ち' ? ' class="warn"' : ''}>
        <td><b>${esc(x.name)}</b><div class="meta">${esc(kindLabel(x.kind))}${
          x.product_code ? '／' + esc(x.product_code) : '／商品コードなし'}</div></td>
        <td class="num">${x.kind === 'sale' || x.kind === 'rental' ? x.qty + '台' : '—'}</td>
        <td class="num">${x.kind === 'sale' || x.kind === 'rental' ? x.allocated_qty + '台' : '—'}</td>
        <td class="num">${x.procure_qty ? '<b>' + x.procure_qty + '台</b>' : '—'}</td>
        <td><span class="tag ${ITEM_FUL_CLASS[x.fulfillment_status] || 'act'}">${esc(x.fulfillment_status)}</span>
          ${x.rental_request_id ? `<div class="meta">申込 #${x.rental_request_id}</div>` : ''}</td>
        <td class="meta" style="font-size:11.5px">${ids.length
          ? ids.slice(0, 6).map(f => esc(f.item_id)).join('、') + (ids.length > 6 ? ` ほか${ids.length - 6}台` : '')
          : '—'}</td>
      </tr>`;
    }).join('')}
  </tbody></table></div>` : '<div class="empty">在庫を伴う明細がありません（作業・月額サービスだけの契約です）。</div>'}

  ${short ? `<p class="meta" style="margin-top:8px"><b>${short}台が調達待ちです。</b>
    仕入れて在庫が増えたら［不足分を手配］を押してください。
    すでに確保できている個体には触りません。</p>` : ''}

  ${canEdit() && c.status !== '取消' && !shipped ? `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
      ${!started ? `<button class="btn sm pri" onclick="sheetFulfill(${c.id})" ${ff.ok ? '' : 'disabled'}>手配に進む</button>` : ''}
      ${short ? `<button class="btn sm" onclick="sheetFulfill(${c.id}, true)" ${ff.ok ? '' : 'disabled'}>不足分を手配</button>` : ''}
      ${got ? `<button class="btn sm ghost" onclick="releaseFulfill(${c.id})">確保した個体を戻す</button>` : ''}
    </div>
    ${ff.ok ? '' : `<div class="meta" style="margin-top:6px">${esc(ff.reason)}</div>`}` : ''}
  ${shipped ? `<p class="meta" style="margin-top:8px">発送以降に進んでいるので、ここからは在庫を自動で戻しません。
    返品・返却は実物を確認してから個体ごとに操作してください。</p>` : ''}
  <p class="meta" style="margin-top:8px">ここで完成しているのは<b>受注から手配・在庫確保まで</b>です。
    発送・納品・返却の管理はまだ作っていません。</p>`;
}

function sheetFulfill(contractId, onlyShort) {
  const c = contractOf(contractId); if (!c) return;
  const lines = fulLinesOf(contractId).filter(x => x.kind === 'sale' || x.kind === 'rental');
  const target = onlyShort ? lines.filter(x => x.procure_qty > 0) : lines;
  openSheet({
    title: onlyShort ? '不足分を手配する' : '手配を開始する',
    subject: contractNo(c), cta: onlyShort ? '不足分を手配する' : '手配を開始する',
    hint: `<strong>ここで実在庫を押さえます。</strong>
      販売の商品は「販売予約」、レンタルの商品は「予約中」になります。
      足りないぶんは<strong>「調達待ち」として残します</strong>（仮の在庫は作りません）。
      ${onlyShort ? 'すでに確保できている個体には触りません。' : ''}`,
    body: `${target.length ? `<div class="table-wrap"><table class="t"><thead><tr>
        <th>明細</th><th>必要</th><th>確保済み</th><th>これから</th>
      </tr></thead><tbody>
      ${target.map(x => `<tr>
        <td><b>${esc(x.name)}</b><div class="meta">${esc(kindLabel(x.kind))}</div></td>
        <td class="num">${x.qty}台</td>
        <td class="num">${x.allocated_qty}台</td>
        <td class="num"><b>${x.procure_qty}台</b></td>
      </tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">手配するものがありません。</div>'}
      <p class="meta" style="margin-top:10px">在庫が足りないときは、取れたぶんだけ確保して残りを調達待ちにします。
        取れた個体を取り消すことはしません。</p>`,
    run: async () => {
      const { data, error } = await sb.rpc('inv_contract_fulfill_start',
        { p_contract_id: contractId, p_only_short: !!onlyShort });
      if (error) { toast(error.message || '手配できませんでした'); return; }
      await loadAll(); render();
      if (data && data.ok === false) { toast(data.reason || '手配できませんでした'); return; }
      const stopped = (data && data.stopped) || [];
      if (stopped.length) { toast(stopped.join(' ／ ')); return; }
      toast((data && data.allocated ? data.allocated + '台を確保しました' : '新しく確保するものはありませんでした')
        + (data && data.short ? '／' + data.short + '台は調達待ちです' : ''));
    }
  });
}

function releaseFulfill(contractId) {
  const c = contractOf(contractId); if (!c) return;
  openSheet({
    title: '確保した個体を戻す', subject: contractNo(c), cta: '在庫へ戻す',
    hint: `<strong>この契約が押さえた個体だけ</strong>を在庫へ戻します。
      同じ商品でも、ほかの案件が押さえている個体には触りません。
      発送済み・売却済みの個体は戻しません（返品・返却の手続きが要ります）。`,
    body: `<label class="field"><span>理由（履歴に残ります）</span>
        <input class="input" id="frReason" placeholder="例）納期変更のため一度戻す"></label>`,
    run: async () => {
      const { data, error } = await sb.rpc('inv_contract_fulfill_release',
        { p_contract_id: contractId, p_reason: ($('frReason') || {}).value || null });
      if (error) { toast(error.message || '戻せませんでした'); return; }
      await loadAll(); render();
      toast(((data && data.released) || 0) + '台を在庫へ戻しました'
        + (data && data.reason ? '／' + data.reason : ''));
    }
  });
}

/* ---- 請求と入金（Phase 3-b） ----
     契約から請求の予定を作り、担当者が確認して発行し、入金を記録する。
     状態は重ならないように整理してある：
       下書き → 発行待ち → 発行済み → 一部入金 → 入金済み
                              └→ 期限超過      └→ 取消
     「発行済み」が入金待ちを含む（請求済みと入金待ちは分けない）。
     ここでも在庫は動かさない。 */
const INVOICE_STATE_CLASS = { '下書き': 'act', '発行待ち': 'act', '発行済み': 'st-在庫',
                              '一部入金': 'act', '入金済み': 'st-在庫',
                              '期限超過': 'st-廃棄', '取消': 'st-廃棄' };
const INVOICE_KIND = { initial: '初期費用', monthly: '月額', manual: '個別' };
const PAY_WAYS = ['銀行振込', '請求書払い', 'カード', '相殺', 'その他'];

const invoicesOf = (contractId) => db.invoices.filter(v => v.contract_id === contractId)
  .sort((a, b) => (a.kind === b.kind ? a.sequence_no - b.sequence_no
                   : (a.kind === 'initial' ? -1 : b.kind === 'initial' ? 1 : 0)) || (a.id - b.id));
const invoiceOf = (id) => db.invoices.find(v => v.id === id) || null;
const paymentsOf = (invoiceId) => db.payments.filter(x => x.invoice_id === invoiceId)
  .sort((a, b) => String(a.paid_on).localeCompare(String(b.paid_on)) || (a.id - b.id));
/* 請求の期間の見出し。2026/11 月額 のように出す */
function invoiceLabel(v) {
  if (v.kind === 'monthly' && v.period_start) {
    return String(v.period_start).slice(0, 7).replace('-', '/') + ' 月額';
  }
  if (v.kind === 'initial') return '初期費用';
  return v.note || '個別の請求';
}

/* 契約画面の「請求」欄 */
function contractInvoicesHtml(c) {
  const vs = invoicesOf(c.id);
  const canMake = c.status === '確定' && c.terms_confirmed_at;
  const over = vs.filter(v => (v.over_paid || 0) > 0);
  return `
  <div class="sec">請求<span class="secn">${vs.length}件</span></div>
  ${c.payment_method === 'カード' ? `<p class="meta" style="margin:0 0 10px">
    カード決済の自動連携（Stripe）はまだつないでいません。請求の予定は作れますが、
    <b>入金済みへの自動更新はしません</b>。いまは入金を手で記録してください。</p>` : ''}
  ${over.length ? `<div class="card" style="border:1px solid #E8A33D;margin-bottom:10px">
    <b>過入金あり</b>
    <div class="meta">${over.map(v => esc(invoiceLabel(v)) + '：' + yen(v.over_paid) + ' 多く入っています').join('<br>')}</div>
    <div class="meta" style="margin-top:4px">返金するか、次回の請求で相殺するかを決めてください。自動では消しません。</div>
  </div>` : ''}
  ${vs.length ? `<div class="table-wrap"><table class="t"><thead><tr>
      <th>請求</th><th>請求番号</th><th>金額（税込）</th><th>請求予定 / 発行</th><th>支払期限</th>
      <th>入金</th><th>状態</th>${canEdit() ? '<th></th>' : ''}
    </tr></thead><tbody>
    ${vs.map(v => `<tr${v.status === '期限超過' ? ' class="warn"' : ''}>
      <td><b>${esc(invoiceLabel(v))}</b>${v.period_start ? `<div class="meta">${
        esc(v.period_start)} 〜 ${esc(v.period_end || '')}</div>` : ''}</td>
      <td class="meta">${v.invoice_no ? esc(v.invoice_no) : '（発行前）'}</td>
      <td class="num"><b>${yen(v.amount_incl)}</b><div class="meta">税 ${yen(v.tax)}</div></td>
      <td class="meta">${esc(v.scheduled_issue_date || '—')}${
        v.issued_at ? `<div class="meta">発行 ${fmtDT(v.issued_at)}</div>` : ''}</td>
      <td class="meta">${esc(v.due_date || '—')}</td>
      <td class="num">${v.paid_total ? yen(v.paid_total) : '—'}${
        v.remaining ? `<div class="meta">残 ${yen(v.remaining)}</div>` : ''}${
        v.over_paid ? `<div class="meta">過入金 ${yen(v.over_paid)}</div>` : ''}</td>
      <td><span class="tag ${INVOICE_STATE_CLASS[v.status] || 'act'}">${esc(v.status)}</span></td>
      ${canEdit() ? `<td style="white-space:nowrap">
        ${v.status === '下書き' ? `<button class="btn sm ghost" onclick="sheetInvoiceEdit(${v.id})">直す</button>
          <button class="btn sm" onclick="readyInvoice(${v.id})">確認した</button>` : ''}
        ${v.status === '発行待ち' ? `<button class="btn sm ghost" onclick="readyInvoice(${v.id},true)">下書きに戻す</button>
          <button class="btn sm" onclick="sheetInvoiceIssue(${v.id})">発行する</button>` : ''}
        ${['発行済み', '一部入金', '期限超過'].includes(v.status)
          ? `<button class="btn sm" onclick="sheetPayment(${v.id})">入金を記録</button>` : ''}
        ${v.status === '入金済み' ? `<button class="btn sm ghost" onclick="sheetPayment(${v.id})">入金を記録</button>` : ''}
        ${['下書き', '発行待ち', '発行済み'].includes(v.status) && !v.paid_total
          ? `<button class="btn sm ghost" onclick="cancelInvoice(${v.id})">取消</button>` : ''}
      </td>` : ''}
    </tr>
    ${paymentsOf(v.id).length ? `<tr class="qty"><td colspan="${canEdit() ? 8 : 7}">
      <div class="meta">入金の記録</div>
      ${paymentsOf(v.id).map(pm => `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <span class="meta">${esc(pm.paid_on)}</span>
        <b>${yen(pm.amount)}</b>
        <span class="meta">${esc(pm.method || '')}${pm.reference ? '／' + esc(pm.reference) : ''}${
          pm.note ? '／' + esc(pm.note) : ''}</span>
        ${canEdit() ? `<button class="btn sm ghost" onclick="deletePayment(${pm.id})">消す</button>` : ''}
      </div>`).join('')}
    </td></tr>` : ''}`).join('')}
  </tbody></table></div>`
    : `<div class="empty">まだ請求はありません。${canMake
        ? '［請求の予定を作る］で、初期費用と月額ぶんの下書きをまとめて作れます。'
        : '契約と支払条件を確定すると作れるようになります。'}</div>`}

  ${canEdit() && c.status !== '取消' ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
    <button class="btn sm" onclick="generateInvoices(${c.id})" ${canMake ? '' : 'disabled'}>請求の予定を作る</button>
    <button class="btn sm ghost" onclick="sheetInvoiceAdd(${c.id})" ${c.status === '確定' ? '' : 'disabled'}>請求を1本足す</button>
  </div>
  ${canMake ? '' : '<div class="meta" style="margin-top:6px">契約と支払条件を確定してから作れます。</div>'}` : ''}
  <p class="meta" style="margin-top:8px">請求の予定は<b>下書きで作ります。自動では発行しません。</b>
    中身を確認して［確認した］→［発行する］の順に進めると、そこではじめて正式な請求番号が付きます。
    発行したあとは金額・日付を直せません（取り消して作り直します）。</p>`;
}

async function generateInvoices(contractId) {
  const { data, error } = await sb.rpc('inv_contract_invoices_generate', { p_contract_id: contractId });
  if (error) { toast(error.message || '作れませんでした'); return; }
  await loadAll(); render();
  const made = (data && data.created) || 0;
  const skip = (data && data.skipped) || 0;
  toast(made ? made + '本の下書きを作りました' + (skip ? '（' + skip + '本はすでにあります）' : '')
             : 'すでに全部そろっています（' + skip + '本）');
}

function sheetInvoiceAdd(contractId) {
  const c = contractOf(contractId); if (!c) return;
  openSheet({
    title: '請求を1本足す', subject: contractNo(c), cta: '作る',
    hint: '追加費用など、予定に入っていない請求を手で足します。下書きで作られます。',
    body: `<label class="field" style="margin-bottom:10px"><span>請求の名前</span>
        <input class="input" id="viTitle" placeholder="例）追加キッティング 3台ぶん"></label>
      <label class="field" style="margin-bottom:10px"><span>金額（税抜）</span>
        <input class="input num" type="number" id="viAmount" min="0" step="100" value="0"></label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field" style="margin-bottom:10px"><span>請求予定日</span>
          <input class="input" type="date" id="viIssue"></label>
        <label class="field" style="margin-bottom:10px"><span>支払期限</span>
          <input class="input" type="date" id="viDue"></label>
      </div>
      <label class="bchk"><input type="checkbox" id="viTax" checked> 課税対象</label>`,
    validate: () => {
      if (!(($('viTitle') || {}).value || '').trim()) { toast('請求の名前を入れてください'); return false; }
      return true;
    },
    run: async () => {
      const { error } = await sb.rpc('inv_contract_invoice_add', {
        p_contract_id: contractId,
        p_title: ($('viTitle') || {}).value,
        p_amount_excl: numField('viAmount') || 0,
        p_taxable: !!($('viTax') || {}).checked,
        p_issue: ($('viIssue') || {}).value || null,
        p_due: ($('viDue') || {}).value || null
      });
      if (error) { toast(error.message || '作れませんでした'); return; }
      await loadAll(); render(); toast('請求を1本足しました（下書き）');
    }
  });
}

function sheetInvoiceEdit(id) {
  const v = invoiceOf(id); if (!v) return;
  openSheet({
    title: '請求を直す', subject: invoiceLabel(v), cta: '保存',
    hint: '直せるのは<strong>下書き・発行待ちのあいだ</strong>だけです。発行したあとは取り消して作り直します。',
    body: `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field" style="margin-bottom:10px"><span>請求予定日</span>
          <input class="input" type="date" id="veIssue" value="${esc(v.scheduled_issue_date || '')}"></label>
        <label class="field" style="margin-bottom:10px"><span>支払期限</span>
          <input class="input" type="date" id="veDue" value="${esc(v.due_date || '')}"></label>
      </div>
      <label class="field" style="margin-bottom:10px"><span>金額（税抜）</span>
        <input class="input num" type="number" id="veAmount" min="0" step="100" value="${esc(String(v.amount_excl || 0))}"></label>
      <label class="field" style="margin-bottom:10px"><span>お客様向けの但し書き</span>
        <input class="input" id="veNote" value="${esc(v.note || '')}"></label>
      <label class="field"><span>社内メモ</span>
        <textarea class="input" id="veInt" rows="2">${esc(v.internal_note || '')}</textarea></label>`,
    run: async () => {
      const { error } = await sb.rpc('inv_contract_invoice_set', {
        p_id: id,
        p_issue: ($('veIssue') || {}).value || null,
        p_due: ($('veDue') || {}).value || null,
        p_amount_excl: numField('veAmount'),
        p_taxable: (v.tax || 0) > 0 || (v.amount_excl || 0) === 0,
        p_note: ($('veNote') || {}).value,
        p_internal: ($('veInt') || {}).value
      });
      if (error) { toast(error.message || '保存できませんでした'); return; }
      await loadAll(); render(); toast('保存しました');
    }
  });
}

async function readyInvoice(id, back) {
  const { error } = await sb.rpc('inv_contract_invoice_ready', { p_id: id, p_back: !!back });
  if (error) { toast(error.message || '変えられませんでした'); return; }
  await loadAll(); render();
  toast(back ? '下書きに戻しました' : '発行待ちにしました。［発行する］で請求番号が付きます');
}

function sheetInvoiceIssue(id) {
  const v = invoiceOf(id); if (!v) return;
  openSheet({
    title: '請求を発行する', subject: invoiceLabel(v), cta: '発行する',
    hint: `発行すると<strong>正式な請求番号が付きます</strong>。
      そのあとは金額・日付を直せません（取り消して作り直します）。`,
    body: `<div class="prices" style="margin-bottom:10px">
        <div><div class="lbl">金額（税込）</div><div class="v plus">${yen(v.amount_incl)}</div></div>
        <div><div class="lbl">うち消費税</div><div class="v">${yen(v.tax)}</div></div>
        <div><div class="lbl">支払期限</div><div class="v" style="font-size:15px">${esc(v.due_date || '—')}</div></div>
      </div>
      <label class="field"><span>発行日</span>
        <input class="input" type="date" id="vsOn" value="${esc(new Date().toISOString().slice(0, 10))}"></label>
      <p class="meta" style="margin-top:8px">請求書そのものの送付は、これまでどおり担当者の作業です（自動送信はしません）。</p>`,
    run: async () => {
      const { data, error } = await sb.rpc('inv_contract_invoice_issue',
        { p_id: id, p_on: ($('vsOn') || {}).value || null });
      if (error) { toast(error.message || '発行できませんでした'); return; }
      await loadAll(); render();
      toast('発行しました：' + ((data && data.invoice_no) || ''));
    }
  });
}

function sheetPayment(invoiceId) {
  const v = invoiceOf(invoiceId); if (!v) return;
  const rest = v.remaining || 0;
  openSheet({
    title: '入金を記録する', subject: invoiceLabel(v), cta: '記録する',
    hint: `1つの請求に<strong>何回でも</strong>記録できます（一部入金）。
      入金合計が請求額に届けば「入金済み」になります。返金はマイナスで入れてください。`,
    body: `<div class="prices" style="margin-bottom:10px">
        <div><div class="lbl">請求額（税込）</div><div class="v">${yen(v.amount_incl)}</div></div>
        <div><div class="lbl">入金済み</div><div class="v">${yen(v.paid_total || 0)}</div></div>
        <div><div class="lbl">残額</div><div class="v plus">${yen(rest)}</div></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field" style="margin-bottom:10px"><span>入金日</span>
          <input class="input" type="date" id="pmOn" value="${esc(new Date().toISOString().slice(0, 10))}"></label>
        <label class="field" style="margin-bottom:10px"><span>金額</span>
          <input class="input num" type="number" id="pmAmount" step="1" value="${esc(String(rest || v.amount_incl))}"></label>
      </div>
      <label class="field" style="margin-bottom:10px"><span>支払方法</span>
        <select class="input" id="pmMethod">
          ${PAY_WAYS.map(m => `<option${m === (v.kind === 'manual' ? '銀行振込' : '銀行振込') ? ' selected' : ''}>${esc(m)}</option>`).join('')}
        </select></label>
      <label class="field" style="margin-bottom:10px"><span>振込名義 / 参照番号</span>
        <input class="input" id="pmRef" placeholder="例）ケイヤクテスト（カ"></label>
      <label class="field"><span>メモ</span>
        <input class="input" id="pmNote" placeholder="例）手数料は先方負担"></label>`,
    validate: () => {
      if (!numField('pmAmount')) { toast('入金額を入れてください'); return false; }
      return true;
    },
    run: async () => {
      const { data, error } = await sb.rpc('inv_contract_payment_add', {
        p_invoice_id: invoiceId,
        p_amount: numField('pmAmount'),
        p_paid_on: ($('pmOn') || {}).value || null,
        p_method: ($('pmMethod') || {}).value || null,
        p_reference: ($('pmRef') || {}).value || null,
        p_note: ($('pmNote') || {}).value || null
      });
      if (error) { toast(error.message || '記録できませんでした'); return; }
      await loadAll(); render();
      toast((data && data.warn) ? data.warn : '入金を記録しました（' + ((data && data.status) || '') + '）');
    }
  });
}

async function deletePayment(id) {
  const { error } = await sb.rpc('inv_contract_payment_delete', { p_id: id });
  if (error) { toast(error.message || '消せませんでした'); return; }
  await loadAll(); render(); toast('入金の記録を消しました');
}

function cancelInvoice(id) {
  const v = invoiceOf(id); if (!v) return;
  openSheet({
    title: '請求を取り消す', subject: invoiceLabel(v), cta: '取り消す',
    hint: v.invoice_no ? '発行済みの請求です。取り消したうえで、新しい請求を作り直してください（履歴は残ります）。'
                       : 'まだ発行していない請求です。',
    body: `<label class="field"><span>理由（履歴に残ります）</span>
        <input class="input" id="vcReason" placeholder="例）金額の訂正のため"></label>`,
    run: async () => {
      const { error } = await sb.rpc('inv_contract_invoice_cancel',
        { p_id: id, p_reason: ($('vcReason') || {}).value || null });
      if (error) { toast(error.message || '取り消せませんでした'); return; }
      await loadAll(); render(); toast('請求を取り消しました');
    }
  });
}

/* ---- 操作 ---- */
function sheetContractHead(id) {
  const c = contractOf(id); if (!c) return;
  openSheet({
    title: '件名・日付', subject: contractNo(c), cta: '保存',
    hint: '契約を確定すると、ここは直せなくなります。',
    body: `<label class="field" style="margin-bottom:10px"><span>件名</span>
        <input class="input" id="khTitle" value="${esc(c.title || '')}" placeholder="例）新入社員12名ぶん PC・設定一式"></label>
      <label class="field" style="margin-bottom:10px"><span>契約日</span>
        <input class="input" type="date" id="khDate" value="${esc(c.contract_date || '')}"></label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field" style="margin-bottom:10px"><span>利用開始</span>
          <input class="input" type="date" id="khStart" value="${esc(c.start_date || '')}"></label>
        <label class="field" style="margin-bottom:10px"><span>利用終了</span>
          <input class="input" type="date" id="khEnd" value="${esc(c.end_date || '')}"></label>
      </div>
      <label class="field" style="margin-bottom:10px"><span>お客様向けの但し書き</span>
        <textarea class="input" id="khNote" rows="3">${esc(c.note || '')}</textarea></label>
      <label class="field"><span>社内メモ（顧客には出ません）</span>
        <textarea class="input" id="khInt" rows="2">${esc(c.internal_note || '')}</textarea></label>`,
    run: async () => {
      const { error } = await sb.rpc('inv_contract_set', {
        p_id: id,
        p_title: ($('khTitle') || {}).value,
        p_contract_date: ($('khDate') || {}).value || null,
        p_start: ($('khStart') || {}).value || null,
        p_end: ($('khEnd') || {}).value || null,
        p_note: ($('khNote') || {}).value,
        p_internal: ($('khInt') || {}).value
      });
      if (error) { toast(error.message || '保存できませんでした'); return; }
      await loadAll(); render(); toast('保存しました');
    }
  });
}

function sheetContractTerms(id) {
  const c = contractOf(id); if (!c) return;
  openSheet({
    title: '支払条件', subject: contractNo(c), cta: '保存',
    hint: `<b>後払い</b>（請求書払い・銀行振込の後払い）は、入金より先に手配します。
      そのぶん、管理者の社内承認が要ります。<b>前払い</b>は入金が確認できてから手配します。`,
    body: `<label class="field" style="margin-bottom:10px"><span>支払方法</span>
        <select class="input" id="ktMethod">
          <option value="">（選んでください）</option>
          ${PAY_METHODS.map(m => `<option${c.payment_method === m ? ' selected' : ''}>${esc(m)}</option>`).join('')}
        </select></label>
      <label class="field" style="margin-bottom:10px"><span>前払い / 後払い</span>
        <select class="input" id="ktTiming">
          <option value="">（選んでください）</option>
          ${PAY_TIMINGS.map(m => `<option${c.payment_timing === m ? ' selected' : ''}>${esc(m)}</option>`).join('')}
        </select></label>
      <label class="field" style="margin-bottom:6px"><span>支払条件</span>
        <input class="input" id="ktTerms" value="${esc(c.payment_terms || '')}" placeholder="例）月末締め翌月末払い"></label>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
        ${PAY_TERM_SAMPLES.map(t => `<button type="button" class="btn sm ghost"
          onclick="document.getElementById('ktTerms').value='${esc(t)}'">${esc(t)}</button>`).join('')}
      </div>
      <label class="field"><span>毎月の請求日（月額があるとき。1〜31）</span>
        <input class="input num" type="number" id="ktDay" min="1" max="31" value="${esc(c.billing_day == null ? '' : String(c.billing_day))}"></label>
      <p class="meta" style="margin-top:8px">月額の請求は、ここで決めた日をもとに毎月の請求予定を作ります（Phase 3-b）。</p>`,
    run: async () => {
      const { error } = await sb.rpc('inv_contract_set', {
        p_id: id,
        p_method: ($('ktMethod') || {}).value || null,
        p_timing: ($('ktTiming') || {}).value || null,
        p_terms: ($('ktTerms') || {}).value || null,
        p_billing_day: numField('ktDay')
      });
      if (error) { toast(error.message || '保存できませんでした'); return; }
      await loadAll(); render(); toast('支払条件を入れました。確定するとあとから変えられません');
    }
  });
}

function sheetContractBilling(id) {
  const c = contractOf(id); if (!c) return;
  openSheet({
    title: '請求先', subject: contractNo(c), cta: '保存',
    hint: '契約先と同じなら、空のままで構いません。自治体・学校法人・親会社一括請求・経理部指定のときに入れてください。',
    body: `<label class="field" style="margin-bottom:10px"><span>請求先の会社名・団体名</span>
        <input class="input" id="kbCompany" value="${esc(c.billing_company || '')}" placeholder="例）○○市役所"></label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field" style="margin-bottom:10px"><span>部署</span>
          <input class="input" id="kbDept" value="${esc(c.billing_department || '')}" placeholder="例）総務部 経理課"></label>
        <label class="field" style="margin-bottom:10px"><span>ご担当者</span>
          <input class="input" id="kbPerson" value="${esc(c.billing_person || '')}"></label>
      </div>
      <div style="display:grid;grid-template-columns:140px 1fr;gap:10px">
        <label class="field" style="margin-bottom:10px"><span>郵便番号</span>
          <input class="input" id="kbPostal" value="${esc(c.billing_postal_code || '')}" placeholder="150-0001"></label>
        <label class="field" style="margin-bottom:10px"><span>住所</span>
          <input class="input" id="kbAddr" value="${esc(c.billing_address || '')}"></label>
      </div>
      <label class="field" style="margin-bottom:10px"><span>請求先メール</span>
        <input class="input" type="email" id="kbEmail" value="${esc(c.billing_email || '')}"></label>
      <label class="field"><span>請求についての申し送り</span>
        <textarea class="input" id="kbNote" rows="2" placeholder="例）請求書は郵送でお願いします">${esc(c.billing_note || '')}</textarea></label>`,
    run: async () => {
      // 空文字を送ると消える（シートはいつも全項目を出しているので、消す操作もここで通る）
      const { error } = await sb.rpc('inv_contract_billing_set', {
        p_id: id,
        p_company: ($('kbCompany') || {}).value,
        p_department: ($('kbDept') || {}).value,
        p_person: ($('kbPerson') || {}).value,
        p_postal: ($('kbPostal') || {}).value,
        p_address: ($('kbAddr') || {}).value,
        p_email: ($('kbEmail') || {}).value,
        p_note: ($('kbNote') || {}).value
      });
      if (error) { toast(error.message || '保存できませんでした'); return; }
      await loadAll(); render(); toast('請求先を保存しました');
    }
  });
}

function sheetContractItem(contractId, itemId) {
  const it = itemId ? (db.cItems.find(x => x.id === itemId) || {}) : {};
  const c = contractOf(contractId);
  openSheet({
    title: itemId ? '明細を直す' : '明細を追加', subject: c ? contractNo(c) : '', cta: '保存',
    hint: 'レンタルと月額サービスは「月額」として計算します（単価×数量×月数）。それ以外は一括です。',
    body: `<label class="field" style="margin-bottom:10px"><span>種類</span>
        <select class="input" id="kiKind">${QUOTE_KINDS.map(([v, t]) =>
          `<option value="${v}"${(it.kind || 'sale') === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      <label class="field" style="margin-bottom:10px"><span>品名</span>
        <input class="input" id="kiName" value="${esc(it.name || '')}"></label>
      <label class="field" style="margin-bottom:10px"><span>内容・スペック</span>
        <input class="input" id="kiSpec" value="${esc(it.spec || '')}"></label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field" style="margin-bottom:10px"><span>数量</span>
          <input class="input num" type="number" id="kiQty" min="1" value="${esc(String(it.qty || 1))}"></label>
        <label class="field" style="margin-bottom:10px"><span>単価（税抜）</span>
          <input class="input num" type="number" id="kiUnit" min="0" step="100" value="${esc(String(it.unit_price || 0))}"></label>
      </div>
      <label class="field" style="margin-bottom:10px"><span>期間（月額のときだけ）</span>
        <input class="input num" type="number" id="kiMonths" min="0" max="120" value="${esc(it.months == null ? '' : String(it.months))}"></label>
      <label class="field" style="margin-bottom:10px"><span>商品コード（任意）</span>
        <input class="input" id="kiCode" value="${esc(it.product_code || '')}"></label>
      <label class="bchk"><input type="checkbox" id="kiTax" ${it.taxable === false ? '' : 'checked'}> 課税対象</label>`,
    validate: () => {
      if (!(($('kiName') || {}).value || '').trim()) { toast('品名を入れてください'); return false; }
      return true;
    },
    run: async () => {
      const { error } = await sb.rpc('inv_contract_item_save', {
        p_contract_id: contractId, p_item_id: itemId || null,
        p_kind: ($('kiKind') || {}).value || 'other',
        p_name: ($('kiName') || {}).value, p_spec: ($('kiSpec') || {}).value || null,
        p_qty: numField('kiQty') || 1, p_unit: numField('kiUnit') || 0,
        p_months: numField('kiMonths'), p_billing: null,
        p_taxable: !!($('kiTax') || {}).checked,
        p_code: ($('kiCode') || {}).value || null, p_note: null, p_sort: null
      });
      if (error) { toast(error.message || '保存できませんでした'); return; }
      await loadAll(); render(); toast('明細を保存しました');
    }
  });
}

async function deleteContractItem(contractId, itemId) {
  const { error } = await sb.rpc('inv_contract_item_delete',
    { p_contract_id: contractId, p_item_id: itemId });
  if (error) { toast(error.message || '消せませんでした'); return; }
  await loadAll(); render(); toast('明細を消しました');
}

function confirmContract(id) {
  const c = contractOf(id); if (!c) return;
  const mm = methodMismatch(c);
  const addr = (co, dept, person, postal, address, extra) => co
    ? esc([co, dept, person].filter(Boolean).join('／'))
      + (postal || address ? '<div class="meta">' + esc([postal ? '〒' + postal : '', address].filter(Boolean).join(' ')) + '</div>' : '')
      + (extra ? '<div class="meta">' + esc(extra) + '</div>' : '')
    : '<span class="meta">契約先と同じ</span>';
  openSheet({
    title: '契約を確定する', subject: contractNo(c), cta: '確定する',
    hint: `確定すると<strong>明細と金額は直せなくなります</strong>。
      直すときは取り消して作り直してください。<br>
      <strong>機器はまだ確保されません。</strong>在庫の確保は［手配に進む］を押したときだけです。`,
    body: `<div class="prices">
        <div><div class="lbl">初期費用（税抜）</div><div class="v">${yen(c.initial_total || 0)}</div></div>
        <div><div class="lbl">月額費用（税抜）</div><div class="v">${c.monthly_total ? yen(c.monthly_total) : '—'}</div></div>
        <div><div class="lbl">税込総額</div><div class="v plus">${yen(c.total || 0)}</div></div>
      </div>
      ${c.customer_confirmed_at ? `
        <div class="sec" style="margin-top:14px">お客様が入れた内容<span class="secn">${
          fmtDT(c.customer_confirmed_at)}　${esc(c.customer_confirmed_by || '')} 様</span></div>
        ${mm ? `<div class="card" style="border:1px solid #E8A33D;margin-bottom:10px">
          <b>支払方法が一致していません</b><div class="meta">${esc(mm)}</div></div>` : ''}
        <div class="table-wrap"><table class="t"><tbody>
          <tr><td style="width:110px" class="meta">請求先</td><td>${
            addr(c.billing_company, c.billing_department, c.billing_person,
                 c.billing_postal_code, c.billing_address, c.billing_email)}</td></tr>
          <tr><td class="meta">お届け先</td><td>${
            addr(c.shipping_company, c.shipping_department, c.shipping_person,
                 c.shipping_postal_code, c.shipping_address, c.shipping_phone)}</td></tr>
          <tr><td class="meta">支払希望</td><td>${esc(c.requested_payment_method || '—')}
            ${c.payment_method ? `<div class="meta">社内の設定：${esc(c.payment_method)}${
              c.payment_timing ? '（' + esc(c.payment_timing) + '）' : ''}</div>` : ''}</td></tr>
          <tr><td class="meta">支払条件</td><td>${esc(c.payment_terms || '未設定')}</td></tr>
          <tr><td class="meta">お届け希望日</td><td>${esc(c.desired_delivery_date || '—')}
            <div class="meta">ご希望日です。確定日は担当者から案内します。</div></td></tr>
          ${c.customer_message ? `<tr><td class="meta">ご連絡事項</td><td class="pre">${esc(c.customer_message)}</td></tr>` : ''}
        </tbody></table></div>`
        : `<p class="meta" style="margin-top:10px">お客様はまだ顧客ページから内容を送っていません。</p>`}
      <p class="meta" style="margin-top:10px">支払条件はこのあとで決めても構いません。
        契約が決まったことと、支払い方が決まったことは別に扱います。</p>`,
    run: async () => {
      const { error } = await sb.rpc('inv_contract_confirm', { p_id: id });
      if (error) { toast(error.message || '確定できませんでした'); return; }
      await loadAll(); render(); toast('契約を確定しました（在庫はまだ確保していません）');
    }
  });
}

async function confirmContractTerms(id) {
  const { error } = await sb.rpc('inv_contract_terms_confirm', { p_id: id });
  if (error) { toast(error.message || '確定できませんでした'); return; }
  await loadAll(); render(); toast('支払条件を確定しました');
}

function sheetContractCredit(id) {
  const c = contractOf(id); if (!c) return;
  openSheet({
    title: '入金前の手配を承認する', subject: contractNo(c), cta: '承認する',
    hint: `この契約は<strong>${esc(c.payment_terms || '後払い')}</strong>です。
      入金より先に機器を出すことになるので、<strong>与信の判断</strong>としてここで承認します。
      承認すると、入金前でも手配に進めるようになります。`,
    body: `<div class="prices" style="margin-bottom:10px">
        <div><div class="lbl">お客様</div><div class="v" style="font-size:15px">${esc(c.company || c.customer_name || '')}</div></div>
        <div><div class="lbl">金額（税込）</div><div class="v">${yen(c.total || 0)}</div></div>
        <div><div class="lbl">支払条件</div><div class="v" style="font-size:15px">${esc(c.payment_terms || '')}</div></div>
      </div>
      <label class="field"><span>判断の理由・条件（履歴に残ります）</span>
        <textarea class="input" id="kcNote" rows="3" placeholder="例）取引実績あり。与信枠内。"></textarea></label>`,
    run: async () => {
      const { error } = await sb.rpc('inv_contract_credit_approve',
        { p_id: id, p_note: ($('kcNote') || {}).value || null });
      if (error) { toast(error.message || '承認できませんでした'); return; }
      await loadAll(); render(); toast('承認しました。入金前でも手配に進めます');
    }
  });
}

function cancelContract(id) {
  const c = contractOf(id); if (!c) return;
  openSheet({
    title: '契約を取り消す', subject: contractNo(c), cta: '取り消す',
    hint: '手配前なので、在庫は触っていません。取り消しても個体の状態は変わりません。',
    body: `<label class="field"><span>理由（履歴に残ります）</span>
        <input class="input" id="kxReason" placeholder="例）お客様都合"></label>`,
    run: async () => {
      const { error } = await sb.rpc('inv_contract_cancel',
        { p_id: id, p_reason: ($('kxReason') || {}).value || null });
      if (error) { toast(error.message || '取り消せませんでした'); return; }
      await loadAll(); render(); toast('契約を取り消しました');
    }
  });
}

function copyQuoteUrl(id) {
  const q = quoteOf(id); if (!q) return;
  const url = quoteUrl(q);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => toast('顧客URLをコピーしました'),
                                            () => toast('コピーできませんでした：' + url));
  } else {
    toast(url);
  }
}

function sheetQuoteHead(id) {
  const q = quoteOf(id); if (!q) return;
  openSheet({
    title: '見積の設定', subject: quoteNo(q), cta: '保存',
    hint: '件名はお客様の見積書にそのまま出ます。有効期限を空にすると、提示した日から14日後になります。',
    body: `<label class="field" style="margin-bottom:10px"><span>件名</span>
        <input class="input" id="qhTitle" value="${esc(q.title || '')}" placeholder="例）新入社員12名ぶん PC・設定一式"></label>
      <label class="field" style="margin-bottom:10px"><span>有効期限</span>
        <input class="input" type="date" id="qhValid" value="${esc(q.valid_until || '')}"></label>
      <label class="field" style="margin-bottom:10px"><span>消費税率（%）</span>
        <input class="input num" type="number" id="qhTax" min="0" max="30" step="0.1" value="${esc(String(q.tax_rate || 10))}"></label>
      <label class="field" style="margin-bottom:10px"><span>お客様向けの但し書き</span>
        <textarea class="input" id="qhNote" rows="3">${esc(q.note || '')}</textarea></label>
      <label class="field"><span>社内メモ（顧客ページには出ません）</span>
        <textarea class="input" id="qhInt" rows="2">${esc(q.internal_note || '')}</textarea></label>`,
    run: async () => {
      // 渡さない＝いまの値を残す、空文字＝消す。だから value をそのまま送る。
      // 有効期限だけは日付なので、空にしたいときは p_clear_valid で伝える。
      const valid = ($('qhValid') || {}).value || '';
      const { error } = await sb.rpc('inv_quote_set', {
        p_id: id,
        p_title: ($('qhTitle') || {}).value,
        p_valid: valid || null,
        p_clear_valid: !valid,
        p_tax: numField('qhTax'),
        p_note: ($('qhNote') || {}).value,
        p_internal: ($('qhInt') || {}).value
      });
      if (error) { toast(error.message || '保存できませんでした'); return; }
      await loadAll(); render(); toast('保存しました');
    }
  });
}

function sheetQuoteItem(quoteId, itemId) {
  const it = itemId ? (db.qItems.find(x => x.id === itemId) || {}) : {};
  openSheet({
    title: itemId ? '明細を直す' : '明細を追加', subject: quoteNo(quoteOf(quoteId)), cta: '保存',
    hint: 'レンタルと月額サービスは「月額」として計算します（単価×数量×月数）。それ以外は一括です。',
    body: `<label class="field" style="margin-bottom:10px"><span>種類</span>
        <select class="input" id="qiKind">${QUOTE_KINDS.map(([v, t]) =>
          `<option value="${v}"${(it.kind || 'sale') === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      <label class="field" style="margin-bottom:10px"><span>品名</span>
        <input class="input" id="qiName" value="${esc(it.name || '')}" placeholder="例）HP ProBook 450 G9"></label>
      <label class="field" style="margin-bottom:10px"><span>内容・スペック</span>
        <input class="input" id="qiSpec" value="${esc(it.spec || '')}" placeholder="例）Core i5 / 8GB / SSD 256GB"></label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field" style="margin-bottom:10px"><span>数量</span>
          <input class="input num" type="number" id="qiQty" min="1" value="${esc(String(it.qty || 1))}"></label>
        <label class="field" style="margin-bottom:10px"><span>単価（税抜）</span>
          <input class="input num" type="number" id="qiUnit" min="0" step="100" value="${esc(String(it.unit_price || 0))}"></label>
      </div>
      <label class="field" style="margin-bottom:10px"><span>期間（月額のときだけ）</span>
        <input class="input num" type="number" id="qiMonths" min="0" max="120" value="${esc(it.months == null ? '' : String(it.months))}"></label>
      <label class="field" style="margin-bottom:10px"><span>商品コード（任意）</span>
        <input class="input" id="qiCode" value="${esc(it.product_code || '')}" placeholder="P-00424"></label>
      <label class="bchk"><input type="checkbox" id="qiTax" ${it.taxable === false ? '' : 'checked'}> 課税対象</label>`,
    validate: () => {
      if (!(($('qiName') || {}).value || '').trim()) { toast('品名を入れてください'); return false; }
      return true;
    },
    run: async () => {
      const kind = ($('qiKind') || {}).value || 'other';
      const { error } = await sb.rpc('inv_quote_item_save', {
        p_quote_id: quoteId, p_item_id: itemId || null, p_kind: kind,
        p_name: ($('qiName') || {}).value, p_spec: ($('qiSpec') || {}).value || null,
        p_qty: numField('qiQty') || 1, p_unit: numField('qiUnit') || 0,
        p_months: numField('qiMonths'), p_billing: null,
        p_taxable: !!($('qiTax') || {}).checked,
        p_code: ($('qiCode') || {}).value || null, p_note: null, p_sort: null
      });
      if (error) { toast(error.message || '保存できませんでした'); return; }
      await loadAll(); render(); toast('明細を保存しました');
    }
  });
}

/* 商品マスタから明細を作る。値は初期値で、あとから自由に直せる */
function sheetQuoteFromProduct(quoteId) {
  const list = db.masters.filter(p => p.kind === 'individual').slice(0, 300);
  openSheet({
    title: '商品から追加', subject: quoteNo(quoteOf(quoteId)), cta: '追加',
    hint: '商品の登録内容（品名・スペック・価格）を初期値として入れます。入れたあとは自由に直せます。',
    body: `<label class="field" style="margin-bottom:10px"><span>商品</span>
        <select class="input" id="qfCode">${list.map(p =>
          `<option value="${esc(p.code)}">${esc(titleOf(p))}（${esc(p.code)}）</option>`).join('')}</select></label>
      <label class="field" style="margin-bottom:10px"><span>入れかた</span>
        <select class="input" id="qfKind">
          <option value="sale">販売（一括）</option>
          <option value="rental">レンタル（月額）</option>
        </select></label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field" style="margin-bottom:10px"><span>数量</span>
          <input class="input num" type="number" id="qfQty" min="1" value="1"></label>
        <label class="field" style="margin-bottom:10px"><span>期間（レンタル）</span>
          <input class="input num" type="number" id="qfMonths" min="1" max="120" value="12"></label>
      </div>`,
    run: async () => {
      const code = ($('qfCode') || {}).value;
      const kind = ($('qfKind') || {}).value || 'sale';
      const p = prod(code) || {};
      const unit = kind === 'rental' ? (p.rental_price_month || 0) : (p.sale_price || 0);
      const { error } = await sb.rpc('inv_quote_item_save', {
        p_quote_id: quoteId, p_item_id: null, p_kind: kind,
        p_name: titleOf(p), p_spec: [p.cpu, p.memory_size, p.storage_capacity, p.screen_size].filter(Boolean).join(' / ') || null,
        p_qty: numField('qfQty') || 1, p_unit: unit,
        p_months: kind === 'rental' ? (numField('qfMonths') || 12) : null,
        p_billing: null, p_taxable: true, p_code: code, p_note: null, p_sort: null
      });
      if (error) { toast(error.message || '追加できませんでした'); return; }
      await loadAll(); render();
      toast(unit ? '商品を追加しました' : '商品を追加しました（価格は未設定なので入れてください）');
    }
  });
}

/* 案件の「必要なもの」から、明細の下地をまとめて作る（金額は空のまま） */
async function quoteFromDeal(quoteId) {
  const q = quoteOf(quoteId); if (!q) return;
  const d = db.deals.find(x => x.id === q.deal_id) || {};
  const map = {
    'PC本体': ['sale', 'PC本体'],
    'モニター・周辺機器': ['sale', 'モニター・周辺機器'],
    '初期設定・キッティング': ['kitting', 'キッティング（初期設定）'],
    'Office / Microsoft 365': ['setup', 'Office / Microsoft 365'],
    'アカウント設定': ['setup', 'アカウント設定'],
    'ネットワーク・Wi-Fi': ['network', 'ネットワーク構築'],
    'セキュリティ': ['setup', 'セキュリティ設定'],
    '現地設置': ['install', '現地設置・配線・接続確認'],
    'AI研修': ['training', 'AI研修'],
    'Office研修': ['training', 'Office研修'],
    'データ消去・証明書': ['other', 'データ消去・証明書発行'],
    '故障時の交換対応': ['service_monthly', '故障時の交換対応（8RENT Care）']
  };
  const want = (d.services || []).filter(x => map[x]);
  if (!want.length) { toast('案件に「必要なもの」が入っていません'); return; }
  for (const w of want) {
    const [kind, name] = map[w];
    const r = await sb.rpc('inv_quote_item_save', {
      p_quote_id: quoteId, p_item_id: null, p_kind: kind, p_name: name, p_spec: null,
      p_qty: d.qty || 1, p_unit: 0, p_months: kind === 'service_monthly' ? (d.months || 12) : null,
      p_billing: null, p_taxable: true, p_code: null, p_note: null, p_sort: null
    });
    if (r.error) { toast(r.error.message || '作れませんでした'); return; }
  }
  await loadAll(); render();
  toast(want.length + '行つくりました。単価を入れてください');
}

async function deleteQuoteItem(quoteId, itemId) {
  const { error } = await sb.rpc('inv_quote_item_delete', { p_quote_id: quoteId, p_item_id: itemId });
  if (error) { toast(error.message || '消せませんでした'); return; }
  await loadAll(); render(); toast('明細を消しました');
}

function presentQuote(id) {
  const q = quoteOf(id); if (!q) return;
  const others = quotesOf(q.deal_id).filter(x => x.id !== id && ['提示済み', '相談中'].includes(x.status));
  openSheet({
    title: 'お客様に提示する', subject: quoteNo(q), cta: '提示する',
    hint: `顧客URLを発行します。<strong>提示するとこの版は編集できなくなります。</strong>
      ${others.length ? `前に提示した ${others.map(x => quoteNo(x)).join('・')} は<strong>自動で失効</strong>します
        （古いURLから承認されないようにするためです）。` : ''}`,
    body: `<label class="field" style="max-width:220px"><span>有効期限（何日間）</span>
        <input class="input num" type="number" id="qpDays" min="1" max="180" value="14"></label>
      <p class="meta" style="margin-top:10px">お客様の画面には、初期費用と月額費用を分けて出します。
        原価・在庫数・管理番号・社内メモは出しません。<br>
        メールでお送りするのは担当者の操作です（自動送信はしません）。</p>`,
    run: async () => {
      const { data, error } = await sb.rpc('inv_quote_present', { p_id: id, p_days: numField('qpDays') || 14 });
      if (error) { toast(error.message || '提示できませんでした'); return; }
      await loadAll(); render();
      toast('提示しました。顧客URLをコピーしてお送りください');
      if (data && data.token) copyQuoteUrl(id);
    }
  });
}

function cancelQuote(id) {
  openSheet({
    title: '見積を取り消す', subject: quoteNo(quoteOf(id)), cta: '取り消す',
    hint: '取り消すと、顧客URLからは操作できなくなります。',
    body: `<label class="field"><span>理由（社内メモに残ります）</span>
        <input class="input" id="qcWhy" placeholder="例）条件が変わったため作り直し"></label>`,
    run: async () => {
      const { error } = await sb.rpc('inv_quote_cancel', { p_id: id, p_reason: ($('qcWhy') || {}).value || null });
      if (error) { toast(error.message || '取り消せませんでした'); return; }
      await loadAll(); render(); toast('取り消しました');
    }
  });
}

async function setDealStatus(id, status) {
  const { data, error } = await sb.rpc('inv_deal_set_status', { p_id: id, p_status: status });
  if (error) { toast(error.message || '変えられませんでした'); return; }
  const i = db.deals.findIndex(d => d.id === id);
  if (i >= 0 && data) db.deals[i] = data;
  renderDealBody();
  toast(`${status} にしました`);
}
function sheetDealNote(id) {
  const d = db.deals.find(x => x.id === id);
  if (!d) return;
  openSheet({
    title: '社内メモ', subject: '#' + id, cta: '保存',
    hint: 'お客様には見えません。在庫と調達の確認結果や、お見積りの方針を書いておくところです。',
    body: `<label class="field"><span>メモ</span>
      <textarea class="input" id="sheetVal" rows="5" style="line-height:1.8"
        placeholder="例）11月開始。整備済み15台＋新品5台で手当てできる見込み。現地設置は別途見積。">${esc(d.note || '')}</textarea></label>`,
    run: (v) => saveDealNote(id, v)
  });
}
async function saveDealNote(id, note) {
  const { data, error } = await sb.rpc('inv_deal_note', { p_id: id, p_note: note });
  if (error) { toast(error.message || '保存できませんでした'); return; }
  const i = db.deals.findIndex(d => d.id === id);
  if (i >= 0 && data) db.deals[i] = data;
  renderDealBody();
  toast('メモを保存しました');
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
/* 印刷ボタンを押したら、選んでいる**個体**を印刷済みとして記録してから印刷する。
   ブラウザは紙が出たかを保証できないので、記録するのは「印刷操作をした」ことだけ。
   出なかったらもう一度押せばよい（回数と日時が更新される）。
   数量品と棚のラベルには印刷状態を持たせていないので、個体だけを記録する。 */
async function doPrintLabels() {
  const ids = db.items.filter(i => ui.labelSel[labelKey('item', i.id)]).map(i => i.id);
  if (ids.length && canEdit()) {
    const ok = await markQrPrinted(ids, 'print');
    if (ok) await refreshTx();
  }
  window.print();
  if (ids.length && canEdit()) render();   // 印刷のあとアイコンを緑にする
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
        <button class="btn lime" onclick="doPrintLabels()" ${sel.length ? '' : 'disabled'}>
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
  const cfg = sheetState;
  const val = (($('sheetVal') || {}).value || '').trim();
  // 入力が足りないときは閉じない（閉じてから知らせると入れ直しになるため）
  if (cfg.validate && !cfg.validate(val)) return;

  // 保存が失敗したときに入れた値を消さないシート。run が false を返したら開いたまま
  if (cfg.keepOpenOnError) {
    const cta = $('sheetPanel').querySelector('.btn.cta');
    const label = cta ? cta.textContent : '';
    if (cta) { cta.disabled = true; cta.textContent = '保存中…'; }
    let ok = false;
    try { ok = await cfg.run(val); } catch (e) { ok = false; toast('保存できませんでした'); }
    if (ok === false) {
      if (cta) { cta.disabled = false; cta.textContent = label; }
      return;
    }
    closeSheet();
    return;
  }
  closeSheet();
  await cfg.run(val);
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
/* ---- 管理画面で商品を探す ----
   お客様が見る「商品URL」とは別に、店舗の担当者が商品を探して登録・更新する
   ための導線。いまは楽天とAmazonだけに出す。

   検索語は商品マスターの型番をいちばんに使い、型番が空のときだけ商品名を使う。
   管理番号・仕入元ID・出品SKUは使わない（別の商品が出てしまう）。

   検索語つきURLの形は、実際に管理画面で1度検索して確かめた人だけが
   販売サイトの設定（admin_search_url_template）に入れる。
   こちらで推測して組み立てることはしない。設定が空のあいだは
   「検索語をコピーして管理画面を開く」に切り替える。 */
const ADMIN_SEARCH_CHANNELS = ['rakuten', 'amazon'];

/* 検索語。前後の空白を落とし、あいだの空白は半角1個にそろえる */
function adminSearchTerm(p) {
  const clean = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
  const model = clean((p || {}).model);
  if (model) return { q: model, from: 'model', label: '型番' };
  const name = clean((p || {}).name);
  if (name) return { q: name, from: 'name', label: '商品名' };
  return { q: '', from: null, label: null };
}

/* 「探す」で開くURLを決める。
     ・設定に検証ずみの検索URL（{q}つき）があれば、検索結果をそのまま開く
     ・無ければ管理画面のトップを開き、検索語はクリップボードへ渡す
   どちらも実URLを持つ <a target="_blank" rel="noopener noreferrer"> で開く。
   window.open は使わない。noopener つきの window.open は、正しく開けた
   ときでも null を返す仕様で、返り値からブロックの有無を判定できないため
   （以前はここで「ポップアップがブロックされました」と誤って出していた）。 */
function adminSearchLink(code, ch) {
  const t = adminSearchTerm(prod(code));
  if (!t.q) return { ready: false, why: '型番も商品名も登録されていません', term: t };
  const st = chanSetting(ch);
  const tpl = (st.admin_search_url_template || '').trim();
  const home = (st.admin_home_url || '').trim();
  if (tpl && tpl.indexOf('{q}') >= 0) {
    return { ready: true, direct: true, term: t, url: tpl.replace(/\{q\}/g, encodeURIComponent(t.q)) };
  }
  if (home) return { ready: true, direct: false, term: t, url: home };
  return { ready: false, why: chanLabel(ch) + 'の管理画面URLが未設定です（設定 → 販売サイト）', term: t };
}

/* 検索語をコピーして知らせるだけ。タブを開くのはリンク自身の仕事 */
function adminSearchCopy(code, ch) {
  const t = adminSearchTerm(prod(code));
  if (!t.q) return;
  const paste = t.label + '「' + t.q + '」をコピーしました。管理画面の検索欄に貼り付けてください';
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t.q).then(
      () => toast(paste),
      () => toast('コピーできませんでした。' + t.label + 'は ' + t.q + ' です'));
  } else {
    toast('コピーできませんでした。' + t.label + 'は ' + t.q + ' です');
  }
}

/* 出品先の表の「管理画面」欄。楽天・Amazonだけに出し、閲覧のみの人には出さない。
   管理URL（admin_url）は型番×販売サイトに1つ持つので、1台ぶんの行ではなく
   型番まとめての行から読む。 */
function adminCell(code, ch) {
  if (!canEdit()) return '<span class="meta">—</span>';
  if (ADMIN_SEARCH_CHANNELS.indexOf(ch) < 0) return '<span class="meta">—</span>';
  const link = adminSearchLink(code, ch);
  const direct = ((channelsOf(code).find(v => v.channel === ch) || {}).admin_url || '').trim();
  const stop = 'event.stopPropagation()';

  const search = !link.ready
    ? `<button class="btn sm ghost" disabled title="${esc(link.why)}">${
         esc((link.term.label || '型番') + 'で探す')}</button>
       <div class="meta">${esc(link.why)}</div>`
    : `<a class="btn sm ghost" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer"
         onclick="${stop};${link.direct ? '' : `adminSearchCopy('${esc(code)}','${esc(ch)}')`}"
         title="${esc(chanLabel(ch) + 'の管理画面で ' + link.term.q + ' を探します'
                  + (link.direct ? '' : '（検索語はコピーします。検索欄に貼り付けてください）'))}"
         >${esc(link.term.label + 'で探す')}</a>
       <div class="meta num" style="word-break:break-all">${esc(link.term.q)}${
         link.direct ? '' : '<br>検索語をコピーします'}</div>`;

  const edit = direct
    ? `<a class="btn sm" href="${esc(direct)}" target="_blank" rel="noopener noreferrer"
         onclick="${stop}" title="${esc(direct)}">商品を編集</a>`
    : '';
  return `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-start">
      ${edit}<div>${search}
        <div><button class="btn sm ghost" style="margin-top:4px;font-size:11.5px"
          onclick="${stop};sheetAdminUrl('${esc(code)}','${esc(ch)}')">管理URLを${
            direct ? '直す' : '登録'}</button></div></div></div>`;
}

/* 管理URLだけを入れ直す。出品情報とは別の保存にして、
   どちらかが失敗したときに「もう一方は保存できた」と取り違えないようにする。
   失敗したときはシートを閉じない（入れた値が消えないように）。 */
function sheetAdminUrl(code, ch) {
  const c = CHANNELS.find(x => x.key === ch) || { key: ch, label: ch };
  const now = ((channelsOf(code).find(v => v.channel === ch) || {}).admin_url || '').trim();
  const host = ch === 'rakuten' ? 'item.rms.rakuten.co.jp'
             : ch === 'amazon' ? 'sellercentral.amazon.co.jp' : '';
  openSheet({
    title: c.label + 'の管理画面URL', subject: code, cta: '保存',
    keepOpenOnError: true,
    hint: `出品先の表に［商品を編集］を出すためのURLです。
      <strong>${esc(c.label)}の管理画面でこの商品を開いて、そのときのURLを貼ってください。</strong>
      こちらで組み立てたURLは使いません。`,
    body: `<label class="field"><span>管理画面URL</span>
        <input class="input" id="auUrl" value="${esc(now)}"
               placeholder="${host ? 'https://' + esc(host) + '/…' : 'https://…'}"></label>
      <p class="meta" style="margin-top:8px">
        ${host ? '<code>' + esc(host) + '</code> の https だけ受け付けます。' : ''}
        ログイン中だけ有効な（セッションID・トークンつきの）URLは登録できません。<br>
        空にすると［商品を編集］は出なくなります。まだ出品していない商品でも登録できます。</p>`,
    run: async () => {
      const url = (($('auUrl') || {}).value || '').trim();
      if (url === now) return true;                   // 変わっていないので何もしない
      const { error } = await sb.rpc('inv_listing_admin_url_set',
        { p_code: code, p_channel: ch, p_url: url || null });
      if (error) { toast('保存できませんでした：' + error.message); return false; }
      await loadAll();
      render();
      toast(url ? chanLabel(ch) + 'の管理画面URLを保存しました' : chanLabel(ch) + 'の管理画面URLを消しました');
      return true;
    }
  });
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
    ${ADMIN_SEARCH_CHANNELS.indexOf(ch) >= 0 ? `
    <label class="field" style="margin-bottom:10px"><span>検索語つきURL（ひな形・任意）</span>
      <input class="input" id="caSearch" value="${esc(st.admin_search_url_template || '')}" placeholder="https://…?keyword={q}">
      <span class="meta"><strong>この管理画面で1度じっさいに検索して、出てきたURLを貼ってください。</strong>
        <code>{q}</code> が検索語（型番、無ければ商品名）に差し替わります。
        <br>空のあいだは、出品先の［探す］は<strong>検索語をコピーして管理画面のトップを開く</strong>動きになります。
        推測で作ったURLは入れないでください。</span></label>` : ''}
    ${st.note ? `<p class="meta">${esc(st.note)}</p>` : ''}`,
    [['閉じる', 'closeModal()', 'btn ghost'],
     ['保存', `saveChannelAdmin('${esc(ch)}')`, 'btn lime']]);
}
async function saveChannelAdmin(ch) {
  const { data, error } = await sb.rpc('inv_channel_settings_set', {
    p_channel: ch,
    p_home: (($('caHome') || {}).value || '').trim() || null,
    p_template: (($('caTpl') || {}).value || '').trim() || null,
    p_search: (($('caSearch') || {}).value || '').trim() || null
  });
  if (error) { toast('保存できませんでした：' + error.message); return; }
  const i = db.chanSettings.findIndex(x => x.channel === ch);
  if (data) { if (i >= 0) db.chanSettings[i] = data; else db.chanSettings.push(data); }
  closeModal();
  render();          // 出品先の「管理画面」欄はこの設定を見ているので、すぐ描き直す
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

/* 棚卸確認を取り消す。checked_at を消すだけでは
     inventory_items.last_checked_at（在庫一覧の色）
     inventory_transactions（履歴）
   と噛み合わなくなるので、サーバー側の inv_stocktake_uncheck にまとめてやらせる。
   在庫の状態・在庫数・出品状態・8RENTは変えない。履歴も消さない。 */
function openUncheck(id) {
  if (!db.stocktake) { toast('棚卸を実施していません'); return; }
  const row = (db.stChecked || []).find(x => x.item_id === id);
  if (!row || !row.checked_at) { toast('この個体はまだ確認していません'); return; }
  const it = item(id);
  openModal('この棚卸確認を取り消しますか？', `
    <div class="card" style="margin-bottom:12px">
      <div><span class="k">管理番号</span>${esc(id)}</div>
      <div><span class="k">型番</span>${esc((it && (it.model || it.name)) || '—')}</div>
      <div><span class="k">今回の確認</span>${fmtDT(row.checked_at)}</div>
    </div>
    <p class="meta"><strong>在庫状態そのものは変更しません。</strong>今回の棚卸では「未確認」に戻します。
      最終棚卸確認の日時は、今回の棚卸が始まる前の記録へ戻します（記録が無ければ未確認）。
      履歴は消さず「棚卸確認取消」として残します。</p>
    ${row.expected === false
      ? '<p class="meta">この個体は帳簿外現物なので、取り消すとこの棚卸の一覧から消えます。</p>' : ''}
  `, [['やめる', 'closeModal()', 'btn ghost'],
      ['未確認に戻す', `closeModal();uncheckItem('${esc(id)}')`, 'btn danger']]);
}
async function uncheckItem(id) {
  if (!db.stocktake) return;
  const { data, error } = await sb.rpc('inv_stocktake_uncheck',
    { p_stocktake_id: db.stocktake.id, p_item_id: id });
  if (error) { toast(error.message || '取り消せませんでした'); return; }
  const i = db.items.findIndex(x => x.id === id);
  if (i >= 0 && data) db.items[i] = data;
  await loadStocktakeItems();
  await refreshTx();
  render();
  toast(id + ' を未確認に戻しました');
}

/* 棚卸で「現物が見つからない」と**人が確定したときだけ**差異確定にする。
   押しただけでは変えないし、未確認のまま終了しても自動では確定しない。

   `inv_item_op('状態変更','不明')` を画面から呼ぶだけでは、その棚卸で
   **処理が済んだことが残らない**（checked_at も missing_at も NULL のまま）ため、
   未確認一覧に残り続けて未確認の数も減らなかった。専用RPCで
     missing_at = now()
     inventory_items.status = '不明'
     履歴に追記
   を1トランザクションでやる。

   「不明」は販売可能数・8RENT可能数・販売予約可能数（どれも status='在庫' だけを
   数えている）から自動的に外れる。**その数え方には手を入れていない。**
   お客様への約束が生きている個体（予約中・販売予約・貸出中）は、先に
   返却・キャンセルしてもらう必要があるのでここでは確定しない（サーバー側でも弾く）。 */
const MISSING_NG = ['予約中', '販売予約', '貸出中', '売却済', '廃棄'];
function openMissing(id) {
  if (!db.stocktake) { toast('棚卸を実施していません'); return; }
  const it = item(id);
  if (!it) { toast('個体が見つかりません'); return; }
  if (MISSING_NG.includes(it.status)) {
    toast(`${it.status} のものは差異確定できません（先に返却・キャンセルしてください）`);
    return;
  }
  openModal('この個体は現物が見つかりませんでしたか？', `
    <div class="card" style="margin-bottom:12px">
      <div><span class="k">管理番号</span>${esc(id)}</div>
      <div><span class="k">型番</span>${esc(it.model || it.name || '—')}</div>
      <div><span class="k">メーカー</span>${esc(it.maker || '—')}</div>
      <div><span class="k">保管場所</span>${esc(locPath(it.location_id))}</div>
      <div><span class="k">いまの状態</span>${esc(it.status)}</div>
    </div>
    <p class="meta">この棚卸で<strong>差異確定</strong>にし、状態を「不明」にします。
      未確認の数から外れ、［差異］タブへ移ります。
      在庫数・出品状態・8RENTの設定そのものは変えませんが、
      「不明」は販売可能数・8RENT可能数・販売予約可能数から外れます（数えているのは「在庫」だけのため）。
      見つかったら［差異確定を取り消す］で元の状態へ戻せます。</p>
  `, [['キャンセル', 'closeModal()', 'btn ghost'],
      ['不明にする', `closeModal();markMissing('${esc(id)}')`, 'btn danger']]);
}
async function markMissing(id) {
  if (!db.stocktake) return;
  const { data, error } = await sb.rpc('inv_stocktake_mark_missing',
    { p_stocktake_id: db.stocktake.id, p_item_id: id });
  if (error) { toast(error.message || '差異確定できませんでした'); return; }
  const i = db.items.findIndex(x => x.id === id);
  if (i >= 0 && data) db.items[i] = data;
  await loadStocktakeItems();
  await refreshTx();
  render();
  toast(id + ' を差異確定（不明）にしました');
}

/* 差異確定の取消。誤操作を戻せるようにする。
   状態が「不明」のままのときだけ、差異確定の前の状態（在庫／出品中）へ戻す。
   人があとから別の状態にしていたら上書きしない（サーバー側で判断する）。 */
function openUnmissing(id) {
  if (!db.stocktake) { toast('棚卸を実施していません'); return; }
  const row = (db.stChecked || []).find(x => x.item_id === id);
  if (!row || !row.missing_at) { toast('この個体は差異確定していません'); return; }
  const it = item(id);
  openModal('差異確定を取り消しますか？', `
    <div class="card" style="margin-bottom:12px">
      <div><span class="k">管理番号</span>${esc(id)}</div>
      <div><span class="k">型番</span>${esc((it && (it.model || it.name)) || '—')}</div>
      <div><span class="k">差異確定</span>${fmtDT(row.missing_at)}</div>
      <div><span class="k">いまの状態</span>${esc((it && it.status) || '—')}</div>
    </div>
    <p class="meta">この棚卸では「未確認」に戻します。状態が<strong>「不明」のままなら</strong>、
      差異確定の前の状態（在庫／出品中）へ戻します。
      あとから別の状態にしている場合は、その状態のままにします。
      履歴は消さず「棚卸差異確定取消」として残します。</p>
  `, [['やめる', 'closeModal()', 'btn ghost'],
      ['差異確定を取り消す', `closeModal();unmarkMissing('${esc(id)}')`, 'btn danger']]);
}
async function unmarkMissing(id) {
  if (!db.stocktake) return;
  const { data, error } = await sb.rpc('inv_stocktake_unmark_missing',
    { p_stocktake_id: db.stocktake.id, p_item_id: id });
  if (error) { toast(error.message || '取り消せませんでした'); return; }
  const i = db.items.findIndex(x => x.id === id);
  if (i >= 0 && data) db.items[i] = data;
  await loadStocktakeItems();
  await refreshTx();
  render();
  toast(id + ' の差異確定を取り消しました');
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
    // 数え方は棚卸画面と同じ stocktakeProgress()。帳簿在庫が分母で、
    // 帳簿外現物を読んでも分母は増えない（別枠で出す）
    const p = stocktakeProgress();
    el.textContent = `現物確認済み ${p.done} / 帳簿在庫 ${p.total}`
      + (p.missing ? `　差異確定 ${p.missing}` : '')
      + (p.extra ? `　帳簿外 ${p.extra}` : '');
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
    c.webcam ? 'カメラ必須' : '', c.numpad ? 'テンキー必須' : '',
    c.purpose ? '用途：' + c.purpose : ''
  ].filter(Boolean).join('／');
}
/* 申込の商品。8RENTは「型番が分かる人」だけの入口ではないので、
   決まっていない申込が普通にある。空欄にせず、そう書く。
   お客様が書いた「希望モデル」（conditions.model）は、社内で決める商品とは別物。 */
function rentalProductText(r) {
  if (!r.product_code) {
    const wish = ((r.conditions || {}).model || '').trim();
    return `<span class="tag act">商品未指定</span><div class="meta">条件から提案</div>`
      + (wish ? `<div class="meta">ご希望：${esc(wish)}</div>` : '');
  }
  const p = prod(r.product_code);
  return esc(p ? titleOf(p) : r.product_code);
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
      const ids = reqItems(r);
      return `<tr class="clk" onclick="showRentalDetail(${r.id})">
        <td class="meta nowrap num">${esc(fmtDT(r.created_at))}</td>
        <td>${esc(r.customer_name)}${r.company ? `<div class="meta">${esc(r.company)}</div>` : ''}</td>
        <td>${rentalProductText(r)}${r.office ? '<div class="meta">Office付き</div>' : ''}</td>
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
  const pick = `<button class="btn sm" onclick="sheetRentalProduct(${r.id})">商品を決める</button>`;
  if (r.status === '希望受付') return `
    <button class="btn sm" onclick="doRentalStatus(${r.id},'在庫・調達確認')">確認を始める</button>${cancel}`;
  // 商品が決まっていないうちは割り当てられない（似た型番をこちらで当てはめない）
  if (r.status === '在庫・調達確認') return r.product_code
    ? `<button class="btn sm" onclick="doRentalAllocate(${r.id})">個体を割り当てる</button>${cancel}`
    : `${pick}${cancel}`;
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
  openModal(`申込 #${r.id}`, `
    <div class="info" style="margin-bottom:14px">
      <div><span class="k">お客様</span>${esc(r.customer_name)}</div>
      <div><span class="k">会社名</span>${esc(r.company || '—')}</div>
      <div><span class="k">メール</span>${esc(r.email || '—')}</div>
      <div><span class="k">電話</span>${esc(r.phone || '—')}</div>
      <div><span class="k">商品</span>${rentalProductText(r)}</div>
      <div><span class="k">台数</span>${r.qty || 1}台${r.procure_qty ? `（うち取り寄せ ${r.procure_qty}台）` : ''}</div>
      <div><span class="k">Office</span>${r.office ? '希望あり' : '—'}</div>
      <div><span class="k">CPU</span>${esc((r.conditions || {}).cpu || '') || '—'}</div>
      <div><span class="k">メモリ</span>${(r.conditions || {}).memory_gb ? (r.conditions.memory_gb + 'GB以上') : '—'}</div>
      <div><span class="k">ストレージ</span>${(r.conditions || {}).storage_gb
        ? (r.conditions.storage_gb >= 1024 ? 'SSD 1TB以上' : 'SSD ' + r.conditions.storage_gb + 'GB以上') : '—'}</div>
      <div><span class="k">画面サイズ</span>${esc({ small: '13型以下', mid: '14型前後', large: '15型以上' }[(r.conditions || {}).screen] || '') || '—'}</div>
      <div><span class="k">用途</span>${esc((r.conditions || {}).purpose || '') || '—'}</div>
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
        ...(r.product_code
          ? [['商品を変える', `closeModal();sheetRentalProduct(${r.id})`, 'btn ghost'],
             ['個体を割り当てる', `doRentalAllocate(${r.id});closeModal()`, 'btn lime']]
          : [['商品を決める', `closeModal();sheetRentalProduct(${r.id})`, 'btn lime']])
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
/* 商品未指定の申込に、社内で商品を決める。
   似た型番や後継機をこちらで当てはめることはしない。人が選んだものだけを入れる。
   ここで入れるのは商品だけで、個体は押さえない（押さえるのは［個体を割り当てる］）。 */
function sheetRentalProduct(id) {
  const r = db.rentalReqs.find(x => x.id === id); if (!r) return;
  const wish = ((r.conditions || {}).model || '').trim();
  const list = db.masters
    .filter(p => p.kind === 'individual' && p.rental_enabled)
    .sort((a, b) => String(titleOf(a)).localeCompare(String(titleOf(b)), 'ja'));
  openSheet({
    title: '申込の商品を決める', subject: '#' + r.id + '　' + (r.customer_name || ''), cta: '保存',
    keepOpenOnError: true,
    hint: `お客様のご希望から、<strong>実在する商品</strong>を選んでください。
      似た型番や後継機をこちらで当てはめることはしません。
      <strong>決めただけでは個体は押さえません。</strong>押さえるのは［個体を割り当てる］のときです。`,
    body: `<div class="prow"><span>ご希望の条件</span><b>${esc(rentalCondText(r)) || '—'}</b></div>
      ${wish ? `<div class="prow"><span>お客様が書いた希望モデル</span><b>${esc(wish)}</b></div>` : ''}
      <div class="prow"><span>台数</span><b>${r.qty || 1}台</b></div>
      <label class="field" style="margin-top:12px"><span>商品</span>
        <select class="input" id="rpCode">
          <option value="">（商品未指定にもどす）</option>
          ${list.map(p => `<option value="${esc(p.code)}"${p.code === r.product_code ? ' selected' : ''}
            >${esc(titleOf(p))}（${esc(p.code)}）</option>`).join('')}
        </select>
        <span class="meta">8RENTに掲載している商品だけが出ます。
          見つからないときは、先に商品を登録して8RENT掲載を有効にしてください。</span></label>`,
    run: async () => {
      const code = (($('rpCode') || {}).value || '').trim();
      const { error } = await sb.rpc('inv_rental_request_product_set',
        { p_request_id: id, p_code: code || null });
      if (error) { toast('決められませんでした：' + error.message); return false; }
      await loadAll();
      await refreshTx();
      render();
      toast(code ? '商品を決めました' : '商品未指定にもどしました');
      return true;
    }
  });
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

/* 画面を開きっぱなしにしていると、その間にお客様が見積を承認しても
   古い状態のまま見えてしまう（データを読むのはページを開いたときだけのため）。
   別のタブから戻ってきたときに読み直す。入力中（シートが開いている）ときと、
   読んだ直後は動かさない。 */
let lastLoadAt = Date.now();
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || sheetState || scan.on) return;
  if (Date.now() - lastLoadAt < 20000) return;
  lastLoadAt = Date.now();
  if (await loadAll()) render();
});

/* Escapeで、開いているものを手前から順に閉じる */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('modal').classList.contains('on')) { closeModal(); return; }
  if ($('sheet').classList.contains('on')) { closeSheet(); return; }
  if (scan.on) closeScan();
});
