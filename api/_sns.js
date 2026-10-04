// ============================================================
// SNS投稿準備：サーバー側の純粋な処理（/api/sns から使う）
//
//   ファイル名が _ で始まるので、Vercelはこれをエンドポイントにしません。
//   通信はしない（材料の取得・Supabase は api/sns.js が行う）。
//   ここに置くのは「同じ入力なら同じ出力」の処理だけで、テスト
//   （tools/test-sns.js）はこのファイルを直接呼んで確かめます。
//
//   たたき台に使う材料は「公開されているもの」だけ。
//     ・公開ページ（許可したパスだけ。任意のURLは受け付けない）
//     ・コラム（/assets/columns.json に載っている slug だけ）
//     ・商品（公開ビュー inv_public_products の、ここで許可した列だけ）
//   仕入値・在庫数・顧客名・見積は、そもそも読みに行かない。
// ============================================================

const crypto = require("crypto");
const M = require("../assets/sns-master.js");

const MATERIAL_MAX = 2500;   // 材料にする本文の上限（長い記事でも量を決めておく）
const IG_BODY_MAX = 1200;
const X_BODY_MAX = 400;
const NOTE_MAX = 300;

/* ---- HTML → 文章 -------------------------------------------------- */

function decode(s) {
  return String(s)
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : " "; })
    .replace(/&amp;/gi, "&");
}

