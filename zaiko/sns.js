/* ========================================================================
   SNS投稿準備（/zaiko/sns）

   「PCを売るSNS」ではなく「PC調達の悩みを解決するSNS」にするための画面。
   文を作る前に、必ず次の5つを選ぶ。
     ① 誰に（ペルソナ）  ② 何に困っている（Issue）  ③ 投稿タイプ
     ④ 投稿目的          ⑤ CTA（最後にしてほしいこと）
   そのうえで元コンテンツ（任意）を選び、［AIでSNS投稿文を作る］を押したときだけ
   /api/sns が Instagram と X の文を作る。

   ・自動投稿はしない。Instagram はスマホの共有・コピー、X は投稿画面を文入りで開くだけ
   ・管理者だけ。読むのは Supabase から直接（RLSで管理者だけ）。書くのは必ず /api/sns
   ・AIのキー、URLの組み立て、ハッシュタグの照合はサーバー側
   ・生成した文は textContent / esc() で出す（innerHTML にそのまま入れない）

   定義（ペルソナ・Issue・CTA など）は /assets/sns-master.js。
   app.js より先に読み込むので、ここでは関数と状態だけを置き、
   app.js の値（sb・me・esc・toast など）は呼ばれた時点で使う。
   ======================================================================== */
'use strict';

const SNS_API = '/api/sns';
const snsState = {
  loaded: false, loading: false, error: '',
  posts: [], tags: [], columns: [], products: [],
  f: { persona: '', issue: '', status: '' },
  draft: null,        // 編集中の投稿（保存前の値）
  base: null,         // 最後に保存した値（未保存の変更があるかを見る）
  mat: null,          // AIに渡す材料（画面を開いたときに1回取る）
  matFor: '', matOpen: false,
  warnings: [],
  busy: '',
  shareFile: null
};

/* ---------------------------------------------------------------- 読み込み */
async function snsLoad(force) {
  if (snsState.loading || (snsState.loaded && !force)) return;
  snsState.loading = true;
  const [p, t, pr, cj] = await Promise.all([
    sb.from('ec_sns_posts').select('*').is('archived_at', null).order('post_no', { ascending: false }).limit(500),
    sb.from('ec_sns_hashtags').select('tag').eq('active', true).order('sort_index'),
    sb.from('inv_public_products').select('code,name,maker,model,rental_enabled,sale_enabled').limit(2000),
    fetch('/assets/columns.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null)
  ]);
  snsState.loading = false;
  if (p.error) {
    snsState.error = /does not exist|schema cache|PGRST205|42P01/i.test(p.error.message || p.error.code || '')
      ? 'SNS投稿の表がまだありません。Supabase で zaiko/migrations/2026-10-10-sns-posts.sql を実行してください。'
      : '読み込めませんでした：' + (p.error.message || p.error.code);
  } else {
    snsState.error = '';
  }
  snsState.posts = p.data || [];
  snsState.tags = t.error ? [] : (t.data || []).map(x => x.tag);
  snsState.products = pr.error ? [] : (pr.data || []);
  snsState.columns = (cj && cj.articles) || [];
  snsState.loaded = true;
  if (ui.screen === 'sns') render();
}

async function snsCall(action, payload) {
  const { data: { session } } = await sb.auth.getSession();
  const r = await fetch(SNS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (session ? session.access_token : '') },
    body: JSON.stringify(Object.assign({ action }, payload || {}))
  });
  const out = await r.json().catch(() => null);
  if (!r.ok || !out || !out.ok) throw new Error((out && out.error) || ('通信に失敗しました（' + r.status + '）'));
  return out;
}

function snsPut(post) {
  if (!post) return;
  const i = snsState.posts.findIndex(p => p.id === post.id);
  if (post.archived_at) { if (i >= 0) snsState.posts.splice(i, 1); return; }
  if (i >= 0) snsState.posts[i] = post; else snsState.posts.unshift(post);
}

