// ============================================================
// 法人ITまるごと見積（/quote）の受付（Vercel サーバーレス関数）
//
//   /quote のフォームはここへ送信します。ここで
//     (1) Supabase の inv_deal_create() で案件として保存
//     (2) Slack へ通知
//   を行います。/api/contact と同じ作りです（Slack の Webhook URL を
//   ブラウザに渡さないため、サーバー側を通します）。
//
//   ここでは 決済もしませんし、個体も押さえません。
//   「こういうものが要る」という希望を受け取って保存するだけです。
//   購入・レンタル・組み合わせのどれにするかは、担当者が中身を見て決めます。
//
//   ── Vercel での設定 ─────────────────────────────
//     SLACK_WEBHOOK_URL   Slackの受信Webhook（未設定でもフォームは動きます）
//     SUPABASE_URL        既定 https://htglvascsuqkixpmclwr.supabase.co
//     SUPABASE_ANON_KEY   既定 sb_publishable_...（公開鍵。RLSで保護）
//     ZAIKO_DEALS_URL     Slack通知のボタンの遷移先。既定 https://www.8ec.jp/zaiko/deals
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL || "https://htglvascsuqkixpmclwr.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_yZCcrwdqjuf0u_5WBWlHIw_AxdvteEV";
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const ZAIKO_DEALS_URL = process.env.ZAIKO_DEALS_URL || "https://www.8ec.jp/zaiko/deals";

const GRADE_LABEL = {
  budget: "コスト重視（整備済み中心）",
  standard: "性能重視（スペック優先）",
  latest: "新品がいい（新品を調達）",
  any: "おまかせ（提案してほしい）",
};

/** 前後の空白を落として長さを制限する。空なら null */
function clean(value, max) {
  const s = String(value == null ? "" : value).trim();
  if (!s) return null;
  return s.slice(0, max);
}
/** 数値。範囲外・数値でないものは null にする（フォームの値をそのまま信じない） */
function num(value, min, max) {
  const n = Number(String(value == null ? "" : value).trim());
  if (!Number.isFinite(n)) return null;
  const v = Math.round(n);
  return v < min || v > max ? null : v;
}
/** YYYY-MM-DD だけ通す */
function date(value) {
  const s = String(value == null ? "" : value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) ? s : null;
}
/** 文字列の配列。決めた選択肢だけを通す */
function pickList(value, allowed, max) {
  if (!Array.isArray(value)) return [];
  const ok = [];
  value.forEach((v) => {
    const s = String(v == null ? "" : v).trim();
    if (s && allowed.indexOf(s) >= 0 && ok.indexOf(s) < 0 && ok.length < max) ok.push(s);
  });
  return ok;
}

const SERVICES = [
  "PC本体", "モニター・周辺機器",
  "初期設定・キッティング", "Office / Microsoft 365", "アカウント設定",
  "ネットワーク・Wi-Fi", "セキュリティ", "現地設置", "AI研修", "Office研修",
  "データ消去・証明書", "故障時の交換対応",
];
/** お客様の希望。購入相談（/buy の商品カードから）とレンタル相談を見分ける。
    どちらで用意するかを決めるのは担当者なので、ここでは「希望」としてだけ持つ */
const WANTS = ["購入希望", "レンタル希望", "未定"];

/** 商品コードの形だけ見る（P-00424 など）。実在するかはDB側で確かめる */
function productCode(value) {
  const s = String(value == null ? "" : value).trim().toUpperCase();
  return /^[A-Z]{1,4}-[A-Z0-9-]{1,20}$/.test(s) ? s : null;
}

const PURPOSES = [
  "新入社員・中途入社", "短期プロジェクト", "オフィス開設・移転", "研修・イベント",
  "PC入替", "増員", "故障・緊急代替", "その他",
];

