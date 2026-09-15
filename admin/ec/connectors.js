/* ========================================================================
   モールコネクタ ―― モールごとの違いをここだけに閉じ込める。

   画面（admin/ec/index.html）はモール名を知らずに動く。
   モールを増やすときは、このファイルに1つオブジェクトを足すだけでよい。

   Phase 1 で通すのはCSVの出力と取り込み。APIは各コネクタの api に
   あとから足す（楽天RMS・Amazon SP-API・Yahoo は申請と審査に時間がかかるため、
   先にCSVで運用できる形にしてある）。

   列名について：
     モールのCSVテンプレートは、契約プランや店舗によって列が増減する。
     ここに書いてあるのは主要列で、そのまま通る保証はない。
     画面の「ヘッダー照合」に実物のテンプレートを読ませると、
     食い違っている列を出すようにしてある。まずそれで確かめること。
   ======================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- CSV入出力
     読み書きそのものは assets/csv.js（管理画面で共通）。ここではモール固有の
     事情——タブ区切りと、出力時の Shift_JIS 変換——だけを足す。 */

  var parseCsv   = function (text, sep) { return window.EightCsv.parse(text, sep); };
  var buildCsv   = function (rows, sep) { return window.EightCsv.build(rows, sep); };
  var decodeBytes = function (buf) { return window.EightCsv.decode(buf); };

  /* 文字列をファイルにする。Shift_JIS は cp932.js の変換表で書く
     （ブラウザは Shift_JIS を読めても書けないため）。 */
  function toBlob(text, encoding) {
    if (encoding === 'shift_jis' && window.EightCP932) {
      return {
        blob: new Blob([window.EightCP932.encode(text)], { type: 'text/csv' }),
        unmappable: window.EightCP932.unmappable(text)
      };
    }
    // UTF-8。Excelでそのまま開けるようBOMを付ける
    return { blob: new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }), unmappable: [] };
  }

  /* ---------------------------------------------------------------- 値の取り出し */

  var num = function (v) {
    if (v === '' || v == null) return null;
    var n = Number(String(v).replace(/[,¥\s]/g, ''));
    return isFinite(n) ? n : null;
  };
  var int0 = function (v) { var n = num(v); return n == null ? null : Math.round(n); };
  var s = function (v) { return v == null ? '' : String(v); };

  /* 出品行の値。モール個別の設定が空ならマスターの値に落とす */
  function title(p, l) { return (l && l.title) || p.name || ''; }
  function price(p, l) { return (l && l.price != null && l.price !== '') ? l.price : (p.price != null ? p.price : ''); }
  function desc(p, l) { return (l && l.description) || p.description || ''; }
  function ship(p, l) { return (l && l.shipping_fee != null && l.shipping_fee !== '') ? l.shipping_fee : (p.shipping_fee != null ? p.shipping_fee : ''); }
  function img(p, n) { var a = p.image_urls || []; return a[n] || ''; }

  /* ---------------------------------------------------------------- コネクタ */

  /* 8EC（自社）。全項目を持つ形。取り込みもこの形で受ける */
  var EC8 = {
    key: '8ec', label: '8EC（自社）', short: '8EC', color: '#2479e9', phase: 1,
    help: '自社ショップ用。商品マスターの全項目をそのまま出し入れします。バックアップにも使えます。',
    csv: {
      encoding: 'utf-8', sep: ',',
      filename: function (ymd) { return '8ec-products-' + ymd + '.csv'; },
      columns: [
        { h: 'SKU', v: function (p) { return p.sku; } },
        { h: 'JANコード', v: function (p) { return s(p.jan); } },
        { h: '商品名', v: function (p) { return p.name; } },
        { h: 'メーカー', v: function (p) { return s(p.maker); } },
        { h: '型番', v: function (p) { return s(p.model); } },
        { h: 'カテゴリ', v: function (p) { return s(p.category); } },
        { h: '商品状態', v: function (p) { return s(p.condition); } },
        { h: '仕入価格', v: function (p) { return s(p.cost); } },
        { h: '販売価格', v: function (p) { return s(p.price); } },
        { h: '最低販売価格', v: function (p) { return s(p.min_price); } },
        { h: '送料', v: function (p) { return s(p.shipping_fee); } },
        { h: '在庫数', v: function (p) { return p.stock; } },
        { h: '安全在庫', v: function (p) { return p.safety_stock; } },
        { h: '保証内容', v: function (p) { return s(p.warranty); } },
        { h: 'スペック', v: function (p) { return s(p.spec); } },
        { h: '商品説明', v: function (p) { return s(p.description); } },
        { h: 'SEOキーワード', v: function (p) { return s(p.seo_keywords); } },
        { h: '商品画像URL', v: function (p) { return (p.image_urls || []).join(' '); } },
        { h: 'CPU', v: function (p) { return s(p.cpu); } },
        { h: 'メモリ', v: function (p) { return s(p.memory); } },
        { h: 'ストレージ', v: function (p) { return s(p.storage); } },
        { h: 'OS', v: function (p) { return s(p.os); } },
        { h: 'Office', v: function (p) { return s(p.office); } },
        { h: '画面サイズ', v: function (p) { return s(p.screen_size); } },
        { h: 'バッテリー', v: function (p) { return s(p.battery); } },
        { h: '傷ランク', v: function (p) { return s(p.grade); } },
        { h: '付属品', v: function (p) { return s(p.accessories); } },
        { h: '取扱状態', v: function (p) { return p.status; } },
        { h: 'メモ', v: function (p) { return s(p.note); } }
      ],
      keyField: ['SKU', 'sku', '商品コード'],
      fields: {
        jan: { h: ['JANコード', 'JAN'], t: s },
        name: { h: ['商品名'], t: s },
        maker: { h: ['メーカー'], t: s },
        model: { h: ['型番'], t: s },
        category: { h: ['カテゴリ', '種別'], t: s },
        condition: { h: ['商品状態'], t: s },
        cost: { h: ['仕入価格', '原価'], t: num },
        price: { h: ['販売価格'], t: num },
        min_price: { h: ['最低販売価格'], t: num },
        shipping_fee: { h: ['送料'], t: num },
        stock: { h: ['在庫数', '在庫'], t: int0 },
        safety_stock: { h: ['安全在庫'], t: int0 },
        warranty: { h: ['保証内容', '保証'], t: s },
        spec: { h: ['スペック'], t: s },
        description: { h: ['商品説明'], t: s },
        seo_keywords: { h: ['SEOキーワード'], t: s },
        cpu: { h: ['CPU'], t: s },
        memory: { h: ['メモリ'], t: s },
        storage: { h: ['ストレージ', 'SSD', 'HDD'], t: s },
        os: { h: ['OS'], t: s },
        office: { h: ['Office'], t: s },
        screen_size: { h: ['画面サイズ'], t: s },
        battery: { h: ['バッテリー'], t: s },
        grade: { h: ['傷ランク', 'ランク'], t: s },
        accessories: { h: ['付属品'], t: s },
        status: { h: ['取扱状態'], t: s },
        note: { h: ['メモ', '備考'], t: s },
        image_urls: { h: ['商品画像URL', '画像URL'], t: function (v) { return s(v).split(/[\s,]+/).filter(Boolean); } }
      }
    }
  };

  /* 楽天市場。RMS「商品一括編集」の item.csv を想定した主要列 */
  var RAKUTEN = {
    key: 'rakuten', label: '楽天市場', short: '楽天', color: '#bf0000', phase: 1,
    help: 'RMS「商品一括編集」の item.csv を想定しています。列の構成は店舗の契約により違うので、'
        + '最初の1回はRMSから実物をダウンロードして「ヘッダー照合」で確かめてください。'
        + '文字コードは Shift_JIS で出力します。',
    csv: {
      encoding: 'shift_jis', sep: ',',
      filename: function (ymd) { return 'rakuten-item-' + ymd + '.csv'; },
      columns: [
        // コントロールカラム。u=更新、n=新規。既存商品の更新を既定にする
        { h: 'コントロールカラム', v: function (p, l) { return (l && l.mall_item_id) ? 'u' : 'n'; } },
        { h: '商品管理番号（商品URL）', v: function (p, l) { return (l && l.mall_item_id) || p.sku; } },
        { h: '商品番号', v: function (p) { return p.sku; } },
        { h: '全商品ディレクトリID', v: function (p, l) { return s(l && l.mall_category); } },
        { h: '商品名', v: function (p, l) { return title(p, l); } },
        { h: '販売価格', v: function (p, l) { return price(p, l); } },
        { h: '表示価格', v: function () { return ''; } },
        { h: '消費税', v: function () { return '1'; } },          // 1=税込表示
        { h: '送料', v: function (p, l) { return Number(ship(p, l) || 0) > 0 ? '1' : '0'; } },  // 0=送料込み 1=別
        { h: '個別送料', v: function (p, l) { return ship(p, l); } },
        { h: '在庫タイプ', v: function () { return '2'; } },       // 2=通常在庫
        { h: '在庫数', v: function (p) { return p.stock; } },
        { h: '在庫数表示', v: function () { return '1'; } },
        { h: 'PC用キャッチコピー', v: function (p) { return s(p.spec).slice(0, 174); } },
        { h: 'PC用商品説明文', v: function (p, l) { return desc(p, l); } },
        { h: 'スマートフォン用商品説明文', v: function (p, l) { return desc(p, l); } },
        { h: '商品画像URL', v: function (p) { return (p.image_urls || []).slice(0, 20).join(' '); } },
        { h: '商品画像名（ALT）', v: function (p, l) { return title(p, l); } },
        { h: 'JANコード', v: function (p) { return s(p.jan); } },
        { h: 'カタログIDなしの理由', v: function (p) { return p.jan ? '' : '4'; } }
      ],
      keyField: ['商品管理番号（商品URL）', '商品管理番号', '商品番号', 'SKU'],
      fields: {
        name: { h: ['商品名', 'PC用商品名'], t: s, to: 'listing.title' },
        price: { h: ['販売価格'], t: num, to: 'listing.price' },
        stock: { h: ['在庫数'], t: int0, to: 'product.stock' },
        jan: { h: ['JANコード'], t: s, to: 'product.jan' },
        mall_category: { h: ['全商品ディレクトリID', 'ジャンルID'], t: s, to: 'listing.mall_category' },
        mall_item_id: { h: ['商品管理番号（商品URL）', '商品管理番号'], t: s, to: 'listing.mall_item_id' }
      }
    },
    api: null   // RMS WEB SERVICE。ライセンスキー取得後にここへ
  };

  /* Yahoo!ショッピング。ストアクリエイターProの商品CSVを想定した主要列 */
  var YAHOO = {
    key: 'yahoo', label: 'Yahoo!ショッピング', short: 'Yahoo', color: '#ff0033', phase: 2,
    help: 'ストアクリエイターProの商品データCSVを想定しています。Phase 2 の対象なので、'
        + 'まずは出力して実物のテンプレートと照合するところから始めてください。',
    csv: {
      encoding: 'shift_jis', sep: ',',
      filename: function (ymd) { return 'yahoo-item-' + ymd + '.csv'; },
      columns: [
        { h: 'code', v: function (p, l) { return (l && l.mall_item_id) || p.sku; } },
        { h: 'name', v: function (p, l) { return title(p, l); } },
        { h: 'price', v: function (p, l) { return price(p, l); } },
        { h: 'quantity', v: function (p) { return p.stock; } },
        { h: 'jan', v: function (p) { return s(p.jan); } },
        { h: 'brand', v: function (p) { return s(p.maker); } },
        { h: 'product-code', v: function (p) { return s(p.model); } },
        { h: 'caption', v: function (p) { return s(p.spec); } },
        { h: 'explanation', v: function (p, l) { return desc(p, l); } },
        { h: 'headline', v: function (p, l) { return title(p, l); } },
        { h: 'image', v: function (p) { return img(p, 0); } },
        { h: 'ship-weight', v: function () { return ''; } },
        { h: 'taxable', v: function () { return '1'; } },
        { h: 'product-category', v: function (p, l) { return s(l && l.mall_category); } }
      ],
      keyField: ['code', 'sku', 'SKU'],
      fields: {
        name: { h: ['name'], t: s, to: 'listing.title' },
        price: { h: ['price'], t: num, to: 'listing.price' },
        stock: { h: ['quantity'], t: int0, to: 'product.stock' },
        jan: { h: ['jan'], t: s, to: 'product.jan' },
        mall_item_id: { h: ['code'], t: s, to: 'listing.mall_item_id' }
      }
    },
    api: null
  };

  /* Amazon。在庫ファイル（Inventory Loader）はタブ区切り */
  var AMAZON = {
    key: 'amazon', label: 'Amazon', short: 'Amazon', color: '#ff9900', phase: 2,
    help: '在庫ファイル（Inventory Loader）を想定したタブ区切りです。'
        + '商品を新しく登録するには別のカテゴリ別テンプレートが要ります。Phase 2 の対象です。',
    csv: {
      encoding: 'utf-8', sep: '\t', ext: 'txt',
      filename: function (ymd) { return 'amazon-inventory-' + ymd + '.txt'; },
      columns: [
        { h: 'sku', v: function (p, l) { return (l && l.mall_item_id) || p.sku; } },
        { h: 'product-id', v: function (p) { return s(p.jan); } },
        { h: 'product-id-type', v: function (p) { return p.jan ? '3' : ''; } },   // 3=EAN/JAN
        { h: 'price', v: function (p, l) { return price(p, l); } },
        { h: 'minimum-seller-allowed-price', v: function (p) { return s(p.min_price); } },
        { h: 'item-condition', v: function (p) { return p.condition === '新品' ? '11' : '2'; } },
        { h: 'quantity', v: function (p) { return p.stock; } },
        { h: 'add-delete', v: function () { return 'a'; } },
        { h: 'item-note', v: function (p) { return s(p.warranty); } }
      ],
      keyField: ['sku', 'seller-sku', 'SKU'],
      fields: {
        price: { h: ['price'], t: num, to: 'listing.price' },
        stock: { h: ['quantity'], t: int0, to: 'product.stock' },
        jan: { h: ['product-id'], t: s, to: 'product.jan' },
        mall_item_id: { h: ['sku', 'seller-sku'], t: s, to: 'listing.mall_item_id' }
      }
    },
    api: null   // SP-API。開発者登録の審査が通ってから
  };

  var ALL = [EC8, RAKUTEN, AMAZON, YAHOO];
  var BY_KEY = {};
  ALL.forEach(function (c) { BY_KEY[c.key] = c; });

  /* ---------------------------------------------------------------- 出力・取込 */

  /* 商品の配列 → そのモールのCSV文字列 */
  function exportRows(mall, items) {
    var c = BY_KEY[mall];
    if (!c) throw new Error('知らないモールです: ' + mall);
    var cols = c.csv.columns;
    var rows = [cols.map(function (x) { return x.h; })];
    items.forEach(function (it) {
      rows.push(cols.map(function (x) {
        var v;
        try { v = x.v(it.product, it.listing); } catch (e) { v = ''; }
        return v == null ? '' : v;
      }));
    });
    return buildCsv(rows, c.csv.sep);
  }

  /* CSVのヘッダー行 → こちらの想定とどれだけ噛み合っているか。
     モールのテンプレートは店舗ごとに違うので、取り込む前にこれで確かめる。 */
  function matchHeaders(mall, headers) {
    var c = BY_KEY[mall];
    var norm = function (h) { return String(h || '').replace(/^﻿/, '').trim(); };
    var got = headers.map(norm);
    var keyHit = (c.csv.keyField || []).find(function (k) { return got.indexOf(k) >= 0; }) || null;
    var used = {}, mapped = [], missing = [];
    Object.keys(c.csv.fields).forEach(function (f) {
      var def = c.csv.fields[f];
      var hit = def.h.find(function (h) { return got.indexOf(h) >= 0; });
      if (hit) { mapped.push({ field: f, header: hit }); used[hit] = 1; }
      else { missing.push({ field: f, tried: def.h }); }
    });
    if (keyHit) used[keyHit] = 1;
    return {
      keyHeader: keyHit,
      mapped: mapped,
      missing: missing,
      unknown: got.filter(function (h) { return h && !used[h]; })
    };
  }

  /* CSVの中身 → SKUごとの変更内容。
     戻り値の rows は {key, product:{}, listing:{}} で、画面側がそのまま当てられる形。 */
  function importRows(mall, text) {
    var c = BY_KEY[mall];
    var table = parseCsv(text, c.csv.sep);
    if (!table.length) return { header: [], rows: [], skipped: 0, match: null };

    var header = table[0].map(function (h) { return String(h || '').replace(/^﻿/, '').trim(); });
    var match = matchHeaders(mall, header);
    var idx = {};
    header.forEach(function (h, i) { if (idx[h] == null) idx[h] = i; });

    var keyCol = match.keyHeader == null ? -1 : idx[match.keyHeader];
    var rows = [], skipped = 0;

    for (var r = 1; r < table.length; r++) {
      var line = table[r];
      var key = keyCol >= 0 ? String(line[keyCol] || '').trim() : '';
      if (!key) { skipped++; continue; }
      var out = { key: key, product: {}, listing: {}, line: r + 1 };
      match.mapped.forEach(function (m) {
        var def = c.csv.fields[m.field];
        var raw = line[idx[m.header]];
        if (raw === undefined || String(raw).trim() === '') return;
        var v = def.t(raw);
        if (v == null || v === '') return;
        var to = def.to || ('product.' + m.field);
        var bits = to.split('.');
        out[bits[0] === 'listing' ? 'listing' : 'product'][bits[1]] = v;
      });
      if (!Object.keys(out.product).length && !Object.keys(out.listing).length) { skipped++; continue; }
      rows.push(out);
    }
    return { header: header, rows: rows, skipped: skipped, match: match };
  }

  window.EightMalls = {
    all: function () { return ALL.slice(); },
    get: function (k) { return BY_KEY[k]; },
    keys: function () { return ALL.map(function (c) { return c.key; }); },
    exportRows: exportRows,
    importRows: importRows,
    matchHeaders: matchHeaders,
    parseCsv: parseCsv,
    buildCsv: buildCsv,
    decodeBytes: decodeBytes,
    toBlob: toBlob
  };
})();