/* ---------------------------------------------------------------- 画面の入口 */
function viewSns() {
  // ADMIN_SCREENS に入っているので、管理者以外は guardRoute() でここへ来ない。念のためここでも止める
  if (!canAdmin()) {
    return `<h1>SNS投稿</h1><div class="card" style="margin-top:15px">SNS投稿は管理者だけが使えます。</div>`;
  }
  if (!snsState.loaded) { snsLoad(); return `<h1>SNS投稿</h1><div class="empty" style="margin-top:15px">読み込み中…</div>`; }
  if (snsState.error) return `<h1>SNS投稿</h1><div class="warnbox" style="margin-top:15px"><span class="ms">error</span><div>${esc(snsState.error)}</div></div>`;
  return ui.snsNo ? snsEditorHtml() : snsListHtml();
}

const SM = () => window.SnsMaster;
const snsLabel = (list, key) => SM().labelOf(SM()[list], key);

function snsStatusTags(p) {
  const st = SM().statusOf(p);
  const cls = { none: 'none', ready: 'todo', ig: 'todo', x: 'todo', done: 'on' }[st.key];
  return `<span class="snstags"><span class="tag sns-${cls}">${esc(st.label)}</span>`
    + (p.social_stale ? '<span class="tag sns-stale" title="元コンテンツか、選んだ軸が変わっています">元が更新されています</span>' : '')
    + '</span>';
}

