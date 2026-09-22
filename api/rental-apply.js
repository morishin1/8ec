// ============================================================
// 8RENT のレンタル希望受付（/api/rental-apply）
//
//   /rent の申込フォームはここへ送ります。ここで
//     (1) 入力チェック
//     (2) 回数制限（連打・自動投稿よけ）
//     (3) 同じ内容の二度押しを落とす
//     (4) Supabase の inv_rental_request_create() で保存
//     (5) Slack へ通知
//   を行います。/api/quote・/api/contact と同じ作りです。
//
//   お客様のブラウザ → Vercel /api/rental-apply →（サーバー鍵）→ Supabase
//   の順で必ず通します。ブラウザから inv_rental_request_create() を
//   直接呼ぶ経路はありません（以前は直接呼んでいて、回数制限も
//   Slack通知も迂回できる状態でした）。
//
//   ここは「レンタルの希望を受け取る」だけです。
//     希望受付 → 在庫・調達確認 → 見積 → 顧客承認 → 契約 → 手配
//   個体を押さえるのは契約後の手配だけなので、ここでは
//   inventory_items も inv_rental_allocate() も触りません。
//
//   ── Vercel での設定 ─────────────────────────────
//     SUPABASE_SECRET_KEY 【必須】サーバー鍵。無いと 503 を返して止まります
//     SLACK_WEBHOOK_URL   Slackの受信Webhook（未設定でもフォームは動きます）
//     SUPABASE_URL        既定 https://htglvascsuqkixpmclwr.supabase.co
//     ZAIKO_RENTAL_URL    Slack通知のボタンの遷移先。既定 https://www.8ec.jp/zaiko/rental-requests
// ============================================================

const crypto = require("crypto");
const L = require("./_lib.js");
const { clean, slackEscape } = L;

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const ZAIKO_RENTAL_URL = process.env.ZAIKO_RENTAL_URL || "https://www.8ec.jp/zaiko/rental-requests";

// 受け取るJSONの上限。これを超えたら読まずに断る
const MAX_BODY = 32 * 1024;

/** 数値。範囲外・数値でないものは null（フォームの値をそのまま信じない） */
function num(value, min, max) {
  const n = Number(String(value == null ? "" : value).trim());
  if (!Number.isFinite(n)) return null;
  const v = Math.round(n);
  return v < min || v > max ? null : v;
}
/** YYYY-MM-DD だけ通す */
function onlyDate(value) {
  const s = String(value == null ? "" : value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) ? s : null;
}
/** 商品コードの形だけ見る（P-00432 など）。実在するかはDB側で確かめる */
function productCode(value) {
  const s = String(value == null ? "" : value).trim().toUpperCase();
  return /^[A-Z]{1,4}-[A-Z0-9-]{1,20}$/.test(s) ? s : null;
}
/** 機種の候補。フォームは選んだ機種の枝番をまとめて送ってくる */
function codeList(value, max) {
  if (!Array.isArray(value)) return [];
  const ok = [];
  value.forEach((v) => {
    const c = productCode(v);
    if (c && ok.indexOf(c) < 0 && ok.length < max) ok.push(c);
  });
  return ok;
}
/** ご希望のスペック。決めたキーだけを、決めた形で通す */
function conditions(src) {
  const s = (src && typeof src === "object") ? src : {};
  const out = {};
  const put = (k, v) => { if (v !== null && v !== undefined && v !== "") out[k] = v; };
  put("cpu", clean(s.cpu, 40));
  put("memory_gb", num(s.memory_gb, 1, 1024));
  put("storage_gb", num(s.storage_gb, 1, 100000));
  put("screen", clean(s.screen, 40));
  put("office", clean(s.office, 20));
  put("model", clean(s.model, 160));
  if (s.webcam === true || s.webcam === "yes") out.webcam = true;
  if (s.numpad === true || s.numpad === "yes") out.numpad = true;
  return out;
}

