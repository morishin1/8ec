/* 楽天の注文を /zaiko の在庫につなぐ Edge Function。
 *
 *   画像・商品情報の同期（rakuten-product-sync）は Rakuten Developers API だが、
 *   注文はそちらでは取れない。受注は RMS WEB SERVICE の Order API を使う。
 *   資格情報も別で、RMSの「Web APIサービス」から発行する
 *   serviceSecret / licenseKey を Authorization: ESA <base64> で送る。
 *
 *   流れ
 *     searchOrder で期間内の注文番号を取る
 *       → getOrder で明細（商品コード・URL・数量・発送状況）を取る
 *       → inv_sale_orders_apply() に渡して在庫を確保する
 *
 *   在庫を動かす判断はすべてSQL側（inv_sale_orders_apply → inv_sale_reserve）に
 *   置いてある。ここは「楽天から取って形をそろえる」だけで、冪等性も
 *   注文番号×明細番号×連番の一意制約で担保する。このEdge Functionを
 *   何度呼んでも在庫は二重に減らない。
 *
 *   必要な環境変数
 *     RAKUTEN_RMS_SERVICE_SECRET  RMS Web APIのサービスシークレット
 *     RAKUTEN_RMS_LICENSE_KEY     RMS Web APIのライセンスキー
 *     SUPABASE_URL / SUPABASE_ANON_KEY（プロジェクト既定）
 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const RMS_BASE = "https://api.rms.rakuten.co.jp/es/2.0/order";
/* RMSの orderProgress。100=注文確認待ち 200=楽天処理中 300=発送待ち 400=変更確定待ち
   500=発送中 600=発送完了 700=支払手続き中 800=支払手続き済 900=キャンセル */
const PROGRESS_SHIPPED = new Set([600, 700, 800]);
const PROGRESS_CANCELLED = new Set([900]);

function esaHeader(serviceSecret: string, licenseKey: string) {
  const raw = `${serviceSecret}:${licenseKey}`;
  return "ESA " + btoa(raw);
}

