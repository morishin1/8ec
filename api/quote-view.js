// ============================================================
// 顧客向け見積ページが読む中身（/api/quote-view?t=<token>）
//
//   ブラウザからSupabaseを直接たたかず、ここを通します。
//   理由は2つです。
//     ・お客様の画面に公開鍵やテーブル構造を出さないため
//     ・見積の閲覧・操作をこちら側で一本化するため（Slack通知は decide 側）
//
//   返すのは inv_quote_public() の中身だけです。
//   この関数は 原価・粗利・社内メモ・在庫数・管理番号 を返しません。
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL || "https://htglvascsuqkixpmclwr.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_yZCcrwdqjuf0u_5WBWlHIw_AxdvteEV";

/** tokenの形だけ見る（英数字32文字以上） */
function cleanToken(v) {
  const s = String(v == null ? "" : v).trim();
  return /^[A-Za-z0-9]{20,80}$/.test(s) ? s : null;
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { res.setHeader("Allow", "GET,POST"); return res.status(204).end(); }

  let token = null;
  if (req.method === "GET") {
    const q = (req.url || "").split("?")[1] || "";
    token = cleanToken(new URLSearchParams(q).get("t"));
  } else {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = null; } }
    token = cleanToken(body && body.token);
  }
  if (!token) return res.status(400).json({ found: false, error: "URLが正しくありません" });

  try {
    const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/inv_quote_public", {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: "Bearer " + SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_token: token }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error("quote-view: rpc failed", r.status, detail);
      return res.status(502).json({ found: false, error: "見積を読み込めませんでした" });
    }
    const out = await r.json();
    // 検索エンジンにもキャッシュにも載せない（お客様ごとのURLのため）
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    return res.status(200).json(out || { found: false });
  } catch (e) {
    console.error("quote-view: error", e);
    return res.status(502).json({ found: false, error: "見積を読み込めませんでした" });
  }
};

module.exports.cleanToken = cleanToken;
