/* ===================================================================
   8EC / 8RENT 共通：公開カタログの取得・画像選択・提供可能数の表示

   取得元は Supabase の公開ビュー inv_public_catalog（zaiko/setup.sql・
   zaiko/migrations/2026-09-19-public-catalog.sql）。/zaiko が管理する
   商品マスター・画像・実在庫・出品情報から、公開してよい列だけを返す。

     表示項目            → 取得元
     商品名/型番/メーカー → inventory_products
     カテゴリ名          → inventory_categories
     代表画像            → image_url（人が指定したメイン画像）→ images[0]
     8RENT用の画像       → rental_image_url / rental_images（無ければ一般画像）
     提供可能数 available → inventory_items.status = '在庫' の個体数
                            （予約中・販売予約・貸出中・修理中などは含めない）
     レンタル可否・月額   → rental_enabled / rental_price_month
     販売可否・購入先     → inventory_channel_listings（楽天に出品中で
                            登録済みURLがあるもの）。URLは推測生成しない

   このファイルは / と /rental/ の両方が読み込む。取得・画像・在庫の判定を
   画面ごとに書き分けない（ずれた表示を作らない）ための共通部品。
   =================================================================== */
window.EightCatalog = (function () {
  'use strict';

  const SUPA_URL = "https://htglvascsuqkixpmclwr.supabase.co";
  const SUPA_KEY = "sb_publishable_yZCcrwdqjuf0u_5WBWlHIw_AxdvteEV";
  const VIEW = 'inv_public_catalog';

  /* カテゴリの表示名・アイコン。id は /zaiko の inventory_categories と同じ */
  const CAT_META = {
    pc:      { icon: 'laptop_mac',      label: 'パソコン' },
    monitor: { icon: 'desktop_windows', label: 'モニター' },
    tablet:  { icon: 'tablet_mac',      label: 'タブレット' },
    phone:   { icon: 'smartphone',      label: 'スマートフォン' },
    network: { icon: 'router',          label: 'ネットワーク機器' },
    printer: { icon: 'print',           label: 'プリンター' },
    other:   { icon: 'devices_other',   label: 'その他IT機器' }
  };
  const TAG_LABEL = { recommend: 'おすすめ', popular: '人気', new: '新着' };
  const SALE_LABEL = { rakuten: '楽天市場で購入' };

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

  /* 公開カタログを読む。opts.rental=true なら rental_enabled の商品だけ。
     通信エラーは items=[] ではなく error で返す（「在庫0」と混同しない） */
  async function load(opts) {
    const c = client();
    if (!c) return { items: [], error: new Error('接続の初期化に失敗しました') };
    const { data, error } = await c.from(VIEW).select('*');
    if (error) return { items: [], error };
    let items = (data || []).slice();
    if (opts && opts.rental) items = items.filter(it => it.rental_enabled);
    items.sort((a, b) => String(a.name || a.model || '').localeCompare(String(b.name || b.model || ''), 'ja'));
    return { items, error: null };
  }

  function catLabel(id) { return (CAT_META[id] || {}).label || id || ''; }
  function catIcon(id) { return (CAT_META[id] || {}).icon || 'devices_other'; }
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

  /* 表示に使う画像の候補を順番に返す（重複なし）。
       mode='rental' … 8RENT向け画像 → 一般画像
       それ以外       … 一般画像（メイン → 一覧）→ 8RENT向け画像 */
  function images(it, mode) {
    const list = [];
    const push = (u) => { const v = validUrl(u); if (v && list.indexOf(v) < 0) list.push(v); };
    const general = () => { push(it.image_url); (Array.isArray(it.images) ? it.images : []).forEach(push); };
    const rental = () => { push(it.rental_image_url); (Array.isArray(it.rental_images) ? it.rental_images : []).forEach(push); };
    if (mode === 'rental') { rental(); general(); } else { general(); rental(); }
    return list;
  }

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

  /* 提供可能数の表示。0 は「在庫切れ」、少なければ残り台数 */
  function availTag(n) {
    if (n > 3) return `<span class="c-avail ok">在庫あり</span>`;
    if (n > 0) return `<span class="c-avail few">残り${n}台</span>`;
    return `<span class="c-avail none">在庫切れ</span>`;
  }

  /* 購入できるか（楽天に出品中で登録済みURLがある）。価格は出品先の販売価格 */
  function sale(it) {
    if (!it.sale_enabled || !validUrl(it.sale_url)) return null;
    return { label: SALE_LABEL[it.sale_channel] || '購入する', url: it.sale_url, price: it.sale_price, channel: it.sale_channel };
  }
  /* レンタルできるか（公開設定ON）。申込できるかは提供可能数で別に判定する */
  function rental(it) {
    if (!it.rental_enabled) return null;
    return { price: it.rental_price_month, minMonths: it.rental_min_months || 1 };
  }

  function specLine(it) {
    const parts = [it.cpu, it.memory_size ? it.memory_size + (it.storage_capacity ? '' : '') : '',
      it.storage_capacity ? [it.storage_capacity, it.storage_type].filter(Boolean).join(' ') : '',
      it.screen_size, it.os].filter(Boolean);
    return parts.length ? parts.join('／') : (it.spec || '');
  }

  /* カテゴリごとの商品数（機種数）。台数ではない */
  function categoryCounts(items) {
    const counts = {};
    items.forEach(it => { if (it.category_id) counts[it.category_id] = (counts[it.category_id] || 0) + 1; });
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a]).map(id => ({ id, label: catLabel(id), icon: catIcon(id), count: counts[id] }));
  }

  /* 商品カード。opts.mode='rental' なら8RENT向け画像と申込導線、それ以外は購入／レンタルの両導線。
       opts.onDetail(code) … 詳細を開く関数名（文字列）
       opts.rentalHref(code) … レンタルページへの遷移先を作る関数
       opts.qty … 必要台数。提供可能数がこれに満たない商品には購入／レンタルのボタンを出さない */
  function cardHtml(it, opts) {
    opts = opts || {};
    const mode = opts.mode || 'top';
    const name = esc(title(it));
    const tags = (it.rental_tags || []).map(t => `<span>${esc(TAG_LABEL[t] || t)}</span>`).join('');
    const need = Math.max(1, Number(opts.qty || 1));
    const avail = Number(it.available || 0);
    const enough = avail >= need;
    const s = sale(it), r = rental(it);
    const badges = [
      it.office_supported ? `<span><span class="ms">description</span>Office対応</span>` : '',
      it.trial_eligible && r ? `<span><span class="ms">verified</span>お試し対象</span>` : ''
    ].filter(Boolean).join('');
    const spec = specLine(it);

    let prices = '';
    if (mode === 'rental') {
      prices = r && r.price
        ? `<div class="c-price"><span class="month num"><span class="yen">¥</span>${yen(r.price)}</span><span class="unit"> /月（税別）〜${r.minMonths}ヶ月</span></div>`
        : `<div class="c-noprice">料金はお問い合わせください</div>`;
    } else {
      const rows = [];
      if (s) rows.push(`<div class="c-row"><span class="c-k">購入</span>${s.price ? `<span class="month num"><span class="yen">¥</span>${yen(s.price)}</span><span class="unit"> ${esc(s.label)}</span>` : `<span class="unit">${esc(s.label)}</span>`}</div>`);
      if (r) rows.push(`<div class="c-row"><span class="c-k">レンタル</span>${r.price ? `<span class="month num"><span class="yen">¥</span>${yen(r.price)}</span><span class="unit"> /月（税別）〜${r.minMonths}ヶ月</span>` : `<span class="unit">月額はお問い合わせください</span>`}</div>`);
      prices = rows.length ? `<div class="c-price">${rows.join('')}</div>` : `<div class="c-noprice">価格はお問い合わせください</div>`;
    }

    let actions = '';
    const detail = opts.onDetail ? `<button type="button" class="btn sm" onclick="event.stopPropagation();${opts.onDetail}('${esc(it.code)}')">詳細を見る</button>` : '';
    if (mode === 'rental') {
      actions = detail + (enough && r
        ? `<button type="button" class="btn sm lime" onclick="event.stopPropagation();${opts.onDetail}('${esc(it.code)}')">申し込む</button>`
        : '');
    } else {
      const buy = s && enough
        ? `<a class="btn sm lime" href="${esc(s.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(s.label)}</a>` : '';
      const rent = r && enough && opts.rentalHref
        ? `<a class="btn sm ${buy ? '' : 'lime'}" href="${esc(opts.rentalHref(it.code))}" onclick="event.stopPropagation()">レンタルする</a>` : '';
      actions = detail + buy + rent;
    }

    return `<article class="card" data-code="${esc(it.code)}" ${opts.onDetail ? `onclick="${opts.onDetail}('${esc(it.code)}')"` : ''}>
    <div class="c-media">${mediaHtml(it, mode)}${tags ? `<div class="c-tags">${tags}</div>` : ''}${availTag(avail)}${it.category_id ? `<span class="c-catbadge">${esc(catLabel(it.category_id))}</span>` : ''}</div>
    <div class="c-body">
      ${it.maker ? `<p class="c-maker">${esc(it.maker)}${it.model && it.model !== it.name ? '　' + esc(it.model) : ''}</p>` : (it.model && it.model !== it.name ? `<p class="c-maker">${esc(it.model)}</p>` : '')}
      <h3 class="c-name">${name}</h3>
      ${spec ? `<p class="c-spec">${esc(spec)}</p>` : ''}
      ${badges ? `<div class="c-badges">${badges}</div>` : ''}
      ${prices}
      ${actions ? `<div class="c-actions">${actions}</div>` : ''}
    </div>
  </article>`;
  }

  /* 商品詳細のギャラリー（写真が複数あるときだけサムネイルを並べる） */
  function galleryHtml(it, mode) {
    const c = images(it, mode);
    if (!c.length) return `<div class="c-media dt-media">${placeholder()}</div>`;
    const main = `<div class="c-media dt-media"><img id="dtShot" src="${esc(c[0])}" alt="${esc(title(it))}" decoding="async" width="640" height="480" data-alt="${esc(c.slice(1).join('|'))}" onerror="EightCatalog.imgError(this)"></div>`;
    if (c.length < 2) return main;
    return main + `<div class="dt-shots">${c.map((u, i) =>
      `<button type="button" class="${i === 0 ? 'on' : ''}" onclick="EightCatalog.showShot('${esc(u)}',this)" aria-label="写真${i + 1}"><img src="${esc(u)}" alt="" loading="lazy" onerror="this.parentNode.remove()"></button>`).join('')}</div>`;
  }
  function showShot(url, btn) {
    const img = document.getElementById('dtShot');
    if (img) { img.removeAttribute('data-alt'); img.src = url; }
    if (btn && btn.parentNode) { [...btn.parentNode.children].forEach(b => b.classList.remove('on')); btn.classList.add('on'); }
  }

  /* URL の ?code= / #code から商品コードを取る（別ページからの遷移用） */
  function codeFromUrl() {
    const p = new URLSearchParams(location.search).get('code');
    if (p) return p;
    const h = location.hash.replace(/^#/, '');
    return /^[A-Z]+-\d+$/i.test(h) ? h : null;
  }

  return { load, images, mediaHtml, imgError, availTag, sale, rental, specLine, categoryCounts, cardHtml,
           galleryHtml, showShot, codeFromUrl, catLabel, catIcon, title, esc, yen, CAT_META, TAG_LABEL, SUPA_URL, SUPA_KEY, client };
})();
