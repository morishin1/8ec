/* ===================================================================
   型番ページ（/products/:slug）の中身。

   考えかた
     ・1つの型番＝1ページ。「型番 価格」「型番 中古」「型番 レンタル」などは
       すべてこの1ページで受ける。言葉ごとにページを作らない。
     ・出すのは /zaiko に登録してある事実と、その事実から言える選び方だけ。
       「最安値」のような確かめられない言い切りはしない。
     ・在庫が0でも、ページは消さずに「同等スペックをお探しします」で相談につなぐ。
   =================================================================== */
(function () {
  'use strict';
  var C = window.EightCatalog;
  var $ = function (id) { return document.getElementById(id); };
  var esc = C.esc, yen = C.yen;

  function track(name, extra) {
    try {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push(Object.assign({ event: name, page: 'product' }, extra || {}));
    } catch (_) { /* 計測でページを壊さない */ }
  }

  // /products/hp-probook-450-g9 → hp-probook-450-g9
  // 末尾の .html も落とす（本番はrewriteで拡張子なし、ローカル確認では .html になるため）
  var path = location.pathname.replace(/\.html$/, '');
  var slug = decodeURIComponent(path.replace(/^\/products\/?/, '').replace(/\/$/, '')).toLowerCase();

  /* ---- 事実から言えることだけを書く ---- */
  function useFor(rep) {
    var out = [];
    var mem = parseInt(String(rep.memory_size || '').replace(/[^\d]/g, ''), 10) || 0;
    var cpu = String(rep.cpu || '');
    var screen = parseFloat(String(rep.screen_size || '').replace(/[^\d.]/g, '')) || 0;
    if (/i7|i9|Ryzen 7|Ryzen 9|M[23]\s*(Pro|Max)/i.test(cpu) || mem >= 32) {
      out.push('設計・開発・動画編集など、処理の重い作業にも向きます。');
    } else if (/i5|Ryzen 5|M[123]/i.test(cpu) || mem >= 16) {
      out.push('表計算・資料作成・オンライン会議を同時に開いても余裕がある構成です。');
    } else if (cpu) {
      out.push('メール・資料作成・社内システムなど、事務作業を中心とした用途に向きます。');
    }
    if (mem && mem <= 8) out.push('メモリは' + rep.memory_size + 'です。会議アプリとブラウザを多数開く使い方なら、16GB以上もご相談ください。');
    if (screen && screen <= 13.3) out.push('持ち運びやすい画面サイズです。外出・訪問の多い部署に向きます。');
    else if (screen && screen >= 15) out.push('画面が大きく、据え置きで長時間使う席に向きます。');
    if (rep.numpad) out.push('テンキー付きなので、数値入力の多い経理・受発注の業務に向きます。');
    if (rep.webcam) out.push('カメラ内蔵で、オンライン会議をそのまま始められます。');
    return out;
  }

  function checkPoints(m) {
    var rep = m.rep, out = [];
    out.push('Officeの有無は選べます。' + (m.office ? 'この機種はOffice付きでのご用意も確認できています。' : 'ご希望をお知らせいただければ、Office付きでご用意できるかを確認してご案内します。'));
    out.push('台数がまとまる場合は、キッティング（初期設定・アカウント作成・セキュリティ設定）まで含めてお見積りできます。');
    if (m.saleCondition) out.push('この商品の状態は「' + m.saleCondition + '」です。' + (m.saleCondition === '整備済み' ? '動作確認・清掃・初期化を済ませたうえでお渡しします。' : ''));
    out.push('納品後の故障や交換のご相談も承ります（レンタルは 8RENT Care の対象です）。');
    return out;
  }

  /* 購入とレンタル、どちらが向くか。料金が分かるときだけ金額に触れる */
  function buyOrRent(m) {
    var rows = [];
    var buy = m.sale ? (m.salePrice ? yen(m.salePrice) + ' 円（税抜）' : 'お見積り') : null;
    var rent = m.rental ? (m.price ? yen(m.price) + ' 円／月（税抜）〜' : 'お見積り') : null;
    if (buy) {
      rows.push({ kind: 'buy', label: '購入', price: buy, points: [
        '3年以上など、長く使う予定がある',
        '資産として持ちたい・社内の標準機にしたい',
        '台数が増えても構成をそろえたい'
      ] });
    }
    if (rent) {
      rows.push({ kind: 'rent', label: 'レンタル', price: rent, points: [
        '利用期間が決まっている（1ヶ月〜）',
        '増員や短期プロジェクトで台数が変わる',
        '返却・データ消去までまとめて任せたい'
      ] });
    }
    if (m.sale && m.rental && m.salePrice && m.price) {
      var months = Math.ceil(m.salePrice / m.price);
      rows.monthsNote = '目安として、' + months + 'ヶ月ぶんのレンタル料が購入価格と同じくらいになります'
        + '（設定費用・返却費用は含みません。実際の金額はお見積りでご案内します）。';
    }
    return rows;
  }

  /* 同等機種。同じカテゴリで、CPUの系統かメモリが近いものを実データから出す */
  function similar(m, all) {
    var mem = function (x) { return parseInt(String(x.rep.memory_size || '').replace(/[^\d]/g, ''), 10) || 0; };
    var fam = function (x) { var c = String(x.rep.cpu || ''); var t = c.match(/i[3579]|Ryzen \d|M\d/i); return t ? t[0].toLowerCase() : ''; };
    return all.filter(function (x) { return x.key !== m.key && x.category_id === m.category_id; })
      .map(function (x) {
        var score = 0;
        if (fam(x) && fam(x) === fam(m)) score += 2;
        if (mem(x) && mem(x) === mem(m)) score += 1;
        if (x.maker === m.maker) score += 1;
        return { m: x, score: score };
      })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, 3).map(function (x) { return x.m; });
  }

  function specRows(m) {
    var r = m.rep;
    return [
      ['メーカー', m.maker],
      ['型番（MPN）', m.model],
      ['商品コード', m.code],
      ['CPU', [r.cpu, r.cpu_gen].filter(Boolean).join(' ')],
      ['メモリ', r.memory_size],
      ['ストレージ', [r.storage_capacity, r.storage_type].filter(Boolean).join(' ')],
      ['画面サイズ', r.screen_size],
      ['OS', r.os],
      ['Office', m.office ? 'ご用意できます（ご希望をお知らせください）' : 'ご希望に応じて確認します'],
      ['カメラ', r.webcam ? 'あり' : ''],
      ['テンキー', r.numpad ? 'あり' : ''],
      ['無線', [r.wifi ? 'Wi-Fi' : '', r.bluetooth ? 'Bluetooth' : ''].filter(Boolean).join(' / ')],
      ['付属品', r.accessories],
      ['状態', m.saleCondition || r.condition_note]
    ].filter(function (x) { return x[1]; });
  }

  /* 構造化データ。価格が分かっているときだけ offers を入れる（推測で入れない） */
  function jsonLd(m) {
    var d = {
      '@context': 'https://schema.org', '@type': 'Product',
      name: [m.maker, m.title].filter(Boolean).join(' '),
      sku: m.code,
      category: m.category_name || undefined,
      description: (m.rep.rental_description || '').split('\n')[0] || undefined
    };
    if (m.maker) d.brand = { '@type': 'Brand', name: m.maker };
    if (m.model) d.mpn = m.model;
    if (m.image) d.image = [location.origin + m.image.replace(location.origin, '')];
    if (m.sale && m.salePrice) {
      d.offers = {
        '@type': 'Offer', priceCurrency: 'JPY', price: String(m.salePrice),
        availability: m.saleAvailability === '在庫あり'
          ? 'https://schema.org/InStock' : 'https://schema.org/PreOrder',
        url: location.href,
        seller: { '@type': 'Organization', name: 'COMMERCE（株式会社エイト）' }
      };
    }
    var crumb = {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'COMMERCE', item: location.origin + '/' },
        { '@type': 'ListItem', position: 2, name: '商品', item: location.origin + '/products' },
        { '@type': 'ListItem', position: 3, name: [m.maker, m.title].filter(Boolean).join(' '), item: location.href }
      ]
    };
    var el = document.createElement('script');
    el.type = 'application/ld+json';
    el.textContent = JSON.stringify([d, crumb]);
    document.head.appendChild(el);
  }

  function setMeta(m) {
    var title = [m.maker, m.title].filter(Boolean).join(' ');
    var spec = C.specLine(m.rep);
    var price = [];
    if (m.sale) price.push(m.salePrice ? '法人販売価格 ' + yen(m.salePrice) + '円（税抜）' : '販売価格はお見積り');
    if (m.rental) price.push(m.price ? 'レンタル月額 ' + yen(m.price) + '円〜' : 'レンタル料金はお見積り');
    document.title = title + '｜法人向けの価格・スペック・レンタル｜COMMERCE';
    var desc = title + 'の法人向け情報です。' + (spec ? spec + '。' : '')
      + (price.length ? price.join('／') + '。' : '')
      + 'キッティング・Office・セキュリティ設定までまとめてご依頼いただけます。在庫にない場合も同等スペックをお探しします。';
    var set = function (sel, attr, val) { var e = document.querySelector(sel); if (e) e.setAttribute(attr, val); };
    set('meta[name="description"]', 'content', desc);
    set('meta[property="og:title"]', 'content', title + '｜COMMERCE');
    set('meta[property="og:description"]', 'content', desc.slice(0, 110));
    set('link[rel="canonical"]', 'href', location.origin + '/products/' + (m.slug || ''));
    set('meta[property="og:url"]', 'content', location.origin + '/products/' + (m.slug || ''));
  }

  function crumbHtml(m) {
    return '<a href="/">COMMERCE</a>　›　<a href="/products">商品</a>'
      + (m ? '　›　' + esc([m.maker, m.title].filter(Boolean).join(' ')) : '');
  }

  /* ---- 描く ---- */
  function renderDetail(m, all) {
    setMeta(m); jsonLd(m);
    $('crumb').innerHTML = crumbHtml(m);
    var vs = buyOrRent(m);
    var uses = useFor(m.rep);
    var sim = similar(m, all);
    var title = [m.maker, m.title].filter(Boolean).join(' ');
    $('host').innerHTML =
      '<div class="c-wrap">'
      + '<div class="pt-head">'
        + '<div class="pt-shot">' + (m.image
            ? '<img src="' + esc(m.image) + '" alt="' + esc(title) + '" width="640" height="480" decoding="async">'
            : C.placeholder()) + '</div>'
        + '<div class="pt-main">'
          + '<div class="pt-maker">' + esc(m.maker || '') + '</div>'
          + '<h1>' + esc(title) + '</h1>'
          + '<div class="pt-tags">'
            + (m.category_name ? '<span>' + esc(m.category_name) + '</span>' : '')
            + (m.model ? '<span>型番 ' + esc(m.model) + '</span>' : '')
            + (m.saleCondition ? '<span class="on">' + esc(m.saleCondition) + '</span>' : '')
            + (m.rental ? '<span class="on">レンタル可</span>' : '')
            + (m.sale ? '<span class="on">購入可</span>' : '')
          + '</div>'
          + '<div class="pt-price">'
            + (m.sale ? '<div><div class="k">法人販売価格（税抜）</div><div class="v' + (m.salePrice ? '' : ' ask') + '">'
                + (m.salePrice ? '<span class="num">' + yen(m.salePrice) + '</span> 円' : '販売価格はお見積り') + '</div></div>' : '')
            + (m.rental ? '<div><div class="k">レンタル（税抜）</div><div class="v' + (m.price ? '' : ' ask') + '">'
                + (m.price ? '<span class="num">' + yen(m.price) + '</span> 円／月〜' : '月額はお見積り') + '</div></div>' : '')
            + '<div><div class="k">ご用意</div><div class="v ask">'
                + esc(m.sale ? (m.saleAvailability || 'ご相談ください') : m.availability) + '</div></div>'
          + '</div>'
          + '<div class="pt-cta">'
            + (m.sale ? '<a class="c-cta sm" href="/quote?mode=buy&code=' + encodeURIComponent(m.code)
                + '&from=' + encodeURIComponent('product:' + (m.slug || '')) + '" data-lead="product-buy">購入を相談する</a>' : '')
            + (m.rental ? '<a class="c-cta sm ghost" href="/quote?mode=rent&code=' + encodeURIComponent(m.code)
                + '&from=' + encodeURIComponent('product:' + (m.slug || '')) + '" data-lead="product-rent">レンタルを相談する</a>' : '')
            + '<a class="c-cta sm ghost" href="/quote?code=' + encodeURIComponent(m.code)
              + '&from=' + encodeURIComponent('product:' + (m.slug || '')) + '" data-lead="product-diagnosis">3分で無料診断</a>'
          + '</div>'
          + '<p class="pt-note">価格は1台あたり・税抜です。台数・構成・納期によって変わるため、'
            + 'お見積りで正式にご案内します。最安値をうたうことはしていません。</p>'
        + '</div>'
      + '</div>'

      + '<div class="c-sec" style="padding-left:0;padding-right:0">'
        + '<h2 class="c-h2">スペック</h2>'
        + '<table class="spec"><tbody>'
        + specRows(m).map(function (r) { return '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td></tr>'; }).join('')
        + '</tbody></table>'
        + (m.rep.rental_description ? '<p class="pt-note" style="margin-top:14px;white-space:pre-wrap">' + esc(m.rep.rental_description) + '</p>' : '')
      + '</div>'

      + (uses.length ? '<div class="c-sec" style="padding-left:0;padding-right:0">'
          + '<h2 class="c-h2">どんな仕事に向いているか</h2>'
          + '<ul class="pt-list">' + uses.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>'
        + '</div>' : '')

      + '<div class="c-sec" style="padding-left:0;padding-right:0">'
        + '<h2 class="c-h2">法人で使うときに見るところ</h2>'
        + '<ul class="pt-list">' + checkPoints(m).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>'
      + '</div>'

      + (vs.length ? '<div class="c-sec" style="padding-left:0;padding-right:0">'
          + '<h2 class="c-h2">購入とレンタル、どちらが向くか</h2>'
          + '<div class="pt-vs">' + vs.map(function (v) {
              return '<div class="c-card ' + v.kind + '"><h3><span>' + esc(v.label) + '</span>' + esc(v.price) + '</h3>'
                + '<ul class="pt-list" style="margin-top:10px">' + v.points.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul></div>';
            }).join('') + '</div>'
          + (vs.monthsNote ? '<p class="pt-note">' + esc(vs.monthsNote) + '</p>' : '')
          + '<p class="pt-note">どちらが合うか分からない場合は、利用期間と台数をお知らせいただければ'
            + '<a href="/quote" data-lead="product-vs">3分の診断</a>でご提案します。</p>'
        + '</div>' : '')

      + (sim.length ? '<div class="c-sec" style="padding-left:0;padding-right:0">'
          + '<h2 class="c-h2">同等スペックの機種</h2>'
          + '<p class="c-lede">同じカテゴリーで、構成が近いものです。ご希望の型番が手配できないときは、'
            + 'こうした機種からご提案します。</p>'
          + '<div class="p-grid" style="margin-top:16px">'
          + sim.map(function (x) { return C.cardHtml(x, { href: C.productUrl(x) }); }).join('')
          + '</div></div>' : '')

      + '<div class="c-sec" style="padding-left:0;padding-right:0">'
        + '<div class="pt-miss">'
          + '<h2>この型番でなくても大丈夫です。</h2>'
          + '<p>台数がまとまらない、納期が合わない、といった場合でも、同等スペックの機種を含めてお探しします。'
            + '新品のお取り寄せもご相談いただけます。ご希望の台数と時期をお知らせください。</p>'
          + '<a class="c-cta" href="/quote?from=' + encodeURIComponent('product:' + (m.slug || ''))
            + '" data-lead="product-similar">同等スペックも含めて探してもらう</a>'
        + '</div>'
      + '</div>'
      + '</div>';
    track('product_view', { slug: m.slug, code: m.code, rental: !!m.rental, sale: !!m.sale });
  }

  function renderMissing(all) {
    $('crumb').innerHTML = crumbHtml(null);
    document.title = 'お探しの型番｜法人向けの調達相談｜COMMERCE';
    var rm = document.querySelector('meta[name="robots"]');
    if (rm) rm.setAttribute('content', 'noindex,follow');   // 中身の無いページは検索に出さない
    $('host').innerHTML = '<div class="c-wrap"><div class="c-sec" style="padding-left:0;padding-right:0">'
      + '<div class="pt-miss">'
        + '<h2>' + (slug ? esc(slug) + ' ' : '') + 'この型番または同等スペックをお探しします。</h2>'
        + '<p>いまこのページに掲載はありませんが、取り扱いが無いという意味ではありません。'
          + '自社の在庫と、国内大手ITディストリビューターからの調達を組み合わせてご用意できます。'
          + '型番が決まっていない場合も、用途と台数からご提案します。</p>'
        + '<a class="c-cta" href="/quote" data-lead="product-missing">3分で無料診断</a>'
      + '</div></div>'
      + '<div class="c-sec" style="padding-left:0;padding-right:0"><h2 class="c-h2">いま掲載している商品</h2>'
      + '<div class="p-grid" style="margin-top:16px">'
      + all.slice(0, 6).map(function (x) { return C.cardHtml(x, { href: C.productUrl(x) }); }).join('')
      + '</div></div></div>';
    track('product_missing', { slug: slug });
  }

  function renderIndex(all) {
    $('crumb').innerHTML = crumbHtml(null);
    $('host').innerHTML = '<div class="c-wrap"><div class="c-sec" style="padding-left:0;padding-right:0">'
      + '<div class="c-eyebrow">PRODUCTS</div><h1 class="c-h2">商品を型番から探す</h1>'
      + '<p class="c-lede">型番ごとに、スペック・法人販売価格・レンタル料金・購入とレンタルの向き不向きをまとめています。'
        + 'ここに無い型番も、同等スペックを含めてお探しします。</p>'
      + '<div class="p-grid" style="margin-top:20px">'
      + all.map(function (x) { return C.cardHtml(x, { href: C.productUrl(x) }); }).join('')
      + '</div></div></div>';
  }

  (async function main() {
    if (!C || !C.client()) {
      $('host').innerHTML = '<div class="c-wrap"><div class="p-state err">接続の初期化に失敗しました。時間をおいて再読み込みしてください。</div></div>';
      return;
    }
    await C.loadCategories();
    var res = await C.load();
    if (res.error) {
      $('host').innerHTML = '<div class="c-wrap"><div class="p-state err">商品の読み込みに失敗しました。時間をおいて再読み込みしてください。</div></div>';
      return;
    }
    var all = C.withSlugs(C.models(res.items));
    if (!slug) return renderIndex(all);
    var m = all.find(function (x) { return x.slug === slug; })
         || all.find(function (x) { return String(x.code || '').toLowerCase() === slug; });
    if (m) renderDetail(m, all); else renderMissing(all);
  })();
})();
