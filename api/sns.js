// ============================================================
// SNS投稿準備（/zaiko/sns）のサーバー側（Vercel サーバーレス関数）
//
//   Persona × Issue × Content × CTA を選んだ投稿について、
//   Instagram と X に貼る文の**たたき台**を組み立てて保存する。
//   自動投稿はしない。SNSのトークンも持たない。最終投稿は人が行う。
//
//   **外部のAI APIは使いません。APIキーも足しません。**
//   たたき台は、選んだ軸の表示名と、元コンテンツの見出し・説明だけから
//   決まった型で組み立てます（api/_sns.js の draftFrom）。
//   材料に無いことを書かない・数字を作らない、がいちばん大事な要件なので、
//   そもそも作りようのない作りにしています。
//
//   ブラウザ（/zaiko）→ Vercel /api/sns →（サーバー鍵）→ Supabase
//   ・操作のたびに、ログインと役割をここで確かめる。SNS投稿は**管理者だけ**
//     （判定は #51 で入った共通の L.caller() を使い、その上でここで admin に絞る）
//   ・サーバー鍵はここだけで使う。ブラウザには渡さない
//   ・材料にするのは公開されているものだけ（api/_sns.js の説明を参照）
//   ・URLはここで組み立てる。文の中には書かせない
//   ・ハッシュタグは ec_sns_hashtags の候補からだけ
//
//   action（POST の JSON で渡す）
//     save      … 投稿を作る／直す（軸・元コンテンツ・文・タグ・画像）
//     material  … 組み立てに使う材料を見せる（文は作らない）
//     generate  … たたき台を組み立てて保存する（ボタンを押したときだけ）
//     mark      … Instagram済・X済を付ける／外す
//     check     … 元コンテンツが更新されていないか確かめる（古ければ印を付ける）
//     archive   … 一覧から外す（消さない）
//
//   ── Vercel での設定 ─────────────────────────────
//     SUPABASE_SECRET_KEY 【必須】サーバー鍵（無ければ 503 で何も変更しない）
//     SNS_DAILY_LIMIT     1日（日本時間）の組み立て回数の上限。既定 50
//     SUPABASE_ANON_KEY   公開ビューを読む鍵。既定はサイトに載っている公開鍵
//     SITE_URL            既定 https://www.8ec.jp（CTAのURLと、公開ページを取りに行く先）
//   **AI用のキーは1つも要りません。**
// ============================================================

const L = require("./_lib.js");
const S = require("./_sns.js");
const M = require("../assets/sns-master.js");

const SITE = String(process.env.SITE_URL || "https://www.8ec.jp").replace(/\/+$/, "");
// 公開鍵（サイトのJSにも載っている）。公開ビューのように「誰が読んでもよいもの」しか読めない。
// 商品の材料はわざとこの鍵で読む（サーバー鍵で読むと、うっかり社内の列まで取れてしまうため）
const PUBLIC_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_yZCcrwdqjuf0u_5WBWlHIw_AxdvteEV";
const DAILY_LIMIT = Math.max(1, Number(process.env.SNS_DAILY_LIMIT) || 50);
const FETCH_TIMEOUT = 10000;
const CHECK_MAX = 30;

/* 生成のしかたの名札。履歴（generated_model）に残して、
   どの型で作ったものかを後から分かるようにする */
const DRAFT_KIND = "template-v1";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ---- 公開されているものを取りに行く ------------------------------ */

async function fetchText(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: "text/html,application/json" } });
    if (!r.ok) throw new HttpError(502, "公開ページを読めませんでした（" + r.status + "）");
    return await r.text();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, "公開ページを読めませんでした。時間をおいてお試しください");
  } finally {
    clearTimeout(timer);
  }
}

async function publicView(query) {
  const r = await fetch(L.SUPABASE_URL + "/rest/v1/" + query, {
    headers: { apikey: PUBLIC_KEY, Authorization: "Bearer " + PUBLIC_KEY },
  });
  const out = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(out)) throw new HttpError(502, "公開カタログを読めませんでした");
  return out;
}

/* 商品ページの slug。assets/catalog.js の withSlugs と同じく、
   同じ slug が2つ以上あるときは型番を足して分ける */
