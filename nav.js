/* ==========================================================================
   共通ナビゲーション挙動
   - サービスドロップダウン: クリック/キーボード/タッチ対応（ホバーはCSS）
   - モバイルドロワー: ハンバーガーで開閉、背景クリック・Escで閉じる
   ========================================================================== */
(function(){
  'use strict';

  /* ---- デスクトップ ドロップダウン ---- */
  document.querySelectorAll('.nav-svc').forEach(function(svc){
    var btn = svc.querySelector('button');
    if(!btn) return;
    btn.addEventListener('click', function(e){
      e.preventDefault();
      svc.classList.toggle('open');
    });
    btn.addEventListener('keydown', function(e){
      if(e.key === 'Escape'){ svc.classList.remove('open'); btn.blur(); }
    });
  });
  // 外側クリックで閉じる
  document.addEventListener('click', function(e){
    document.querySelectorAll('.nav-svc.open').forEach(function(svc){
      if(!svc.contains(e.target)) svc.classList.remove('open');
    });
  });

  /* ---- モバイルドロワー ---- */
  var toggle = document.querySelector('.nav-toggle');
  var drawer = document.querySelector('.mobile-drawer');
  if(toggle && drawer){
    var close = drawer.querySelector('.md-close');
    function open(){
      drawer.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
    function shut(){
      drawer.classList.remove('open');
      document.body.style.overflow = '';
    }
    toggle.addEventListener('click', open);
    if(close) close.addEventListener('click', shut);
    // 背景クリックで閉じる
    drawer.addEventListener('click', function(e){
      if(e.target === drawer) shut();
    });
    // リンクをタップしたら閉じる（ドロワー内のaタグ）
    drawer.querySelectorAll('a').forEach(function(a){
      a.addEventListener('click', function(){
        // quote-modal を開くリンクはドロワーを閉じる前に発火させたい
        // → setTimeout でモーダルオープンの後に閉じる
        setTimeout(shut, 0);
      });
    });
    // Escで閉じる
    document.addEventListener('keydown', function(e){
      if(e.key === 'Escape' && drawer.classList.contains('open')) shut();
    });
  }
})();
