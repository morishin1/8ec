/* ===================================================================
   8EC / 8RENT 共通：公開カタログの取得・画像選択・用意できるかの表示

   役割分担
     楽天    … 販売チャネル（裏側。公開画面には出さない）
     8EC     … レンタルチャネル。「いまある在庫から1台選ぶ」のではなく、
               必要なスペック・台数・期間を送ってもらい、こちらで在庫や仕入れを
               組み合わせて用意するサービスとして見せる
     /zaiko  … 商品・実在庫の共通基盤（個体管理はここだけ）

   公開画面に出さないもの
     実在庫数（残り1台・在庫2台・レンタル可能3台・購入可能台数）
       … 法人のお客様に「残り1台」と見せると複数台を借りられない印象になるため。
         数は内部管理（inv_channel_stock_feed）でだけ使う
     楽天の販売情報（購入リンク・販売価格・販売可能台数）
     楽天の商品説明の原文（販売向けの文言が多いため）

   取得元は Supabase の公開ビュー inv_public_catalog。ビューの時点で
   rental_enabled=true の商品だけに絞られ、在庫数と楽天の販売情報は入っていない。

     表示項目            → 取得元
     商品名/型番/メーカー → inventory_products
     カテゴリ名          → inventory_categories
     代表画像（1枚だけ）  → rental_image_url → rental_images[0] → image_url → images[0]
                            → どれも無ければ「画像準備中」
     スペック（事実）     → cpu / memory_size / storage_* / screen_size / os /
                            webcam / wifi / bluetooth / numpad / accessories / condition_note
     用意できるか        → availability（ご案内可能／取り寄せ可能／ご相談ください）
                            台数は出さない。台数はお客様から伺う
     説明                → rental_description（レンタル向けに作り直した文だけ）

   同じメーカー＋型番は公開側では1商品にまとめる（model_key）。
   スペック違いは商品詳細と申込条件のバリエーションとして扱う。

   このファイルはサイトのトップ（/ ＝ 8RENT）が読み込む。
   /rental/ は / へ転送している（vercel.json の redirects）。
   =================================================================== */
