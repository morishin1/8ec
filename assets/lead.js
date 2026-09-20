/* ===================================================================
   リード獲得の計測口。

   いちばん見たいのは「法人リード数」で、そのために
     ・3分診断を開いた数（どのページから来たか）
     ・診断を始めた数・完了した数
     ・商品ページ→診断の遷移
     ・購入相談／レンタル相談の数
   を後から数えられるようにしておく。

   ここでは送信先を決めていない（GA4などを入れたときに拾えるよう、
   window.dataLayer に積むだけ）。計測でページが壊れないよう、
   すべて try/catch の中で行う。個人情報は積まない。
   =================================================================== */
(function () {
  'use strict';
  function push(o) {
    try {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push(o);
    } catch (_) { /* 計測は失敗しても無視する */ }
  }

  // どのページを見ているか（型番ページは slug も）
  var path = location.pathname.replace(/\.html$/, '').replace(/\/index$/, '/');
  push({ event: 'page_view_type', page_type: path === '/' ? 'top'
    : path.indexOf('/products') === 0 ? 'product'
    : path.indexOf('/packs') === 0 ? 'pack'
    : path.replace(/^\//, '') || 'top' });

  // 診断・相談への導線がクリックされたとき
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="/quote"]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    var mode = /mode=buy/.test(href) ? 'buy' : (/mode=rent/.test(href) ? 'rent' : 'diagnosis');
    push({
      event: 'lead_cta_click',
      cta: a.getAttribute('data-lead') || 'other',   // どの場所のボタンか
      lead_type: mode,                                // 購入相談 / レンタル相談 / 診断
      from: path
    });
  }, true);
})();
