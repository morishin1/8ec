#!/usr/bin/env node
/* ========================================================================
   SNS投稿準備（/api/sns）のテスト

     node tools/test-sns.js

   fetch を差し替えて動かすので、OpenAI にも Supabase にも公開サイトにも行かない。
   文字列の一致ではなく、関数とAPIを実際に呼んで結果を確かめる。
   （「サーバーで止める」「AIに渡さない」を、潰しても気づける形で見る）
   ======================================================================== */
'use strict';

process.env.SUPABASE_SECRET_KEY = 'test-secret';
process.env.SUPABASE_URL = 'https://supa.test';
process.env.SITE_URL = 'https://www.8ec.jp';
process.env.OPENAI_API_KEY = 'sk-test';
process.env.OPENAI_MODEL = 'gpt-5-nano';
process.env.SNS_DAILY_LIMIT = '3';

const assert = require('assert');
const M = require('../assets/sns-master.js');
const S = require('../api/_sns.js');

let passed = 0;
const fails = [];
async function t(name, fn) {
  try { await fn(); passed++; }
  catch (e) { fails.push(name + '\n    ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e)); }
}

/* ---------------------------------------------------------------- 偽のサーバー */
const TOKEN = 'user-token-aaaaaaaaaaaaaaaaaaaaaaaa';
const world = {};
function reset() {
  world.users = { [TOKEN]: 'staff@8grp.co.jp', 'viewer-token-bbbbbbbbbbbbbbbbbbbbbb': 'viewer@8grp.co.jp',
                  'member-token-dddddddddddddddddddddd': 'ware@8grp.co.jp' };
  world.members = [{ email: 'staff@8grp.co.jp', role: 'admin', display_name: '担当' },
                   { email: 'ware@8grp.co.jp', role: 'member', display_name: '倉庫' },
                   { email: 'viewer@8grp.co.jp', role: 'viewer', display_name: '閲覧' }];
  world.posts = [];
  world.tags = ['#法人PC', '#PCレンタル', '#新入社員', '#キッティング'];
  world.gens = [];
  world.openai = [];        // OpenAI に送ったもの
  world.aiReply = null;     // OpenAI の返事（JSON文字列）
  world.aiStatus = 200;
  world.publicCalls = [];   // 公開サイト・公開ビューに行ったURL
  world.publicKeyUsed = [];
  world.pages = {
    '/': '<html><head><meta name="description" content="法人向けにIT機器の購入・レンタル・設定をまとめて承ります。見積無料。"><meta property="og:image" content="/assets/hero.png"></head><body><header>共通ヘッダー 0120-000-000</header><main>トップ</main></body></html>',
    '/packs/new-employee-pc.html': '<html><head><title>新入社員のPC調達</title><meta name="description" content="新入社員ぶんのPCを設定済みでお届けします。"><meta property="og:image" content="https://www.8ec.jp/assets/pack.png"></head><body><header>ヘッダー</header><main><h1>新入社員のPC</h1><p>入社日までに、アカウント・Office設定済みで届けます。1台から対応。</p><script>alert(1)</script></main><footer>フッター</footer></body></html>',
    '/cases.html': '<html><head><title>活用例</title></head><body><main><p>30台を2週間で用意した例。</p></main></body></html>',
    '/assets/columns.json': JSON.stringify({ articles: [{ slug: 'old-pc-hidden-cost', title: '古いPCのコスト' }] }),
    '/column/old-pc-hidden-cost.html': '<html><head><title>x</title></head><body><header>h</header><main><article class="article"><h1>古いPCのコスト</h1><p>5年使ったPCは起動に3分かかる。</p></article><aside>関連</aside></main></body></html>',
  };
  world.products = [{
    code: 'P-001', name: 'ProBook 450 G9', model: '450G9', maker: 'HP', category_name: 'ノートPC',
    spec: 'Core i5 / 16GB', cpu: 'Core i5', cpu_gen: '第12世代', memory_size: '16GB', storage_type: 'SSD',
    storage_capacity: '256GB', screen_size: '15.6', os: 'Windows 11 Pro', office_supported: true,
    rental_enabled: true, availability: 'ご案内可能', rental_price_month: null, rental_min_months: 1,
    rental_description: 'テレワーク向け', sale_enabled: true, sale_price: 59800, sale_condition: '整備済み',
    sale_availability: '在庫あり', image_url: 'https://img.test/a.jpg', images: ['https://img.test/b.jpg'],
    updated_at: '2026-09-01T00:00:00Z',
    // 公開ビューには無いが、万一返ってきても材料に入らないことを確かめる
    unit_price: 12345, supplier: '仕入先株式会社', qty: 7,
  }];
}

function json(status, body, headers) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => (headers || {})[String(k).toLowerCase()] || null },
    json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}