async function productSlugFor(p) {
  const all = await publicView("inv_public_products?select=code,maker,name,model");
  const base = M.productSlug(p);
  const same = all.filter((m) => M.productSlug(m) === base).length;
  const extra = String(p.model || p.code || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return same > 1 && extra && base.indexOf(extra) < 0 ? base + "-" + extra : base;
}

/* 元コンテンツから材料を作る。許可したもの以外は取りに行かない */
async function buildMaterial(type, ref) {
  if (type === "none") {
    const html = await fetchText(SITE + "/");
    return { material: S.materialFromService(html, { site: SITE, url: SITE + "/" }), product: null };
  }
  if (type === "column") {
    if (!/^[a-z0-9-]{1,80}$/.test(String(ref || ""))) throw new HttpError(400, "コラムの指定が不正です");
    const idx = JSON.parse(await fetchText(SITE + "/assets/columns.json"));
    const art = ((idx && idx.articles) || []).find((a) => a && a.slug === ref);
    if (!art) throw new HttpError(400, "そのコラムは公開されていません");
    const url = SITE + "/column/" + ref + ".html";
    const html = await fetchText(url);
    return { material: S.materialFromPage(html, { site: SITE, url, title: art.title }), product: null };
  }
  if (type === "page") {
    const page = M.pageOf(ref);
    if (!page) throw new HttpError(400, "そのページは元コンテンツにできません");
    const html = await fetchText(SITE + page.file);
    return {
      material: S.materialFromPage(html, { site: SITE, url: SITE + page.path, notReal: !!page.notReal }),
      product: null,
    };
  }
  if (type === "product") {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(ref || ""))) throw new HttpError(400, "商品の指定が不正です");
    const rows = await publicView("inv_public_products?select=" + S.PRODUCT_COLUMNS.join(",")
      + "&code=eq." + encodeURIComponent(ref));
    const p = rows[0];
    if (!p) throw new HttpError(400, "その商品は公開されていません");
    const slug = await productSlugFor(p);
    const url = SITE + "/products/" + encodeURIComponent(slug);
    return {
      material: S.materialFromProduct(p, { url }),
      product: { code: p.code, slug, rental_enabled: !!p.rental_enabled, sale_enabled: !!p.sale_enabled },
    };
  }
  throw new HttpError(400, "元コンテンツの種類が不正です");
}

/* ---- 投稿の読み書き --------------------------------------------- */

async function loadPost(id) {
  if (!UUID_RE.test(String(id || ""))) throw new HttpError(400, "投稿の指定が不正です");
  const q = await L.rest("ec_sns_posts?select=*&id=eq." + id + "&archived_at=is.null");
  if (!q.ok) throw new HttpError(503, supaError(q));
  const row = Array.isArray(q.out) && q.out[0];
  if (!row) throw new HttpError(404, "投稿が見つかりません");
  return row;
}

async function patchPost(id, patch) {
  const q = await L.rest("ec_sns_posts?id=eq." + id + "&archived_at=is.null",
    { method: "PATCH", body: patch, headers: { Prefer: "return=representation" } });
  if (!q.ok) throw new HttpError(503, supaError(q));
  const row = Array.isArray(q.out) && q.out[0];
  if (!row) throw new HttpError(404, "投稿が見つかりません");
  return row;
}

