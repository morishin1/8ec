/* ========================================================================
   SNS投稿準備の定義（Persona × Issue × Content × CTA）

   /zaiko/sns の画面と /api/sns の両方がこのファイルを読む。
   画面とサーバーで別々に持つと、選べる値と受け付ける値がずれるため。
     ブラウザ … <script src="/assets/sns-master.js"> → window.SnsMaster
     サーバー … require('../assets/sns-master.js')

   ■ キーは投稿に保存される（ec_sns_posts.persona など）
     表示名は直してよいが、キーは変えない・消さない。使わなくなったものは
     retired: true を付けて選択肢から外す（過去の投稿の表示には使う）。

   ■ 方針
     「PCを売るSNS」ではなく「PC調達・IT機器導入の困りごとを解決するSNS」。
     投稿は Issue解決 → 役立つ情報 → 必要ならサービス紹介 → CTA の順にする。
   ======================================================================== */
(function (root, factory) {
  var m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.SnsMaster = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SERVICE = 'COMMERCE（エイトコマース）';

  /* ---- 誰に（ペルソナ） ---- */
  var PERSONAS = [
    { key: 'owner_smb',       label: '中小企業の経営者' },
    { key: 'general_affairs', label: '総務担当' },
    { key: 'it_admin',        label: '情報システム担当' },
    { key: 'hr_recruit',      label: '採用担当' },
    { key: 'school',          label: '学校・教育機関' },
    { key: 'training_co',     label: '研修会社' },
    { key: 'new_site',        label: '新規拠点を立ち上げる企業' },
    { key: 'bulk_temp',       label: '一時的に大量のPCが必要な企業' }
  ];

  /* ---- 何に困っている（Issue） ----
     personas は「このペルソナを選んだときに上に並べる」ためのヒント。
     組み合わせを制限するものではない。
     pages は元コンテンツの候補として上に並べる公開ページ */
  var ISSUES = [
    { key: 'cost_down',       label: 'PCを安く揃えたい',
      personas: ['owner_smb', 'general_affairs'], pages: ['/buy', '/rent'] },
    { key: 'new_vs_used',     label: '新品と中古のどちらを選べばよいか分からない',
      personas: ['owner_smb', 'general_affairs', 'it_admin'], pages: ['/faq', '/buy'] },
    { key: 'buy_vs_rent',     label: '購入とレンタルのどちらがよいか迷う',
      personas: ['owner_smb', 'general_affairs'], pages: ['/faq', '/rent', '/buy'] },
    { key: 'temp_10_30',      label: '一時的に10〜30台ほど必要',
      personas: ['bulk_temp', 'training_co'], pages: ['/packs/short-term-rental', '/rent'] },
    { key: 'new_hire_pc',     label: '新入社員用PCを準備したい',
      personas: ['hr_recruit', 'general_affairs'], pages: ['/packs/new-employee-pc'] },
    { key: 'with_office',     label: 'Office込みで用意したい',
      personas: ['general_affairs'], pages: ['/support', '/faq'] },
    { key: 'failure_support', label: '故障時の対応が不安',
      personas: ['it_admin', 'general_affairs'], pages: ['/care', '/support'] },
    { key: 'spec_unknown',    label: '必要なPCスペックが分からない',
      personas: ['general_affairs', 'school'], pages: ['/pc', '/faq'] },
    { key: 'pc_management',   label: '社内PC管理が面倒',
      personas: ['it_admin'], pages: ['/packs/kitting', '/support'] },
    { key: 'replace_old',     label: '古いPCを入れ替えたい',
      personas: ['it_admin', 'owner_smb'], pages: ['/pc', '/buy'] },
    { key: 'short_term',      label: '短期間だけPCが必要',
      personas: ['bulk_temp', 'new_site'], pages: ['/packs/short-term-rental', '/rent'] },
    { key: 'event_training',  label: '研修・イベントで複数台必要',
      personas: ['training_co', 'school', 'bulk_temp'], pages: ['/packs/training-pc'] }
  ];

  /* ---- 投稿タイプ ---- */
  var CONTENT_TYPES = [
    { key: 'issue',        label: 'Issue解決' },
    { key: 'knowhow',      label: 'ノウハウ' },
    { key: 'intro',        label: '商品紹介' },
    { key: 'compare',      label: '比較' },
    { key: 'case',         label: '事例（活用例）' },
    { key: 'faq',          label: 'FAQ' },
    { key: 'arrival',      label: '入荷情報' },
    { key: 'howto_choose', label: '選び方' },
    { key: 'buy_vs_rent',  label: '購入 vs レンタル' },
    { key: 'corp_intro',   label: '法人導入のポイント' }
  ];

  /* ---- 投稿目的 ----
     cta は、目的を選んだときに入れておく CTA の既定値 */
  var OBJECTIVES = [
    { key: 'awareness', label: '認知',         cta: 'view_stock' },
    { key: 'traffic',   label: 'サイト流入',   cta: 'view_stock' },
    { key: 'inquiry',   label: '問い合わせ',   cta: 'quote' },
    { key: 'purchase',  label: '購入',         cta: 'view_product' },
    { key: 'rental',    label: 'レンタル相談', cta: 'rental_consult' }
  ];

  /* ---- CTA（最後にしてほしいこと） ----
     URL はサーバーが ctaPath() で組み立てる。投稿文の中には入れない。
     lead: true のものは /quote へ送るので、どの投稿から来たかが
     inventory_deals.source に残る（from=sns-x-<投稿No>）。 */
  var CTAS = [
    { key: 'view_product',   label: '商品を見る' },
    { key: 'quote',          label: '見積を依頼する',     lead: true },
    { key: 'rental_consult', label: 'レンタル相談',       lead: true },
    { key: 'contact',        label: '問い合わせ' },
    { key: 'view_stock',     label: '在庫を見る' },
    { key: 'corp_consult',   label: '法人導入を相談する', lead: true }
  ];

  /* ---- 元コンテンツにできる公開ページ ----
     /api/sns はここにあるパスしか取りに行かない（任意のURLは受け付けない）。
     file は実際に置いてあるファイル（Vercelの書き換えを通さずに読むため）。
     notReal: true のページは「特定企業の実績ではない」ので、実績としては使わない */
  var PAGES = [
    { path: '/packs/new-employee-pc',   file: '/packs/new-employee-pc.html',   label: 'パック：新入社員PC' },
    { path: '/packs/short-term-rental', file: '/packs/short-term-rental.html', label: 'パック：短期レンタル' },
    { path: '/packs/training-pc',       file: '/packs/training-pc.html',       label: 'パック：研修・イベントPC' },
    { path: '/packs/office-opening',    file: '/packs/office-opening.html',    label: 'パック：オフィス開設' },
    { path: '/packs/kitting',           file: '/packs/kitting.html',           label: 'パック：キッティング' },
    { path: '/faq',     file: '/faq.html',     label: 'よくある質問' },
    { path: '/cases',   file: '/cases.html',   label: '活用例（特定企業の実績ではない）', notReal: true },
    { path: '/care',    file: '/care.html',    label: '8RENT Care（故障・代替機）' },
    { path: '/support', file: '/support.html', label: '設定・サポート' },
    { path: '/rent',    file: '/rent.html',    label: '8RENT（レンタル）' },
    { path: '/buy',     file: '/buy.html',     label: '8EC BUY（購入）' },
    { path: '/pc',      file: '/pc.html',      label: '法人PC' }
  ];

  var SOURCE_TYPES = [
    { key: 'none',    label: 'なし（Issue解決のみ）' },
    { key: 'column',  label: 'コラム' },
    { key: 'product', label: '商品' },
    { key: 'page',    label: '公開ページ' }
  ];

  var IG_TAGS_MAX = 5;
  var X_TAGS_MAX = 2;
  var X_MAX = 280;
  var X_URL_WEIGHT = 23;

  /* ---- 引く・確かめる ---- */
  function find(list, key) {
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    return null;
  }
  function labelOf(list, key) { var x = find(list, key); return x ? x.label : (key || ''); }
  function pageOf(path) {
    for (var i = 0; i < PAGES.length; i++) if (PAGES[i].path === path) return PAGES[i];
    return null;
  }

  /* 選んだ軸が定義にあるか。足りないものを日本語で返す（空なら OK） */
  function missingAxes(p) {
    var out = [];
    p = p || {};
    if (!find(PERSONAS, p.persona)) out.push('対象（ペルソナ）');
    if (!find(ISSUES, p.issue)) out.push('課題（Issue）');
    if (!find(CONTENT_TYPES, p.content_type)) out.push('投稿タイプ');
    if (!find(OBJECTIVES, p.objective)) out.push('投稿目的');
    if (!find(CTAS, p.cta)) out.push('CTA');
    return out;
  }

  /* ペルソナに合う Issue を上に並べる（ほかも下に残す） */
  function issuesFor(persona) {
    var hit = [], rest = [];
    ISSUES.forEach(function (x) {
      (x.personas.indexOf(persona) >= 0 ? hit : rest).push(x);
    });
    return { hit: hit, rest: rest };
  }

  /* 計測用の参照。/quote の from と、ほかのURLの utm_content に入る */
  function ref(postNo, channel) {
    return 'sns-' + (channel === 'instagram' ? 'ig' : 'x') + '-' + String(postNo || 0);
  }

  /* 商品ページの slug。assets/catalog.js の slugOf と同じ作り方 */
  function productSlug(m) {
    var src = [m.maker, m.title || m.name || m.model].filter(Boolean).join(' ');
    var s = String(src)
      .replace(/[（(].*?[）)]/g, ' ')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return s.length >= 3 ? s : String(m.code || '').toLowerCase();
  }

  /* CTA の行き先（サイト内のパス）。
     product … 元コンテンツが商品のときの { code, slug, rental_enabled, sale_enabled } */
  function ctaPath(cta, r, product) {
    var enc = encodeURIComponent;
    var utm = 'utm_source=sns&utm_content=' + enc(r);
    switch (cta) {
      case 'view_product':
        return product && product.slug
          ? '/products/' + enc(product.slug) + '?' + utm
          : '/buy?' + utm;
      case 'quote':
      case 'corp_consult':
        return product && product.code
          ? '/quote?code=' + enc(product.code) + '&from=' + enc(r)
          : '/quote?from=' + enc(r);
      case 'rental_consult':
        return '/quote?mode=rent' + (product && product.code ? '&code=' + enc(product.code) : '')
          + '&from=' + enc(r);
      case 'contact':
        return '/?' + utm + '#contact';
      case 'view_stock':
        return (product && product.sale_enabled && !product.rental_enabled ? '/buy?' : '/rent?') + utm;
      default:
        return '/?' + utm;
    }
  }

  /* X の文字数。日本語は2、URLは長さにかかわらず23（8sp と同じ数え方） */
  function xWeight(text) {
    var t = String(text == null ? '' : text);
    var n = 0;
    t = t.replace(/https?:\/\/\S+/gi, function () { n += X_URL_WEIGHT; return ''; });
    for (var i = 0; i < t.length; i++) {
      var c = t.codePointAt(i);
      if (c > 0xFFFF) i++;
      n += ((c >= 0x0000 && c <= 0x10FF)
         || (c >= 0x2000 && c <= 0x200D)
         || (c >= 0x2010 && c <= 0x201F)
         || (c >= 0x2032 && c <= 0x2037)) ? 1 : 2;
    }
    return n;
  }

  /* X の投稿画面を文入りで開く。投稿そのものは人が押す */
  function xIntentUrl(text) {
    return 'https://x.com/intent/post?text=' + encodeURIComponent(String(text == null ? '' : text));
  }

  /* 一覧と編集画面で同じ見立てを使う。
     stale（元コンテンツや軸が変わった）は状態とは別に並べて出す */
  function statusOf(p) {
    p = p || {};
    var made = !!(String(p.instagram_caption || '').trim() || String(p.x_caption || '').trim());
    var ig = !!p.instagram_posted_at, x = !!p.x_posted_at;
    if (!made) return { key: 'none', label: 'SNS未作成' };
    if (ig && x) return { key: 'done', label: 'Instagram済・X済' };
    if (ig) return { key: 'ig', label: 'Instagram済' };
    if (x) return { key: 'x', label: 'X済' };
    return { key: 'ready', label: 'SNS文作成済み' };
  }

  /* 投稿日。先に投稿したほう */
  function postedAt(p) {
    var a = p && p.instagram_posted_at, b = p && p.x_posted_at;
    if (a && b) return new Date(a) < new Date(b) ? a : b;
    return a || b || null;
  }

  return {
    SERVICE: SERVICE,
    PERSONAS: PERSONAS, ISSUES: ISSUES, CONTENT_TYPES: CONTENT_TYPES,
    OBJECTIVES: OBJECTIVES, CTAS: CTAS, PAGES: PAGES, SOURCE_TYPES: SOURCE_TYPES,
    IG_TAGS_MAX: IG_TAGS_MAX, X_TAGS_MAX: X_TAGS_MAX, X_MAX: X_MAX,
    find: find, labelOf: labelOf, pageOf: pageOf, missingAxes: missingAxes, issuesFor: issuesFor,
    ref: ref, productSlug: productSlug, ctaPath: ctaPath,
    xWeight: xWeight, xIntentUrl: xIntentUrl, statusOf: statusOf, postedAt: postedAt
  };
});
