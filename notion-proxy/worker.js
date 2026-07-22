/* ============================================================
   Notion Contact Form Proxy (Cloudflare Worker)

   概要:
     index.html のお問い合わせフォームから JSON を受け取り、
     Notion API 経由で「8grp問い合わせ管理」DBに1ページ追加する。

   環境変数（wrangler secret put で設定）:
     NOTION_TOKEN       - Notion Integration の Internal Integration Token
                          (https://www.notion.so/my-integrations で発行)
     NOTION_DATABASE_ID - 8grp問い合わせ管理 のデータベースID
                          デフォルト: 591ade7c-f5ff-492c-b150-3418b9e43c29
     ALLOWED_ORIGIN     - CORS 許可オリジン（例: https://8ec.jp）
                          "*" でも動くが本番では具体ドメイン推奨

   セットアップ:
     1. https://www.notion.so/my-integrations で Integration 作成 → Token 取得
     2. Notion側で対象DB（8grp問い合わせ管理）を開き、右上「…」→
        「接続」→作成した Integration を招待
     3. wrangler secret put NOTION_TOKEN
        wrangler secret put NOTION_DATABASE_ID   (任意・既定値でよければ不要)
        wrangler secret put ALLOWED_ORIGIN       (任意)
     4. wrangler deploy

   ルーティング:
     POST /api/contact  → Notionへ1件追加
     OPTIONS /api/contact → CORSプリフライト応答
     それ以外は 404
   ============================================================ */

const NOTION_VERSION = "2022-06-28";
const DEFAULT_DB_ID  = "591ade7c-f5ff-492c-b150-3418b9e43c29"; // 8grp問い合わせ管理

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // /api/contact のみ受け付け
    if (url.pathname !== "/api/contact") {
      return new Response("Not found", { status: 404 });
    }

    const allowedOrigin = (env.ALLOWED_ORIGIN || "*").trim();
    const corsHeaders = {
      "Access-Control-Allow-Origin":  allowedOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };

    // プリフライト
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, corsHeaders);
    }

    // Bodyパース
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400, corsHeaders);
    }

    // ハニーポット: "website"フィールドに何か入っていたら bot として静かに捨てる
    if (body && typeof body.website === "string" && body.website.length > 0) {
      return json({ ok: true, skipped: true }, 200, corsHeaders);
    }

    // 軽いバリデーション
    const name  = safe(body.name);
    const email = safe(body.email);
    if (!name)  return json({ error: "name is required" }, 400, corsHeaders);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: "valid email is required" }, 400, corsHeaders);
    }

    // トークンチェック
    if (!env.NOTION_TOKEN) {
      return json({ error: "Server not configured (NOTION_TOKEN missing)" }, 500, corsHeaders);
    }

    const dbId = env.NOTION_DATABASE_ID || DEFAULT_DB_ID;

    // お問い合わせ内容に利用用途/台数/期間/備考をまとめる
    const content = [
      body.use  ? `【ご利用用途】${useLabel(body.use)}` : "",
      body.qty  ? `【希望台数】${safe(body.qty)}`        : "",
      body.term ? `【ご利用期間】${safe(body.term)}`     : "",
      body.note ? `\n【ご要望・補足】\n${safe(body.note)}` : "",
      body.source ? `\n\n──────────\nSource: ${safe(body.source)}` : "",
    ].filter(Boolean).join("\n");

    const subject = `PCレンタル見積もり依頼：${safe(body.company) || name}`;

    // Notion API: Create Page
    const notionBody = {
      parent: { database_id: dbId },
      properties: {
        // お名前（title property）
        "お名前": {
          title: [{ text: { content: name } }]
        },
        // 件名（text）
        "件名": {
          rich_text: [{ text: { content: subject } }]
        },
        // 会社名（text）
        "会社名": {
          rich_text: [{ text: { content: safe(body.company) } }]
        },
        // メールアドレス（email）
        "メールアドレス": { email: email },
        // 電話番号（phone_number）
        "電話番号": { phone_number: safe(body.tel) || null },
        // お問い合わせ種別（select）— LP経由は固定で「レンタル問い合わせ」
        // ※ Notion側 8grp問い合わせ管理DB に当オプションが存在する前提
        //    （サービスについて / 採用について / 協業・パートナーについて /
        //      取材・メディアについて / その他 / レンタル問い合わせ）
        "お問い合わせ種別": {
          select: { name: "レンタル問い合わせ" }
        },
        // ステータス（select）— 新着は未対応
        "ステータス": {
          select: { name: "未対応" }
        },
        // 重要度（select）— 既定は普通
        "重要度": {
          select: { name: "普通" }
        },
        // 受信日時（date）
        "受信日時": {
          date: { start: body.submittedAt || new Date().toISOString() }
        },
        // お問い合わせ内容（text）
        "お問い合わせ内容": {
          rich_text: [{ text: { content: content || "(内容なし)" } }]
        }
      }
    };

    // Notion API 呼び出し
    const notionRes = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.NOTION_TOKEN}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type":   "application/json",
      },
      body: JSON.stringify(notionBody),
    });

    if (!notionRes.ok) {
      const errText = await notionRes.text().catch(()=>"");
      console.error("Notion API error:", notionRes.status, errText);
      return json({
        error: "Notion API error",
        status: notionRes.status,
        detail: errText.slice(0, 500),
      }, 502, corsHeaders);
    }

    const notionJson = await notionRes.json();
    return json({ ok: true, pageId: notionJson.id }, 200, corsHeaders);
  }
};

/* ---------- util ---------- */
function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders }
  });
}
function safe(v) {
  if (v == null) return "";
  return String(v).slice(0, 2000);
}
function useLabel(v) {
  const map = {
    training:    "新入社員研修",
    event:       "イベント・展示会",
    telework:    "テレワーク",
    replacement: "故障時の代替機",
    other:       "その他",
  };
  return map[v] || safe(v);
}