async function activeTags() {
  const q = await L.rest("ec_sns_hashtags?select=tag&active=is.true&order=sort_index.asc,tag.asc");
  if (!q.ok) return [];
  return (q.out || []).map((r) => r.tag).filter((t) => /^#\S+$/.test(t));
}

function supaError(q) {
  const m = (q && q.out && (q.out.message || q.out.hint)) || "";
  if (/ec_sns_|does not exist|schema cache|PGRST205|42P01/i.test(m)) {
    return "SNS投稿の表がまだありません。zaiko/migrations/2026-10-10-sns-posts.sql を実行してください";
  }
  return "保存できませんでした。時間をおいてお試しください";
}

/* 軸と元コンテンツ。画面から来た値をそのまま信じず、定義にあるものだけ通す */
function axesFrom(body) {
  const a = {
    persona: String(body.persona || ""), issue: String(body.issue || ""),
    content_type: String(body.content_type || ""), objective: String(body.objective || ""),
    cta: String(body.cta || ""),
  };
  const miss = M.missingAxes(a);
  if (miss.length) throw new HttpError(400, "選んでください：" + miss.join("、"));
  return a;
}

function sourceFrom(body) {
  const type = String(body.source_type || "none");
  const ref = body.source_ref == null ? "" : String(body.source_ref).trim();
  if (type === "none") return { source_type: "none", source_ref: null };
  if (type === "column" && /^[a-z0-9-]{1,80}$/.test(ref)) return { source_type: type, source_ref: ref };
  if (type === "product" && /^[A-Za-z0-9_-]{1,40}$/.test(ref)) return { source_type: type, source_ref: ref };
  if (type === "page" && M.pageOf(ref)) return { source_type: type, source_ref: ref };
  throw new HttpError(400, "元コンテンツを選び直してください");
}

async function actSave(body, who) {
  const row = Object.assign({}, axesFrom(body), sourceFrom(body));
  row.source_title = L.clean(body.source_title, 200);
  row.note = L.clean(body.note, S.NOTE_MAX);
  row.updated_by_email = who.email;

  // 文・タグ・画像は、送られてきたときだけ書く（送られていなければ今の値のまま）
  if (body.instagram_caption !== undefined) row.instagram_caption = L.clean(body.instagram_caption, 2200);
  if (body.x_caption !== undefined) row.x_caption = L.clean(body.x_caption, 1000);
  if (body.instagram_tags !== undefined || body.x_tags !== undefined) {
    const tags = await activeTags();
    if (body.instagram_tags !== undefined) row.instagram_tags = S.pickTags(body.instagram_tags, tags, M.IG_TAGS_MAX);
    if (body.x_tags !== undefined) row.x_tags = S.pickTags(body.x_tags, tags, M.X_TAGS_MAX);
  }
  if (body.social_image !== undefined) {
    const img = S.cleanImageUrl(body.social_image);
    if (img === undefined) throw new HttpError(400, "画像のURLが不正です");
    row.social_image = img;
  }

  if (body.id) {
    await loadPost(body.id);
    return { post: await patchPost(body.id, row) };
  }
  row.created_by_email = who.email;
  const q = await L.rest("ec_sns_posts", { method: "POST", body: row, headers: { Prefer: "return=representation" } });
  if (!q.ok) throw new HttpError(503, supaError(q));
  return { post: q.out && q.out[0] };
}

/* 組み立てに使う材料を見せる（文は作らない）。
   id を渡すと、その投稿の元コンテンツで作り、前に生成したときと材料が
   変わっていれば「古い」の印を付ける（編集画面を開いたときに1回だけ呼ぶ） */
async function actMaterial(body) {
  if (body.id) {
    const post = await loadPost(body.id);
    const { material } = await buildMaterial(post.source_type, post.source_ref);
    const changed = !!(post.generated_at && post.source_hash && S.hash(material.text) !== post.source_hash);
    if (changed && !post.social_stale) {
      await L.rest("ec_sns_posts?id=eq." + post.id, { method: "PATCH", body: { social_stale: true } });
    }
    return { material, stale: changed || !!post.social_stale };
  }
  const src = sourceFrom(body);
  const { material } = await buildMaterial(src.source_type, src.source_ref);
  return { material };
}

/* 日本時間の今日の0時（UTCのISO文字列） */
function jstDayStart(now) {
  const t = (now || new Date()).getTime() + 9 * 3600000;
  const d = new Date(t);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 9 * 3600000).toISOString();
}

/* 今日（日本時間）の組み立て回数。
   共通の L.rest() は本文だけを返す（ヘッダは返さない）ので、
   **Content-Range には頼らず、行を取って数える。**
   上限は1日ぶんなので、行数はたかが知れている。 */
async function countToday() {
  const q = await L.rest("ec_sns_generations?select=id&created_at=gte."
    + encodeURIComponent(jstDayStart()) + "&limit=1000");
  if (!q.ok) throw new HttpError(503, supaError(q));
  return Array.isArray(q.out) ? q.out.length : 0;
}

/* たたき台を組み立てて保存する。**外部のAI APIは呼びません。**
   回数を数えているのは「押しすぎで他の人の操作が詰まらないように」の歯止めで、
   上限に当たっても**文は手で書いて保存できます**。 */
async function actGenerate(body, who) {
  const post = await loadPost(body.id);
  const miss = M.missingAxes(post);
  if (miss.length) throw new HttpError(400, "選んでください：" + miss.join("、"));

  if ((await countToday()) >= DAILY_LIMIT) {
    throw new HttpError(429, "今日の組み立ての上限（" + DAILY_LIMIT + "回）に達しました。明日また使えます。文は手で書いて保存できます");
  }

  const { material, product } = await buildMaterial(post.source_type, post.source_ref);
  const tags = await activeTags();

  // 上限を数えるために、組み立てる前に記録する（途中で失敗しても1回と数える）
  const log = await L.rest("ec_sns_generations",
    { method: "POST", body: { post_id: post.id, actor_email: who.email, model: DRAFT_KIND },
      headers: { Prefer: "return=representation" } });
  const logId = log.ok && log.out && log.out[0] && log.out[0].id;

  /* 型から組み立てて、**これまでと同じ compose() に通す**
     （URLの付け方・タグの照合・連絡先の除去・材料に無い数字の警告は1つも変えていない） */
  const draft = S.draftFrom(post, material, tags);
  const url = SITE + M.ctaPath(post.cta, M.ref(post.post_no, "x"), product);
  const c = S.compose(draft, {
    tags, url, site: SITE, materialText: material.text, axisText: S.axisText(post), note: post.note || "",
  });

  const patch = {
    instagram_caption: c.instagram || null,
    x_caption: c.x || null,
    instagram_tags: c.igTags,
    x_tags: c.xTags,
    cta_url: url,
    source_title: material.title ? String(material.title).slice(0, 200) : post.source_title,
    source_hash: S.hash(material.text),
    generated_at: new Date().toISOString(),
    generated_model: DRAFT_KIND,
    social_stale: false,
    updated_by_email: who.email,
  };
  if (!post.social_image && material.images && material.images[0]) patch.social_image = material.images[0];
  const saved = await patchPost(post.id, patch);
  if (logId) await L.rest("ec_sns_generations?id=eq." + logId, { method: "PATCH", body: { ok: true } });

  return { post: saved, warnings: c.warnings, material };
}