/* タグを外して文章だけにする。タグや属性が混ざったまま投稿文へ入らないように */
function htmlText(html, max) {
  const s = decode(String(html == null ? "" : html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|form|nav|header|footer|button)[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(br|\/p|\/li|\/h[1-6]|\/div|\/tr|\/dt|\/dd)[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " "))
    .replace(/[ \t\r\f\v　]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return max && s.length > max ? s.slice(0, max) : s;
}

/* ページの本文。共通ヘッダー・フッター（tools/build-shell.py が入れるもの）は
   サイト全体で同じなので渡さない。article → main → body の順に探す */
function pageBody(html) {
  const h = String(html || "");
  const art = h.match(/<article[\s>][\s\S]*?<\/article>/i);
  if (art) return art[0];
  const main = h.match(/<main[\s>][\s\S]*?<\/main>/i);
  if (main) return main[0];
  const body = h.match(/<body[\s>][\s\S]*<\/body>/i);
  return body ? body[0] : h;
}

function metaContent(html, attr, name) {
  const re = new RegExp("<meta[^>]+" + attr + "=[\"']" + name.replace(/[:.]/g, "\\$&") + "[\"'][^>]*>", "i");
  const tag = String(html || "").match(re);
  if (!tag) return "";
  const c = tag[0].match(/content=["']([^"']*)["']/i);
  return c ? decode(c[1]).trim() : "";
}

function titleOf(html) {
  const t = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return t ? decode(t[1]).replace(/\s+/g, " ").trim() : "";
}

/* og:image。公開画像で、https のものだけ */
function ogImage(html, site) {
  const v = metaContent(html, "property", "og:image");
  if (!v) return "";
  if (/^https:\/\//i.test(v)) return v;
  if (v.charAt(0) === "/" && site) return site + v;
  return "";
}

/* ---- 材料を組み立てる ---------------------------------------------- */

/* 公開ページ（コラム・パック・FAQ など）から材料を作る */
function materialFromPage(html, opts) {
  const o = opts || {};
  const title = o.title || titleOf(html);
  const desc = metaContent(html, "name", "description");
  const body = htmlText(pageBody(html), MATERIAL_MAX);
  const lines = [];
  lines.push("見出し：" + title);
  if (desc) lines.push("ページの説明：" + desc);
  if (o.notReal) lines.push("注意：このページの内容は活用例・導入イメージで、特定企業の実績ではありません。");
  lines.push("本文：" + body);
  const img = ogImage(html, o.site);
  return { title, text: lines.join("\n"), url: o.url || "", images: img ? [img] : [], notReal: !!o.notReal };
}

/* 元コンテンツが無いとき。トップページの説明文（公開されているサービス説明）だけを渡す */
function materialFromService(html, opts) {
  const o = opts || {};
  const desc = metaContent(html, "name", "description");
  const img = ogImage(html, o.site);
  return {
    title: "サービス説明",
    text: "サービス名：" + M.SERVICE + "\nサービスの説明：" + (desc || "（説明文を取得できませんでした）"),
    url: o.url || "",
    images: img ? [img] : [],
    notReal: false,
  };
}

/* 商品は公開ビューの列のうち、ここに挙げたものだけを渡す。
   在庫数・仕入値・楽天の情報は公開ビューにも無いが、念のため列を名指しで選ぶ */
const PRODUCT_COLUMNS = [
  "code", "name", "model", "maker", "category_name", "spec", "cpu", "cpu_gen", "memory_size",
  "storage_type", "storage_capacity", "screen_size", "os", "webcam", "wifi", "office_supported",
  "condition_note", "rental_enabled", "availability", "rental_price_month", "rental_min_months",
  "rental_description", "sale_enabled", "sale_price", "sale_condition", "sale_availability",
  "image_url", "images", "updated_at",
];

function yen(n) { return "¥" + Number(n).toLocaleString("ja-JP"); }

function materialFromProduct(p, opts) {
  const o = opts || {};
  const x = p || {};
  const name = [x.maker, x.name || x.model].filter(Boolean).join(" ");
  const lines = ["商品名：" + name];
  const add = (label, v) => { if (v != null && String(v).trim() !== "") lines.push(label + "：" + String(v).trim()); };
  add("型番", x.model);
  add("カテゴリー", x.category_name);
  add("スペック", x.spec);
  add("CPU", [x.cpu, x.cpu_gen].filter(Boolean).join(" "));
  add("メモリ", x.memory_size);
  add("ストレージ", [x.storage_type, x.storage_capacity].filter(Boolean).join(" "));
  add("画面サイズ", x.screen_size);
  add("OS", x.os);
  if (x.office_supported === true) lines.push("Office：対応");
  add("状態の補足", x.condition_note);
  if (x.rental_enabled) {
    lines.push("レンタル：対応（" + (x.availability || "ご相談ください") + "）");
    lines.push("レンタル月額：" + (x.rental_price_month ? yen(x.rental_price_month) + "／月" : "お見積り（金額は書かない）"));
    if (x.rental_min_months) lines.push("最短レンタル期間：" + x.rental_min_months + "ヶ月");
    add("レンタルの説明", x.rental_description && String(x.rental_description).slice(0, 800));
  }
  if (x.sale_enabled) {
    lines.push("購入：対応（" + (x.sale_availability || "ご相談ください") + "）");
    lines.push("販売価格：" + (x.sale_price ? yen(x.sale_price) : "お見積り（金額は書かない）"));
    add("商品の状態", x.sale_condition);
  }
  lines.push("注意：在庫の台数は公開していません。「残り◯台」「在庫◯台」とは書かない。");
  const imgs = [];
  if (x.image_url && /^https:\/\//i.test(x.image_url)) imgs.push(x.image_url);
  (Array.isArray(x.images) ? x.images : []).forEach((u) => {
    if (typeof u === "string" && /^https:\/\//i.test(u) && imgs.indexOf(u) < 0) imgs.push(u);
  });
  return { title: name || x.code || "", text: lines.join("\n"), url: o.url || "", images: imgs.slice(0, 8), notReal: false };
}

/* 材料が変わったかどうかを見るためのハッシュ */
function hash(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex").slice(0, 32);
}

/* ---- 投稿案を組み立てる（テンプレート） ------------------------------
   **外部のAI APIは使いません。APIキーも要りません。**
   投稿案は、選んだ軸（Persona × Issue × Content × Objective × CTA）の
   **表示名**と、元コンテンツの**見出し・説明**だけから組み立てます。

   なぜこうするか
     ・このプロジェクトでは外部AI APIを足さない決まりになっている
     ・材料に無いことを書かない／数字を作らない、がいちばん大事な要件で、
       決まった型から組むなら**そもそも作りようがない**
     ・毎回同じ入力なら同じ文が出るので、直した内容が消えたかどうかを人が追える

   使う文字は、材料（元コンテンツの見出し・説明）と軸の表示名の中にあるものだけ。
   数字も新しく作りません（Issue の「10〜30台」のように、軸の表示名に
   もともと入っているものだけが出ます）。

   できた文はそのまま投稿するものではなく**たたき台**で、画面で直してから保存します。 */

/* 投稿タイプごとの2行目。売り込みではなく「何の話か」を言う */
var TYPE_LINE = {
  issue:        'このお悩みの考えかたを、わかりやすくまとめました。',
  knowhow:      '知っておくと迷いにくくなる点をまとめました。',
  intro:        'いまご案内できるものを紹介します。',
  compare:      'どちらが向いているかを見分ける目安をまとめました。',
  case:         'こんな使い方があります、という例をまとめました。',
  faq:          'よくいただくご質問にお答えします。',
  arrival:      '新しく入ったものをご案内します。',
  howto_choose: '選ぶときに見るところをまとめました。',
  buy_vs_rent:  '購入とレンタル、それぞれが向いている場面をまとめました。',
  corp_intro:   '法人でそろえるときに気をつける点をまとめました。'
};

/* CTA ごとの締めの一言。URL はこのあと compose() が付ける */
var CTA_LINE = {
  view_product:   { ig: '気になるものは、プロフィールのリンクから見られます。', x: '商品はこちらから。' },
  quote:          { ig: 'お見積りは、プロフィールのリンクからどうぞ。',         x: 'お見積りはこちらから。' },
  rental_consult: { ig: 'レンタルのご相談は、プロフィールのリンクからどうぞ。', x: 'レンタルのご相談はこちらから。' },
  contact:        { ig: 'ご質問は、プロフィールのリンクからどうぞ。',           x: 'ご質問はこちらから。' },
  view_stock:     { ig: 'いまの在庫は、プロフィールのリンクから見られます。',   x: 'いまの在庫はこちらから。' },
  corp_consult:   { ig: '法人導入のご相談は、プロフィールのリンクからどうぞ。', x: '法人導入のご相談はこちらから。' }
};

/* Issue ごとに、まず当ててみるハッシュタグ。
   **ここに挙げても、登録済みの候補に無いタグは使われません**
   （最後に pickTags() が候補と完全一致するものだけ残します）。 */
var ISSUE_TAGS = {
  cost_down:       ['#法人PC', '#中古PC', '#IT調達'],
  new_vs_used:     ['#中古PC', '#整備済みPC', '#法人PC'],
  buy_vs_rent:     ['#PCレンタル', '#法人PC', '#IT調達'],
  temp_10_30:      ['#PCレンタル', '#法人PC'],
  new_hire_pc:     ['#新入社員', '#法人PC', '#キッティング'],
  with_office:     ['#法人PC', '#IT調達'],
  failure_support: ['#法人PC', '#情シス'],
  spec_unknown:    ['#法人PC', '#中古PC'],
  pc_management:   ['#情シス', '#キッティング', '#法人PC'],
  replace_old:     ['#法人PC', '#整備済みPC', '#IT調達'],
  short_term:      ['#PCレンタル', '#法人PC'],
  event_training:  ['#研修', '#PCレンタル', '#法人PC']
};
var PERSONA_TAGS = {
  owner_smb: ['#中小企業'], general_affairs: ['#総務'], it_admin: ['#情シス'],
  hr_recruit: ['#新入社員'], school: ['#研修'], training_co: ['#研修'],
  new_site: ['#オフィス開設'], bulk_temp: ['#PCレンタル']
};

/* 材料の「ページの説明」だけを1文として借りる。本文はそのまま使わない
   （長すぎるうえ、数字や固有名詞が混ざりやすいため）。 */
function materialLead(material) {
  var m = String((material && material.text) || '').match(/^ページの説明：(.+)$/m);
  if (!m) return '';
  var t = String(m[1]).trim().replace(/\s+/g, ' ');
  if (!t) return '';
  // 1文だけ、80文字まで
  var one = t.split(/(?<=[。．！？])/)[0] || t;
  return one.length > 80 ? '' : one;
}

/* たたき台を作る。**返す形は compose() がそのまま受け取れる形**にしてあるので、
   このあとの compose()（URL・タグ・連絡先・数字の確認）は1行も変えていない。 */
function draftFrom(post, material, tags) {
  var lab = function (list, key) { return M.labelOf(list, key); };
  var persona = lab(M.PERSONAS, post.persona);
  var issue = lab(M.ISSUES, post.issue);
  var cta = CTA_LINE[post.cta] || CTA_LINE.view_stock;
  var title = String((material && material.title) || '').trim();
  var lead = materialLead(material);
  var note = String(post.note || '').trim().slice(0, NOTE_MAX);

  /* ---- Instagram（3〜6行） ---- */
  var ig = [];
  ig.push(persona + 'の方へ。「' + issue + '」でお困りではありませんか。');
  ig.push(TYPE_LINE[post.content_type] || TYPE_LINE.issue);
  if (title) ig.push('▼ ' + title);
  if (lead) ig.push(lead);
  if (note) ig.push(note);
  ig.push(cta.ig);
  if (ig.length > 6) ig = ig.slice(0, 5).concat([cta.ig]);

  /* ---- X（短く2文。URL はこのあと付くので、その分を空けておく） ---- */
  var xs = [persona + 'の「' + issue + '」に。'];
  if (title) xs.push(title + 'をまとめました。');
  else xs.push(TYPE_LINE[post.content_type] || TYPE_LINE.issue);
  xs.push(cta.x);
  var x = xs.join('');
  // URL（23文字ぶん）とタグの余白を見て、長すぎるときは真ん中を落とす
  if (M.xWeight(x) > M.X_MAX - 40) x = xs[0] + xs[xs.length - 1];

  /* ---- ハッシュタグ ---- */
  var want = (ISSUE_TAGS[post.issue] || []).concat(PERSONA_TAGS[post.persona] || []);
  return {
    instagram: ig.join('\n'),
    x: x,
    instagram_tags: want,
    x_tags: want
  };
}

/* ---- 組み立てた文を、こちらで整える --------------------------------
   **人が手で書いた文も、ここを通してから保存します。**
   URL・ハッシュタグ・連絡先はこちらで付け外しし、材料に無い数字は警告にします。 */

/* URL・ハッシュタグ・連絡先を本文から落とす。URLとタグはこちらで付ける */
function plainBody(text, max, site) {
  let s = String(text == null ? "" : text)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b(?:www\.)?8ec\.jp\S*/gi, " ")
    .replace(/[#＃][^\s#＃]+/g, " ")
    .replace(/[ \t　]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (site) {
    const host = String(site).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (host) s = s.split(host).join("");
  }
  return max && s.length > max ? s.slice(0, max).trim() : s;
}

/* 候補（登録済みのタグ）に完全一致するものだけ残す。表記は候補にそろえる */
function pickTags(want, allowed, max) {
  const norm = {};
  (allowed || []).forEach((t) => { norm[String(t).toLowerCase()] = t; });
  const out = [];
  (Array.isArray(want) ? want : []).forEach((t) => {
    let k = String(t || "").trim();
    if (k && k.charAt(0) !== "#" && k.charAt(0) !== "＃") k = "#" + k;
    k = k.replace(/^＃/, "#").toLowerCase();
    if (norm[k] && out.indexOf(norm[k]) < 0) out.push(norm[k]);
  });
  return out.slice(0, max);
}

/* 全角数字を半角にして、桁区切りを外す */
function normDigits(s) {
  return String(s || "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/(\d)[,，](?=\d{3})/g, "$1");
}

/* 材料に無い数字。消しはしない（人が気づけるように、画面へ警告として出す）。
   「価格を作らない」「スペックを補わない」「実績を推測しない」への機械的な備え */
function unknownNumbers(output, allowedText) {
  const known = new Set((normDigits(allowedText).match(/\d+(?:\.\d+)?/g) || []));
  const out = [];
  const text = normDigits(String(output || "").replace(/[#＃][^\s#＃]+/g, " "));
  const re = /(\d+(?:\.\d+)?)\s*(万円|円|台|％|%|ヶ月|か月|カ月|ヵ月|年|日|名|人|社|GB|TB|インチ|型|世代|倍|割)?/g;
  let m;
  while ((m = re.exec(text))) {
    if (known.has(m[1])) continue;
    const token = m[0].trim();
    if (out.indexOf(token) < 0) out.push(token);
  }
  return out;
}

/* メールアドレス・電話番号の形。見つけたら本文から外して警告する */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+81[-\s]?|0)\d{1,4}[-‐－\s]?\d{1,4}[-‐－\s]?\d{3,4}/g;
function stripContacts(text) {
  let found = false;
  const s = String(text || "")
    .replace(EMAIL_RE, () => { found = true; return ""; })
    .replace(PHONE_RE, (m) => (/[-‐－\s]/.test(m) || m.length >= 10 ? ((found = true), "") : m));
  return { text: s.replace(/[ \t　]{2,}/g, " ").trim(), found };
}

/* 生成結果を整えて、投稿に保存する形にする */
function compose(draft, ctx) {
  const tags = ctx.tags || [];
  const igRaw = stripContacts(plainBody(draft && draft.instagram, IG_BODY_MAX, ctx.site));
  const xRaw = stripContacts(plainBody(draft && draft.x, X_BODY_MAX, ctx.site));
  const igTags = pickTags(draft && draft.instagram_tags, tags, M.IG_TAGS_MAX);
  const xTags = pickTags(draft && draft.x_tags, tags, M.X_TAGS_MAX);

  const instagram = igRaw.text ? igRaw.text + (igTags.length ? "\n\n" + igTags.join(" ") : "") : "";
  const x = (xRaw.text ? xRaw.text + "\n\n" : "") + ctx.url + (xTags.length ? "\n" + xTags.join(" ") : "");

  const warnings = [];
  if (!igRaw.text) warnings.push("Instagram の文が空です。作り直すか、手で書いてください。");
  if (!xRaw.text) warnings.push("X の文が空です。作り直すか、手で書いてください。");
  if (igRaw.found || xRaw.found) warnings.push("メールアドレスや電話番号のような文字列があったので外しました。");
  const allowed = [ctx.materialText, ctx.axisText, ctx.note].join("\n");
  const unknown = unknownNumbers(igRaw.text + "\n" + xRaw.text, allowed);
  if (unknown.length) warnings.push("材料に無い数字があります：" + unknown.join("、") + "（正しいか確かめてから投稿してください）");
  if (M.xWeight(x) > M.X_MAX) warnings.push("X の文が " + M.X_MAX + " 文字（半角換算）を超えています。短くしてください。");

  return { instagram, x, igTags, xTags, warnings };
}

/* 軸の表示名（ペルソナ・Issueの数字「10〜30台」などは材料と同じ扱いにする） */
function axisText(post) {
  return [M.labelOf(M.PERSONAS, post.persona), M.labelOf(M.ISSUES, post.issue),
          M.labelOf(M.CONTENT_TYPES, post.content_type), M.labelOf(M.OBJECTIVES, post.objective),
          M.labelOf(M.CTAS, post.cta)].join("\n");
}

/* 画面から来た画像URL。https で、引用符や空白を含まないものだけ */
function cleanImageUrl(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return null;
  return /^https:\/\/[^\s"'<>]{1,1000}$/i.test(s) ? s : undefined;
}

module.exports = {
  MATERIAL_MAX, IG_BODY_MAX, X_BODY_MAX, NOTE_MAX, PRODUCT_COLUMNS,
  htmlText, pageBody, metaContent, titleOf, ogImage,
  materialFromPage, materialFromService, materialFromProduct, hash,
  draftFrom, materialLead, TYPE_LINE, CTA_LINE, ISSUE_TAGS, PERSONA_TAGS,
  plainBody, pickTags, unknownNumbers, stripContacts, compose, axisText,
  cleanImageUrl,
};
