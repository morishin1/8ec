// ============================================================
// 顧客向け見積ページが読む中身（/api/quote-view?t=<token>）
//
//   お客様のブラウザ → Vercel /api/* →（サーバー鍵）→ Supabase
//   この順番で必ず通します。ブラウザからSupabaseを直接たたく経路はありません。
//
//   理由は3つです。
//     ・お客様の画面に公開鍵やテーブル構造を出さないため
//     ・見積の閲覧・操作をこちら側で一本化するため（Slack通知は decide 側）
//     ・ここに足す共通処理（通知・記録・回数制限）を迂回させないため
//
//   サーバー鍵（SUPABASE_SECRET_KEY）が無ければ 503 を返して止まります。
//   公開鍵で代わりに動かすことはしません（_lib.js の説明を参照）。
//
//   返すのは inv_quote_public() の中身だけです。
//   この関数は 原価・粗利・社内メモ・在庫数・管理番号 を返しません。
// ============================================================

const L = require("./_lib.js");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { res.setHeader("Allow", "GET,POST"); return res.status(204).end(); }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");

  if (!L.hasKey()) return L.keyMissing(res, { found: false });

  let token = null;
  if (req.method === "GET") {
    const q = (req.url || "").split("?")[1] || "";
    token = L.cleanToken(new URLSearchParams(q).get("t"));
  } else {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = null; } }
    token = L.cleanToken(body && body.token);
  }

  const key = L.clientKey(req);
  if (L.tooFast("quote-view", key, 60, 60000)) return L.tooMany(res, 60, { found: false });

  // 形が違うtokenは、それだけで「外した」1回として数える
  if (!token) {
    await L.accessCheck("quote-view", key, true);
    return res.status(400).json({ found: false, error: "URLが正しくありません" });
  }

  try {
    const { ok, status, out } = await L.rpc("inv_quote_public", { p_token: token });
    if (!ok) {
      console.error("quote-view: rpc failed", status, (out && (out.message || out.hint)) || "");
      return res.status(502).json({ found: false, error: "見積を読み込めませんでした" });
    }
    const miss = !(out && out.found);
    const guard = await L.accessCheck("quote-view", key, miss);
    // 外し続けている相手だけ止める。正しいURLのお客様は通す
    if (miss && guard.blocked) return L.tooMany(res, 600, { found: false });
    return res.status(200).json(out || { found: false });
  } catch (e) {
    console.error("quote-view: error", e);
    return res.status(502).json({ found: false, error: "見積を読み込めませんでした" });
  }
};