window.EightCatalog = (function () {
  'use strict';

  const SUPA_URL = "https://htglvascsuqkixpmclwr.supabase.co";
  const SUPA_KEY = "sb_publishable_yZCcrwdqjuf0u_5WBWlHIw_AxdvteEV";
  /* 公開カタログ。レンタル（8RENT）と販売（8EC BUY）の両方が1つのビューに入る。
     販売の列を足す前のDB（migration未適用）では読めないので、
     そのときは以前のビューへ落として「レンタルだけのサイト」として動かす。 */
  const VIEW = 'inv_public_products';
  const VIEW_FALLBACK = 'inv_public_catalog';
  const CAT_VIEW = 'inv_public_categories';

  /* 「カテゴリーから探す」に出すカテゴリー。
     表示元は /zaiko のカテゴリーマスター（inv_public_categories）で、
     公開中の商品から逆算はしない。商品が0件のカテゴリーも消さない
     （消すと「8RENTはそれを扱っていない」ように見えるため）。

     ここに書いてあるのは、マスターがまだ読めないとき（migration未適用・
     通信断）に出す控え。IDはマスターと同じものを使う。 */
  const CAT_FALLBACK = [
    { id: 'pc',         name: 'パソコン',                     icon: 'laptop_mac' },
    { id: 'monitor',    name: 'ディスプレイ・モニター',         icon: 'desktop_windows' },
    { id: 'software',   name: 'ソフトウェア',                 icon: 'apps' },
    { id: 'consume',    name: 'パソコンサプライ・消耗品',       icon: 'inventory_2' },
    { id: 'network',    name: '無線LAN・ネットワーク機器',      icon: 'router' },
    { id: 'printer',    name: 'プリンター・プロジェクター',      icon: 'print' },
    { id: 'storage',    name: '外付けドライブ・ストレージ',      icon: 'hard_drive' },
    { id: 'input',      name: 'キーボード・マウス・ウェブカメラ', icon: 'keyboard' },
    { id: 'server',     name: 'サーバー関連',                 icon: 'dns' },
    { id: 'parts',      name: 'パソコンパーツ',               icon: 'memory' },
    { id: 'mobile-acc', name: 'スマホ・タブレットアクセサリ',    icon: 'smartphone' },
    { id: 'ups',        name: 'UPS（無停電電源装置）',         icon: 'battery_charging_full' }
  ];

  /* 読み込んだカテゴリーマスター。商品側のカテゴリ名の補完にも使う */
  let cats = CAT_FALLBACK.slice();

  /* カテゴリの表示名・アイコン。id は /zaiko の inventory_categories と同じ。
     マスターに無い（＝公開していない）カテゴリの商品でも、名前だけは出せるようにする */
  const CAT_META = {
    pc:      { icon: 'laptop_mac',      label: 'パソコン' },
    monitor: { icon: 'desktop_windows', label: 'ディスプレイ・モニター' },
    tablet:  { icon: 'tablet_mac',      label: 'タブレット' },
    phone:   { icon: 'smartphone',      label: 'スマートフォン' },
    network: { icon: 'router',          label: '無線LAN・ネットワーク機器' },
    printer: { icon: 'print',           label: 'プリンター・プロジェクター' },
    other:   { icon: 'devices_other',   label: 'その他IT機器' }
  };
  const TAG_LABEL = { recommend: 'おすすめ', popular: '人気', new: '新着' };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yen = (n) => Number(n || 0).toLocaleString('ja-JP');

  let sb = null;
  function client() {
    if (sb) return sb;
    if (!window.supabase || !window.supabase.createClient) return null;
    // 公開ページなのでセッションは保持しない（/zaiko のログインに干渉しない）
    sb = window.supabase.createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    return sb;
  }

  /* 公開カタログを読む。ビューが rental_enabled=true の商品だけを返すので、
     opts.rental=true は念のための絞り込み（本番ビューが古い場合の保険）。
     通信エラーは items=[] ではなく error で返す（「在庫0」と混同しない） */
  async function load(opts) {
    const c = client();
    if (!c) return { items: [], error: new Error('接続の初期化に失敗しました') };
    let { data, error } = await c.from(VIEW).select('*');
    if (error) {
      // 販売の列がまだ無いDB。レンタルぶんだけで動かす
      const alt = await c.from(VIEW_FALLBACK).select('*');
      if (alt.error) return { items: [], error };
      data = (alt.data || []).map(x => Object.assign({ sale_enabled: false, sale_price: null,
        sale_condition: null, sale_procurement_available: false, sale_availability: null }, x));
    }
    let items = (data || []).slice();
    if (opts && opts.rental) items = items.filter(it => it.rental_enabled);
    if (opts && opts.sale) items = items.filter(it => it.sale_enabled);
    items.sort((a, b) => String(a.name || a.model || '').localeCompare(String(b.name || b.model || ''), 'ja'));
    return { items, error: null };
  }

  const catOf = (id) => cats.find(c => c.id === id) || null;
  function catLabel(id) {
    const c = catOf(id);
    return (c && c.name) || (CAT_META[id] || {}).label || id || '';
  }
  function catIcon(id) {
    const c = catOf(id);
    return (c && c.icon) || (CAT_META[id] || {}).icon || 'devices_other';
  }
  function title(it) { return it.name || it.model || ''; }

  /* 画像URLとして使えるものだけ通す。http(s) か サイト内の絶対パス。
     相対パスや空文字は使わない（壊れた画像を出さないため） */
  function validUrl(u) {
    if (typeof u !== 'string') return null;
    const s = u.trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s) || s.startsWith('/')) return s;
    return null;
  }

  /* 表示に使う画像。8ECで見せるのは代表画像の1枚だけ（カードも商品詳細も同じ）。
     優先順位： rental_image_url → rental_images[0] → image_url → images[0] → 画像準備中
     返すのは候補の配列だが、2枚目以降は「1枚目が読めなかったときの差し替え先」で、
     並べて見せるためのものではない（枚数は商品マスターに何枚あっても表示は1枚）。 */
  function images(it, mode) {
    const list = [];
    const push = (u) => { const v = validUrl(u); if (v && list.indexOf(v) < 0) list.push(v); };
    const general = () => { push(it.image_url); (Array.isArray(it.images) ? it.images : []).forEach(push); };
    const rental = () => { push(it.rental_image_url); (Array.isArray(it.rental_images) ? it.rental_images : []).forEach(push); };
    if (mode === 'rental') { rental(); general(); } else { general(); rental(); }
    return list;
  }
  /* 代表画像1枚（無ければ null） */
  function mainImage(it, mode) { return images(it, mode)[0] || null; }

  const placeholder = () => `<div class="ph" aria-label="画像準備中"><span class="ms">devices</span><span class="ph-t">画像準備中</span></div>`;

  /* <img> を1枚出す。読めなければ data-alt の次の候補に切り替え、最後は「画像準備中」。
     width/height を付けてレイアウトのずれを抑える（4:3） */
  function mediaHtml(it, mode) {
    const c = images(it, mode);
    if (!c.length) return placeholder();
    return `<img src="${esc(c[0])}" alt="${esc(title(it))}" loading="lazy" decoding="async" width="400" height="300"` +
      ` data-alt="${esc(c.slice(1).join('|'))}" onerror="EightCatalog.imgError(this)">`;
  }
  function imgError(img) {
    const rest = (img.getAttribute('data-alt') || '').split('|').filter(Boolean);
    if (rest.length) {
      img.setAttribute('data-alt', rest.slice(1).join('|'));
      img.src = rest[0];
      return;
    }
    const d = document.createElement('div');
    d.innerHTML = placeholder();
    img.replaceWith(d.firstChild);
  }

  /* 用意できるかどうかだけを出す。台数は公開しない（台数はお客様から伺う） */
  const AVAIL_CLASS = { 'ご案内可能': 'ok', '取り寄せ可能': 'few' };
  function availability(it) {
    return (it && it.availability) || 'ご相談ください';
  }
  function availTag(it) {
    const t = availability(it);
    return `<span class="c-avail ${AVAIL_CLASS[t] || 'none'}">${esc(t)}</span>`;
  }

  /* レンタルの公開設定と料金。台数は持たない（台数はお客様から伺う） */
  function rental(it) {
    if (!it.rental_enabled) return null;
    return { price: it.rental_price_month, minMonths: it.rental_min_months || 1, availability: availability(it) };
  }
  function specLine(it) {
    const parts = [it.cpu, it.memory_size ? it.memory_size + (it.storage_capacity ? '' : '') : '',
      it.storage_capacity ? [it.storage_capacity, it.storage_type].filter(Boolean).join(' ') : '',
      it.screen_size, it.os].filter(Boolean);
    return parts.length ? parts.join('／') : (it.spec || '');
  }

  /* カテゴリーマスターを読む。読めなければ控えの一覧で動かす
     （カテゴリーが1つも出ない、という見え方にはしない） */
  async function loadCategories() {
    const c = client();
    if (!c) return { cats: cats, error: new Error('接続の初期化に失敗しました') };
    const { data, error } = await c.from(CAT_VIEW).select('*');
    if (error || !data || !data.length) return { cats: cats, error: error || null };
    cats = data.slice()
      .sort((a, b) => (a.sort_no || 0) - (b.sort_no || 0) || String(a.id).localeCompare(String(b.id)))
      .map(r => ({ id: r.id, name: r.name, icon: r.icon || 'devices_other',
                   parent_id: r.parent_id || null }));
    return { cats: cats, error: null };
  }
  function categories() { return cats.slice(); }
  /* 子カテゴリー（パソコン → ノートパソコン / デスクトップパソコン）。
     トップのタイルには親だけを出し、親を選んだあとの絞り込みに子を使う */
  const children = (id) => cats.filter(c => c.parent_id === id);
  /* 自分と自分の子孫。親の件数は子を足した数にする */
  function tree(id) {
    const out = [id];
    let added = true;
    while (added) {
      added = false;
      cats.forEach(c => { if (c.parent_id && out.indexOf(c.parent_id) >= 0 && out.indexOf(c.id) < 0) { out.push(c.id); added = true; } });
    }
    return out;
  }

  /* カテゴリーごとの機種数。台数ではない。
     並びも件数もマスターが決めるので、商品が0件のカテゴリーも count:0 で返る。
     マスターに無いカテゴリの商品は、ここでは数えない（公開していないため）。 */
  function categoryCounts(items) {
    const counts = {};
    (items || []).forEach(it => {
      if (it.category_id) counts[it.category_id] = (counts[it.category_id] || 0) + 1;
    });
    // トップに出すのは親だけ。件数は子（ノートパソコン・デスクトップパソコン）と
    // 親に直接ぶら下がっているもの（未分類）を足した数にする
    return cats.filter(c => !c.parent_id).map(c => ({
      id: c.id, label: c.name, icon: c.icon,
      count: tree(c.id).reduce((n, id) => n + (counts[id] || 0), 0),
      kids: children(c.id).map(k => ({ id: k.id, label: k.name, icon: k.icon, count: counts[k.id] || 0 }))
    }));
  }

  /* 商品詳細の写真。サムネイルは並べず、代表画像を1枚だけ出す
     （枚数を見せることより、どの商品かが分かることを優先する）。
     読めなければ次の候補へ差し替え、最後は「画像準備中」。 */
  function galleryHtml(it, mode) {
    const c = images(it, mode);
    if (!c.length) return `<div class="c-media dt-media">${placeholder()}</div>`;
    return `<div class="c-media dt-media"><img id="dtShot" src="${esc(c[0])}" alt="${esc(title(it))}" decoding="async" width="640" height="480" data-alt="${esc(c.slice(1).join('|'))}" onload="EightCatalog.fitShot(this)" onerror="EightCatalog.imgError(this)"></div>`;
  }
  /* 元画像より大きく引き伸ばさない。小さい写真を枠いっぱいに拡大すると粗く見えるので、
     自然サイズを上限にして中央に置く（object-fit: contain と併用） */
  function fitShot(img) {
    if (!img || !img.naturalWidth) return;
    // 枠（CSSの上限）と元画像の小さいほうに合わせる。大きい写真は枠なりに縮み、
    // 小さい写真は等倍のまま出る（引き伸ばして粗くしない）
    img.style.maxWidth = `min(100%, ${img.naturalWidth}px)`;
    img.style.maxHeight = `min(420px, ${img.naturalHeight}px)`;
    img.style.margin = '0 auto';
  }

  /* ===== 機種にまとめる =====
     同じメーカー＋型番の枝番（メモリ違い・Office有無）はカードを分けず、
     1つの機種として持つ。レンタルと販売はここで別々に集計するので、
       レンタルだけ / 販売だけ / 両方
     のどれでもカード1枚で出せる。 */
  function models(list) {
    const map = new Map();
    (list || []).forEach(it => {
      const key = it.model_key || it.code;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(it);
    });
    const rank = (x) => x.availability === 'ご案内可能' ? 0 : (x.availability === '取り寄せ可能' ? 1 : 2);
    return [...map.entries()].map(([key, v]) => {
      const rep = v.slice().sort((a, b) =>
        (rank(a) - rank(b)) ||
        ((a.rental_price_month || Infinity) - (b.rental_price_month || Infinity)))[0];
      const rPrices = v.filter(x => x.rental_enabled).map(x => x.rental_price_month).filter(x => x > 0);
      const sPrices = v.filter(x => x.sale_enabled).map(x => x.sale_price).filter(x => x > 0);
      const saleV = v.filter(x => x.sale_enabled);
      const saleAvail = saleV.some(x => x.sale_availability === '在庫あり') ? '在庫あり'
        : (saleV.some(x => x.sale_availability === '取り寄せ可能') ? '取り寄せ可能'
        : (saleV.length ? 'ご相談ください' : null));
      return {
        key, rep, variants: v,
        maker: rep.maker, model: rep.model, code: rep.code,
        category_id: rep.category_id, category_name: rep.category_name,
        title: commonName(v.map(x => title(x))) || title(rep),
        image: v.map(x => mainImage(x, 'rental')).find(Boolean) || null,
        imageOf: v.find(x => mainImage(x, 'rental')) || rep,
        // レンタル。台数は持たない（台数はお客様から伺う）
        rental: v.some(x => x.rental_enabled),
        availability: v.some(x => x.availability === 'ご案内可能') ? 'ご案内可能'
          : (v.some(x => x.availability === '取り寄せ可能') ? '取り寄せ可能' : 'ご相談ください'),
        procurement: v.some(x => x.procurement_available),
        office: v.some(x => x.office_supported),
        price: rPrices.length ? Math.min.apply(null, rPrices) : null,
        minMonths: Math.min.apply(null, v.map(x => x.rental_min_months || 1)),
        tags: [...new Set(v.reduce((a, x) => a.concat(x.rental_tags || []), []))],
        // 販売。こちらは「在庫あり／取り寄せ可能」までは出す（数量は出さない）
        sale: saleV.length > 0,
        salePrice: sPrices.length ? Math.min.apply(null, sPrices) : null,
        saleCondition: (saleV.find(x => x.sale_condition) || {}).sale_condition || null,
        saleAvailability: saleAvail
      };
    }).sort((a, b) => (({ 'ご案内可能': 0, '取り寄せ可能': 1 }[a.availability] ?? 2)
                     - ({ 'ご案内可能': 0, '取り寄せ可能': 1 }[b.availability] ?? 2))
                    || ((a.price || a.salePrice || Infinity) - (b.price || b.salePrice || Infinity)));
  }

  /* 枝番の名前の共通部分を機種名にする
     （「ProBook 450 G9 8GB」「…16GB」→「ProBook 450 G9」） */
  function commonName(names) {
    if (!names.length) return '';
    let p = names[0];
    names.slice(1).forEach(n => {
      let i = 0;
      while (i < p.length && i < n.length && p[i] === n[i]) i++;
      p = p.slice(0, i);
    });
    p = p.replace(/[\s　/・（(\-－—]+$/, '').trim();
    return p.length >= 4 ? p : '';
  }

  /* ===== 型番ページ（/products/:slug）のURL =====
     1つの型番＝1ページ。検索の言葉ごとにページを分けない。
     slug はメーカーと商品名（無ければ型番）から作る。
       HP ProBook 450 G9 → hp-probook-450-g9
     日本語や記号しか無い商品は、商品コードをそのまま使う（推測で当てない）。 */
  function slugOf(m) {
    const src = [m.maker, m.title || m.name || m.model].filter(Boolean).join(' ');
    const s = String(src)
      .replace(/[（(].*?[）)]/g, ' ')        // 括弧書きは落とす
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return s.length >= 3 ? s : String(m.code || '').toLowerCase();
  }
  /* 同じ slug が2つ以上できたときは、型番を足して分ける */
  function withSlugs(models) {
    const seen = {};
    models.forEach(m => { const s = slugOf(m); seen[s] = (seen[s] || 0) + 1; });
    return models.map(m => {
      const base = slugOf(m);
      const extra = String(m.model || m.code || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      m.slug = (seen[base] > 1 && extra && base.indexOf(extra) < 0) ? `${base}-${extra}` : base;
      return m;
    });
  }
  const productUrl = (m) => '/products/' + (m.slug || slugOf(m));

  /* ===== 商品カード（トップ・/rent・/buy で同じもの） =====
     レンタルできる商品にはレンタル欄、販売する商品には購入欄を出す。
     両方対応なら両方、片方だけなら片方だけ。
       ・レンタルは台数を出さない（「ご希望台数をお知らせください」と書く）
       ・販売は 在庫あり／取り寄せ可能 の言葉だけ（残り何台かは出さない）
       ・料金・価格が未設定なら「お見積り」と書き、金額を推測しない
     opts.href … カードの見出しから開く詳細ページ（/rent?code=… など）
     opts.show … 'both'（既定）／'rent'／'buy' */
  function cardHtml(m, opts) {
    const o = opts || {};
    const show = o.show || 'both';
    const showRent = m.rental && show !== 'buy';
    const showBuy = m.sale && show !== 'rent';
    // 型番ページ（/products/:slug）は slug だけで商品が決まるので、?code= は付けない
    // （同じページが2つのURLで見えると、検索側で重複になるため）
    const href = !o.href ? null
      : (o.href.indexOf('/products') === 0
          ? o.href
          : o.href + (o.href.indexOf('?') >= 0 ? '&' : '?') + 'code=' + encodeURIComponent(m.code));
    const spec = specLine(m.rep);
    const tag = (t, accent) => `<span class="c-tag${accent ? ' on' : ''}">${esc(t)}</span>`;
    const head = `<div class="c-name">${esc(m.title)}</div>`;
    return `<article class="p-card">
      <${href ? `a class="c-shot" href="${esc(href)}"` : 'div class="c-shot"'}>
        ${m.image
          ? `<img src="${esc(m.image)}" alt="${esc(m.title)}" loading="lazy" decoding="async" width="400" height="300"
                  data-alt="${esc(images(m.imageOf, 'rental').slice(1).join('|'))}" onerror="EightCatalog.imgError(this)">`
          : placeholder()}
      </${href ? 'a' : 'div'}>
      <div class="c-body">
        <div class="c-tags">
          ${m.category_name || catLabel(m.category_id) ? tag(m.category_name || catLabel(m.category_id)) : ''}
          ${m.office && showRent ? tag('Office対応', true) : ''}
          ${showBuy && m.saleCondition ? tag(m.saleCondition, true) : ''}
        </div>
        <div class="c-maker">${esc([m.maker, m.model].filter(Boolean).join('　'))}</div>
        ${href ? `<a class="c-link" href="${esc(href)}">${head}</a>` : head}
        ${spec ? `<div class="c-spec">${esc(spec)}</div>` : ''}
        <div class="c-offers">
          ${showRent ? `<div class="c-offer">
            <div class="c-kind rent">レンタル</div>
            <div class="c-price">${m.price
              ? `<span class="num">${yen(m.price)}</span><span class="u">円／月〜</span>`
              : '<span class="ask">月額はお見積り</span>'}</div>
            <div class="c-note">ご希望台数をお知らせください。在庫・調達状況を確認してご案内します。</div>
            <a class="c-cta ghost" href="/quote?mode=rent&amp;code=${encodeURIComponent(m.code)}&amp;from=${encodeURIComponent(o.from || 'card')}">レンタルを相談する</a>
          </div>` : ''}
          ${showBuy ? `<div class="c-offer">
            <div class="c-kind buy">購入</div>
            <div class="c-price">${m.salePrice
              ? `<span class="num">${yen(m.salePrice)}</span><span class="u">円（税抜）</span>`
              : '<span class="ask">販売価格はお見積り</span>'}</div>
            <div class="c-note">${esc(m.saleAvailability || 'ご相談ください')}${
              m.saleAvailability === '取り寄せ可能' ? '（お取り寄せでご用意します）' : ''}</div>
            <a class="c-cta lime" href="/quote?mode=buy&amp;code=${encodeURIComponent(m.code)}&amp;from=${encodeURIComponent(o.from || 'card')}">この商品を購入相談する</a>
          </div>` : ''}
        </div>
      </div>
    </article>`;
  }

  /* URL の ?code= / #code から商品コードを取る（別ページからの遷移用） */
  function codeFromUrl() {
    const p = new URLSearchParams(location.search).get('code');
    if (p) return p;
    const h = location.hash.replace(/^#/, '');
    return /^[A-Z]+-\d+$/i.test(h) ? h : null;
  }

  return { load, loadCategories, categories, children, tree, images, mainImage, mediaHtml, imgError, fitShot, availTag, availability, rental,
           models, commonName, cardHtml, placeholder, slugOf, withSlugs, productUrl,
           specLine, categoryCounts,
           galleryHtml, codeFromUrl, catLabel, catIcon, title, esc, yen, CAT_META, TAG_LABEL, SUPA_URL, SUPA_KEY, client };
})();