function params(url) { return new URL(url).searchParams; }
function eqVal(sp, k) { const v = sp.get(k); return v && v.indexOf('eq.') === 0 ? decodeURIComponent(v.slice(3)) : null; }

global.fetch = async (url, opts) => {
  const o = opts || {};
  const method = o.method || 'GET';
  const h = o.headers || {};
  // ---- 公開サイト
  if (url.indexOf('https://www.8ec.jp') === 0) {
    const path = url.slice('https://www.8ec.jp'.length);
    world.publicCalls.push(path);
    if (world.pages[path] === undefined) return json(404, 'not found');
    return json(200, world.pages[path]);
  }
  // ---- OpenAI
  if (url === 'https://api.openai.com/v1/chat/completions') {
    const body = JSON.parse(o.body);
    world.openai.push(body);
    if (world.aiStatus !== 200) return json(world.aiStatus, { error: { message: 'x' } });
    return json(200, { choices: [{ finish_reason: 'stop', message: { content: world.aiReply } }] });
  }
  // ---- Supabase Auth
  if (url === 'https://supa.test/auth/v1/user') {
    const tok = String(h.Authorization || '').replace(/^Bearer /, '');
    const email = world.users[tok];
    return email ? json(200, { email }) : json(401, { message: 'bad jwt' });
  }
  // ---- Supabase REST
  if (url.indexOf('https://supa.test/rest/v1/') === 0) {
    const rest = url.slice('https://supa.test/rest/v1/'.length);
    const table = rest.split('?')[0];
    const sp = params(url);
    const isSecret = h.apikey === 'test-secret';
    if (table === 'inv_public_products') {
      world.publicKeyUsed.push(h.apikey);
      if (isSecret) throw new Error('公開ビューをサーバー鍵で読んだ');
      const code = eqVal(sp, 'code');
      const cols = (sp.get('select') || '').split(',');
      const rows = world.products.filter(p => !code || p.code === code).map(p => {
        const r = {}; cols.forEach(c => { if (c in p) r[c] = p[c]; }); return r;
      });
      return json(200, rows);
    }
    if (!isSecret) throw new Error('社内の表を公開鍵で読もうとした: ' + table);
    if (table === 'inventory_members') {
      const email = eqVal(sp, 'email');
      return json(200, world.members.filter(m => m.email === email));
    }
    if (table === 'ec_sns_hashtags') return json(200, world.tags.map(tag => ({ tag })));
    if (table === 'ec_sns_generations') {
      if (method === 'POST') { const row = Object.assign({ id: world.gens.length + 1 }, JSON.parse(o.body)); world.gens.push(row); return json(201, [row]); }
      if (method === 'PATCH') return json(200, []);
      return json(200, [], { 'content-range': '0-0/' + world.gens.length });
    }
    if (table === 'ec_sns_posts') {
      const id = eqVal(sp, 'id');
      if (method === 'POST') {
        const row = Object.assign({ id: '11111111-1111-4111-8111-' + String(world.posts.length + 1).padStart(12, '0'),
          post_no: world.posts.length + 1, social_stale: false, archived_at: null }, JSON.parse(o.body));
        world.posts.push(row);
        return json(201, [row]);
      }
      let rows = world.posts.filter(p => (!id || p.id === id) && !p.archived_at);
      const inList = sp.get('id');
      if (inList && inList.indexOf('in.(') === 0) {
        const ids = inList.slice(4, -1).split(',');
        rows = world.posts.filter(p => ids.indexOf(p.id) >= 0 && p.generated_at && !p.archived_at);
      }
      if (method === 'PATCH') {
        const patch = JSON.parse(o.body);
        rows.forEach(r => {
          // トリガーのうち、テストで効くところだけまねる
          if ('instagram_caption' in patch && patch.instagram_caption !== r.instagram_caption && !('instagram_posted_at' in patch)) r.instagram_posted_at = null;
          if ('x_caption' in patch && patch.x_caption !== r.x_caption && !('x_posted_at' in patch)) r.x_posted_at = null;
          Object.assign(r, patch);
        });
        return json(200, rows);
      }
      return json(200, rows);
    }
    return json(404, { message: 'relation does not exist' });
  }
  throw new Error('想定外の通信: ' + url);
};

