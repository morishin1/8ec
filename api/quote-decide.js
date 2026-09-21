// ============================================================
// お客様の［この内容で進める］［内容について相談する］（/api/quote-decide）
//
//   ここでやること
//     (1) 連打・総当たりを止める
//     (2) inv_quote_decide() をサーバー鍵で呼ぶ
//     (3) Slack へ通知する（お客様が押したときだけ・同じ操作の二度目は送らない）
//
//   お客様のブラウザ → Vercel /api/* →（サーバー鍵）→ Supabase の順で必ず通ります。
//   anon（公開鍵）から inv_quote_decide は呼べません（2026-09-23-quote-api-only.sql）。
//
//   押しても契約・決済・機器の確保は起きません。
//   案件が「契約準備」へ進み、担当者が続きを進めます。
//   在庫（inventory_items）はこの経路では一切動きません。
// ============================================================

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const ZAIKO_DEALS_URL = process.env.ZAIKO_DEALS_URL || "https://www.8ec.jp/zaiko/deals";

// 鍵の解決・IPの数えかた・RPCの呼びかたは _lib.js に集めてある
const L = require("./_lib.js");
const { cleanToken, clientKey, accessCheck, tooFast, rpc, clean, slackEscape } = L;

function buildSlackPayload(row) {
  const ok = row.action === "approve";
  const fields = [
    { type: "mrkdwn", text: "*見積番号*\n" + slackEscape(row.quote_no || "-") },
    { type: "mrkdwn", text: "*お名前*\n" + slackEscape(row.name) },
  ];
  if (row.company) fields.push({ type: "mrkdwn", text: "*会社名*\n" + slackEscape(row.company) });

  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: ok ? "✅ お客様が見積を承認しました" : "💬 見積について相談が届きました",
        emoji: true,
      },
    },
    { type: "section", fields },
  ];
  if (!ok && row.message) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "*ご相談の内容*\n" + slackEscape(row.message.slice(0, 2000)) } });
  }
  blocks.push(
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ok
          ? "案件は *契約準備* へ進みました。*この時点で在庫は確保していません。* 契約と支払方法が決まってから手配してください。"
          : "案件は *見積* のままです。内容を確認して、必要なら新しい版を作ってください。",
      },
    },
    {
      type: "actions",
      elements: [{
        type: "button", style: "primary",
        text: { type: "plain_text", text: "/zaiko で案件を見る", emoji: true },
        url: ZAIKO_DEALS_URL,
      }],
    },
    {
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: "受信 " + new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false }) + "（JST）",
      }],
    },
  );
  return {
    text: (ok ? "見積承認：" : "見積の相談：") + slackEscape(row.quote_no || "")
      + "　" + slackEscape(row.name) + " 様" + (row.company ? "（" + slackEscape(row.company) + "）" : ""),
    blocks,
  };
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { res.setHeader("Allow", "POST"); return res.status(204).end(); }
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "POST のみ受け付けます" }); }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");

  if (!L.hasKey()) return L.keyMissing(res);

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = null; } }
  if (!body || typeof body !== "object") return res.status(400).json({ error: "リクエストの形式が不正です" });

  const token = cleanToken(body.token);
  const action = body.action === "approve" ? "approve" : (body.action === "consult" ? "consult" : null);
  const row = {
    action,
    name: clean(body.name, 100),
    company: clean(body.company, 120),
    message: clean(body.message, 2000),
  };
  const key = clientKey(req);
  // 同じ相手からの連打はここで止める（DB側の数えかたと二段構え）
  if (tooFast("quote-decide", key, 10, 60000)) return L.tooMany(res, 60);
  if (!token) return res.status(400).json({ error: "URLが正しくありません" });
  if (!action) return res.status(400).json({ error: "操作が正しくありません" });
  if (!row.name) return res.status(400).json({ error: "ご担当者名を入力してください" });

  // ── 1) 見積の状態を進める（ここが失敗したら失敗として返す） ──
  //     書き込む操作なので、数えた結果が行きすぎていれば通さない
  let out = null;
  try {
    const guard = await accessCheck("quote-decide", key, false);
    if (guard.blocked) return L.tooMany(res, 600);
    const r = await rpc("inv_quote_decide", {
      p_token: token, p_action: action, p_name: row.name,
      p_company: row.company, p_message: row.message,
    });
    out = r.out;
    if (!r.ok) {
      // 期限切れ・失効などは、SQL側のメッセージをそのままお客様に見せる
      const msg = (out && (out.message || out.hint)) || "お手続きできませんでした";
      console.error("quote-decide: rpc failed", r.status, msg);
      return res.status(400).json({ error: msg });
    }
  } catch (e) {
    console.error("quote-decide: error", e);
    return res.status(502).json({ error: "お手続きできませんでした" });
  }

  // ── 2) Slack へ通知 ──
  //     ・DBはもう確定しているので、Slackが失敗してもお客様の操作は成功として返す
  //       （失敗はログに残す。案件の状態は /zaiko/deals で見えるので取りこぼさない）
  //     ・同じ操作の二度目（already）は、状態が変わっていないので送らない
  const already = !!(out && out.already);
  if (SLACK_WEBHOOK_URL && !already) {
    try {
      const s = await fetch(SLACK_WEBHOOK_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildSlackPayload(Object.assign({}, row, { quote_no: out && out.quote_no }))),
      });
      if (!s.ok) console.error("quote-decide: slack notify failed", s.status, await s.text().catch(() => ""));
    } catch (e) {
      console.error("quote-decide: slack notify error", e);
    }
  }

  return res.status(200).json({
    ok: true, already, status: out && out.status, quote_no: out && out.quote_no,
  });
};

module.exports.buildSlackPayload = buildSlackPayload;