/* ---------------------------------------------------------------- 一覧 */
function snsListHtml() {
  const M = SM(), f = snsState.f;
  const rows = snsState.posts.filter(p =>
    (!f.persona || p.persona === f.persona) && (!f.issue || p.issue === f.issue)
    && (!f.status || (f.status === 'stale' ? p.social_stale : M.statusOf(p).key === f.status)));
  const opt = (list, cur) => list.filter(x => !x.retired).map(x =>
    `<option value="${esc(x.key)}"${cur === x.key ? ' selected' : ''}>${esc(x.label)}</option>`).join('');
  const stOpts = [['none', 'SNS未作成'], ['ready', 'SNS文作成済み'], ['ig', 'Instagram済'], ['x', 'X済'],
                  ['done', 'Instagram済・X済'], ['stale', '元が更新されています']];
  return `
    <div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap">
      <h1>SNS投稿</h1>
      <button class="btn lime" style="margin-left:auto" onclick="go('sns','new')"><span class="ms">add</span>新しく作る</button>
    </div>
    <p class="sub" style="margin:8px 0 15px">「PCを売る」投稿ではなく、<b>PC調達・IT機器導入の困りごとを解決する</b>投稿を作ります。
      先に <b>誰に・何の悩みに・何をしてほしいか</b> を選んでから、AIで Instagram と X の文を下書きします。
      <b>自動では投稿しません。</b>投稿は担当者が行い、済んだら印を付けてください。</p>
    <div class="fields" style="max-width:none;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin-bottom:10px">
      <label class="field"><span>ペルソナ</span><select class="input" onchange="snsState.f.persona=this.value;render()">
        <option value="">すべて</option>${opt(M.PERSONAS, f.persona)}</select></label>
      <label class="field"><span>Issue</span><select class="input" onchange="snsState.f.issue=this.value;render()">
        <option value="">すべて</option>${opt(M.ISSUES, f.issue)}</select></label>
      <label class="field"><span>ステータス</span><select class="input" onchange="snsState.f.status=this.value;render()">
        <option value="">すべて</option>${stOpts.map(([k, l]) => `<option value="${k}"${f.status === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <span class="meta">${rows.length} 件</span>
      <button class="btn sm ghost" style="margin-left:auto" onclick="snsCheckAll(this)"
        title="コラム・商品・公開ページが、文を作ったあとに変わっていないかを確かめます">
        <span class="ms">sync</span>元コンテンツの更新を確認</button>
    </div>
    ${rows.length ? `<div class="table-wrap"><table class="t">
      <thead><tr><th>No</th><th>サービス</th><th>ペルソナ</th><th>Issue</th><th>投稿タイプ</th><th>投稿目的</th><th>CTA</th>
        <th>Instagram</th><th>X</th><th>投稿日</th><th>ステータス</th></tr></thead>
      <tbody>${rows.map(p => `
        <tr style="cursor:pointer" onclick="go('sns',${Number(p.post_no)})">
          <td class="num">${Number(p.post_no)}</td>
          <td>8EC</td>
          <td>${esc(snsLabel('PERSONAS', p.persona))}</td>
          <td>${esc(snsLabel('ISSUES', p.issue))}</td>
          <td>${esc(snsLabel('CONTENT_TYPES', p.content_type))}</td>
          <td>${esc(snsLabel('OBJECTIVES', p.objective))}</td>
          <td>${esc(snsLabel('CTAS', p.cta))}</td>
          <td class="nowrap">${p.instagram_posted_at ? '済 ' + fmtD(p.instagram_posted_at) : (p.instagram_caption ? '未投稿' : '—')}</td>
          <td class="nowrap">${p.x_posted_at ? '済 ' + fmtD(p.x_posted_at) : (p.x_caption ? '未投稿' : '—')}</td>
          <td class="nowrap">${M.postedAt(p) ? fmtD(M.postedAt(p)) : '—'}</td>
          <td class="nowrap">${snsStatusTags(p)}</td>
        </tr>`).join('')}</tbody></table></div>`
      : `<div class="empty" style="margin-top:12px">${snsState.posts.length ? '条件に合う投稿はありません。' : 'まだ投稿はありません。［新しく作る］から始めてください。'}</div>`}`;
}

async function snsCheckAll(btn) {
  const ids = snsState.posts.filter(p => p.generated_at).slice(0, 30).map(p => p.id);
  if (!ids.length) { toast('確かめる投稿がありません'); return; }
  btn.disabled = true;
  try {
    const out = await snsCall('check', { ids });
    snsState.posts.forEach(p => { if (out.stale.indexOf(p.id) >= 0) p.social_stale = true; });
    toast(out.stale.length ? `元が更新された投稿が ${out.stale.length}件あります`
      : (out.failed.length ? `${out.failed.length}件は確かめられませんでした` : '更新された元コンテンツはありません'));
    render();
  } catch (e) { toast(e.message); btn.disabled = false; }
}

/* ---------------------------------------------------------------- 作成・編集 */
const SNS_FIELDS = ['persona', 'issue', 'content_type', 'objective', 'cta', 'source_type', 'source_ref', 'note',
                    'instagram_caption', 'x_caption', 'social_image'];

function snsOpenDraft() {
  const key = String(ui.snsNo);
  if (snsState.draft && snsState.draft._key === key) return snsState.draft;
  let base;
  if (key === 'new') {
    base = { persona: '', issue: '', content_type: 'issue', objective: '', cta: '', source_type: 'none',
             source_ref: '', note: '', instagram_caption: '', x_caption: '', social_image: '' };
  } else {
    const p = snsState.posts.find(x => String(x.post_no) === key);
    if (!p) return null;
    base = {};
    SNS_FIELDS.forEach(k => { base[k] = p[k] == null ? '' : p[k]; });
    base.id = p.id;
  }
  snsState.base = Object.assign({}, base);
  snsState.draft = Object.assign({ _key: key }, base);
  snsState.warnings = [];
  snsState.mat = null; snsState.matFor = ''; snsState.shareFile = null;
  if (base.id) snsLoadMaterial(true);
  return snsState.draft;
}

const snsDirtyKeys = (keys) => (keys || SNS_FIELDS).filter(k =>
  String(snsState.draft[k] == null ? '' : snsState.draft[k]) !== String(snsState.base[k] == null ? '' : snsState.base[k]));
const SNS_SETUP = ['persona', 'issue', 'content_type', 'objective', 'cta', 'source_type', 'source_ref', 'note'];

function snsPost() { return snsState.draft && snsState.draft.id ? snsState.posts.find(p => p.id === snsState.draft.id) : null; }

function snsSourceTitle(d) {
  const M = SM();
  if (d.source_type === 'column') { const a = snsState.columns.find(x => x.slug === d.source_ref); return a ? a.title : d.source_ref; }
  if (d.source_type === 'page') { const pg = M.pageOf(d.source_ref); return pg ? pg.label : d.source_ref; }
  if (d.source_type === 'product') {
    const p = snsState.products.find(x => x.code === d.source_ref);
    return p ? [p.maker, p.name || p.model].filter(Boolean).join(' ') : d.source_ref;
  }
  return '';
}

function snsSourceOptions(d) {
  const M = SM();
  if (d.source_type === 'column') {
    return snsState.columns.map(a => `<option value="${esc(a.slug)}"${d.source_ref === a.slug ? ' selected' : ''}>${esc(a.title)}</option>`).join('');
  }
  if (d.source_type === 'page') {
    const issue = M.find(M.ISSUES, d.issue);
    const hint = issue ? issue.pages : [];
    const pages = M.PAGES.slice().sort((a, b) => (hint.indexOf(a.path) < 0) - (hint.indexOf(b.path) < 0));
    return pages.map(pg => `<option value="${esc(pg.path)}"${d.source_ref === pg.path ? ' selected' : ''}>${
      hint.indexOf(pg.path) >= 0 ? '★ ' : ''}${esc(pg.label)}（${esc(pg.path)}）</option>`).join('');
  }
  if (d.source_type === 'product') {
    return snsState.products.slice().sort((a, b) => String(a.maker || '').localeCompare(String(b.maker || ''), 'ja'))
      .map(p => `<option value="${esc(p.code)}"${d.source_ref === p.code ? ' selected' : ''}>${
        esc([p.maker, p.name || p.model].filter(Boolean).join(' '))}（${esc(p.code)}）</option>`).join('');
  }
  return '';
}

function snsEditorHtml() {
  const d = snsOpenDraft();
  if (!d) return `<h1>SNS投稿</h1><div class="empty" style="margin-top:15px">この投稿は見つかりません。
    <button class="btn sm ghost" onclick="go('sns')">一覧へ</button></div>`;
  const M = SM(), post = snsPost();
  const sel = (field, list, opts) => `<select class="input" id="sns-${field}" onchange="snsSet('${field}',this.value,true)">
      <option value="">選んでください</option>${opts || list.filter(x => !x.retired || d[field] === x.key).map(x =>
        `<option value="${esc(x.key)}"${d[field] === x.key ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}</select>`;
  const issues = M.issuesFor(d.persona);
  const issueOpts = (issues.hit.length ? `<optgroup label="このペルソナに多い悩み">${issues.hit.map(x =>
      `<option value="${esc(x.key)}"${d.issue === x.key ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}</optgroup>
      <optgroup label="そのほか">` : '') + issues.rest.map(x =>
      `<option value="${esc(x.key)}"${d.issue === x.key ? ' selected' : ''}>${esc(x.label)}</option>`).join('')
      + (issues.hit.length ? '</optgroup>' : '');
  const miss = M.missingAxes(d);
  const needRef = d.source_type !== 'none' && !d.source_ref;
  const made = !!(d.instagram_caption || d.x_caption);
  const busy = snsState.busy;

  return `
    <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap">
      <button class="btn sm ghost" onclick="snsLeave()"><span class="ms">arrow_back</span>一覧</button>
      <h1 style="font-size:30px">SNS投稿${post ? ' <span class="num meta" style="font-size:16px">No.' + Number(post.post_no) + '</span>' : '（新規）'}</h1>
      ${post ? snsStatusTags(post) : ''}
    </div>

    <div class="sec" style="font-size:18px;margin-top:22px">1. 誰の、何の悩みに答える投稿か</div>
    <div class="fields" style="max-width:none;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">
      <label class="field"><span>① 対象（ペルソナ）</span>${sel('persona', M.PERSONAS)}</label>
      <label class="field"><span>② 課題（Issue）</span><select class="input" id="sns-issue" onchange="snsSet('issue',this.value,true)">
        <option value="">選んでください</option>${issueOpts}</select></label>
      <label class="field"><span>③ 投稿タイプ</span>${sel('content_type', M.CONTENT_TYPES)}</label>
      <label class="field"><span>④ 投稿目的</span>${sel('objective', M.OBJECTIVES)}</label>
      <label class="field"><span>⑤ CTA（最後にしてほしいこと）</span>${sel('cta', M.CTAS)}</label>
    </div>

    <div class="sec" style="font-size:18px;margin-top:22px">2. 元コンテンツ（任意）</div>
    <div class="fields" style="max-width:none;grid-template-columns:minmax(200px,260px) 1fr">
      <label class="field"><span>⑥ 種類</span><select class="input" onchange="snsSet('source_type',this.value,true)">
        ${M.SOURCE_TYPES.map(x => `<option value="${x.key}"${d.source_type === x.key ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}</select></label>
      ${d.source_type === 'none' ? `<div class="meta" style="align-self:end;padding-bottom:12px">
          元が無いときは、トップページのサービス説明だけを材料にします。</div>`
        : `<label class="field"><span>どれを使うか</span><select class="input" onchange="snsSet('source_ref',this.value,true)">
          <option value="">選んでください</option>${snsSourceOptions(d)}</select></label>`}
    </div>
    ${d.source_type === 'page' && d.source_ref === '/cases' ? `<p class="meta" style="margin-top:6px">
      活用例は特定企業の実績ではありません。AIにもそう伝え、実績としては書かせません。</p>` : ''}
    <label class="field" style="margin-top:14px;max-width:760px"><span>⑦ 補足（任意・1行）</span>
      <input class="input" maxlength="300" value="${esc(d.note)}" placeholder="例：4月入社に間に合わせたい企業向けに"
        oninput="snsSet('note',this.value)"></label>
    <p class="meta" style="margin-top:4px">補足もAIに渡す材料に加わります。事実でないこと（未確認の価格・実績など）は書かないでください。</p>
    <details style="margin-top:10px" ${snsState.matOpen ? 'open' : ''} ontoggle="snsState.matOpen=this.open;if(this.open)snsLoadMaterial()">
      <summary class="meta" style="cursor:pointer">AIに渡す材料を見る</summary>
      <div id="sns-mat">${snsMaterialHtml()}</div>
    </details>

    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:18px">
      <button class="btn lime" ${miss.length || needRef || busy ? 'disabled' : ''} onclick="snsGenerate()">
        <span class="ms">auto_awesome</span>${busy === 'gen' ? '作成中…' : (made ? 'AIで作り直す' : 'AIでSNS投稿文を作る')}</button>
      <button class="btn ghost" ${miss.length || needRef || busy ? 'disabled' : ''} onclick="snsSave()">
        ${busy === 'save' ? '保存中…' : (d.id ? '保存' : '選んだ内容を保存')}</button>
      <span class="meta">${miss.length ? '選んでください：' + esc(miss.join('、'))
        : needRef ? '元コンテンツを選んでください' : 'AIは押したときだけ動きます。自動では投稿しません。'}</span>
    </div>

    ${snsState.warnings.length ? `<div class="warnbox" style="margin-top:14px"><span class="ms">warning</span><div>${
      snsState.warnings.map(w => `<div>${esc(w)}</div>`).join('')}</div></div>` : ''}
    ${post && post.social_stale ? `<div class="warnbox" style="margin-top:14px"><span class="ms">update</span>
      <div>元コンテンツか、選んだ軸が文を作ったあとに変わっています。内容を確かめて、必要なら作り直してください。</div></div>` : ''}

    ${d.id ? snsOutputHtml(d, post) : ''}
    ${d.id ? `<details style="margin-top:30px"><summary class="meta" style="cursor:pointer">この投稿を一覧から外す</summary>
      <p class="meta" style="margin:6px 0">消去はしません（計測の番号を残すため）。一覧に出なくなるだけです。</p>
      <button class="btn sm ghost" onclick="snsArchive()">一覧から外す</button></details>` : ''}`;
}

function snsMaterialHtml() {
  const m = snsState.mat;
  if (!m) return '<div class="meta" style="margin-top:6px">開くと読み込みます。</div>';
  if (m.error) return `<div class="meta" style="margin-top:6px">${esc(m.error)}</div>`;
  return `<div class="meta" style="margin:6px 0">${m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.url)}</a>` : ''}</div>
    <div class="pre">${esc(m.text)}</div>`;
}

function snsOutputHtml(d, post) {
  const M = SM();
  const imgs = [];
  if (d.social_image) imgs.push(d.social_image);
  ((snsState.mat && snsState.mat.images) || []).forEach(u => { if (imgs.indexOf(u) < 0) imgs.push(u); });
  const xw = M.xWeight(d.x_caption);
  const canShare = !!(navigator.share);
  const dirtyCap = snsDirtyKeys(['instagram_caption', 'x_caption', 'social_image']).length > 0;
  return `
    <div class="sec" style="font-size:18px;margin-top:30px">3. Instagram</div>
    <textarea class="input" id="sns-ig" rows="8" style="max-width:760px" oninput="snsSet('instagram_caption',this.value);snsCount()"
      placeholder="［AIでSNS投稿文を作る］を押すか、手で書いてください">${esc(d.instagram_caption)}</textarea>
    <div class="meta" id="sns-ig-n">${String(d.instagram_caption || '').length} 文字（Instagramのキャプションはリンクが押せないのでURLは入れません）</div>
    ${imgs.length ? `<div class="field" style="margin-top:10px"><span>画像</span>
      <div style="display:flex;gap:10px;flex-wrap:wrap">${imgs.map(u => `
        <label style="display:flex;flex-direction:column;align-items:center;gap:4px;cursor:pointer">
          <img src="${esc(u)}" alt="" loading="lazy" style="width:120px;height:90px;object-fit:contain;background:var(--panel);border:${
            d.social_image === u ? '2px solid var(--ink)' : '1px solid var(--line)'}">
          <input type="radio" name="sns-img" ${d.social_image === u ? 'checked' : ''} onchange="snsPickImage(${esc(JSON.stringify(u))})">
        </label>`).join('')}</div></div>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:center">
      ${canShare ? `<button class="btn sm pri" onclick="snsShareIG()"><span class="ms">ios_share</span>スマホで共有</button>` : ''}
      <button class="btn sm ghost" onclick="snsCopy('instagram_caption')">文をコピー</button>
      <a class="btn sm ghost" href="https://www.instagram.com/" target="_blank" rel="noopener" onclick="snsCopy('instagram_caption')">コピーしてInstagramを開く</a>
      ${d.social_image ? `<a class="btn sm ghost" href="${esc(d.social_image)}" target="_blank" rel="noopener">画像を開く</a>` : ''}
      <label style="display:flex;gap:6px;align-items:center;margin-left:8px">
        <input type="checkbox" ${post && post.instagram_posted_at ? 'checked' : ''} ${d.instagram_caption ? '' : 'disabled'}
          onchange="snsMark('instagram',this.checked,this)"> Instagram 投稿済み
        ${post && post.instagram_posted_at ? `<span class="meta">${fmtDT(post.instagram_posted_at)}</span>` : ''}</label>
    </div>

    <div class="sec" style="font-size:18px;margin-top:30px">4. X</div>
    <textarea class="input" id="sns-x" rows="5" style="max-width:760px" oninput="snsSet('x_caption',this.value);snsCount()"
      placeholder="［AIでSNS投稿文を作る］を押すか、手で書いてください">${esc(d.x_caption)}</textarea>
    <div class="meta" id="sns-x-n" style="${xw > M.X_MAX ? 'color:#B3261E;font-weight:700' : ''}">${xw} / ${M.X_MAX}（日本語は2、URLは23として数えます）</div>
    ${post && post.cta_url ? `<div class="meta">CTAのURL：<a href="${esc(post.cta_url)}" target="_blank" rel="noopener">${esc(post.cta_url)}</a>（サーバーが付けたもの。AIは書いていません）</div>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:center">
      <button class="btn sm pri" onclick="snsOpenX()"><span class="ms">open_in_new</span>Xの投稿画面を開く</button>
      <button class="btn sm ghost" onclick="snsCopy('x_caption')">文をコピー</button>
      <label style="display:flex;gap:6px;align-items:center;margin-left:8px">
        <input type="checkbox" ${post && post.x_posted_at ? 'checked' : ''} ${d.x_caption ? '' : 'disabled'}
          onchange="snsMark('x',this.checked,this)"> X 投稿済み
        ${post && post.x_posted_at ? `<span class="meta">${fmtDT(post.x_posted_at)}</span>` : ''}</label>
    </div>

    <div style="display:flex;gap:10px;align-items:center;margin-top:18px">
      <button class="btn pri" id="sns-save-cap" ${dirtyCap && !snsState.busy ? '' : 'disabled'} onclick="snsSave()">文と画像を保存</button>
      <span class="meta" id="sns-cap-note">${dirtyCap ? '保存していない変更があります' : ''}</span>
    </div>
    <p class="meta" style="margin-top:8px">文を直すと、その文の「投稿済み」の印は外れます（前の文を投稿した印を残さないため）。</p>`;
}

/* 入力。軸や元コンテンツを変えたときだけ描き直す（文の入力中は描き直さない） */
function snsSet(field, value, rerender) {
  const d = snsState.draft;
  if (!d) return;
  d[field] = value;
  if (field === 'objective' && value) {
    const o = SM().find(SM().OBJECTIVES, value);
    if (o && !d.cta) d.cta = o.cta;
  }
  if (field === 'source_type') { d.source_ref = ''; snsState.mat = null; snsState.matFor = ''; }
  if (field === 'source_ref') { snsState.mat = null; snsState.matFor = ''; }
  if (rerender) render();
  else snsDirtyNote();
}
function snsDirtyNote() {
  const dirty = snsDirtyKeys(['instagram_caption', 'x_caption', 'social_image']).length > 0;
  const b = $('sns-save-cap'), n = $('sns-cap-note');
  if (b) b.disabled = !dirty || !!snsState.busy;
  if (n) n.textContent = dirty ? '保存していない変更があります' : '';
}
function snsCount() {
  const d = snsState.draft, M = SM();
  const ig = $('sns-ig-n'), x = $('sns-x-n');
  if (ig) ig.textContent = String(d.instagram_caption || '').length + ' 文字（Instagramのキャプションはリンクが押せないのでURLは入れません）';
  if (x) {
    const w = M.xWeight(d.x_caption);
    x.textContent = w + ' / ' + M.X_MAX + '（日本語は2、URLは23として数えます）';
    x.style.color = w > M.X_MAX ? '#B3261E' : '';
    x.style.fontWeight = w > M.X_MAX ? '700' : '';
  }
}

async function snsLoadMaterial(byId) {
  const d = snsState.draft;
  if (!d) return;
  // 保存済みで元コンテンツを変えていなければ、投稿として読む（古いかどうかも一緒に分かる）
  if (byId === undefined) byId = !!d.id && !snsDirtyKeys(['source_type', 'source_ref']).length;
  const key = byId ? 'id:' + d.id : d.source_type + ':' + d.source_ref;
  if (snsState.matFor === key && snsState.mat) return;
  if (d.source_type !== 'none' && !d.source_ref) { snsState.mat = { error: '元コンテンツを選ぶと表示します。' }; snsPaintMaterial(); return; }
  snsState.matFor = key;
  try {
    const out = await snsCall('material', byId ? { id: d.id } : { source_type: d.source_type, source_ref: d.source_ref });
    if (snsState.matFor !== key) return;
    snsState.mat = out.material;
    if (byId && out.stale) {
      const p = snsPost();
      if (p && !p.social_stale) { p.social_stale = true; render(); return; }
    }
    if (byId) { render(); return; }     // 画像の候補を出すため
  } catch (e) {
    snsState.mat = { error: e.message };
  }
  snsPaintMaterial();
}
function snsPaintMaterial() { const el = $('sns-mat'); if (el) el.innerHTML = snsMaterialHtml(); }

/* 保存。選んだ内容と、文・画像をまとめて送る。送った値はサーバーで確かめ直す */
async function snsSave() {
  const d = snsState.draft;
  if (!d || snsState.busy) return null;
  snsState.busy = 'save'; render();
  try {
    const payload = {
      id: d.id || undefined, persona: d.persona, issue: d.issue, content_type: d.content_type,
      objective: d.objective, cta: d.cta, source_type: d.source_type, source_ref: d.source_ref || null,
      source_title: snsSourceTitle(d), note: d.note
    };
    if (d.id) {
      payload.instagram_caption = d.instagram_caption;
      payload.x_caption = d.x_caption;
      payload.social_image = d.social_image || null;
    }
    const out = await snsCall('save', payload);
    snsPut(out.post);
    snsAfterSave(out.post);
    toast('保存しました');
    return out.post;
  } catch (e) {
    toast(e.message);
    return null;
  } finally {
    snsState.busy = ''; render();
  }
}
function snsAfterSave(post) {
  const wasNew = !snsState.draft.id;
  const base = {};
  SNS_FIELDS.forEach(k => { base[k] = post[k] == null ? '' : post[k]; });
  base.id = post.id;
  snsState.base = Object.assign({}, base);
  snsState.draft = Object.assign({ _key: String(post.post_no) }, base);
  if (wasNew) {
    history.replaceState(null, '', pathFor('sns', post.post_no));
    ui.snsNo = post.post_no;
  }
}

async function snsGenerate() {
  const d = snsState.draft;
  if (!d || snsState.busy) return;
  if ((d.instagram_caption || d.x_caption)
      && !confirm('いまの Instagram と X の文を、AIの新しい文で置き換えます。手で直したところは消えます。よろしいですか？')) return;
  // 選んだ内容が保存されていなければ、先に保存する（保存した内容でAIが作る）
  if (!d.id || snsDirtyKeys(SNS_SETUP).length) {
    // 文の手直しが保存されていないときは、置き換える前に一緒に保存しない（上で確認済み）
    const saved = await snsSave();
    if (!saved) return;
  }
  snsState.busy = 'gen'; snsState.warnings = []; render();
  try {
    const out = await snsCall('generate', { id: snsState.draft.id });
    snsPut(out.post);
    snsAfterSave(out.post);
    snsState.warnings = out.warnings || [];
    snsState.mat = out.material || snsState.mat;
    snsState.matFor = 'id:' + out.post.id;
    snsState.shareFile = null;
    toast('SNS投稿文を作りました。読んで直してから投稿してください');
  } catch (e) {
    toast(e.message);
    snsState.warnings = [e.message];
  } finally {
    snsState.busy = ''; render();
  }
}

async function snsMark(channel, posted, box) {
  const d = snsState.draft;
  if (snsDirtyKeys(['instagram_caption', 'x_caption']).length) {
    box.checked = !posted;
    toast('先に［文と画像を保存］を押してください（保存前の文には印を付けられません）');
    return;
  }
  box.disabled = true;
  try {
    const out = await snsCall('mark', { id: d.id, channel, posted });
    snsPut(out.post);
    toast(posted ? (channel === 'x' ? 'X 投稿済みにしました' : 'Instagram 投稿済みにしました') : '印を外しました');
    render();
  } catch (e) { toast(e.message); box.checked = !posted; box.disabled = false; }
}

async function snsArchive() {
  const d = snsState.draft;
  if (!d || !d.id || !confirm('この投稿を一覧から外します（消去はしません）。よろしいですか？')) return;
  try {
    const out = await snsCall('archive', { id: d.id });
    snsPut(out.post);
    snsState.draft = null;
    toast('一覧から外しました');
    go('sns');
  } catch (e) { toast(e.message); }
}

function snsLeave() {
  if (snsState.draft && snsDirtyKeys().length && !confirm('保存していない変更があります。一覧に戻りますか？')) return;
  snsState.draft = null;
  go('sns');
}

/* ---------------------------------------------------------------- 共有・コピー */
function snsCopy(field) {
  const text = String((snsState.draft || {})[field] || '');
  if (!text) { toast('文がありません'); return; }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast('コピーしました'), () => toast('コピーできませんでした'));
  } else {
    toast('この端末ではコピーできません。文を選んでコピーしてください');
  }
}

function snsOpenX() {
  const text = String((snsState.draft || {}).x_caption || '');
  if (!text) { toast('X の文がありません'); return; }
  window.open(SM().xIntentUrl(text), '_blank', 'noopener');
}

/* 画像は選んだ時点で File にしておく。押してから取りに行くと、
   ユーザー操作の流れから外れて共有シートが開かない端末があるため（8sp と同じ） */
function snsPickImage(url) {
  snsSet('social_image', url, true);
  snsState.shareFile = null;
  fetch(url, { mode: 'cors' }).then(r => r.ok ? r.blob() : null).then(b => {
    if (!b || snsState.draft.social_image !== url) return;
    const ext = (b.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    snsState.shareFile = new File([b], 'sns.' + ext, { type: b.type || 'image/jpeg' });
  }).catch(() => { /* 取れない画像（他サイト）は文だけ共有する */ });
}

async function snsShareIG() {
  const text = String((snsState.draft || {}).instagram_caption || '');
  if (!text) { toast('Instagram の文がありません'); return; }
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {});
  const f = snsState.shareFile;
  const data = f && navigator.canShare && navigator.canShare({ files: [f] }) ? { files: [f], text } : { text };
  try {
    await navigator.share(data);
  } catch (e) {
    if (e && e.name === 'AbortError') return;      // 共有シートを閉じただけ
    toast('共有できませんでした。文はコピー済みです');
  }
}