/** Slack の mrkdwn で意味を持つ文字をエスケープ */
function slackEscape(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildSlackPayload(row) {
  const fields = [{ type: "mrkdwn", text: "*ご担当者*\n" + slackEscape(row.name) }];
  if (row.company) fields.push({ type: "mrkdwn", text: "*会社名*\n" + slackEscape(row.company) });
  if (row.email) fields.push({ type: "mrkdwn", text: "*メール*\n" + slackEscape(row.email) });
  if (row.phone) fields.push({ type: "mrkdwn", text: "*電話*\n" + slackEscape(row.phone) });
  fields.push({ type: "mrkdwn", text: "*用途*\n" + slackEscape(row.purpose || "未選択") });
  if (row.want) fields.push({ type: "mrkdwn", text: "*ご希望*\n" + slackEscape(row.want) });
  if (row.product_code) {
    fields.push({
      type: "mrkdwn",
      text: "*ご覧の商品*\n" + slackEscape(row.product_code + (row.product_name ? "　" + row.product_name : "")),
    });
  }

  const size = [
    row.headcount == null ? null : row.headcount + "名",
    row.qty == null ? null : row.qty + "台",
    row.months == null ? null : row.months + "ヶ月",
    row.start_date ? row.start_date + "開始" : null,
  ].filter(Boolean).join(" / ");
  if (size) fields.push({ type: "mrkdwn", text: "*規模・期間*\n" + slackEscape(size) });
  if (row.grade) fields.push({ type: "mrkdwn", text: "*ご希望の方針*\n" + slackEscape(GRADE_LABEL[row.grade] || row.grade) });

  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: row.want === "購入希望" ? "🛒 商品の購入相談"
          : row.want === "レンタル希望" ? "📦 商品のレンタル相談"
          : "🧾 3分IT調達診断からのご依頼",
        emoji: true,
      },
    },
    { type: "section", fields },
  ];
  if (row.services.length) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "*ご希望の作業*\n" + slackEscape(row.services.join(" / ")) } });
  }
  const spec = Object.keys(row.spec).map((k) => k + "：" + row.spec[k]).join(" / ");
  if (spec) blocks.push({ type: "section", text: { type: "mrkdwn", text: "*ご希望のスペック*\n" + slackEscape(spec) } });
  if (row.message) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "*その他のご希望*\n" + slackEscape(row.message.slice(0, 2500)) } });
  }
  blocks.push(
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
        text: "受信 " + new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false }) + "（JST）"
          + "　この時点では在庫も決済も動いていません",
      }],
    },
  );
  const head = row.want === "購入希望" ? "購入相談" : "まるごと見積";
  return {
    text: head + "：" + slackEscape(row.name) + " 様"
      + (row.company ? "（" + slackEscape(row.company) + "）" : "")
      + (row.product_code ? "　" + slackEscape(row.product_name || row.product_code) : ""),
    blocks,
  };
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { res.setHeader("Allow", "POST"); return res.status(204).end(); }
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "POST のみ受け付けます" }); }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = null; } }
  if (!body || typeof body !== "object") return res.status(400).json({ error: "リクエストの形式が不正です" });

  // ハニーポット：人には見えない項目。埋まっていたら自動投稿とみなして黙って捨てる
  if (String(body.website || "").trim() !== "") return res.status(200).json({ ok: true });

  const spec = {};
  ["cpu", "memory", "storage", "screen", "office", "webcam", "numpad"].forEach((k) => {
    const v = clean(body.spec && body.spec[k], 40);
    if (v) spec[k] = v;
  });

  const row = {
    name: clean(body.name, 100),
    company: clean(body.company, 120),
    email: clean(body.email, 160),
    phone: clean(body.phone, 40),
    purpose: PURPOSES.indexOf(clean(body.purpose, 40)) >= 0 ? clean(body.purpose, 40) : null,
    headcount: num(body.headcount, 0, 5000),
    qty: num(body.qty, 0, 5000),
    start_date: date(body.start_date),
    months: num(body.months, 0, 120),
    grade: GRADE_LABEL[String(body.grade || "")] ? String(body.grade) : null,
    spec,
    services: pickList(body.services, SERVICES, 20),
    message: clean(body.message, 4000),
    source: clean(body.source, 40) || "quote",
    // 商品から始まった相談（/buy の［この商品を購入相談する］）
    product_code: productCode(body.product_code),
    product_name: clean(body.product_name, 160),
    want: WANTS.indexOf(clean(body.want, 20)) >= 0 ? clean(body.want, 20) : null,
  };
  if (!row.name) return res.status(400).json({ error: "ご担当者名を入力してください" });

  // ── 1) Supabase に保存（ここが失敗したら送信失敗として返す） ──
  try {
    const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/inv_deal_create", {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: "Bearer " + SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_name: row.name, p_company: row.company, p_email: row.email, p_phone: row.phone,
        p_purpose: row.purpose, p_headcount: row.headcount, p_qty: row.qty,
        p_start: row.start_date, p_months: row.months, p_grade: row.grade,
        p_spec: row.spec, p_services: row.services, p_message: row.message, p_source: row.source,
        p_product_code: row.product_code, p_want: row.want,
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error("quote: supabase insert failed", r.status, detail);
      return res.status(502).json({ error: "保存に失敗しました" });
    }
  } catch (e) {
    console.error("quote: supabase request error", e);
    return res.status(502).json({ error: "保存に失敗しました" });
  }

  // ── 2) Slack に通知（失敗しても送信は成功として返す） ──
  // 依頼を取りこぼさないことを優先し、通知は「おまけ」として扱う。
  if (SLACK_WEBHOOK_URL) {
    try {
      const s = await fetch(SLACK_WEBHOOK_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildSlackPayload(row)),
      });
      if (!s.ok) console.error("quote: slack notify failed", s.status, await s.text().catch(() => ""));
    } catch (e) {
      console.error("quote: slack notify error", e);
    }
  }

  return res.status(200).json({ ok: true });
};

// テストから読めるように内部関数も公開しておく（Vercelの動作には影響しません）
module.exports.buildSlackPayload = buildSlackPayload;
module.exports.SERVICES = SERVICES;
module.exports.PURPOSES = PURPOSES;
module.exports.GRADE_LABEL = GRADE_LABEL;
