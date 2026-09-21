// ============================================================
// 顧客向け見積ページが読む中身（/api/quote-view?t=<token>）
//
//   お客様のブラウザ → Vercel /api/* →（サーバー鍵）→ Supabase
//   この順番で必ず通します。ブラウザからSupabaseを直接たたく経路はありません。
//
//   理由は3つです。
//     ・お客様の画面に公開鍵やテーブル構造を出さないため
//     ・見積の閲覧・操作をこちら側で一本化するため（Slack通知は decide 側）
//     ・将来ここに足す共通処理（通知・記録・制限）を迂回させないため
//
//   サーバー鍵（SUPABASE_SECRET_KEY）は service_role として動きます。
//   公開鍵（SUPABASE_ANON_KEY）は 2026-09-23-quote-api-only.sql 適用後、
//   この関数群を呼べません。鍵の値はログに出しません。
//
//   返すのは inv_quote_public() の中身だけです。
//   この関数は 原価・粗利・社内メモ・在庫数・管理番号 を返しません。
// ============================================================

const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://htglvascsuqkixpmclwr.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_yZCcrwdqjuf0u_5WBWlHIw_AxdvteEV";
// サーバー専用の鍵。Supabaseの新しい鍵は sb_secret_…、古い方式は service_role の JWT。
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
// IPをそのまま持たないための塩。変えても困らない（数えるためだけに使う）。
const IP_SALT = process.env.QUOTE_IP_SALT || "8ec-quote-access";

// 鍵が無いときは公開鍵で動く（migration適用前でも止まらないようにするため）。
// migration適用後に公開鍵しか無いと、Supabaseが権限エラーを返します。
const SERVER_KEY = SUPABASE_SECRET_KEY || SUPABASE_ANON_KEY;
if (!SUPABASE_SECRET_KEY) {
  console.warn(
    "quote-api: SUPABASE_SECRET_KEY が未設定です。いまは公開鍵で動いていますが、" +
    "2026-09-23-quote-api-only.sql を当てると顧客見積ページが開けなくなります。"
  );
}

/** tokenの形だけ見る（英数字20〜80文字） */
function cleanToken(v) {
  const s = String(v == null ? "" : v).trim();
  return /^[A-Za-z0-9]{20,80}$/.test(s) ? s : null;
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

/** Supabaseの関数をサーバー鍵で呼ぶ */
async function rpc(fn, args) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + fn, {
    method: "POST",
    headers: {
      apikey: SERVER_KEY,
      Authorization: "Bearer " + SERVER_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const out = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, out };
}

// ── 連打よけ（このインスタンスの中だけ。DB側の数えかたと二段構え） ──
const seen = new Map();
function tooFast(key, limit, windowMs) {
  if (!key) return false;
  const now = Date.now();
  const list = (seen.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  seen.set(key, list);
  if (seen.size > 5000) seen.clear();   // 増えすぎたら捨てる（目的は制限だけ）
  return list.length > limit;
}

/** DB側で数える。行きすぎていれば blocked=true が返る */
async function accessCheck(key, miss) {
  if (!key) return { blocked: false };
  try {
    const { ok, out } = await rpc("inv_quote_access_check", { p_client: key, p_miss: !!miss });
    return ok && out ? out : { blocked: false };
  } catch (e) {
    console.error("quote-api: access check error", e && e.message);
    return { blocked: false };   // 数えられなくても、お客様は通す
  }
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { res.setHeader("Allow", "GET,POST"); return res.status(204).end(); }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");

  let token = null;
  if (req.method === "GET") {
    const q = (req.url || "").split("?")[1] || "";
    token = cleanToken(new URLSearchParams(q).get("t"));
  } else {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = null; } }
    token = cleanToken(body && body.token);
  }

  const key = clientKey(req);
  if (tooFast(key, 60, 60000)) {
    res.setHeader("Retry-After", "60");
    return res.status(429).json({ found: false, error: "アクセスが多すぎます。少し時間をおいてからお試しください" });
  }
  // 形が違うtokenは、それだけで「外した」1回として数える
  if (!token) {
    await accessCheck(key, true);
    return res.status(400).json({ found: false, error: "URLが正しくありません" });
  }

  try {
    const { ok, status, out } = await rpc("inv_quote_public", { p_token: token });
    if (!ok) {
      console.error("quote-view: rpc failed", status, (out && (out.message || out.hint)) || "");
      return res.status(502).json({ found: false, error: "見積を読み込めませんでした" });
    }
    const miss = !(out && out.found);
    const guard = await accessCheck(key, miss);
    // 外し続けている相手だけ止める。正しいURLのお客様は通す
    if (miss && guard.blocked) {
      res.setHeader("Retry-After", "600");
      return res.status(429).json({ found: false, error: "アクセスが多すぎます。少し時間をおいてからお試しください" });
    }
    return res.status(200).json(out || { found: false });
  } catch (e) {
    console.error("quote-view: error", e);
    return res.status(502).json({ found: false, error: "見積を読み込めませんでした" });
  }
};

module.exports.cleanToken = cleanToken;
module.exports.clientKey = clientKey;
module.exports.accessCheck = accessCheck;
module.exports.tooFast = tooFast;
module.exports.rpc = rpc;
module.exports.hasSecretKey = () => !!SUPABASE_SECRET_KEY;
