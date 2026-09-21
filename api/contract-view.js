// ============================================================
// 顧客向けの契約手続きページが読む中身（/api/contract-view?t=<token>）
//
//   お客様のブラウザ → Vercel /api/* →（サーバー鍵）→ Supabase
//   この順番で必ず通します。ブラウザからSupabaseを直接たたく経路はありません。
//   （/api/quote-view と同じ考え方です）
//
//   サーバー鍵（SUPABASE_SECRET_KEY）が無ければ 503 を返して止まります。
//
//   返すのは inv_contract_public() の中身だけです。この関数は
//   原価・粗利・社内メモ・在庫数・S/N・管理番号・仕入先・社内与信・
//   StripeのID・内部ID を返しません。
// ============================================================

const L = require("./_lib.js");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { res.setHeader("Allow", "GET,POST"); return res.status(204).end(); }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");

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
  if (L.tooFast("contract-view", key, 60, 60000)) return L.tooMany(res, 60, { found: false });

  if (!token) {
    await L.accessCheck("contract-view", key, true);
    return res.status(400).json({ found: false, error: "URLが正しくありません" });
  }

  try {
    const { ok, status, out } = await L.rpc("inv_contract_public", { p_token: token });
    if (!ok) {
      console.error("contract-view: rpc failed", status, (out && (out.message || out.hint)) || "");
      return res.status(502).json({ found: false, error: "契約内容を読み込めませんでした" });
    }
    const miss = !(out && out.found);
    const guard = await L.accessCheck("contract-view", key, miss);
    // 外し続けている相手だけ止める。正しいURLのお客様は通す
    if (miss && guard.blocked) return L.tooMany(res, 600, { found: false });
    return res.status(200).json(out || { found: false });
  } catch (e) {
    console.error("contract-view: error", e);
    return res.status(502).json({ found: false, error: "契約内容を読み込めませんでした" });
  }
};