function buildSlackPayload(row) {
  const fields = [
    { type: "mrkdwn", text: "*ご担当者*\n" + slackEscape(row.name) + " 様" },
    { type: "mrkdwn", text: "*台数*\n" + row.qty + "台" },
  ];
  if (row.company) fields.push({ type: "mrkdwn", text: "*会社名*\n" + slackEscape(row.company) });
  if (row.conditions.model) fields.push({ type: "mrkdwn", text: "*ご希望の機種*\n" + slackEscape(row.conditions.model) });
  if (row.start) fields.push({ type: "mrkdwn", text: "*開始希望*\n" + slackEscape(row.start) });
  if (row.months) fields.push({ type: "mrkdwn", text: "*ご利用期間*\n" + row.months + "ヶ月" });
  if (row.email) fields.push({ type: "mrkdwn", text: "*メール*\n" + slackEscape(row.email) });
  if (row.phone) fields.push({ type: "mrkdwn", text: "*電話*\n" + slackEscape(row.phone) });

  const blocks = [
    { type: "header", text: { type: "plain_text", text: "📦 8RENT 新規申込", emoji: true } },
    { type: "section", fields },
  ];
  const spec = Object.keys(row.conditions)
    .filter((k) => k !== "model")
    .map((k) => k + "：" + row.conditions[k]).join(" / ");
  if (spec) blocks.push({ type: "section", text: { type: "mrkdwn", text: "*ご希望のスペック*\n" + slackEscape(spec) } });
  if (row.message) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "*ご連絡事項*\n" + slackEscape(row.message.slice(0, 2500)) } });
  }
  blocks.push(
    { type: "section", text: { type: "mrkdwn",
      text: "*まだ在庫は押さえていません。* 在庫・調達を確認して、/zaiko で進めてください。" } },
    { type: "actions", elements: [{
      type: "button", style: "primary",
      text: { type: "plain_text", text: "/zaiko で申込を見る", emoji: true },
      url: ZAIKO_RENTAL_URL,
    }] },
    { type: "context", elements: [{ type: "mrkdwn",
      text: "受信 " + new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false }) + "（JST）"
        + "　この時点では在庫も決済も動いていません" }] },
  );
  return {
    text: "8RENT 新規申込：" + slackEscape(row.name) + " 様"
      + (row.company ? "（" + slackEscape(row.company) + "）" : "")
      + "　" + row.qty + "台",
    blocks,
  };
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { res.setHeader("Allow", "POST"); return res.status(204).end(); }
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "POST のみ受け付けます" }); }

  res.setHeader("Cache-Control", "no-store");

  // サーバー鍵が無いときは動かさない。公開鍵で代わりに動かすことはしません
  if (!L.hasKey()) {
    return L.keyMissing(res, { error: "現在お申し込みを受け付けられません。時間をおいて再度お試しください" });
  }

  const ctype = String((req.headers && req.headers["content-type"]) || "");
  if (ctype && ctype.indexOf("application/json") < 0) {
    return res.status(415).json({ error: "リクエストの形式が不正です" });
  }
  const len = Number((req.headers && req.headers["content-length"]) || 0);
  if (Number.isFinite(len) && len > MAX_BODY) {
    return res.status(413).json({ error: "入力が大きすぎます。ご連絡事項を短くしてお試しください" });
  }

  let body = req.body;
  if (typeof body === "string") {
    if (body.length > MAX_BODY) return res.status(413).json({ error: "入力が大きすぎます" });
    try { body = JSON.parse(body); } catch (_) { body = null; }
  }
  if (!body || typeof body !== "object") return res.status(400).json({ error: "リクエストの形式が不正です" });

  // ハニーポット：人には見えない項目。埋まっていたら自動投稿とみなして黙って捨てる
  if (String(body.website || "").trim() !== "") return res.status(200).json({ ok: true });

  const key = L.clientKey(req);
  if (L.tooFast("rental-apply", key, 10, 60000)) {
    return L.tooMany(res, 60, { error: "短時間に複数回送信されています。少し時間をおいてもう一度お試しください" });
  }

  const row = {
    codes: codeList(body.codes, 50),
    name: clean(body.name, 100),
    qty: num(body.qty, 1, 500),
    company: clean(body.company, 120),
    email: clean(body.email, 160),
    phone: clean(body.phone, 40),
    start: onlyDate(body.start),
    months: num(body.months, 1, 120),
    office: body.office === true || body.office === "yes",
    message: clean(body.message, 4000),
    conditions: conditions(body.conditions),
  };
  if (!row.name) return res.status(400).json({ error: "お名前を入力してください" });
  if (row.qty == null) return res.status(400).json({ error: "台数は1〜500台でお願いします（それ以上はご相談ください）" });
  if (row.email && !/.+@.+\..+/.test(row.email)) {
    return res.status(400).json({ error: "メールアドレスの形式をご確認ください" });
  }

  try {
    // ── 1) 回数制限（DB側。インスタンスをまたいで数える） ──
    const guard = await L.accessCheck("rental-apply", key, false);
    if (guard.blocked) {
      return L.tooMany(res, 600, { error: "短時間に複数回送信されています。少し時間をおいてもう一度お試しください" });
    }

    // ── 2) 同じ内容の二度押しを落とす ──
    //     10分のあいだに まったく同じ内容 が来たら、保存もSlackもしないで
    //     1回目と同じ返事を返す。時間が空けば通るので、本当に2回目の
    //     お申し込みを塞ぎ続けることはありません。
    if (key) {
      const fp = crypto.createHash("sha256")
        .update(key + "|" + JSON.stringify(row)).digest("hex").slice(0, 64);
      const dup = await L.accessCheck("rental-dup", fp, false);
      if ((dup.tries || 0) > 1) {
        console.warn("rental-apply: duplicate submission ignored");
        return res.status(200).json({ ok: true, already: true, qty: row.qty });
      }
    }

    // ── 3) 保存（ここが失敗したら失敗として返し、Slackは送らない） ──
    const r = await L.rpc("inv_rental_request_create", {
      p_codes: row.codes, p_name: row.name, p_qty: row.qty,
      p_company: row.company, p_email: row.email, p_phone: row.phone,
      p_start: row.start, p_months: row.months, p_office: row.office,
      p_message: row.message, p_conditions: row.conditions,
    });
    if (!r.ok) {
      const msg = (r.out && (r.out.message || r.out.hint)) || "";
      console.error("rental-apply: supabase insert failed", r.status, msg);
      // 機種違い・台数などはSQL側のメッセージをそのままお客様へ見せる
      if (/別々の機種|1〜500|お名前/.test(msg)) return res.status(400).json({ error: msg });
      return res.status(502).json({ error: "現在お申し込みを受け付けられません。時間をおいて再度お試しください" });
    }
    row.request_id = (r.out && r.out.request_id) || null;
  } catch (e) {
    console.error("rental-apply: error", e && e.message);
    return res.status(502).json({ error: "現在お申し込みを受け付けられません。時間をおいて再度お試しください" });
  }

  // ── 4) Slack へ通知（保存はもう済んでいるので、失敗しても成功として返す） ──
  if (SLACK_WEBHOOK_URL) {
    try {
      const s = await fetch(SLACK_WEBHOOK_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildSlackPayload(row)),
      });
      if (!s.ok) console.error("rental-apply: slack notify failed", s.status, await s.text().catch(() => ""));
    } catch (e) {
      console.error("rental-apply: slack notify error", e);
    }
  }

  return res.status(200).json({ ok: true, qty: row.qty });
};

// テストから読めるように内部関数も公開しておく（Vercelの動作には影響しません）
module.exports.buildSlackPayload = buildSlackPayload;
