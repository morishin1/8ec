// ============================================================
// サーバー側だけで使う共通部分（Vercel関数はこのファイルを読む）
//
//   ファイル名が _ で始まるので、Vercelはこれをエンドポイントにしません。
//   /api/* の関数から require して使います。
//
//   このサイトの決まりごと
//     お客様のブラウザ → Vercel /api/* →（サーバー鍵）→ Supabase
//   ブラウザからSupabaseの関数（RPC）を直接呼ぶ経路は作りません。
//   Slack通知・入力チェック・回数制限を必ずここで通すためです。
//
//   サーバー鍵が無いときは動きません（503を返す）。
//   公開鍵で代わりに動かすことはしません。公開鍵はサイトのJSに載っていて
//   誰でも読めるので、それで書き込めるならAPIを通す意味がなくなるためです。
//   鍵の値はログにも出しません。
// ============================================================

const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://htglvascsuqkixpmclwr.supabase.co";
// Supabaseの新しい鍵なら sb_secret_… 、古い方式なら service_role の JWT
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
// IPをそのまま持たないための塩。変えても困りません（数えるためだけに使う）
const IP_SALT = process.env.QUOTE_IP_SALT || "8ec-public-access";

if (!SUPABASE_SECRET_KEY) {
  console.error(
    "api: SUPABASE_SECRET_KEY が未設定です。/api/quote・/api/contact・" +
    "/api/quote-view・/api/quote-decide は 503 を返します。" +
    "Vercel の Settings → Environment Variables に登録して再デプロイしてください。"
  );
}

const hasKey = () => !!SUPABASE_SECRET_KEY;

/** 鍵が無いときの返事。理由は書くが、鍵の有無以外は漏らさない */
function keyMissing(res, body) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Retry-After", "300");
  return res.status(503).json(
    Object.assign({ error: "ただいま受け付けできません。お手数ですが、しばらくしてからお試しください" }, body || {})
  );
}

/** Supabaseの関数をサーバー鍵で呼ぶ */
async function rpc(fn, args) {
  if (!SUPABASE_SECRET_KEY) throw new Error("no-server-key");
  const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + fn, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: "Bearer " + SUPABASE_SECRET_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const out = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, out };
}

/** 相手を数えるための鍵。IPそのものは残さない */
function clientKey(req) {
  const h = (req && req.headers) || {};
  const fwd = String(h["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = fwd || String(h["x-real-ip"] || "").trim()
    || ((req && req.socket && req.socket.remoteAddress) || "");
  if (!ip) return null;
  return crypto.createHash("sha256").update(IP_SALT + "|" + ip).digest("hex").slice(0, 64);
}

// ── 連打よけ（このインスタンスの中だけ。DB側の数えかたと二段構え） ──
const seen = new Map();
function tooFast(bucket, key, limit, windowMs) {
  if (!key) return false;
  const id = bucket + ":" + key;
  const now = Date.now();
  const list = (seen.get(id) || []).filter((t) => now - t < windowMs);
  list.push(now);
  seen.set(id, list);
  if (seen.size > 5000) seen.clear();   // 増えすぎたら捨てる（目的は制限だけ）
  return list.length > limit;
}

/** DB側で数える。行きすぎていれば blocked=true が返る */
async function accessCheck(kind, key, miss) {
  if (!key) return { blocked: false };
  try {
    const { ok, out } = await rpc("inv_public_access_check",
      { p_client: key, p_kind: kind, p_miss: !!miss });
    return ok && out ? out : { blocked: false };
  } catch (e) {
    console.error("api: access check error", e && e.message);
    return { blocked: false };   // 数えられなくても、お客様は通す
  }
}

/** 多すぎるときの返事 */
function tooMany(res, seconds, body) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Retry-After", String(seconds));
  return res.status(429).json(
    Object.assign({ error: "アクセスが多すぎます。少し時間をおいてからお試しください" }, body || {})
  );
}

/** tokenの形だけ見る（英数字20〜80文字） */
function cleanToken(v) {
  const s = String(v == null ? "" : v).trim();
  return /^[A-Za-z0-9]{20,80}$/.test(s) ? s : null;
}

/** 前後の空白を落として長さを制限する。空なら null */
function clean(value, max) {
  const s = String(value == null ? "" : value).trim();
  if (!s) return null;
  return s.slice(0, max);
}

/** Slack の mrkdwn で意味を持つ文字をエスケープ */
function slackEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

module.exports = {
  SUPABASE_URL, hasKey, keyMissing, rpc,
  clientKey, tooFast, accessCheck, tooMany,
  cleanToken, clean, slackEscape,
};
