/* ==========================================================================
   Quote Estimator Modal
   ユーザーの選択から概算見積もりを表示する共有モーダル
   使い方:
     <script src="quote-modal.js" defer></script>
   トリガー:
     - [data-quote-modal] を持つ要素のクリック
     - 「無料見積もり」「無料で見積もり」テキストを含むリンク/ボタン（自動バインド）
   ========================================================================== */
(function(){
  'use strict';

  /* ---------- 料金マスター ---------- */
  const PLANS = {
    pc: {
      label: 'レンタルPC',
      color: '#0B2B7A',
      colorLight: '#E3E9FB',
      icon: 'laptop',
      items: [
        { id:'light',    name:'ライトノートPC',    desc:'事務・Web業務向け',            monthly: 4980,  setup:[3000,5000] },
        { id:'std',      name:'標準ノートPC',      desc:'標準的なビジネス用途',          monthly: 6980,  setup:[3000,7000] },
        { id:'pro',      name:'高性能ノートPC',    desc:'開発・クリエイティブ用途',      monthly: 9800,  setup:[5000,10000] },
        { id:'bulk',     name:'法人まとめ貸し',    desc:'10台以上の大量導入',           monthly: null,  setup:null, note:'別途お見積もり' }
      ],
      options: [
        { id:'kitting',   name:'キッティング（初期設定）', unit:'台',  price:[3000,10000], type:'range-per-unit' },
        { id:'support',   name:'保守サポート',             unit:'式',  price:3000,         type:'per-unit-monthly', desc:'1台あたり月額' },
        { id:'insurance', name:'動産保険',                 unit:'式',  price:500,          type:'per-unit-monthly', desc:'1台あたり月額' }
      ],
      qty: { label:'台数',  min:1, max:100, default:3, unit:'台' },
      term:{ label:'期間',  options:[{v:1,l:'1ヶ月'},{v:3,l:'3ヶ月'},{v:6,l:'6ヶ月'},{v:12,l:'12ヶ月',badge:'人気'},{v:24,l:'24ヶ月',badge:'お得'},{v:36,l:'36ヶ月'}], default:12 }
    },
    mcp: {
      label: 'MCPサーバー',
      color: '#7C3AED',
      colorLight: '#f3ebff',
      icon: 'server',
      items: [
        { id:'basic',    name:'MCPサーバー利用',        desc:'基本利用プラン',              monthly: 9800,  setup:[150000,300000] },
        { id:'managed',  name:'監視・保守込み',         desc:'24h監視＋バックアップ',       monthly: 19800, setup:[200000,400000] },
        { id:'custom',   name:'個別連携あり',           desc:'既存システム連携カスタム',    monthly: null,  setup:[300000,500000], note:'要お見積もり' }
      ],
      options: [
        { id:'ai-link',   name:'AI＋MCP連携導入支援（初期）',  price:[500000,1500000], type:'range-setup' },
        { id:'maint',     name:'保守運用',                     price:[30000,150000],   type:'range-monthly', desc:'月額' }
      ],
      qty: null,
      term:{ label:'契約期間', options:[{v:12,l:'12ヶ月'},{v:24,l:'24ヶ月',badge:'お得'},{v:36,l:'36ヶ月'}], default:12 }
    },
    ai: {
      label: 'AIサーバー',
      color: '#0EA5A4',
      colorLight: '#dbf7f4',
      icon: 'cpu',
      items: [
        { id:'poc-gpu',  name:'AI検証用GPU環境',          desc:'小規模PoC・検証向け',         monthly: 98000,  setup:[200000,500000] },
        { id:'poc-srv',  name:'社内PoC向けAIサーバー',    desc:'社内検証・小規模運用',        monthly: 148000, setup:[500000,1000000] },
        { id:'prod',     name:'本格運用・専有構成',       desc:'本番運用・専有インフラ',      monthly: null,   setup:null, note:'個別お見積もり' }
      ],
      options: [
        { id:'ai-link',   name:'AI＋MCP連携導入支援（初期）',  price:[500000,1500000], type:'range-setup' },
        { id:'maint',     name:'保守運用',                     price:[30000,150000],   type:'range-monthly', desc:'月額' }
      ],
      qty: null,
      term:{ label:'契約期間', options:[{v:12,l:'12ヶ月'},{v:24,l:'24ヶ月',badge:'お得'},{v:36,l:'36ヶ月'}], default:12 }
    },
    joshis: {
      label: 'クラウド情シス',
      color: '#0891B2',
      colorLight: '#CFF0F7',
      icon: 'shield',
      items: [
        { id:'lite',     name:'ライト',       desc:'月10時間／棚卸＋ツール提案＋簡易レポート',  monthly: 49800,  setup:null },
        { id:'standard', name:'スタンダード', desc:'月15時間／構築・補助金まで丸ごと伴走',     monthly: 98000,  setup:null },
        { id:'premium',  name:'プレミアム',   desc:'月30時間／AI業務再設計＋月次レビュー',     monthly: 220000, setup:null }
      ],
      options: [
        { id:'oncall',   name:'営業時間外オンコール対応', price:[30000,80000], type:'range-monthly', desc:'月額追加' },
        { id:'spot',     name:'超過時間のスポット対応',   price:[6000,12000],  type:'range-monthly', desc:'1時間あたり目安' }
      ],
      qty: null,
      term:{ label:'契約期間', options:[{v:12,l:'12ヶ月'},{v:24,l:'24ヶ月',badge:'お得'},{v:36,l:'36ヶ月'}], default:12 }
    },
    aidev: {
      label: 'AI・業務システム開発',
      color: '#0B2A5B',
      colorLight: '#DCE8FF',
      icon: 'spark',
      items: [
        { id:'poc',     name:'PoC・試作開発',          desc:'最短2週間でAIプロトタイプ',     monthly: null, setup:[500000, 1500000] },
        { id:'system',  name:'業務システム開発',         desc:'管理画面・ワークフロー等',       monthly: null, setup:[1000000, 5000000] },
        { id:'ai-srv',  name:'AIサービス開発',           desc:'生成AI/RAG等の本格開発',         monthly: null, setup:[2000000, 8000000] },
        { id:'consult', name:'AI活用コンサルティング',    desc:'業務棚卸し・PoC設計・ROI試算',  monthly: null, setup:[300000, 800000] },
        { id:'all',     name:'企画〜運用 一貫支援',       desc:'本格的なフル開発・継続運用',    monthly: null, setup:null, note:'個別お見積もり' }
      ],
      options: [
        { id:'maint',    name:'運用保守・改善支援',          price:[50000, 200000],  type:'range-monthly', desc:'月額' },
        { id:'mcp-link', name:'MCP連携実装（オプション）',   price:[200000, 1000000], type:'range-setup' }
      ],
      qty: null,
      term:{ label:'実施形態', options:[{v:1,l:'プロジェクト一括'}], default:1 }
    }
  };

  /* ---------- 長期割引（PCのみ） ---------- */
  const PC_TERM_DISCOUNT = { 1:0, 3:0, 6:0.03, 12:0.08, 24:0.15, 36:0.20 };
  /* まとめ貸し割引（台数） */
  const PC_QTY_DISCOUNT = [ { min:10, rate:0.05 }, { min:30, rate:0.10 }, { min:50, rate:0.15 } ];

  /* ---------- アイコン ---------- */
  const ICONS = {
    laptop:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><line x1="2" y1="20" x2="22" y2="20"/></svg>',
    server:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="7" rx="1"/><rect x="3" y="14" width="18" height="7" rx="1"/><line x1="7" y1="6.5" x2="7.01" y2="6.5"/><line x1="7" y1="17.5" x2="7.01" y2="17.5"/></svg>',
    cpu:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>',
    shield:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    spark:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.5 5 5.5.8-4 3.9.9 5.5L12 14.7 7.1 17.2 8 11.7 4 7.8l5.5-.8L12 2z"/></svg>',
    close:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    back:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>',
    calc:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="11" x2="8" y2="11"/><line x1="12" y1="11" x2="12" y2="11"/><line x1="16" y1="11" x2="16" y2="11"/><line x1="8" y1="15" x2="8" y2="15"/><line x1="12" y1="15" x2="12" y2="15"/><line x1="16" y1="15" x2="16" y2="15"/><line x1="8" y1="19" x2="16" y2="19"/></svg>'
  };

  /* ---------- スタイル ---------- */
  const CSS = `
  .qm-overlay{position:fixed;inset:0;background:rgba(11,21,48,.55);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);z-index:9998;opacity:0;pointer-events:none;transition:opacity .22s;display:flex;align-items:center;justify-content:center;padding:20px;}
  .qm-overlay.open{opacity:1;pointer-events:auto;}
  .qm-modal{position:relative;background:#fff;border-radius:24px;width:min(920px,100%);max-height:92vh;overflow:hidden;box-shadow:0 30px 80px rgba(11,21,48,.35);transform:translateY(14px) scale(.98);transition:transform .25s cubic-bezier(.2,.9,.3,1.15);display:flex;flex-direction:column;font-family:"Noto Sans JP","Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif;color:#0B1530;}
  .qm-overlay.open .qm-modal{transform:translateY(0) scale(1);}

  /* Header */
  .qm-head{padding:22px 28px;display:flex;align-items:center;gap:16px;background:linear-gradient(135deg,#0B2B7A 0%,#1E4FD9 70%,#0EA5A4 100%);color:#fff;position:relative;}
  .qm-head .qm-title{font-size:18px;font-weight:900;letter-spacing:.02em;display:flex;align-items:center;gap:10px;}
  .qm-head .qm-title svg{width:22px;height:22px;}
  .qm-head .qm-sub{font-size:12px;opacity:.85;font-weight:600;margin-top:2px;}
  .qm-head .qm-steps{margin-left:auto;display:flex;align-items:center;gap:8px;font-family:"Inter",sans-serif;font-size:11px;font-weight:700;letter-spacing:.08em;}
  .qm-head .qm-steps .qs{display:flex;align-items:center;gap:6px;opacity:.55;transition:opacity .2s;}
  .qm-head .qm-steps .qs.on{opacity:1;}
  .qm-head .qm-steps .qsn{width:22px;height:22px;border-radius:50%;background:rgba(255,255,255,.2);display:grid;place-items:center;font-size:11px;}
  .qm-head .qm-steps .qs.on .qsn{background:#F5A623;color:#0B2B7A;}
  .qm-head .qm-steps .qsd{width:18px;height:1px;background:rgba(255,255,255,.35);}
  .qm-close{position:absolute;right:16px;top:16px;width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.15);border:0;color:#fff;cursor:pointer;display:grid;place-items:center;transition:background .15s;}
  .qm-close:hover{background:rgba(255,255,255,.3);}
  .qm-close svg{width:16px;height:16px;}

  /* Body */
  .qm-body{padding:28px 32px 12px;overflow-y:auto;flex:1;}
  .qm-step{display:none;animation:qm-in .28s ease both;}
  .qm-step.on{display:block;}
  @keyframes qm-in{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
  .qm-h{font-size:20px;font-weight:900;margin:0 0 6px;letter-spacing:-.01em;}
  .qm-p{font-size:13px;color:#5a6681;margin:0 0 20px;}

  /* Step1: category cards */
  .qm-cats{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px;}
  .qm-cat{text-align:left;background:#fff;border:2px solid #e3e8f2;border-radius:18px;padding:22px 20px;cursor:pointer;transition:all .18s;display:flex;flex-direction:column;gap:12px;}
  .qm-cat:hover{border-color:var(--qm-acc,#1E4FD9);transform:translateY(-3px);box-shadow:0 12px 24px rgba(11,21,48,.10);}
  .qm-cat.on{border-color:var(--qm-acc,#1E4FD9);background:var(--qm-tint,#E8EFFF);}
  .qm-cat .qm-ic{width:46px;height:46px;border-radius:12px;background:var(--qm-acc,#1E4FD9);color:#fff;display:grid;place-items:center;}
  .qm-cat .qm-ic svg{width:22px;height:22px;}
  .qm-cat h4{margin:0;font-size:16px;font-weight:900;}
  .qm-cat p{margin:0;font-size:12px;color:#5a6681;line-height:1.55;}
  .qm-cat .qm-from{font-family:"Inter",sans-serif;font-size:11px;font-weight:700;color:var(--qm-acc,#1E4FD9);letter-spacing:.05em;}

  /* Step2: items */
  .qm-items{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
  .qm-item{text-align:left;background:#fff;border:2px solid #e3e8f2;border-radius:14px;padding:16px 18px;cursor:pointer;transition:all .18s;display:flex;align-items:flex-start;gap:14px;}
  .qm-item:hover{border-color:var(--qm-acc);}
  .qm-item.on{border-color:var(--qm-acc);background:var(--qm-tint);}
  .qm-item .qm-rad{width:20px;height:20px;border-radius:50%;border:2px solid #cfd6e6;flex-shrink:0;margin-top:2px;display:grid;place-items:center;transition:all .15s;}
  .qm-item.on .qm-rad{border-color:var(--qm-acc);background:var(--qm-acc);}
  .qm-item.on .qm-rad::after{content:"";width:8px;height:8px;border-radius:50%;background:#fff;}
  .qm-item-body{flex:1;min-width:0;}
  .qm-item h5{margin:0 0 4px;font-size:14px;font-weight:800;}
  .qm-item p{margin:0 0 8px;font-size:12px;color:#5a6681;}
  .qm-item .qm-price{font-family:"Inter",sans-serif;font-size:13px;font-weight:800;color:var(--qm-acc);}
  .qm-item .qm-price small{font-family:"Noto Sans JP",sans-serif;font-size:11px;color:#5a6681;font-weight:600;margin-left:4px;}
  .qm-item .qm-price.is-quote{color:#5a6681;}

  /* Step3: controls */
  .qm-ctrls{display:flex;flex-direction:column;gap:22px;}
  .qm-ctrl-h{font-size:13px;font-weight:800;color:#1a2544;display:flex;align-items:center;gap:8px;margin-bottom:10px;}
  .qm-ctrl-h .qm-req{background:var(--qm-acc);color:#fff;font-size:10px;padding:2px 7px;border-radius:4px;font-weight:700;letter-spacing:.05em;}

  .qm-qty{display:flex;align-items:center;gap:14px;}
  .qm-qty-btn{width:40px;height:40px;border-radius:10px;border:1.5px solid #cfd6e6;background:#fff;font-size:18px;font-weight:800;color:#0B1530;cursor:pointer;transition:all .15s;}
  .qm-qty-btn:hover:not(:disabled){border-color:var(--qm-acc);color:var(--qm-acc);}
  .qm-qty-btn:disabled{opacity:.35;cursor:not-allowed;}
  .qm-qty-num{font-family:"Inter",sans-serif;font-size:28px;font-weight:800;min-width:80px;text-align:center;line-height:1;}
  .qm-qty-num small{font-family:"Noto Sans JP",sans-serif;font-size:13px;color:#5a6681;font-weight:700;margin-left:4px;}
  .qm-qty-slider{flex:1;display:flex;align-items:center;gap:12px;}
  .qm-qty-slider input[type=range]{flex:1;accent-color:var(--qm-acc);height:4px;}

  .qm-terms{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}
  .qm-term{padding:12px 10px;border-radius:10px;border:1.5px solid #e3e8f2;background:#fff;cursor:pointer;font-weight:700;font-size:13px;position:relative;transition:all .15s;}
  .qm-term:hover{border-color:var(--qm-acc);}
  .qm-term.on{border-color:var(--qm-acc);background:var(--qm-tint);color:var(--qm-acc);}
  .qm-term .qm-badge{position:absolute;top:-7px;right:-6px;background:#F5A623;color:#0B2B7A;font-size:9px;font-weight:800;padding:2px 6px;border-radius:4px;letter-spacing:.05em;}

  .qm-opts{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
  .qm-opt{display:flex;align-items:flex-start;gap:10px;padding:12px 14px;border-radius:10px;border:1.5px solid #e3e8f2;cursor:pointer;font-size:13px;transition:all .15s;}
  .qm-opt:hover{border-color:var(--qm-acc);}
  .qm-opt.on{border-color:var(--qm-acc);background:var(--qm-tint);}
  .qm-opt-chk{width:18px;height:18px;border-radius:5px;border:2px solid #cfd6e6;flex-shrink:0;margin-top:1px;display:grid;place-items:center;transition:all .15s;}
  .qm-opt-chk svg{width:12px;height:12px;color:#fff;opacity:0;transition:opacity .15s;}
  .qm-opt.on .qm-opt-chk{background:var(--qm-acc);border-color:var(--qm-acc);}
  .qm-opt.on .qm-opt-chk svg{opacity:1;}
  .qm-opt-body{flex:1;min-width:0;}
  .qm-opt-name{font-weight:700;margin-bottom:2px;}
  .qm-opt-price{font-family:"Inter",sans-serif;font-size:11px;color:#5a6681;font-weight:600;}

  /* Estimate panel */
  .qm-est{margin-top:20px;padding:22px 24px;border-radius:18px;background:linear-gradient(135deg,#0B1530 0%,#1a2544 100%);color:#fff;position:relative;overflow:hidden;}
  .qm-est::before{content:"";position:absolute;right:-40px;top:-40px;width:160px;height:160px;border-radius:50%;background:radial-gradient(circle,rgba(245,166,35,.25) 0%,transparent 65%);}
  .qm-est-label{font-size:11px;font-weight:700;letter-spacing:.15em;opacity:.7;margin-bottom:6px;}
  .qm-est-row{display:flex;align-items:baseline;gap:10px;margin-bottom:6px;}
  .qm-est-amt{font-family:"Inter",sans-serif;font-size:36px;font-weight:800;letter-spacing:-.02em;line-height:1;}
  .qm-est-amt .qm-yen{font-size:20px;margin-right:2px;}
  .qm-est-amt .qm-range{color:#F5A623;}
  .qm-est-unit{font-size:13px;font-weight:700;opacity:.85;}
  .qm-est-break{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:14px;padding-top:14px;border-top:1px solid rgba(255,255,255,.15);}
  .qm-est-break .bk{font-size:11px;}
  .qm-est-break .bk .l{opacity:.6;margin-bottom:2px;letter-spacing:.05em;}
  .qm-est-break .bk .v{font-family:"Inter",sans-serif;font-weight:700;font-size:14px;}
  .qm-est-note{font-size:11px;opacity:.7;margin-top:12px;line-height:1.6;}
  .qm-est-quote{text-align:center;padding:10px 0;}
  .qm-est-quote .qm-est-amt{color:#F5A623;font-size:24px;}
  .qm-est-quote .qm-est-sub{font-size:12px;opacity:.8;margin-top:6px;}

  /* Footer */
  .qm-foot{padding:18px 32px;border-top:1px solid #eef2f9;background:#f8fafe;display:flex;align-items:center;gap:12px;}
  .qm-foot .qm-back{background:transparent;border:0;color:#5a6681;font-weight:700;font-size:13px;cursor:pointer;padding:10px 14px;border-radius:8px;display:flex;align-items:center;gap:6px;}
  .qm-foot .qm-back:hover{background:#eef2f9;color:#0B1530;}
  .qm-foot .qm-back svg{width:14px;height:14px;}
  .qm-foot .qm-spacer{flex:1;}
  .qm-btn{border:0;font-weight:800;cursor:pointer;padding:12px 22px;border-radius:999px;font-size:14px;transition:all .15s;display:inline-flex;align-items:center;gap:8px;font-family:inherit;}
  .qm-btn svg{width:14px;height:14px;}
  .qm-btn-next{background:var(--qm-acc,#1E4FD9);color:#fff;box-shadow:0 6px 16px rgba(30,79,217,.3);}
  .qm-btn-next:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 10px 22px rgba(30,79,217,.4);}
  .qm-btn-next:disabled{opacity:.4;cursor:not-allowed;box-shadow:none;}
  .qm-btn-cta{background:#F5A623;color:#0B2B7A;box-shadow:0 6px 16px rgba(245,166,35,.35);}
  .qm-btn-cta:hover{transform:translateY(-1px);background:#ffb733;}

  /* Trigger default affordance (optional) */
  [data-quote-modal]{cursor:pointer;}

  @media (max-width: 720px){
    .qm-modal{border-radius:18px;max-height:96vh;}
    .qm-head{padding:18px 20px;}
    .qm-head .qm-steps{display:none;}
    .qm-body{padding:22px 20px 8px;}
    .qm-foot{padding:14px 20px;}
    .qm-cats{grid-template-columns:1fr;}
    .qm-items{grid-template-columns:1fr;}
    .qm-opts{grid-template-columns:1fr;}
    .qm-terms{grid-template-columns:repeat(3,1fr);}
    .qm-est-amt{font-size:28px;}
    .qm-est-break{grid-template-columns:1fr 1fr;}
  }
  `;

  /* ---------- State ---------- */
  const state = {
    step: 1,
    cat: null,       // 'pc' | 'mcp' | 'ai'
    item: null,      // item id
    qty: 3,
    term: null,
    opts: new Set()
  };

  /* ---------- Helpers ---------- */
  const yen = (n)=> '¥' + Math.round(n).toLocaleString('ja-JP');
  const rangeYen = (a,b)=> yen(a) + '〜' + yen(b);

  function calcPC(item){
    const p = PLANS.pc;
    const qty = state.qty;
    const term = state.term;
    if(item.monthly === null){
      return { quoteOnly:true, label:item.note||'別途お見積もり' };
    }
    // discounts
    let termDisc = PC_TERM_DISCOUNT[term] || 0;
    let qtyDisc = 0;
    for(const q of PC_QTY_DISCOUNT){ if(qty >= q.min) qtyDisc = q.rate; }
    const disc = 1 - termDisc - qtyDisc;
    const monthlyPerUnit = item.monthly * disc;
    const monthly = monthlyPerUnit * qty;

    // setup
    let setupLow = 0, setupHigh = 0;
    if(item.setup){
      setupLow  += item.setup[0] * qty;
      setupHigh += item.setup[1] * qty;
    }
    // options
    let optMonthlyAdd = 0;
    let optSetupLow = 0, optSetupHigh = 0;
    for(const opt of p.options){
      if(!state.opts.has(opt.id)) continue;
      if(opt.type === 'range-per-unit'){
        optSetupLow  += opt.price[0]*qty;
        optSetupHigh += opt.price[1]*qty;
      } else if(opt.type === 'per-unit-monthly'){
        optMonthlyAdd += opt.price * qty;
      }
    }
    const monthlyTotal = monthly + optMonthlyAdd;
    const setupLowT = setupLow + optSetupLow;
    const setupHighT = setupHigh + optSetupHigh;
    return {
      quoteOnly:false,
      monthly: monthlyTotal,
      setupRange: setupHighT>setupLowT ? [setupLowT, setupHighT] : [setupLowT, setupLowT],
      termMonths: term,
      qty,
      totalLow:  setupLowT  + monthlyTotal*term,
      totalHigh: setupHighT + monthlyTotal*term,
      discount: termDisc + qtyDisc
    };
  }

  function calcMcpAi(catKey, item){
    const p = PLANS[catKey];
    const term = state.term;
    if(item.monthly === null){
      // setup may still exist
      if(item.setup){
        let sL = item.setup[0], sH = item.setup[1];
        // options
        for(const opt of p.options){
          if(!state.opts.has(opt.id)) continue;
          if(opt.type === 'range-setup'){ sL += opt.price[0]; sH += opt.price[1]; }
        }
        return { quoteOnly:true, label: item.note||'個別お見積もり', setupRange:[sL,sH], hasSetup:true };
      }
      return { quoteOnly:true, label: item.note||'個別お見積もり' };
    }
    let monthly = item.monthly;
    let monthlyLow = monthly, monthlyHigh = monthly;
    let setupLow = item.setup ? item.setup[0] : 0;
    let setupHigh = item.setup ? item.setup[1] : 0;
    for(const opt of p.options){
      if(!state.opts.has(opt.id)) continue;
      if(opt.type === 'range-setup'){
        setupLow  += opt.price[0];
        setupHigh += opt.price[1];
      } else if(opt.type === 'range-monthly'){
        monthlyLow  += opt.price[0];
        monthlyHigh += opt.price[1];
      }
    }
    return {
      quoteOnly:false,
      monthlyLow, monthlyHigh,
      setupRange:[setupLow, setupHigh],
      termMonths: term,
      totalLow:  setupLow  + monthlyLow*term,
      totalHigh: setupHigh + monthlyHigh*term,
      isRange: monthlyHigh > monthlyLow
    };
  }

  function compute(){
    if(!state.cat || !state.item) return null;
    const cat = PLANS[state.cat];
    const item = cat.items.find(i=>i.id===state.item);
    if(!item) return null;
    if(state.cat === 'pc') return { ...calcPC(item), item, cat };
    return { ...calcMcpAi(state.cat, item), item, cat };
  }

  /* ---------- DOM Build ---------- */
  let overlay, modal, stepsEl;

  function injectStyle(){
    const s = document.createElement('style');
    s.id = 'qm-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function buildOverlay(){
    overlay = document.createElement('div');
    overlay.className = 'qm-overlay';
    overlay.setAttribute('role','dialog');
    overlay.setAttribute('aria-modal','true');
    overlay.innerHTML = `
      <div class="qm-modal" role="document">
        <div class="qm-head">
          <div>
            <div class="qm-title">${ICONS.calc}<span>概算見積もり</span></div>
            <div class="qm-sub">3ステップで目安金額がわかります</div>
          </div>
          <div class="qm-steps" aria-hidden="true">
            <div class="qs on" data-s="1"><div class="qsn">1</div>サービス</div>
            <div class="qsd"></div>
            <div class="qs" data-s="2"><div class="qsn">2</div>プラン</div>
            <div class="qsd"></div>
            <div class="qs" data-s="3"><div class="qsn">3</div>条件</div>
          </div>
          <button class="qm-close" aria-label="閉じる">${ICONS.close}</button>
        </div>
        <div class="qm-body">
          <div class="qm-step qm-step-1 on"></div>
          <div class="qm-step qm-step-2"></div>
          <div class="qm-step qm-step-3"></div>
        </div>
        <div class="qm-foot">
          <button class="qm-back" type="button">${ICONS.back}戻る</button>
          <div class="qm-spacer"></div>
          <button class="qm-btn qm-btn-next" type="button" disabled>次へ</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    modal = overlay.querySelector('.qm-modal');
    stepsEl = overlay.querySelectorAll('.qm-head .qs');

    // listeners
    overlay.querySelector('.qm-close').addEventListener('click', close);
    overlay.addEventListener('click', (e)=>{ if(e.target === overlay) close(); });
    overlay.querySelector('.qm-back').addEventListener('click', ()=>{
      if(state.step > 1){ state.step--; render(); }
      else close();
    });
    overlay.querySelector('.qm-btn-next').addEventListener('click', onNext);
    document.addEventListener('keydown', (e)=>{ if(e.key==='Escape' && overlay.classList.contains('open')) close(); });
  }

  function setAccent(){
    if(!state.cat){ modal.style.removeProperty('--qm-acc'); modal.style.removeProperty('--qm-tint'); return; }
    const c = PLANS[state.cat];
    modal.style.setProperty('--qm-acc', c.color);
    modal.style.setProperty('--qm-tint', c.colorLight);
  }

  /* ---------- Renderers ---------- */
  function renderStep1(){
    const el = overlay.querySelector('.qm-step-1');
    el.innerHTML = `
      <h3 class="qm-h">どのサービスの見積もりをご希望ですか？</h3>
      <p class="qm-p">カテゴリを選ぶと、この後にプラン・条件を入力いただきます。</p>
      <div class="qm-cats">
        ${Object.entries(PLANS).map(([k,p])=>{
          const min = p.items.find(i=>i.monthly!==null);
          const fromText = min ? `月額 ${yen(min.monthly)}〜` : '';
          return `
          <button class="qm-cat ${state.cat===k?'on':''}" data-cat="${k}" type="button" style="--qm-acc:${p.color};--qm-tint:${p.colorLight};">
            <div class="qm-ic">${ICONS[p.icon]}</div>
            <div>
              <h4>${p.label}</h4>
              <p>${catDesc(k)}</p>
            </div>
            <div class="qm-from">${fromText}</div>
          </button>`;
        }).join('')}
      </div>
    `;
    el.querySelectorAll('.qm-cat').forEach(b=>{
      b.addEventListener('click', ()=>{
        const newCat = b.dataset.cat;
        if(state.cat !== newCat){
          state.cat = newCat;
          state.item = null;
          state.term = PLANS[newCat].term.default;
          state.qty = PLANS[newCat].qty ? PLANS[newCat].qty.default : 1;
          state.opts = new Set();
        }
        setAccent();
        renderStep1();
        updateFoot();
      });
    });
  }
  function catDesc(k){
    return ({
      pc:'法人向けPCの短期・長期レンタル。設定済みで届くキッティング対応。',
      mcp:'業務ツールとAIをつなぐMCPサーバーの構築・運用。',
      ai:'社内LLM・検証用GPUサーバーの構築から運用まで。',
      joshis:'IT担当者の代わりにIT環境をまるごと支援。月額定額の情シス代行。',
      aidev:'AIサービス・業務システムの企画から運用まで一貫支援する開発パートナー。'
    })[k]||'';
  }

  function renderStep2(){
    const el = overlay.querySelector('.qm-step-2');
    if(!state.cat){ el.innerHTML=''; return; }
    const p = PLANS[state.cat];
    el.innerHTML = `
      <h3 class="qm-h">${p.label}のプランを選択</h3>
      <p class="qm-p">ご要件に近いものを1つお選びください。</p>
      <div class="qm-items">
        ${p.items.map(it=>{
          let price = '';
          if(it.monthly !== null){
            price = `<div class="qm-price">${yen(it.monthly)}<small>〜 / 月</small></div>`;
          } else {
            price = `<div class="qm-price is-quote">${it.note||'別途お見積もり'}</div>`;
          }
          return `
          <button class="qm-item ${state.item===it.id?'on':''}" data-item="${it.id}" type="button">
            <div class="qm-rad"></div>
            <div class="qm-item-body">
              <h5>${it.name}</h5>
              <p>${it.desc}</p>
              ${price}
            </div>
          </button>`;
        }).join('')}
      </div>
    `;
    el.querySelectorAll('.qm-item').forEach(b=>{
      b.addEventListener('click', ()=>{
        state.item = b.dataset.item;
        renderStep2();
        updateFoot();
      });
    });
  }

  function renderStep3(){
    const el = overlay.querySelector('.qm-step-3');
    if(!state.cat || !state.item){ el.innerHTML=''; return; }
    const p = PLANS[state.cat];
    const item = p.items.find(i=>i.id===state.item);
    if(!item){ el.innerHTML=''; return; }

    const qtyHtml = p.qty ? `
      <div>
        <div class="qm-ctrl-h">${p.qty.label}<span class="qm-req">必須</span></div>
        <div class="qm-qty">
          <button class="qm-qty-btn" data-q="-1" type="button">−</button>
          <div class="qm-qty-num" id="qm-qty-n">${state.qty}<small>${p.qty.unit}</small></div>
          <button class="qm-qty-btn" data-q="+1" type="button">＋</button>
          <div class="qm-qty-slider">
            <input type="range" id="qm-qty-s" min="${p.qty.min}" max="${p.qty.max}" step="1" value="${state.qty}">
          </div>
        </div>
      </div>
    ` : '';

    const termHtml = `
      <div>
        <div class="qm-ctrl-h">${p.term.label}<span class="qm-req">必須</span></div>
        <div class="qm-terms">
          ${p.term.options.map(o=>`
            <button class="qm-term ${state.term===o.v?'on':''}" data-t="${o.v}" type="button">
              ${o.l}
              ${o.badge?`<span class="qm-badge">${o.badge}</span>`:''}
            </button>
          `).join('')}
        </div>
      </div>
    `;

    const optsHtml = p.options && p.options.length ? `
      <div>
        <div class="qm-ctrl-h">オプション<span style="font-size:11px;color:#5a6681;font-weight:600;">（任意・複数選択可）</span></div>
        <div class="qm-opts">
          ${p.options.map(o=>{
            let priceLabel = '';
            if(o.type==='range-per-unit') priceLabel = `${yen(o.price[0])}〜${yen(o.price[1])} / 台`;
            else if(o.type==='per-unit-monthly') priceLabel = `${yen(o.price)} / 台・月`;
            else if(o.type==='range-setup') priceLabel = `初期 ${yen(o.price[0])}〜${yen(o.price[1])}`;
            else if(o.type==='range-monthly') priceLabel = `月額 ${yen(o.price[0])}〜${yen(o.price[1])}`;
            return `
            <label class="qm-opt ${state.opts.has(o.id)?'on':''}" data-o="${o.id}">
              <div class="qm-opt-chk">${ICONS.check}</div>
              <div class="qm-opt-body">
                <div class="qm-opt-name">${o.name}</div>
                <div class="qm-opt-price">${priceLabel}</div>
              </div>
            </label>`;
          }).join('')}
        </div>
      </div>
    ` : '';

    el.innerHTML = `
      <h3 class="qm-h">ご利用条件の入力</h3>
      <p class="qm-p">${item.name} の条件を入力してください。金額は目安として即時に計算されます。</p>
      <div class="qm-ctrls">
        ${qtyHtml}
        ${termHtml}
        ${optsHtml}
      </div>
      <div class="qm-est" id="qm-est"></div>
    `;

    // qty events
    const qN = el.querySelector('#qm-qty-n');
    const qS = el.querySelector('#qm-qty-s');
    if(p.qty){
      el.querySelectorAll('.qm-qty-btn').forEach(b=>{
        b.addEventListener('click', ()=>{
          const d = parseInt(b.dataset.q,10);
          state.qty = Math.max(p.qty.min, Math.min(p.qty.max, state.qty + d));
          qN.firstChild.textContent = state.qty;
          qS.value = state.qty;
          syncQtyBtns();
          renderEst();
        });
      });
      qS.addEventListener('input', ()=>{
        state.qty = parseInt(qS.value,10);
        qN.firstChild.textContent = state.qty;
        syncQtyBtns();
        renderEst();
      });
      function syncQtyBtns(){
        el.querySelectorAll('.qm-qty-btn').forEach(b=>{
          const d = parseInt(b.dataset.q,10);
          b.disabled = (d<0 && state.qty<=p.qty.min) || (d>0 && state.qty>=p.qty.max);
        });
      }
      syncQtyBtns();
    }
    // term
    el.querySelectorAll('.qm-term').forEach(b=>{
      b.addEventListener('click', ()=>{
        state.term = parseInt(b.dataset.t,10);
        el.querySelectorAll('.qm-term').forEach(x=>x.classList.toggle('on', parseInt(x.dataset.t,10)===state.term));
        renderEst();
      });
    });
    // opts
    el.querySelectorAll('.qm-opt').forEach(b=>{
      b.addEventListener('click', (e)=>{
        e.preventDefault();
        const id = b.dataset.o;
        if(state.opts.has(id)) state.opts.delete(id); else state.opts.add(id);
        b.classList.toggle('on');
        renderEst();
      });
    });
    renderEst();
  }

  function renderEst(){
    const holder = overlay.querySelector('#qm-est');
    if(!holder) return;
    const r = compute();
    if(!r){ holder.innerHTML=''; return; }
    const p = r.cat;
    const item = r.item;

    if(r.quoteOnly){
      let setupHtml = '';
      if(r.hasSetup){
        setupHtml = `<div class="qm-est-break" style="grid-template-columns:1fr;">
          <div class="bk"><div class="l">初期導入費用（目安）</div><div class="v">${rangeYen(r.setupRange[0], r.setupRange[1])}</div></div>
        </div>`;
      }
      holder.innerHTML = `
        <div class="qm-est-quote">
          <div class="qm-est-label">概算</div>
          <div class="qm-est-amt">${r.label}</div>
          <div class="qm-est-sub">${item.name} は規模・構成により変動するため、お問い合わせください。</div>
          ${setupHtml}
        </div>
      `;
      return;
    }

    if(state.cat === 'pc'){
      const totalRange = (r.totalHigh>r.totalLow) ? rangeYen(r.totalLow, r.totalHigh) : yen(r.totalLow);
      const setupRange = (r.setupRange[1]>r.setupRange[0]) ? rangeYen(r.setupRange[0], r.setupRange[1]) : yen(r.setupRange[0]);
      const discTxt = r.discount>0 ? `（長期・台数割引 -${Math.round(r.discount*100)}%反映）` : '';
      holder.innerHTML = `
        <div class="qm-est-label">月額概算（${r.qty}台／${r.termMonths}ヶ月）</div>
        <div class="qm-est-row">
          <div class="qm-est-amt"><span class="qm-yen">¥</span>${Math.round(r.monthly).toLocaleString('ja-JP')}</div>
          <div class="qm-est-unit">／ 月（税別）</div>
        </div>
        <div class="qm-est-break">
          <div class="bk"><div class="l">1台あたり月額</div><div class="v">${yen(r.monthly/r.qty)}</div></div>
          <div class="bk"><div class="l">初期費用（目安）</div><div class="v">${setupRange}</div></div>
          <div class="bk"><div class="l">期間合計（概算）</div><div class="v">${totalRange}</div></div>
        </div>
        <div class="qm-est-note">※上記は税別・参考価格です${discTxt}。実費用は構成・配送先により変動します。正式見積もりは無料でお出しします。</div>
      `;
    } else {
      const monthly = r.isRange ? rangeYen(r.monthlyLow, r.monthlyHigh) : yen(r.monthlyLow);
      const setupRange = (r.setupRange[1]>r.setupRange[0]) ? rangeYen(r.setupRange[0], r.setupRange[1]) : yen(r.setupRange[0]);
      const totalRange = rangeYen(r.totalLow, r.totalHigh);
      holder.innerHTML = `
        <div class="qm-est-label">月額概算（${r.termMonths}ヶ月契約）</div>
        <div class="qm-est-row">
          <div class="qm-est-amt"${r.isRange?' style="font-size:28px;"':''}>
            ${r.isRange ? `<span class="qm-range">${monthly}</span>` : `<span class="qm-yen">¥</span>${Math.round(r.monthlyLow).toLocaleString('ja-JP')}`}
          </div>
          <div class="qm-est-unit">／ 月（税別）</div>
        </div>
        <div class="qm-est-break">
          <div class="bk"><div class="l">初期構築費用</div><div class="v">${setupRange}</div></div>
          <div class="bk"><div class="l">月額</div><div class="v">${monthly}</div></div>
          <div class="bk"><div class="l">期間合計（概算）</div><div class="v">${totalRange}</div></div>
        </div>
        <div class="qm-est-note">※上記は税別・参考価格です。実費用は構成・連携要件により変動します。正式見積もりは無料でお出しします。</div>
      `;
    }
  }

  /* ---------- Step switching ---------- */
  function updateFoot(){
    const nextBtn = overlay.querySelector('.qm-btn-next');
    const backBtn = overlay.querySelector('.qm-back');
    // labels
    if(state.step === 3){
      nextBtn.className = 'qm-btn qm-btn-cta';
      nextBtn.innerHTML = 'この内容で詳細見積もりを依頼する <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';
      nextBtn.disabled = false;
    } else {
      nextBtn.className = 'qm-btn qm-btn-next';
      nextBtn.innerHTML = '次へ <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';
      if(state.step === 1) nextBtn.disabled = !state.cat;
      if(state.step === 2) nextBtn.disabled = !state.item;
    }
    backBtn.style.visibility = state.step===1 ? 'hidden' : 'visible';
    backBtn.firstChild && (backBtn.innerHTML = `${ICONS.back}${state.step===1?'閉じる':'戻る'}`);
    // step indicator
    stepsEl.forEach(s=>s.classList.toggle('on', parseInt(s.dataset.s,10) <= state.step));
    // apply accent from current cat
    setAccent();
  }

  function render(){
    overlay.querySelectorAll('.qm-step').forEach((s,i)=>s.classList.toggle('on', i+1 === state.step));
    if(state.step===1) renderStep1();
    if(state.step===2) renderStep2();
    if(state.step===3) renderStep3();
    updateFoot();
  }

  function onNext(){
    if(state.step === 1 && state.cat){ state.step = 2; render(); return; }
    if(state.step === 2 && state.item){ state.step = 3; render(); return; }
    if(state.step === 3){ handoff(); }
  }

  /* ---------- Handoff to contact form ---------- */
  function handoff(){
    const r = compute();
    const summary = buildSummaryText(r);
    try{
      sessionStorage.setItem('quote.summary', summary);
      sessionStorage.setItem('quote.state', JSON.stringify({
        cat: state.cat, item: state.item, qty: state.qty, term: state.term, opts: [...state.opts]
      }));
    }catch(e){}

    // 現在ページに実フォーム(textarea)があれば、そこに流し込んでスクロール。
    // 無ければ index.html#contact に遷移（sessionStorageでサマリーを運ぶ）。
    const textarea = document.querySelector(
      '#contact textarea, textarea[name="note"], textarea[name="message"], textarea#message, textarea#f-note'
    );
    if(textarea){
      const cur = textarea.value || '';
      const prefix = cur.trim() ? cur.trim()+'\n\n' : '';
      textarea.value = prefix + summary;
      textarea.dispatchEvent(new Event('input',{bubbles:true}));
      close();
      const contact = document.querySelector('#contact') || textarea;
      setTimeout(()=>{ contact.scrollIntoView({behavior:'smooth', block:'start'}); }, 260);
    } else {
      close();
      location.href = 'index.html#contact';
    }
  }

  /* ---------- Autofill from sessionStorage on page load ---------- */
  function autofillFromSession(){
    try{
      const summary = sessionStorage.getItem('quote.summary');
      if(!summary) return;
      const textarea = document.querySelector(
        'textarea[name="note"], textarea[name="message"], textarea#message, textarea#f-note, #contact textarea'
      );
      if(!textarea) return;
      const cur = textarea.value || '';
      if(cur.includes(summary)) { // 既にfill済み（2重防止）
        sessionStorage.removeItem('quote.summary');
        sessionStorage.removeItem('quote.state');
        return;
      }
      const prefix = cur.trim() ? cur.trim()+'\n\n' : '';
      textarea.value = prefix + summary;
      textarea.dispatchEvent(new Event('input',{bubbles:true}));
      sessionStorage.removeItem('quote.summary');
      sessionStorage.removeItem('quote.state');
      // ハッシュ#contactなら一緒にスクロール
      if(location.hash === '#contact'){
        const target = document.querySelector('#contact') || textarea;
        setTimeout(()=>{ target.scrollIntoView({behavior:'smooth', block:'start'}); }, 150);
      }
    }catch(e){}
  }

  function buildSummaryText(r){
    if(!r) return '';
    const lines = [];
    lines.push('【概算見積もりフォームからの送信】');
    lines.push('ご希望サービス：'+ r.cat.label +' / '+ r.item.name);
    if(state.cat === 'pc'){
      lines.push('台数：'+ state.qty +'台');
      lines.push('利用期間：'+ state.term +'ヶ月');
      if(r.quoteOnly){
        lines.push('金額目安：'+ r.label);
      } else {
        lines.push('月額（概算）：'+ yen(r.monthly) +'（1台あたり '+ yen(r.monthly/state.qty) +'）');
        lines.push('初期費用（目安）：'+ rangeYen(r.setupRange[0], r.setupRange[1]));
      }
    } else {
      lines.push('契約期間：'+ state.term +'ヶ月');
      if(r.quoteOnly){
        lines.push('金額目安：'+ r.label);
        if(r.hasSetup) lines.push('初期費用（目安）：'+ rangeYen(r.setupRange[0], r.setupRange[1]));
      } else {
        const monthly = r.isRange ? rangeYen(r.monthlyLow, r.monthlyHigh) : yen(r.monthlyLow);
        lines.push('月額（概算）：'+ monthly);
        lines.push('初期構築費用：'+ rangeYen(r.setupRange[0], r.setupRange[1]));
      }
    }
    if(state.opts.size){
      const optNames = [...state.opts].map(id=>{
        const o = (PLANS[state.cat].options||[]).find(x=>x.id===id);
        return o ? o.name : id;
      });
      lines.push('オプション：'+ optNames.join(' / '));
    }
    lines.push('');
    lines.push('上記条件で正式見積もりをお願いします。');
    return lines.join('\n');
  }

  /* ---------- Open/Close ---------- */
  function open(presetCat){
    // reset to step 1, keep previous selection if same
    if(presetCat && PLANS[presetCat]){
      state.cat = presetCat;
      state.item = null;
      state.term = PLANS[presetCat].term.default;
      state.qty = PLANS[presetCat].qty ? PLANS[presetCat].qty.default : 1;
      state.opts = new Set();
      state.step = 2;
    } else if(!state.cat){
      state.step = 1;
    }
    setAccent();
    render();
    document.body.style.overflow = 'hidden';
    overlay.classList.add('open');
  }
  function close(){
    overlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  /* ---------- Public API + auto-bind ---------- */
  window.QuoteModal = { open, close };

  function init(){
    injectStyle();
    buildOverlay();
    autofillFromSession();

    // explicit triggers
    document.addEventListener('click', (e)=>{
      const trigger = e.target.closest('[data-quote-modal]');
      if(trigger){
        e.preventDefault();
        open(trigger.getAttribute('data-quote-modal') || null);
        return;
      }
      // auto-bind: "無料見積もり" / "無料で見積もり" anchors (but not those going to external/form submit)
      const a = e.target.closest('a, button');
      if(!a) return;
      // skip if explicitly opted out
      if(a.hasAttribute('data-no-quote-modal')) return;
      // only those pointing to #contact (or index.html#contact) with matching text
      const href = a.getAttribute('href') || '';
      const isContactLink = /#contact$/.test(href) || /index\.html#contact$/.test(href);
      const txt = (a.textContent||'').replace(/\s+/g,'');
      const isQuoteText = /無料で?見積もり/.test(txt) || /見積もりを依頼/.test(txt);
      if(isContactLink && isQuoteText && a.type !== 'submit'){
        e.preventDefault();
        open();
      }
    });
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
