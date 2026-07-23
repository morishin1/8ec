// ============================================================
// 8 SHOP: Stripe Checkout セッション生成 Edge Function
//
//   デプロイ:
//     supabase functions deploy create-checkout --no-verify-jwt
//   （--no-verify-jwt … ショップは公開ページで匿名アクセスのため）
//
//   Secrets（Supabase ダッシュボード → Edge Functions → create-checkout → Secrets）:
//     STRIPE_SECRET_KEY   … Stripeの「シークレットキー」（sk_live_… / テストは sk_test_…）
//     SHOP_URL            … 任意。既定 https://8grp.co.jp/8/shop/
//   ※ SUPABASE_URL / SUPABASE_ANON_KEY は Supabase が自動で注入します。
//
//   役割:
//     クライアントから商品ID(id)を受け取り、公開ビュー shop_products から
//     「価格・商品名」をサーバー側で取得（＝金額を絶対にクライアントに信頼させない）、
//     その内容で Stripe Checkout セッションを作成して決済URLを返す。
//     配送先住所・電話番号を購入時に収集する（物販のため）。
// ============================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY");
    if (!STRIPE_KEY) {
      return json({ error: "STRIPE_SECRET_KEY が未設定です。Supabase の Secrets に設定してください。" }, 500);
    }
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SHOP_URL = (Deno.env.get("SHOP_URL") || "https://8grp.co.jp/8/shop/").replace(/\/+$/, "") + "/";

    const { id } = await req.json();
    if (!id) return json({ error: "商品IDがありません。" }, 400);

    // 公開ビューから、その商品の「価格・名称」をサーバー側で取得（金額をクライアントに信頼させない）
    const q = `${SUPABASE_URL}/rest/v1/shop_products?id=eq.${encodeURIComponent(id)}&select=id,title,description,price,image_url,mgmt_no`;
    const pr = await fetch(q, { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` } });
    const rows = await pr.json();
    const p = Array.isArray(rows) ? rows[0] : null;
    if (!p) return json({ error: "商品が見つからないか、公開されていません。" }, 404);

    const amount = Math.round(Number(p.price));
    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ error: "この商品には有効な価格が設定されていません。" }, 400);
    }

    // Stripe は application/x-www-form-urlencoded（ネストは角括弧記法）
    const body = new URLSearchParams();
    body.append("mode", "payment");
    body.append("locale", "ja");
    body.append("success_url", `${SHOP_URL}?paid=1&session_id={CHECKOUT_SESSION_ID}`);
    body.append("cancel_url", `${SHOP_URL}?canceled=1`);
    body.append("line_items[0][quantity]", "1");
    body.append("line_items[0][price_data][currency]", "jpy");
    body.append("line_items[0][price_data][unit_amount]", String(amount));
    body.append("line_items[0][price_data][product_data][name]", String(p.title || p.mgmt_no || "商品"));
    const desc = (p.description || "").toString().trim().slice(0, 500);
    if (desc) body.append("line_items[0][price_data][product_data][description]", desc);
    if (typeof p.image_url === "string" && /^https:\/\//.test(p.image_url)) {
      body.append("line_items[0][price_data][product_data][images][0]", p.image_url);
    }
    // 物販：配送先住所・電話番号を収集
    body.append("shipping_address_collection[allowed_countries][0]", "JP");
    body.append("phone_number_collection[enabled]", "true");
    // 管理用メタデータ（Stripeダッシュボードで照合できる）
    body.append("metadata[product_id]", String(p.id));
    body.append("metadata[mgmt_no]", String(p.mgmt_no || ""));

    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STRIPE_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    const data = await res.json();
    if (!res.ok) {
      return json({ error: "Stripeでの決済ページ作成に失敗しました：" + (data?.error?.message || res.status) }, 502);
    }
    return json({ url: data.url });
  } catch (e) {
    return json({ error: String(e && (e as Error).message ? (e as Error).message : e) }, 500);
  }
});