/* Vercel の req / res をまねる */
function call(body, token) {
  const handler = require('../api/sns.js');
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
      end() { resolve({ status: this.statusCode, body: null }); return this; },
    };
    const req = { method: 'POST', headers: token === null ? {} : { authorization: 'Bearer ' + (token || TOKEN) }, body };
    handler(req, res);
  });
}

const AXES = { persona: 'hr_recruit', issue: 'new_hire_pc', content_type: 'issue', objective: 'inquiry', cta: 'quote' };

(async () => {
  /* ============================================================ 定義 */
  await t('定義：キーが重複していない', () => {
    ['PERSONAS', 'ISSUES', 'CONTENT_TYPES', 'OBJECTIVES', 'CTAS', 'SOURCE_TYPES'].forEach(k => {
      const keys = M[k].map(x => x.key);
      assert.strictEqual(new Set(keys).size, keys.length, k);
    });
  });
  await t('定義：Issue のヒントと目的の既定CTAが実在するキーを指している', () => {
    M.ISSUES.forEach(i => {
      i.personas.forEach(p => assert.ok(M.find(M.PERSONAS, p), i.key + ' → ' + p));
      i.pages.forEach(p => assert.ok(M.pageOf(p), i.key + ' → ' + p));
    });
    M.OBJECTIVES.forEach(o => assert.ok(M.find(M.CTAS, o.cta), o.key));
  });
  await t('定義：要件のペルソナ8・Issue12・投稿タイプ10・CTA6がそろっている', () => {
    assert.strictEqual(M.PERSONAS.length, 8);
    assert.strictEqual(M.ISSUES.length, 12);
    assert.strictEqual(M.CONTENT_TYPES.length, 10);
    assert.strictEqual(M.CTAS.length, 6);
  });
  await t('定義：公開ページの実ファイルがリポジトリにある', () => {
    const fs = require('fs'), path = require('path');
    M.PAGES.forEach(p => assert.ok(fs.existsSync(path.join(__dirname, '..', p.file)), p.file));
  });
  await t('定義：missingAxes は未選択と未知のキーを両方拾う', () => {
    assert.deepStrictEqual(M.missingAxes(AXES), []);
    assert.strictEqual(M.missingAxes(Object.assign({}, AXES, { persona: 'hacker' })).length, 1);
    assert.strictEqual(M.missingAxes({}).length, 5);
  });
  await t('定義：statusOf は要件の4状態を返す', () => {
    assert.strictEqual(M.statusOf({}).label, 'SNS未作成');
    assert.strictEqual(M.statusOf({ x_caption: 'a' }).label, 'SNS文作成済み');
    assert.strictEqual(M.statusOf({ x_caption: 'a', instagram_posted_at: '2026-01-01' }).label, 'Instagram済');
    assert.strictEqual(M.statusOf({ x_caption: 'a', x_posted_at: '2026-01-01' }).label, 'X済');
    assert.strictEqual(M.statusOf({ x_caption: 'a', x_posted_at: 1, instagram_posted_at: 1 }).key, 'done');
  });
  await t('定義：CTAのURL。見積系は from に投稿Noが入る', () => {
    const r = M.ref(12, 'x');
    assert.strictEqual(r, 'sns-x-12');
    assert.strictEqual(M.ctaPath('quote', r, null), '/quote?from=sns-x-12');
    assert.strictEqual(M.ctaPath('rental_consult', r, { code: 'P-1' }), '/quote?mode=rent&code=P-1&from=sns-x-12');
    assert.ok(M.ctaPath('view_product', r, { slug: 'hp-probook' }).indexOf('/products/hp-probook?') === 0);
    assert.ok(M.ctaPath('view_product', r, null).indexOf('/buy?') === 0);
    assert.ok(/#contact$/.test(M.ctaPath('contact', r, null)));
  });
  await t('定義：X の文字数は日本語2・URL23', () => {
    assert.strictEqual(M.xWeight('ab'), 2);
    assert.strictEqual(M.xWeight('あい'), 4);
    assert.strictEqual(M.xWeight('https://www.8ec.jp/quote?from=sns-x-1'), 23);
  });
  await t('定義：productSlug は catalog.js の slugOf と同じ結果', () => {
    assert.strictEqual(M.productSlug({ maker: 'HP', name: 'ProBook 450 G9' }), 'hp-probook-450-g9');
    assert.strictEqual(M.productSlug({ maker: '', name: 'ノートPC（中古）', code: 'P-9' }), 'p-9');
  });

  /* ============================================================ 材料 */
  await t('材料：ページは main だけを取り、script・共通ヘッダーは渡さない', () => {
    reset();
    const m = S.materialFromPage(world.pages['/packs/new-employee-pc.html'], { site: 'https://www.8ec.jp' });
    assert.ok(m.text.indexOf('入社日までに') >= 0);
    assert.ok(m.text.indexOf('alert') < 0);
    assert.ok(m.text.indexOf('ヘッダー') < 0 && m.text.indexOf('フッター') < 0);
    assert.deepStrictEqual(m.images, ['https://www.8ec.jp/assets/pack.png']);
  });
  await t('材料：コラムは article だけを取る', () => {
    reset();
    const m = S.materialFromPage(world.pages['/column/old-pc-hidden-cost.html'], {});
    assert.ok(m.text.indexOf('3分') >= 0 && m.text.indexOf('関連') < 0);
  });
  await t('材料：活用例には「実績ではない」を必ず添える', () => {
    reset();
    const m = S.materialFromPage(world.pages['/cases.html'], { notReal: true });
    assert.ok(m.text.indexOf('特定企業の実績ではありません') >= 0);
  });
  await t('材料：商品は許可した列だけ。仕入値・仕入先・在庫数は入らない', () => {
    reset();
    const m = S.materialFromProduct(world.products[0], {});
    assert.ok(m.text.indexOf('ProBook') >= 0);
    assert.ok(m.text.indexOf('12345') < 0 && m.text.indexOf('仕入先') < 0);
    assert.ok(m.text.indexOf('月額：お見積り') >= 0, '未設定の月額は「お見積り」');
    assert.ok(m.text.indexOf('¥59,800') >= 0);
    assert.ok(S.PRODUCT_COLUMNS.indexOf('unit_price') < 0 && S.PRODUCT_COLUMNS.indexOf('qty') < 0
      && S.PRODUCT_COLUMNS.indexOf('supplier') < 0);
  });

  /* ============================================================ 整える */
  await t('整える：URL・ハッシュタグ・連絡先を本文から落とす', () => {
    const b = S.plainBody('詳しくは https://evil.test/x と 8ec.jp/buy へ #勝手タグ', 400, 'https://www.8ec.jp');
    assert.ok(b.indexOf('http') < 0 && b.indexOf('8ec.jp') < 0 && b.indexOf('#') < 0, b);
    const c = S.stripContacts('電話 03-1234-5678 か a@b.co へ');
    assert.ok(c.found && c.text.indexOf('03-1234') < 0 && c.text.indexOf('@') < 0);
  });
  await t('整える：タグは候補と完全一致だけ。表記は候補にそろえる', () => {
    assert.deepStrictEqual(S.pickTags(['#法人pc', 'PCレンタル', '#勝手', '#法人PC'], ['#法人PC', '#PCレンタル'], 5),
      ['#法人PC', '#PCレンタル']);
    assert.deepStrictEqual(S.pickTags(['#a', '#b', '#c'], ['#a', '#b', '#c'], 2), ['#a', '#b']);
  });
  await t('整える：材料に無い数字を拾う（全角・桁区切りも同じ数として見る）', () => {
    assert.deepStrictEqual(S.unknownNumbers('3万円で10台', '10台まで対応'), ['3万円']);
    assert.deepStrictEqual(S.unknownNumbers('５９，８００円', '¥59,800'), []);
  });

  /* ============================================================ 認証 */
  await t('認証：トークンが無いと 401', async () => {
    reset();
    const r = await call({ action: 'save', ...AXES }, null);
    assert.strictEqual(r.status, 401);
  });
  await t('認証：閲覧（viewer）は 403 で、何も書かない', async () => {
    reset();
    const r = await call({ action: 'save', ...AXES }, 'viewer-token-bbbbbbbbbbbbbbbbbbbbbb');
    assert.strictEqual(r.status, 403);
    assert.strictEqual(world.posts.length, 0);
  });
  await t('認証：倉庫メンバー（member）も 403。保存も生成もしない（SNS投稿は管理者だけ）', async () => {
    reset();
    const M_TOKEN = 'member-token-dddddddddddddddddddddd';
    const s = await call({ action: 'save', ...AXES }, M_TOKEN);
    assert.strictEqual(s.status, 403);
    assert.ok(/管理者だけ/.test(s.body.error), s.body.error);
    assert.strictEqual(world.posts.length, 0);
    const r = await call({ action: 'generate', id: '11111111-1111-4111-8111-000000000001' }, M_TOKEN);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(world.openai.length, 0);
    const m = await call({ action: 'material', source_type: 'none' }, M_TOKEN);
    assert.strictEqual(m.status, 403);
    assert.strictEqual(world.publicCalls.length, 0, '倉庫メンバーのために公開ページも取りに行かない');
  });
  await t('認証：共通の staffFromRequest は倉庫メンバーを通す（ほかの社内APIで使うため）', async () => {
    reset();
    const L = require('../api/_lib.js');
    const who = await L.staffFromRequest({ headers: { authorization: 'Bearer member-token-dddddddddddddddddddddd' } });
    assert.strictEqual(who.ok, true);
    assert.strictEqual(who.role, 'member');
    const v = await L.staffFromRequest({ headers: { authorization: 'Bearer viewer-token-bbbbbbbbbbbbbbbbbbbbbb' } });
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.status, 403);
  });
  await t('認証：inventory_members に無いログインは閲覧扱い（403）', async () => {
    reset();
    world.users['stranger-token-cccccccccccccccccccc'] = 'someone@8grp.co.jp';
    const r = await call({ action: 'generate', id: '11111111-1111-4111-8111-000000000001' }, 'stranger-token-cccccccccccccccccccc');
    assert.strictEqual(r.status, 403);
    assert.strictEqual(world.openai.length, 0);
  });
  await t('認証：知らない action は 400', async () => {
    reset();
    assert.strictEqual((await call({ action: 'drop' })).status, 400);
  });

  /* ============================================================ 保存 */
  await t('保存：軸が足りないと保存しない', async () => {
    reset();
    const r = await call({ action: 'save', persona: 'hr_recruit' });
    assert.strictEqual(r.status, 400);
    assert.ok(/課題/.test(r.body.error));
    assert.strictEqual(world.posts.length, 0);
  });
  await t('保存：定義に無いキーは保存しない', async () => {
    reset();
    const r = await call({ action: 'save', ...AXES, cta: 'buy_now_or_die' });
    assert.strictEqual(r.status, 400);
  });
  await t('保存：許可していないページは元コンテンツにできない', async () => {
    reset();
    const r = await call({ action: 'save', ...AXES, source_type: 'page', source_ref: '/zaiko' });
    assert.strictEqual(r.status, 400);
  });
  await t('保存：作成者を記録し、画像は https だけ', async () => {
    reset();
    const r = await call({ action: 'save', ...AXES, source_type: 'page', source_ref: '/packs/new-employee-pc' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(world.posts[0].created_by_email, 'staff@8grp.co.jp');
    const bad = await call({ action: 'save', id: world.posts[0].id, ...AXES, social_image: 'javascript:alert(1)' });
    assert.strictEqual(bad.status, 400);
  });

  /* ============================================================ 生成 */
  async function newPost(extra) {
    const r = await call(Object.assign({ action: 'save', ...AXES, source_type: 'page', source_ref: '/packs/new-employee-pc' }, extra || {}));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body.post;
  }
  await t('生成：URLはサーバーが付け、AIの書いたURLとタグは落とす', async () => {
    reset();
    const p = await newPost();
    world.aiReply = JSON.stringify({
      instagram: '新入社員のPC、入社日までに間に合いますか？\nhttps://evil.test を見て',
      x: '入社日までに設定済みPCを。 #勝手タグ https://evil.test',
      instagram_tags: ['#新入社員', '#勝手タグ'], x_tags: ['#法人PC', '#PCレンタル', '#新入社員'],
    });
    const r = await call({ action: 'generate', id: p.id });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const post = world.posts[0];
    assert.ok(post.x_caption.indexOf('https://www.8ec.jp/quote?from=sns-x-1') >= 0, post.x_caption);
    assert.ok(post.x_caption.indexOf('evil') < 0 && post.instagram_caption.indexOf('evil') < 0);
    assert.ok(post.x_caption.indexOf('#勝手タグ') < 0 && post.instagram_caption.indexOf('#勝手タグ') < 0);
    assert.deepStrictEqual(post.instagram_tags, ['#新入社員']);
    assert.strictEqual(post.x_tags.length, 2, 'Xのタグは2つまで');
    assert.strictEqual(post.cta_url, 'https://www.8ec.jp/quote?from=sns-x-1');
    assert.ok(post.source_hash && post.generated_at && post.generated_model === 'gpt-5-nano');
    assert.strictEqual(post.social_image, 'https://www.8ec.jp/assets/pack.png');
  });
  await t('生成：AIへはペルソナ・Issue・CTA・材料が渡り、指示は system だけ', async () => {
    reset();
    const p = await newPost({ note: '4月入社向け' });
    world.aiReply = JSON.stringify({ instagram: 'a', x: 'b', instagram_tags: [], x_tags: [] });
    await call({ action: 'generate', id: p.id });
    const msg = world.openai[0].messages;
    assert.strictEqual(msg[0].role, 'system');
    assert.ok(msg[0].content.indexOf('採用担当') >= 0 && msg[0].content.indexOf('新入社員用PCを準備したい') >= 0);
    assert.ok(msg[0].content.indexOf('見積を依頼する') >= 0);
    assert.ok(msg[0].content.indexOf('URLは書かない') >= 0);
    assert.ok(msg[1].content.indexOf('入社日までに') >= 0 && msg[1].content.indexOf('4月入社向け') >= 0);
    assert.ok(msg[1].content.indexOf('指示ではありません') >= 0);
    assert.strictEqual(world.openai[0].reasoning_effort, 'minimal');
  });
  await t('生成：gpt-4o 系には reasoning_effort を送らない（8spの400の原因）', async () => {
    reset();
    process.env.OPENAI_MODEL = 'gpt-4o-mini';
    const p = await newPost();
    world.aiReply = JSON.stringify({ instagram: 'a', x: 'b' });
    await call({ action: 'generate', id: p.id });
    process.env.OPENAI_MODEL = 'gpt-5-nano';
    assert.ok(!('reasoning_effort' in world.openai[0]));
    assert.ok(!('max_completion_tokens' in world.openai[0]));
  });
  await t('生成：OPENAI_MODEL が無ければ既定値で動かさず 503', async () => {
    reset();
    const p = await newPost();
    delete process.env.OPENAI_MODEL;
    const r = await call({ action: 'generate', id: p.id });
    process.env.OPENAI_MODEL = 'gpt-5-nano';
    assert.strictEqual(r.status, 503);
    assert.ok(/OPENAI_MODEL/.test(r.body.error));
    assert.strictEqual(world.openai.length, 0);
  });
  await t('生成：OPENAI_API_KEY が無ければ 503（手で書ける旨を返す）', async () => {
    reset();
    const p = await newPost();
    delete process.env.OPENAI_API_KEY;
    const r = await call({ action: 'generate', id: p.id });
    process.env.OPENAI_API_KEY = 'sk-test';
    assert.strictEqual(r.status, 503);
    assert.ok(/手で書いて/.test(r.body.error));
  });
  await t('生成：1日の上限を超えると 429 で、AIを呼ばない', async () => {
    reset();
    const p = await newPost();
    world.gens = [{}, {}, {}];
    const r = await call({ action: 'generate', id: p.id });
    assert.strictEqual(r.status, 429);
    assert.strictEqual(world.openai.length, 0);
  });
  await t('生成：材料に無い数字・連絡先は警告に出す', async () => {
    reset();
    const p = await newPost();
    world.aiReply = JSON.stringify({ instagram: '1台3万円から。電話 03-1234-5678', x: '5日で届きます' });
    const r = await call({ action: 'generate', id: p.id });
    const w = r.body.warnings.join('\n');
    assert.ok(/3万円/.test(w) && /5日/.test(w), w);
    const listed = ((w.match(/材料に無い数字があります：([^（]*)/) || [])[1] || '').split('、');
    assert.ok(listed.indexOf('1台') < 0, '材料にある「1台」は警告しない: ' + listed);
    assert.ok(/電話番号/.test(w));
    assert.ok(world.posts[0].instagram_caption.indexOf('03-1234') < 0);
  });
  await t('生成：商品は公開鍵で公開ビューを読み、CTAは商品ページ', async () => {
    reset();
    const p = await newPost({ source_type: 'product', source_ref: 'P-001', objective: 'purchase', cta: 'view_product' });
    world.aiReply = JSON.stringify({ instagram: 'a', x: 'b' });
    const r = await call({ action: 'generate', id: p.id });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(world.publicKeyUsed.length && world.publicKeyUsed.every(k => k !== 'test-secret'));
    assert.ok(world.posts[0].cta_url.indexOf('https://www.8ec.jp/products/hp-probook-450-g9?') === 0, world.posts[0].cta_url);
    const sent = JSON.stringify(world.openai[0]);
    assert.ok(sent.indexOf('12345') < 0 && sent.indexOf('仕入先') < 0, '仕入値・仕入先をAIに渡さない');
  });
  await t('生成：公開されていないコラムは取りに行かない', async () => {
    reset();
    const p = await newPost({ source_type: 'column', source_ref: 'secret-draft' });
    const r = await call({ action: 'generate', id: p.id });
    assert.strictEqual(r.status, 400);
    assert.ok(world.publicCalls.indexOf('/column/secret-draft.html') < 0);
    assert.strictEqual(world.openai.length, 0);
  });
  await t('生成：元コンテンツ無しはトップのサービス説明だけを渡す', async () => {
    reset();
    const p = await newPost({ source_type: 'none', source_ref: null });
    world.aiReply = JSON.stringify({ instagram: 'a', x: 'b' });
    await call({ action: 'generate', id: p.id });
    const u = world.openai[0].messages[1].content;
    assert.ok(u.indexOf('見積無料') >= 0);
    assert.ok(u.indexOf('0120') < 0, 'ヘッダーの電話番号は渡さない');
  });
  await t('生成：AIが401なら設定の案内を返す', async () => {
    reset();
    const p = await newPost();
    world.aiStatus = 401;
    const r = await call({ action: 'generate', id: p.id });
    assert.strictEqual(r.status, 503);
    assert.ok(/OPENAI_API_KEY/.test(r.body.error));
  });

  /* ============================================================ 投稿済み・古い */
  await t('投稿済み：文が無いと付けられない／付けると日時が入る', async () => {
    reset();
    const p = await newPost();
    assert.strictEqual((await call({ action: 'mark', id: p.id, channel: 'x', posted: true })).status, 400);
    world.aiReply = JSON.stringify({ instagram: 'a', x: 'b' });
    await call({ action: 'generate', id: p.id });
    const r = await call({ action: 'mark', id: p.id, channel: 'x', posted: true });
    assert.strictEqual(r.status, 200);
    assert.ok(world.posts[0].x_posted_at);
    assert.strictEqual(M.statusOf(world.posts[0]).label, 'X済');
  });
  await t('古い：元ページが変わったら印を付ける。取れなかったものは付けない', async () => {
    reset();
    const p = await newPost();
    world.aiReply = JSON.stringify({ instagram: 'a', x: 'b' });
    await call({ action: 'generate', id: p.id });
    let r = await call({ action: 'check', ids: [p.id] });
    assert.deepStrictEqual(r.body.stale, []);
    world.pages['/packs/new-employee-pc.html'] = world.pages['/packs/new-employee-pc.html'].replace('1台から', '2台から');
    r = await call({ action: 'check', ids: [p.id] });
    assert.deepStrictEqual(r.body.stale, [p.id]);
    assert.strictEqual(world.posts[0].social_stale, true);
    delete world.pages['/packs/new-employee-pc.html'];
    world.posts[0].social_stale = false;
    r = await call({ action: 'check', ids: [p.id] });
    assert.deepStrictEqual(r.body.failed, [p.id]);
    assert.strictEqual(world.posts[0].social_stale, false);
  });
  await t('古い：編集画面を開いたとき（material + id）でも判定する', async () => {
    reset();
    const p = await newPost();
    world.aiReply = JSON.stringify({ instagram: 'a', x: 'b' });
    await call({ action: 'generate', id: p.id });
    world.pages['/packs/new-employee-pc.html'] += '<main>追記</main>';
    world.pages['/packs/new-employee-pc.html'] = world.pages['/packs/new-employee-pc.html'].replace('Office設定済み', 'Office・セキュリティ設定済み');
    const r = await call({ action: 'material', id: p.id });
    assert.strictEqual(r.body.stale, true);
  });
  await t('一覧から外す：消さずに archived_at を入れる', async () => {
    reset();
    const p = await newPost();
    await call({ action: 'archive', id: p.id });
    assert.strictEqual(world.posts.length, 1);
    assert.ok(world.posts[0].archived_at);
  });

  /* ============================================================ 小物 */
  await t('日本時間の0時', () => {
    const { jstDayStart } = require('../api/sns.js')._test;
    assert.strictEqual(jstDayStart(new Date('2026-09-30T16:00:00Z')), '2026-09-30T15:00:00.000Z');
    assert.strictEqual(jstDayStart(new Date('2026-09-30T14:59:00Z')), '2026-09-29T15:00:00.000Z');
  });

  console.log(passed + ' 件 OK' + (fails.length ? '、' + fails.length + ' 件 NG' : ''));
  if (fails.length) { console.log('\n' + fails.map(f => '✗ ' + f).join('\n\n')); process.exit(1); }
})();