async function rms(path: string, auth: string, body: unknown) {
  const res = await fetch(`${RMS_BASE}/${path}/`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  let data: any = null;
  try { data = await res.json(); } catch (_) { data = null; }
  return { ok: res.ok, status: res.status, data };
}

/* RMSのgetOrderの返しを、SQL側が読む形にそろえる。
   商品の特定はモールの商品コード（manageNumber / itemNumber）と商品URLだけで行い、
   ここでは推測しない（当たらなければSQL側が「未割当」で記録して人に知らせる）。 */
function normalizeOrders(orderModelList: any[], shopCode: string) {
  const lines: any[] = [];
  for (const o of orderModelList || []) {
    const orderNumber = String(o?.orderNumber || "").trim();
    if (!orderNumber) continue;
    const progress = Number(o?.orderProgress);
    const shipped = PROGRESS_SHIPPED.has(progress);
    const cancelled = PROGRESS_CANCELLED.has(progress) || !!o?.cancelDueDate;
    const orderedAt = o?.orderDatetime ? String(o.orderDatetime).replace(" ", "T") : null;
    const pkgs: any[] = Array.isArray(o?.PackageModelList) ? o.PackageModelList : [];
    for (const pkg of pkgs) {
      const items: any[] = Array.isArray(pkg?.ItemModelList) ? pkg.ItemModelList : [];
      for (const it of items) {
        // 明細番号。RMSは itemDetailId を返すが、無い店舗設定もあるので
        // そのときは商品管理番号で代用する（同じ注文の中で一意になればよい）
        const lineNumber = String(
          it?.itemDetailId ?? it?.itemNumber ?? it?.manageNumber ?? lines.length + 1,
        ).trim();
        const manage = String(it?.manageNumber || "").trim();
        lines.push({
          order_number: orderNumber,
          line_number: lineNumber,
          // external_item_code に入っているのと同じ形（shopCode:itemNumber）にそろえる
          item_code: it?.itemNumber ? `${shopCode}:${String(it.itemNumber).trim()}` : null,
          item_url: manage ? `https://item.rakuten.co.jp/${shopCode}/${manage}/` : null,
          qty: Math.max(1, Number(it?.units) || 1),
          price: it?.price != null ? Number(it.price) : null,
          ordered_at: orderedAt,
          shipped,
          cancelled,
          raw: { manageNumber: manage, itemNumber: it?.itemNumber ?? null, orderProgress: progress },
        });
      }
    }
  }
  return lines;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const SERVICE_SECRET = Deno.env.get("RAKUTEN_RMS_SERVICE_SECRET") ?? "";
    const LICENSE_KEY = Deno.env.get("RAKUTEN_RMS_LICENSE_KEY") ?? "";
    const SHOP_CODE = Deno.env.get("RAKUTEN_SHOP_CODE") ?? "";
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
    const SUPABASE_ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");

    if (!SERVICE_SECRET || !LICENSE_KEY) {
      return json({
        error: "楽天RMSの資格情報が設定されていません。",
        detail: "RAKUTEN_RMS_SERVICE_SECRET / RAKUTEN_RMS_LICENSE_KEY を設定してください。"
          + "（画像同期で使う Rakuten Developers API とは別の、RMS WEB SERVICE の資格情報です）",
      }, 400);
    }
    if (!token) return json({ error: "ログインしてから実行してください。" }, 401);

    const body = await req.json().catch(() => ({}));
    const days = Math.max(1, Math.min(Number(body?.days) || 3, 31));
    const dryRun = !!body?.dry_run;
    const auth = esaHeader(SERVICE_SECRET, LICENSE_KEY);

    // ── 1. 期間内の注文番号を取る ──
    const end = new Date();
    const begin = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => d.toISOString().slice(0, 19) + "+0900";
    const search = await rms("searchOrder", auth, {
      dateType: 1,                       // 1=注文日
      startDatetime: fmt(begin),
      endDatetime: fmt(end),
      PaginationRequestModel: { requestRecordsAmount: 100, requestPage: 1 },
    });
    if (!search.ok) {
      return json({
        error: "楽天RMSの注文検索に失敗しました（資格情報またはAPI利用申請をご確認ください）。",
        status: search.status, rms_response: search.data,
      }, 502);
    }
    const numbers: string[] = Array.isArray(search.data?.orderNumberList) ? search.data.orderNumberList : [];
    console.log(JSON.stringify({ rms_search: true, days, order_count: numbers.length }));
    if (numbers.length === 0) {
      return json({ days, order_count: 0, line_count: 0, new: 0, already: 0, reserved: 0, shipped: 0, cancelled: 0, unmatched: [], no_stock: [] });
    }

    // ── 2. 注文の明細を取る（100件ずつ） ──
    const orders: any[] = [];
    for (let i = 0; i < numbers.length; i += 100) {
      const got = await rms("getOrder", auth, {
        orderNumberList: numbers.slice(i, i + 100),
        version: 7,
      });
      if (!got.ok) {
        return json({
          error: "楽天RMSの注文取得に失敗しました。", status: got.status, rms_response: got.data,
        }, 502);
      }
      if (Array.isArray(got.data?.OrderModelList)) orders.push(...got.data.OrderModelList);
    }
    const lines = normalizeOrders(orders, SHOP_CODE);
    console.log(JSON.stringify({ rms_get: true, orders: orders.length, lines: lines.length }));

    if (dryRun) {
      return json({ days, dry_run: true, order_count: orders.length, line_count: lines.length, lines });
    }

    // ── 3. 在庫へ反映（判断も冪等性もSQL側） ──
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/inv_sale_orders_apply`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_orders: lines, p_channel: "rakuten" }),
    });
    const out = await res.json().catch(() => null);
    if (!res.ok) {
      return json({ error: "在庫へ反映できませんでした：" + (out?.message || `HTTP ${res.status}`) }, 502);
    }
    return json({ days, order_count: orders.length, line_count: lines.length, ...out });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});

export { normalizeOrders };