async function actMark(body, who) {
  const post = await loadPost(body.id);
  const ch = body.channel === "instagram" ? "instagram" : body.channel === "x" ? "x" : "";
  if (!ch) throw new HttpError(400, "SNSの指定が不正です");
  const caption = ch === "instagram" ? post.instagram_caption : post.x_caption;
  if (body.posted && !String(caption || "").trim()) throw new HttpError(400, "文が無いので投稿済みにできません");
  const patch = { updated_by_email: who.email };
  patch[ch + "_posted_at"] = body.posted ? new Date().toISOString() : null;
  return { post: await patchPost(post.id, patch) };
}

/* 元コンテンツが更新されたか。材料を作り直してハッシュを比べる。
   取りに行けなかったものは「古い」にしない（分からないものを古いと言わない） */
async function actCheck(body) {
  const ids = (Array.isArray(body.ids) ? body.ids : []).filter((x) => UUID_RE.test(String(x))).slice(0, CHECK_MAX);
  if (!ids.length) return { stale: [], failed: [] };
  const q = await L.rest("ec_sns_posts?select=id,source_type,source_ref,source_hash,social_stale,generated_at"
    + "&archived_at=is.null&generated_at=not.is.null&id=in.(" + ids.join(",") + ")");
  if (!q.ok) throw new HttpError(503, supaError(q));
  const cache = {};
  const stale = [], failed = [];
  for (const p of q.out || []) {
    const key = p.source_type + ":" + (p.source_ref || "");
    try {
      if (!cache[key]) cache[key] = buildMaterial(p.source_type, p.source_ref);
      const { material } = await cache[key];
      if (p.source_hash && S.hash(material.text) !== p.source_hash) {
        stale.push(p.id);
        if (!p.social_stale) {
          await L.rest("ec_sns_posts?id=eq." + p.id, { method: "PATCH", body: { social_stale: true } });
        }
      }
    } catch (e) {
      failed.push(p.id);
    }
  }
  return { stale, failed };
}

async function actArchive(body, who) {
  const post = await loadPost(body.id);
  return { post: await patchPost(post.id, { archived_at: new Date().toISOString(), updated_by_email: who.email }) };
}

const ACTIONS = {
  save: actSave, material: actMaterial, generate: actGenerate,
  mark: actMark, check: actCheck, archive: actArchive,
};

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { res.setHeader("Allow", "POST"); return res.status(204).end(); }
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "POST のみ受け付けます" }); }
  res.setHeader("Cache-Control", "no-store");
  if (!L.hasKey()) return L.keyMissing(res);

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = null; } }
  if (!body || typeof body !== "object") return res.status(400).json({ error: "リクエストの形式が不正です" });
  const act = ACTIONS[body.action];
  if (!act) return res.status(400).json({ error: "操作の指定が不正です" });

  /* 誰が叩いたか。**#51 で入った共通の L.caller() をそのまま使う**
     （token は Supabase に聞き、role は inventory_members をサーバー鍵で読み直す。
       画面から送られてきた role は見ない）。SNS投稿は**管理者だけ**。 */
  let who = null;
  try {
    who = await L.caller(req);
  } catch (e) {
    console.error("api/sns: auth error", e && e.message);
    return res.status(503).json({ error: "サーバーの設定がまだです" });
  }
  if (!who) return res.status(401).json({ error: "ログインし直してください" });
  if (who.role !== "admin") return res.status(403).json({ error: "SNS投稿は管理者だけが使えます" });

  try {
    const out = await act(body, who);
    return res.status(200).json(Object.assign({ ok: true }, out));
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    console.error("api/sns:", body.action, e && e.message);
    return res.status(500).json({ error: "処理できませんでした。時間をおいてお試しください" });
  }
};

// テスト用（tools/test-sns.js）
module.exports._test = { jstDayStart, buildMaterial, DRAFT_KIND, DAILY_LIMIT };
