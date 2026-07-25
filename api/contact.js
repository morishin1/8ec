// ============================================================
// 問い合わせ・見積もりフォームの受付（Vercel サーバーレス関数）
//
//   サイト各ページのフォームは、この /api/contact に送信します。
//   ここで (1) Supabase への保存 と (2) Slack への通知 を行います。
//
//   Slack の Webhook URL はブラウザに渡さず、Vercel の環境変数として
//   サーバー側だけで参照します（ブラウザに置くと、URLを知った第三者が
//   自由にチャンネルへ投稿できてしまうため）。
//
//   ── Vercel での設定 ─────────────────────────────
//   プロジェクト → Settings → Environment Variables に追加：
//
//     SLACK_WEBHOOK_URL   Slackの受信Webhook（https://hooks.slack.com/services/...）
//                         ※未設定でもフォームは動作します（Slack通知だけスキップ）
//
//   任意（通常は設定不要。既定値で動きます）：
//     SUPABASE_URL        既定 https://htglvascsuqkixpmclwr.supabase.co
//     SUPABASE_ANON_KEY   既定 sb_publishable_...（公開鍵。RLSで保護されています）
//     ADMIN_CONTACT_URL   Slack通知のボタンの遷移先。既定 https://www.8ec.jp/admin/contact/
//
//   環境変数を追加・変更したあとは、再デプロイすると反映されます。
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL || "https://htglvascsuqkixpmclwr.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_yZCcrwdqjuf0u_5WBWlHIw_AxdvteEV";
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const ADMIN_CONTACT_URL = process.env.ADMIN_CONTACT_URL || "https://www.8ec.jp/admin/contact/";

const SOURCE_LABEL = {
  top: "トップページ",
  pc: "PCレンタル",
  cloud: "クラウド情シス",
  "ai-dev": "AI・業務システム開発",
  company: "会社概要",
  general: "その他",
};

/** 前後の空白を落として長さを制限する。空なら null */
function clean(value, max) {
  const s = String(value == null ? "" : value).trim();
  if (!s) return null;
  return s.slice(0, max);
}

/** Slack の mrkdwn で意味を持つ文字をエスケープ */
function slackEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildSlackPayload(row) {
  const sourceLabel = SOURCE_LABEL[row.source] || row.source || "その他";
  const fields = [{ type: "mrkdwn", text: "*お名前*\n" + slackEscape(row.name) }];
  if (row.company) fields.push({ type: "mrkdwn", text: "*会社名*\n" + slackEscape(row.company) });
  if (row.email) fields.push({ type: "mrkdwn", text: "*メール*\n" + slackEscape(row.email) });
  if (row.phone) fields.push({ type: "mrkdwn", text: "*電話*\n" + slackEscape(row.phone) });
  fields.push({ type: "mrkdwn", text: "*ご相談種別*\n" + slackEscape(row.inquiry_type || "未選択") });
  fields.push({ type: "mrkdwn", text: "*送信元ページ*\n" + slackEscape(sourceLabel) });

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "🔔 お問い合わせ・見積もり依頼が届きました", emoji: true },
    },
    { type: "section", fields },
  ];

  if (row.message) {
    // Slack の section テキストは3000文字までなので余裕をもって切る
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*内容*\n" + slackEscape(row.message.slice(0, 2500)) },
    });
  }

  blocks.push(
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "管理画面で対応する", emoji: true },
          url: ADMIN_CONTACT_URL,
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            "受信 " +
            new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false }) +
            "（JST）",
        },
      ],
    },
  );

  return {
    // スマホの通知プレビューやSlack検索で使われる
    text: "新しいお問い合わせ：" + slackEscape(row.name) + " 様（" + sourceLabel + "）",
    blocks,
  };
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "POST");
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POSTのみ受け付けます" });
  }

  // Vercel は Content-Type: application/json を自動で解釈する。
  // それ以外の形で届いた場合に備えて自前でも解析する。
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (_) { body = null; }
  }
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "リクエストの形式が不正です" });
  }

  // ハニーポット：人には見えない項目。埋まっていたら自動投稿とみなして黙って捨てる
  if (String(body.website || "").trim() !== "") {
    return res.status(200).json({ ok: true });
  }

  const row = {
    source: clean(body.source, 40) || "general",
    name: clean(body.name, 100),
    company: clean(body.company, 120),
    email: clean(body.email, 160),
    phone: clean(body.phone, 40),
    message: clean(body.message, 4000),
    inquiry_type: clean(body.inquiry_type, 40),
  };
  if (!row.name) {
    return res.status(400).json({ error: "お名前を入力してください" });
  }

  // ── 1) Supabase に保存（ここが失敗したら送信失敗として返す） ──
  try {
    const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/contact_public_submit", {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: "Bearer " + SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_source: row.source,
        p_name: row.name,
        p_company: row.company,
        p_email: row.email,
        p_phone: row.phone,
        p_message: row.message,
        p_inquiry_type: row.inquiry_type,
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error("contact: supabase insert failed", r.status, detail);
      return res.status(502).json({ error: "保存に失敗しました" });
    }
  } catch (e) {
    console.error("contact: supabase request error", e);
    return res.status(502).json({ error: "保存に失敗しました" });
  }

  // ── 2) Slack に通知（失敗しても送信は成功として返す） ──
  // 問い合わせを取りこぼさないことを優先し、通知は「おまけ」として扱う。
  if (SLACK_WEBHOOK_URL) {
    try {
      const s = await fetch(SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildSlackPayload(row)),
      });
      if (!s.ok) {
        console.error("contact: slack notify failed", s.status, await s.text().catch(() => ""));
      }
    } catch (e) {
      console.error("contact: slack notify error", e);
    }
  }

  return res.status(200).json({ ok: true });
};

// テストから読めるように内部関数も公開しておく（Vercelの動作には影響しません）
module.exports.buildSlackPayload = buildSlackPayload;
module.exports.slackEscape = slackEscape;
module.exports.clean = clean;
