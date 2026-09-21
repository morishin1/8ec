// ============================================================
// お客様の［この内容で契約手続きを進める］（/api/contract-decide）
//
//   ここでやること
//     (1) 連打・総当たりを止める
//     (2) inv_contract_customer_confirm() をサーバー鍵で呼ぶ
//     (3) Slack へ通知する（お客様が押したときだけ・同じ内容の二度目は送らない）
//
//   押しても契約は「確定」になりません。記録するのは
//   「この内容で進めたい」という意思表示と、入力いただいた内容だけです。
//   契約の確定・入金・手配・発送・Stripeは、担当者が /zaiko で進めます。
// ============================================================

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const ZAIKO_CONTRACTS_URL = process.env.ZAIKO_CONTRACTS_URL || "https://www.8ec.jp/zaiko/contracts/";

const L = require("./_lib.js");
const { cleanToken, clientKey, accessCheck, tooFast, rpc, clean, slackEscape } = L;

const METHODS = ["カード", "請求書払い", "銀行振込"];

/** 郵便番号・住所などを、決めた形に整えてから渡す */
function addr(src, keys, max) {
  const out = {};
  if (!src || typeof src !== "object") return out;
  keys.forEach((k) => { const v = clean(src[k], max[k] || 160); if (v) out[k] = v; });
  return out;
}
/** YYYY-MM-DD だけ通す */
function onlyDate(v) {
  const s = String(v == null ? "" : v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) ? s : null;
}

function buildSlackPayload(row) {
  const fields = [
    { type: "mrkdwn", text: "*契約番号*\n" + slackEscape(row.contract_no || "-") },
    { type: "mrkdwn", text: "*お客様*\n" + slackEscape(row.company || "") },
    { type: "mrkdwn", text: "*ご担当*\n" + slackEscape(row.customer_name || "") + " 様" },
  ];
  if (row.requested_payment_method) {
    fields.push({ type: "mrkdwn", text: "*支払希望*\n" + slackEscape(row.requested_payment_method) });
  }
  if (row.desired_delivery_date) {
    fields.push({ type: "mrkdwn", text: "*お届け希望日*\n" + slackEscape(row.desired_delivery_date) });
  }
  if (row.billing_company) fields.push({ type: "mrkdwn", text: "*請求先*\n" + slackEscape(row.billing_company) });
  if (row.shipping_company) fields.push({ type: "mrkdwn", text: "*お届け先*\n" + slackEscape(row.shipping_company) });

  const blocks = [
    { type: "header", text: { type: "plain_text", text: "📝 お客様が契約手続きを進めました", emoji: true } },
    { type: "section", fields },
  ];
  if (row.message) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "*ご連絡事項*\n" + slackEscape(row.message.slice(0, 2000)) } });
  }
  blocks.push(
    { type: "section", text: { type: "mrkdwn",
      text: "*契約はまだ確定していません。* 内容を確認して、/zaiko で［契約を確定］を押してください。" } },
    { type: "actions", elements: [{
      type: "button", style: "primary",
      text: { type: "plain_text", text: "/zaiko で契約を見る", emoji: true },
      url: ZAIKO_CONTRACTS_URL + (row.contract_id || ""),
    }] },
    { type: "context", elements: [{ type: "mrkdwn",
      text: "受信 " + new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false }) + "（JST）" }] },
  );
  return {
    text: "契約手続き：" + slackEscape(row.contract_no || "") + "　"
      + slackEscape(row.company || "") + "　" + slackEscape(row.customer_name || "") + " 様",
    blocks,
  };
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { res.setHeader("Allow", "POST"); return res.status(204).end(); }
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "POST のみ受け付けます" }); }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");

  if (!L.hasKey()) return L.keyMissing(res);

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = null; } }
  if (!body || typeof body !== "object") return res.status(400).json({ error: "リクエストの形式が不正です" });

  const token = cleanToken(body.token);
  const name = clean(body.name, 100);
  const method = METHODS.indexOf(String(body.method || "")) >= 0 ? String(body.method) : null;
  const billing = addr(body.billing, ["company", "department", "person", "postal_code", "address", "email", "note"],
    { company: 120, department: 80, person: 80, postal_code: 16, address: 200, email: 160, note: 500 });
  const shipping = addr(body.shipping, ["company", "department", "person", "postal_code", "address", "phone", "note"],
    { company: 120, department: 80, person: 80, postal_code: 16, address: 200, phone: 40, note: 500 });
  const delivery = onlyDate(body.desired_delivery_date);
  const message = clean(body.message, 2000);

  const key = clientKey(req);
  if (tooFast("contract-decide", key, 10, 60000)) return L.tooMany(res, 60);
  if (!token) return res.status(400).json({ error: "URLが正しくありません" });
  if (!name) return res.status(400).json({ error: "ご担当者名を入力してください" });

  // ── 1) 内容を記録する（ここが失敗したら失敗として返す） ──
  let out = null;
  try {
    const guard = await accessCheck("contract-decide", key, false);
    if (guard.blocked) return L.tooMany(res, 600);
    const r = await rpc("inv_contract_customer_confirm", {
      p_token: token, p_name: name, p_billing: billing, p_shipping: shipping,
      p_method: method, p_delivery: delivery, p_message: message,
    });
    out = r.out;
    if (!r.ok) {
      // 期限切れ・取消・二重送信などは、SQL側のメッセージをそのままお客様に見せる
      const msg = (out && (out.message || out.hint)) || "お手続きできませんでした";
      console.error("contract-decide: rpc failed", r.status, msg);
      return res.status(400).json({ error: msg });
    }
  } catch (e) {
    console.error("contract-decide: error", e);
    return res.status(502).json({ error: "お手続きできませんでした" });
  }

  // ── 2) Slack へ通知 ──
  //     ・DBはもう確定しているので、Slackが失敗してもお客様の操作は成功として返す
  //     ・同じ内容の二度目（already）は、状態が変わっていないので送らない
  const already = !!(out && out.already);
  if (SLACK_WEBHOOK_URL && !already) {
    try {
      const s = await fetch(SLACK_WEBHOOK_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildSlackPayload(out || {})),
      });
      if (!s.ok) console.error("contract-decide: slack notify failed", s.status, await s.text().catch(() => ""));
    } catch (e) {
      console.error("contract-decide: slack notify error", e);
    }
  }

  return res.status(200).json({ ok: true, already, contract_no: out && out.contract_no });
};

module.exports.buildSlackPayload = buildSlackPayload;
