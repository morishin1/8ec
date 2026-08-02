/* 商品ビジュアル生成
   在庫データ777商品のうち、メーカー提供の写真があるのは3商品だけ。
   残りは「何の機器か」がひと目で分かるように、機器タイプ別のイラストを描き起こして出す。
   使い方：EightProductArt.svg(item) → <svg> 文字列（グラデーション込み・単体で完結） */
(function (global) {
  'use strict';

  /* 機器タイプごとの色。本体は共通のネイビーで、画面・LED・ポートの光だけタイプ色を変える。
     並べたときに一覧として揃って見えつつ、種類の違いは色でも分かる状態にする。 */
  var TYPES = {
    laptop:     { label: 'ノートPC',       accent: '#4f63c4', accent2: '#7d8ee0' },
    tablet:     { label: 'タブレット',     accent: '#6d5bd0', accent2: '#9b8ce6' },
    desktop:    { label: 'デスクトップ',   accent: '#3f6fb5', accent2: '#6f9ad4' },
    monitor:    { label: 'ディスプレイ',   accent: '#2f8fbf', accent2: '#63b6d9' },
    swtch:      { label: 'スイッチ',       accent: '#3aa3a3', accent2: '#6cc9c9' },
    router:     { label: 'ルーター',       accent: '#2f7fd0', accent2: '#69a9e6' },
    ap:         { label: '無線AP',         accent: '#3aa17e', accent2: '#6fc7a6' },
    firewall:   { label: 'UTM・FW',        accent: '#d08a2f', accent2: '#e8b45c' },
    collab:     { label: 'Web会議',        accent: '#7a5bd0', accent2: '#a68ce8' },
    server:     { label: 'サーバー',       accent: '#2f5fa8', accent2: '#6a91cf' },
    storage:    { label: 'ストレージ',     accent: '#3f7fa8', accent2: '#77abc9' },
    rack:       { label: 'ラック',         accent: '#4a5e7a', accent2: '#8494ab' },
    software:   { label: 'ソフトウェア',   accent: '#5b6fd0', accent2: '#93a1e6' },
    mouse:      { label: 'マウス',         accent: '#6a7488', accent2: '#9aa3b5' },
    keyboard:   { label: 'キーボード',     accent: '#586377', accent2: '#8d96a8' },
    cable:      { label: 'ケーブル・光',   accent: '#7d8798', accent2: '#a9b3c2' },
    option:     { label: '周辺機器',       accent: '#5b6577', accent2: '#8f99aa' }
  };

  var BODY = '#1e3a6b';
  var BODY_DARK = '#16305c';
  var BODY_LIGHT = '#2b4c85';
  var METAL = '#cbd5e6';
  var METAL_DARK = '#aebbd2';

  var uid = 0;

  /* 在庫データの source / category / 型番から機器タイプを判定する */
  function typeOf(item) {
    var source = String((item && item.source) || '');
    var category = String((item && item.category) || '');
    var model = String((item && (item.model || item.name)) || '').toUpperCase();
    var has = function (re) { return re.test(category); };

    /* サーバー・ストレージ（HPE）は小ジャンルで細かく分かれるので先に判定する */
    if (source === 'サーバー・ストレージ') {
      if (has(/サーバー[\s　]?(ラックマウント|タワー|ブレード)/)) return 'server';
      if (has(/ハードディスク|ＳＳＤ|SSD|シリコンディスク|ディスクアレイ|テープ|ライブラリー|コントローラー本体/)) return 'storage';
      if (has(/ソフトウェア|ＯＳ|OS（OEM）|OS\(OEM\)/)) return 'software';
      if (has(/ラック/)) return 'rack';
      if (has(/ケーブル|アダプター/)) return 'cable';
      if (has(/ＵＰＳ|UPS|電源監視/)) return 'option';
      if (has(/スイッチ/)) return 'swtch';
      return 'option';
    }

    /* 仕入先の商材ジャンル名（エレコムなど）をそのまま受ける */
    if (has(/^マウス|トラックボール/)) return 'mouse';
    if (has(/^キーボード/)) return 'keyboard';
    if (has(/ウェブカメラ|Ｗｅｂカメラ/)) return 'collab';
    if (has(/アクセスポイント/)) return 'ap';
    if (has(/Ｌ２スイッチ|L2スイッチ|ハブ（イーサネットスイッチ）|KVMスイッチ/)) return 'swtch';
    if (has(/ケーブル|アダプター|コネクター/)) return 'cable';
    /* 「ディスプレイ用フィルター」等はモニター本体ではないので先に外す */
    if (has(/フィルター|保護フィルム|バッグ|ケース/)) return 'option';

    if (source === 'ディスプレイ' || category.indexOf('ディスプレイ') >= 0) return 'monitor';

    if (category.indexOf('ノートブック') >= 0) return 'laptop';
    if (category.indexOf('タブレット') >= 0) return 'tablet';
    if (category.indexOf('デスクトップ') >= 0 || category.indexOf('ワークステーション') >= 0) return 'desktop';

    if (category.indexOf('コラボレーション') >= 0 || /^CS-/.test(model)) return 'collab';
    if (category.indexOf('スイッチ') >= 0 || /^(MS|C1200|C1300|C9[23]00|N9K|FS-AX)/.test(model)) return 'swtch';
    if (category.indexOf('ルーター') >= 0 || /^(MX|C9[12][12]|C8[12]00|ISR)/.test(model)) return 'router';
    if (category.indexOf('ワイヤレス') >= 0 || category.indexOf('Meraki') >= 0 || /^(MR|CW9)/.test(model)) return 'ap';
    if (category.indexOf('セキュリティ') >= 0 || /^(FG-|FPR|CSF|ASA)/.test(model)) return 'firewall';

    /* SFP／トランシーバ・電源やコンソールのケーブル類 */
    if (/^(CAB-|FN-TRAN|SFP|GLC-|QSFP)/.test(model)) return 'cable';
    if (category.indexOf('オプション') >= 0) return 'cable';

    if (source === 'セキュリティ機器') return 'firewall';
    if (source === 'ネットワーク機器') return 'swtch';
    return 'option';
  }

  function labelOf(type) {
    return (TYPES[type] || TYPES.option).label;
  }

  /* 機器ごとの描画。すべて viewBox 0 0 200 140 に収める */
  var DRAW = {
    laptop: function (c) {
      return [
        '<rect x="46" y="20" width="108" height="68" rx="4" fill="' + BODY + '"/>',
        '<rect x="51" y="25" width="98" height="55" rx="2" fill="url(#' + c.screen + ')"/>',
        /* 画面のなかの「作業中」を示すUIらしき要素 */
        '<rect x="57" y="31" width="34" height="4" rx="2" fill="#fff" opacity=".55"/>',
        '<rect x="57" y="40" width="52" height="3" rx="1.5" fill="#fff" opacity=".3"/>',
        '<rect x="57" y="47" width="44" height="3" rx="1.5" fill="#fff" opacity=".3"/>',
        '<rect x="112" y="40" width="31" height="33" rx="2" fill="#fff" opacity=".22"/>',
        '<rect x="82" y="83" width="36" height="3" rx="1.5" fill="' + BODY_LIGHT + '"/>',
        /* 手前に開いた本体 */
        '<path d="M34 90h132l16 20a4 4 0 0 1-3 6H21a4 4 0 0 1-3-6z" fill="' + METAL + '"/>',
        '<path d="M34 90h132l4 5H30z" fill="' + METAL_DARK + '"/>',
        '<rect x="84" y="99" width="32" height="7" rx="3" fill="' + METAL_DARK + '"/>'
      ].join('');
    },

    tablet: function (c) {
      return [
        '<rect x="62" y="14" width="76" height="112" rx="9" fill="' + BODY + '"/>',
        '<rect x="68" y="24" width="64" height="88" rx="3" fill="url(#' + c.screen + ')"/>',
        '<circle cx="100" cy="19" r="1.8" fill="' + METAL_DARK + '"/>',
        '<rect x="88" y="117" width="24" height="3" rx="1.5" fill="' + BODY_LIGHT + '"/>',
        '<rect x="74" y="31" width="26" height="4" rx="2" fill="#fff" opacity=".5"/>',
        '<rect x="74" y="41" width="52" height="26" rx="3" fill="#fff" opacity=".22"/>',
        '<rect x="74" y="73" width="24" height="24" rx="3" fill="#fff" opacity=".3"/>',
        '<rect x="102" y="73" width="24" height="24" rx="3" fill="#fff" opacity=".18"/>'
      ].join('');
    },

    desktop: function (c) {
      return [
        '<rect x="70" y="14" width="60" height="108" rx="6" fill="' + BODY + '"/>',
        '<rect x="70" y="14" width="60" height="8" rx="4" fill="' + BODY_LIGHT + '"/>',
        /* 光学ドライブ・前面パネル */
        '<rect x="80" y="30" width="40" height="5" rx="2.5" fill="' + BODY_DARK + '"/>',
        '<rect x="80" y="40" width="40" height="5" rx="2.5" fill="' + BODY_DARK + '"/>',
        '<circle cx="86" cy="58" r="5" fill="url(#' + c.glow + ')"/>',
        '<rect x="97" y="55" width="23" height="3" rx="1.5" fill="' + BODY_DARK + '"/>',
        /* 前面USBポート */
        '<rect x="80" y="74" width="16" height="10" rx="1.5" fill="' + BODY_DARK + '"/>',
        '<rect x="104" y="74" width="16" height="10" rx="1.5" fill="' + BODY_DARK + '"/>',
        '<rect x="80" y="90" width="16" height="10" rx="1.5" fill="' + BODY_DARK + '"/>',
        '<rect x="104" y="90" width="16" height="10" rx="1.5" fill="' + BODY_DARK + '"/>',
        '<rect x="80" y="108" width="40" height="3" rx="1.5" fill="' + c.accent + '" opacity=".75"/>',
        '<rect x="76" y="122" width="48" height="5" rx="2.5" fill="' + METAL_DARK + '"/>'
      ].join('');
    },

    monitor: function (c) {
      return [
        '<rect x="24" y="16" width="152" height="88" rx="5" fill="' + BODY + '"/>',
        '<rect x="30" y="22" width="140" height="74" rx="2" fill="url(#' + c.screen + ')"/>',
        '<rect x="38" y="30" width="42" height="5" rx="2.5" fill="#fff" opacity=".5"/>',
        '<rect x="38" y="42" width="60" height="4" rx="2" fill="#fff" opacity=".28"/>',
        '<rect x="38" y="52" width="48" height="4" rx="2" fill="#fff" opacity=".28"/>',
        '<rect x="110" y="30" width="52" height="40" rx="3" fill="#fff" opacity=".2"/>',
        '<rect x="38" y="66" width="60" height="22" rx="3" fill="#fff" opacity=".16"/>',
        '<rect x="90" y="104" width="20" height="16" fill="' + METAL_DARK + '"/>',
        '<rect x="62" y="120" width="76" height="8" rx="4" fill="' + METAL + '"/>'
      ].join('');
    },

    swtch: function (c) {
      var ports = '';
      for (var i = 0; i < 12; i++) {
        var x = 32 + i * 11;
        ports += '<rect x="' + x + '" y="56" width="8" height="9" rx="1" fill="' + BODY_DARK + '"/>' +
                 '<rect x="' + (x + 2) + '" y="58" width="4" height="2" rx="1" fill="' + c.accent + '" opacity=".85"/>';
        ports += '<rect x="' + x + '" y="70" width="8" height="9" rx="1" fill="' + BODY_DARK + '"/>' +
                 '<rect x="' + (x + 2) + '" y="72" width="4" height="2" rx="1" fill="' + c.accent2 + '" opacity=".7"/>';
      }
      return [
        '<rect x="14" y="48" width="10" height="40" rx="2" fill="' + METAL_DARK + '"/>',
        '<rect x="176" y="48" width="10" height="40" rx="2" fill="' + METAL_DARK + '"/>',
        '<rect x="22" y="44" width="156" height="48" rx="4" fill="' + BODY + '"/>',
        '<rect x="22" y="44" width="156" height="6" rx="3" fill="' + BODY_LIGHT + '"/>',
        ports,
        '<circle cx="170" cy="60" r="2.6" fill="url(#' + c.glow + ')"/>',
        '<circle cx="170" cy="70" r="2.6" fill="' + c.accent2 + '" opacity=".55"/>',
        '<rect x="160" y="79" width="12" height="3" rx="1.5" fill="' + BODY_DARK + '"/>'
      ].join('');
    },

    router: function (c) {
      var ports = '';
      for (var i = 0; i < 5; i++) {
        ports += '<rect x="' + (52 + i * 15) + '" y="84" width="10" height="8" rx="1" fill="' + BODY_DARK + '"/>';
      }
      return [
        /* アンテナ */
        '<path d="M62 62V30" stroke="' + BODY_DARK + '" stroke-width="5" stroke-linecap="round"/>',
        '<path d="M138 62V30" stroke="' + BODY_DARK + '" stroke-width="5" stroke-linecap="round"/>',
        '<path d="M100 58V22" stroke="' + BODY_DARK + '" stroke-width="5" stroke-linecap="round"/>',
        '<rect x="34" y="58" width="132" height="42" rx="7" fill="' + BODY + '"/>',
        '<rect x="34" y="58" width="132" height="7" rx="3.5" fill="' + BODY_LIGHT + '"/>',
        '<circle cx="52" cy="74" r="3.4" fill="url(#' + c.glow + ')"/>',
        '<circle cx="64" cy="74" r="3.4" fill="' + c.accent2 + '" opacity=".6"/>',
        '<circle cx="76" cy="74" r="3.4" fill="' + c.accent2 + '" opacity=".35"/>',
        ports,
        '<rect x="126" y="70" width="30" height="4" rx="2" fill="' + BODY_DARK + '"/>'
      ].join('');
    },

    ap: function (c) {
      return [
        /* 電波 */
        '<path d="M56 46a62 62 0 0 1 88 0" stroke="' + c.accent2 + '" stroke-width="4" fill="none" stroke-linecap="round" opacity=".45"/>',
        '<path d="M70 58a42 42 0 0 1 60 0" stroke="' + c.accent + '" stroke-width="4" fill="none" stroke-linecap="round" opacity=".7"/>',
        /* 天井設置型APを少し見上げた角度で。薄い円盤に見えるよう平たく描く */
        '<ellipse cx="100" cy="80" rx="52" ry="14" fill="' + BODY_LIGHT + '"/>',
        '<path d="M48 80v14a52 14 0 0 0 104 0V80z" fill="' + BODY + '"/>',
        '<ellipse cx="100" cy="80" rx="34" ry="9" fill="' + BODY_DARK + '" opacity=".55"/>',
        '<circle cx="100" cy="80" r="5.5" fill="url(#' + c.glow + ')"/>',
        '<rect x="94" y="108" width="12" height="14" rx="2" fill="' + METAL_DARK + '"/>',
        '<rect x="82" y="120" width="36" height="5" rx="2.5" fill="' + METAL + '"/>'
      ].join('');
    },

    firewall: function (c) {
      var ports = '';
      for (var i = 0; i < 7; i++) {
        ports += '<rect x="' + (86 + i * 12) + '" y="72" width="9" height="9" rx="1" fill="' + BODY_DARK + '"/>' +
                 '<rect x="' + (88 + i * 12) + '" y="74" width="5" height="2" rx="1" fill="' + c.accent2 + '" opacity=".65"/>';
      }
      return [
        '<rect x="22" y="50" width="156" height="46" rx="5" fill="' + BODY + '"/>',
        '<rect x="22" y="50" width="156" height="6" rx="3" fill="' + BODY_LIGHT + '"/>',
        /* 左に盾のエンブレム＝セキュリティ機器だと分かるように */
        '<path d="M50 62l14 5v9c0 7-5.6 13-14 16-8.4-3-14-9-14-16v-9z" fill="url(#' + c.glow + ')"/>',
        '<path d="M44 76l4.5 4.5L57 71" stroke="#fff" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
        ports,
        '<rect x="86" y="60" width="34" height="3" rx="1.5" fill="' + BODY_DARK + '"/>',
        '<rect x="126" y="60" width="18" height="3" rx="1.5" fill="' + BODY_DARK + '"/>',
        '<rect x="34" y="99" width="132" height="5" rx="2.5" fill="' + METAL_DARK + '" opacity=".55"/>'
      ].join('');
    },

    collab: function (c) {
      var grille = '';
      for (var i = 0; i < 9; i++) {
        grille += '<circle cx="' + (44 + i * 6) + '" cy="86" r="1.6" fill="' + BODY_DARK + '"/>';
        grille += '<circle cx="' + (110 + i * 6) + '" cy="86" r="1.6" fill="' + BODY_DARK + '"/>';
      }
      return [
        '<rect x="26" y="52" width="148" height="44" rx="14" fill="' + BODY + '"/>',
        '<rect x="26" y="52" width="148" height="9" rx="4.5" fill="' + BODY_LIGHT + '"/>',
        '<circle cx="100" cy="72" r="13" fill="' + BODY_DARK + '"/>',
        '<circle cx="100" cy="72" r="7.5" fill="url(#' + c.glow + ')"/>',
        '<circle cx="103" cy="69" r="2.2" fill="#fff" opacity=".7"/>',
        grille,
        '<rect x="86" y="96" width="28" height="16" fill="' + METAL_DARK + '"/>',
        '<rect x="64" y="112" width="72" height="7" rx="3.5" fill="' + METAL + '"/>'
      ].join('');
    },

    cable: function (c) {
      return [
        /* 光トランシーバ＋ケーブル */
        '<rect x="24" y="58" width="54" height="26" rx="3" fill="' + BODY + '"/>',
        '<rect x="24" y="58" width="54" height="5" rx="2.5" fill="' + BODY_LIGHT + '"/>',
        '<rect x="30" y="66" width="16" height="12" rx="1.5" fill="' + BODY_DARK + '"/>',
        '<rect x="50" y="66" width="16" height="12" rx="1.5" fill="' + BODY_DARK + '"/>',
        '<path d="M78 71c26 0 22 34 48 34s22-34 48-34" stroke="' + c.accent + '" stroke-width="7" fill="none" stroke-linecap="round" opacity=".55"/>',
        '<rect x="164" y="58" width="14" height="26" rx="3" fill="' + BODY + '"/>',
        '<rect x="160" y="64" width="6" height="14" rx="2" fill="' + METAL_DARK + '"/>',
        '<circle cx="70" cy="90" r="3" fill="url(#' + c.glow + ')"/>'
      ].join('');
    },

    server: function (c) {
      /* ラックマウントサーバーを2台重ねた前面図。ドライブベイとステータスLEDで判別させる */
      var bays = '';
      for (var i = 0; i < 8; i++) {
        bays += '<rect x="' + (54 + i * 13) + '" y="34" width="10" height="26" rx="1.5" fill="' + BODY_DARK + '"/>' +
                '<rect x="' + (56 + i * 13) + '" y="37" width="2.5" height="20" rx="1.2" fill="' + c.accent2 + '" opacity=".5"/>';
      }
      return [
        '<rect x="30" y="26" width="140" height="42" rx="4" fill="' + BODY + '"/>',
        '<rect x="30" y="26" width="140" height="5" rx="2.5" fill="' + BODY_LIGHT + '"/>',
        bays,
        '<circle cx="42" cy="40" r="3" fill="url(#' + c.glow + ')"/>',
        '<circle cx="42" cy="53" r="3" fill="' + c.accent2 + '" opacity=".55"/>',
        '<rect x="30" y="76" width="140" height="42" rx="4" fill="' + BODY + '"/>',
        '<rect x="30" y="76" width="140" height="5" rx="2.5" fill="' + BODY_LIGHT + '"/>',
        '<rect x="54" y="86" width="88" height="22" rx="2" fill="' + BODY_DARK + '"/>',
        '<rect x="60" y="92" width="42" height="4" rx="2" fill="' + c.accent + '" opacity=".7"/>',
        '<rect x="60" y="100" width="26" height="3" rx="1.5" fill="' + c.accent2 + '" opacity=".45"/>',
        '<circle cx="42" cy="90" r="3" fill="url(#' + c.glow + ')"/>',
        '<rect x="150" y="86" width="14" height="22" rx="2" fill="' + BODY_DARK + '"/>'
      ].join('');
    },

    storage: function (c) {
      /* ディスクアレイ／HDD。取っ手つきのドライブトレイを縦に並べる */
      var trays = '';
      for (var i = 0; i < 4; i++) {
        var y = 34 + i * 20;
        trays += '<rect x="56" y="' + y + '" width="88" height="16" rx="2" fill="' + BODY_DARK + '"/>' +
                 '<rect x="62" y="' + (y + 5) + '" width="30" height="5" rx="2.5" fill="' + BODY_LIGHT + '"/>' +
                 '<circle cx="134" cy="' + (y + 8) + '" r="2.6" fill="' + (i === 0 ? 'url(#' + c.glow + ')' : c.accent2) + '" opacity="' + (i === 0 ? 1 : .5) + '"/>';
      }
      return [
        '<rect x="46" y="24" width="108" height="94" rx="5" fill="' + BODY + '"/>',
        '<rect x="46" y="24" width="108" height="6" rx="3" fill="' + BODY_LIGHT + '"/>',
        trays,
        '<rect x="56" y="118" width="88" height="5" rx="2.5" fill="' + METAL_DARK + '" opacity=".5"/>'
      ].join('');
    },

    rack: function (c) {
      /* 19インチラック。支柱のネジ穴と搭載機器で「箱もの」と分かるように */
      var holes = '';
      for (var i = 0; i < 11; i++) {
        holes += '<rect x="52" y="' + (28 + i * 8.6) + '" width="3" height="3" rx="1" fill="' + BODY_DARK + '"/>';
        holes += '<rect x="145" y="' + (28 + i * 8.6) + '" width="3" height="3" rx="1" fill="' + BODY_DARK + '"/>';
      }
      return [
        '<rect x="44" y="18" width="112" height="106" rx="5" fill="' + BODY + '"/>',
        '<rect x="50" y="24" width="100" height="94" rx="3" fill="' + BODY_DARK + '"/>',
        holes,
        '<rect x="59" y="32" width="82" height="16" rx="2" fill="' + BODY_LIGHT + '"/>',
        '<rect x="59" y="54" width="82" height="16" rx="2" fill="' + BODY_LIGHT + '"/>',
        '<rect x="59" y="76" width="82" height="26" rx="2" fill="' + BODY + '"/>',
        '<circle cx="133" cy="40" r="2.6" fill="url(#' + c.glow + ')"/>',
        '<circle cx="133" cy="62" r="2.6" fill="' + c.accent2 + '" opacity=".55"/>',
        '<rect x="67" y="84" width="38" height="4" rx="2" fill="' + c.accent + '" opacity=".65"/>'
      ].join('');
    },

    software: function (c) {
      /* ライセンス／OS。証書とキーで「モノではない商材」だと分かるようにする */
      return [
        '<rect x="52" y="24" width="96" height="86" rx="5" fill="#fff" stroke="' + METAL_DARK + '" stroke-width="2"/>',
        '<rect x="52" y="24" width="96" height="14" rx="5" fill="' + BODY + '"/>',
        '<rect x="64" y="52" width="60" height="5" rx="2.5" fill="' + BODY_DARK + '" opacity=".7"/>',
        '<rect x="64" y="64" width="72" height="4" rx="2" fill="' + METAL_DARK + '"/>',
        '<rect x="64" y="74" width="52" height="4" rx="2" fill="' + METAL_DARK + '"/>',
        '<circle cx="118" cy="96" r="15" fill="url(#' + c.glow + ')"/>',
        '<circle cx="118" cy="92" r="4.6" fill="#fff"/>',
        '<path d="M118 96v9m0-4h4" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>',
        '<rect x="64" y="90" width="30" height="4" rx="2" fill="' + METAL_DARK + '"/>'
      ].join('');
    },

    mouse: function (c) {
      return [
        '<path d="M100 26c20 0 32 16 32 36v28c0 18-14 30-32 30s-32-12-32-30V62c0-20 12-36 32-36z" fill="' + BODY + '"/>',
        '<path d="M100 26c20 0 32 16 32 36H68c0-20 12-36 32-36z" fill="' + BODY_LIGHT + '"/>',
        '<path d="M100 26v36" stroke="' + BODY_DARK + '" stroke-width="2.4"/>',
        '<rect x="96" y="38" width="8" height="18" rx="4" fill="url(#' + c.glow + ')"/>',
        '<rect x="86" y="76" width="28" height="3" rx="1.5" fill="' + BODY_DARK + '" opacity=".55"/>'
      ].join('');
    },

    keyboard: function (c) {
      var keys = '';
      for (var row = 0; row < 4; row++) {
        for (var i = 0; i < 12; i++) {
          var w = (row === 3 && i === 5) ? 30 : 9;
          if (row === 3 && i > 5 && i < 9) continue;
          keys += '<rect x="' + (34 + i * 11 + (row === 1 ? 3 : 0)) + '" y="' + (56 + row * 13) +
                  '" width="' + w + '" height="9" rx="1.6" fill="' + BODY_DARK + '"/>';
        }
      }
      return [
        '<rect x="24" y="46" width="152" height="62" rx="6" fill="' + BODY + '"/>',
        '<rect x="24" y="46" width="152" height="6" rx="3" fill="' + BODY_LIGHT + '"/>',
        keys,
        '<circle cx="166" cy="52" r="2.4" fill="url(#' + c.glow + ')"/>',
        '<rect x="46" y="108" width="108" height="5" rx="2.5" fill="' + METAL_DARK + '" opacity=".5"/>'
      ].join('');
    },

    option: function (c) {
      /* ドッキングステーション。上面にUSB-Cの受け口、前面にポートを並べる */
      var ports = '';
      for (var i = 0; i < 4; i++) {
        ports += '<rect x="' + (56 + i * 23) + '" y="86" width="15" height="10" rx="1.5" fill="' + BODY_DARK + '"/>' +
                 '<rect x="' + (58 + i * 23) + '" y="89" width="11" height="2" rx="1" fill="' + c.accent2 + '" opacity=".5"/>';
      }
      return [
        '<rect x="44" y="52" width="112" height="14" rx="6" fill="' + BODY_LIGHT + '"/>',
        '<rect x="86" y="44" width="28" height="10" rx="5" fill="' + BODY_DARK + '"/>',
        '<rect x="92" y="47" width="16" height="4" rx="2" fill="url(#' + c.glow + ')"/>',
        '<rect x="44" y="64" width="112" height="38" rx="7" fill="' + BODY + '"/>',
        '<rect x="56" y="72" width="52" height="4" rx="2" fill="' + BODY_DARK + '"/>',
        '<circle cx="140" cy="74" r="3.4" fill="url(#' + c.glow + ')"/>',
        ports,
        '<rect x="56" y="106" width="88" height="5" rx="2.5" fill="' + METAL_DARK + '" opacity=".55"/>'
      ].join('');
    }
  };

  /* item から <svg> 文字列を作る。id はインスタンスごとに変えて、同一ページで衝突させない */
  function svg(item, options) {
    var opts = options || {};
    var type = opts.type || typeOf(item);
    var conf = TYPES[type] || TYPES.option;
    var n = ++uid;
    var ids = {
      bg: 'pa-bg-' + n,
      screen: 'pa-sc-' + n,
      glow: 'pa-gl-' + n,
      accent: conf.accent,
      accent2: conf.accent2
    };
    var draw = (DRAW[type] || DRAW.option)(ids);

    return '<svg class="pa-svg" viewBox="0 0 200 140" role="img" aria-label="' +
      esc(conf.label) + 'のイメージ" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' +
        '<linearGradient id="' + ids.bg + '" x1="0" y1="0" x2="1" y2="1">' +
          '<stop offset="0" stop-color="#ffffff"/>' +
          '<stop offset="1" stop-color="' + conf.accent + '" stop-opacity=".16"/>' +
        '</linearGradient>' +
        '<linearGradient id="' + ids.screen + '" x1="0" y1="0" x2="1" y2="1">' +
          '<stop offset="0" stop-color="' + conf.accent + '"/>' +
          '<stop offset="1" stop-color="' + conf.accent2 + '"/>' +
        '</linearGradient>' +
        '<radialGradient id="' + ids.glow + '">' +
          '<stop offset="0" stop-color="' + conf.accent2 + '"/>' +
          '<stop offset="1" stop-color="' + conf.accent + '"/>' +
        '</radialGradient>' +
      '</defs>' +
      /* bare は機器だけを描く。ヒーロー画像のように複数の機器を並べて使うとき、
         1台ごとの背景タイルが邪魔になるため */
      (opts.bare ? '' :
        '<rect width="200" height="140" fill="url(#' + ids.bg + ')"/>' +
        '<circle cx="168" cy="26" r="40" fill="' + conf.accent + '" opacity=".07"/>') +
      draw +
      '</svg>';
  }

  function esc(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[ch];
    });
  }

  global.EightProductArt = { typeOf: typeOf, labelOf: labelOf, svg: svg, types: TYPES };
})(window);
