// ============================================================
// /zaiko 「楽天商品を同期」: Rakuten Developers API 呼び出し Edge Function
//
//   デプロイ:
//     supabase functions deploy rakuten-product-sync
//   （/zaiko のスタッフだけが叩く関数なので --no-verify-jwt は付けません）
//
//   Secrets（Supabase ダッシュボード → Edge Functions → rakuten-product-sync → Secrets）:
//     RAKUTEN_APPLICATION_ID … Rakuten Developers の Application ID
//     RAKUTEN_ACCESS_KEY     … Rakuten Developers の Access Key
//     RAKUTEN_SHOP_CODE      … 自社楽天店舗の shopCode（例: https://www.rakuten.co.jp/{shopCode}/
//                               や既存の商品URL https://item.rakuten.co.jp/{shopCode}/{itemCode}/
//                               のパスにある文字列。自社の商品ページから確認できます）
//   ※ SUPABASE_URL / SUPABASE_ANON_KEY は Supabase が自動で注入します。
//   ※ Access Key はこの関数（サーバー側）でしか読みません。ブラウザ側のJSやHTML、
//     このリポジトリのどこにも直接書きません。
//
//   処理の流れ:
//     1. 呼び出し元が /zaiko の編集権限を持つか（inventory_members）をJWTで確認
//     2. Rakuten Developers の商品検索APIを、自社 shopCode を指定して呼ぶ
//        （他店舗の商品は取得しない）。1件だけ指定するときの探し方は2通り：
//          - item_code（正式なitemCode。2回目以降・紐付け済みの商品向け）→
//            itemCodeで直接検索
//          - item_url（掲載URL。初回・itemCodeがまだ分からない商品向け）→
//            itemCodeをURLから推測することはせず、shopCode一覧をhits=30で
//            ページングしながらAPIが返すitemUrlと正規化して比較し、一致した
//            1件の「APIレスポンスに入っている正式なitemCode」をそのまま使う
//     3. 商品名・商品説明からスペック（CPU/メモリ/ストレージ/OS等）を抽出
//     4. 正規化したデータを inv_rakuten_sync_apply（SQL関数）へ渡し、
//        既存の inventory_products と照合・不足情報の補完を行わせる
//        （実在庫 inventory_items はここでは一切作らない）
//     5. 新規○件・更新○件・変更なし○件・要確認○件・エラー○件を返す
//
//   【重要・現状の制約】
//     ここで呼んでいるのは「Rakuten Developers 商品検索API」で、商品情報の
//     取得だけができます。受注・キャンセル・発送状態の取得や、楽天側の
//     在庫数量の更新には、別途 RMS WEB SERVICE の利用申請が必要です
//     （このEdge Functionはそちらにはまだ対応していません）。
//
//   【エンドポイント・認証方式について】
//     公式のAPI Test Formで実際に疎通確認済みの形に合わせている：
//       - エンドポイント: 下記 RAKUTEN_ENDPOINT（20260701版）
//       - accessKeyはクエリパラメータで渡す（ヘッダ等のフォールバックは無し）
//       - Referer/Originに RAKUTEN_REFERER / RAKUTEN_ORIGIN を付ける。
//         楽天Developers側の「許可Webサイト」に 8ec.jp / www.8ec.jp を登録
//         していないと 403 REQUEST_CONTEXT_BODY_HTTP_REFERRER_MISSING になる
//         （2026-09-18確認）。
//     それでも失敗する場合は、まずログの rakuten_secrets_check /
//     rakuten_request_param_keys / referer_sent 等で「値ではなくキー名・長さ・
//     送信有無」だけを確認し、Secretsの設定漏れ・コピペ時の余分な空白・
//     許可Webサイト未登録などから切り分けてください
//     （秘密の値そのものはログに一切出さない）。
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

// 楽天市場商品検索API。公式API Test Formで実際に疎通確認済みのエンドポイント（2026-09-18確認）。
const RAKUTEN_ENDPOINT = "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701";

// 楽天Developersの「許可Webサイト」に登録したドメイン。無いと商品検索APIが
// 403 REQUEST_CONTEXT_BODY_HTTP_REFERRER_MISSING を返す（2026-09-18確認）。
const RAKUTEN_REFERER = "https://www.8ec.jp/";
const RAKUTEN_ORIGIN = "https://www.8ec.jp";

// 自社商品は150件前後（hits=30で5ページ程度）なので、余裕を持たせつつ
// 無限ループにはしない上限（URL一致検索でページングする最大ページ数）。
const MAX_URL_SEARCH_PAGES = 10;

// このRakuten Developersアプリの予想QPS登録が「1リクエスト/秒」のため、
// ページング時は次のリクエストまで必ずこれだけ空ける（1秒に余裕を持たせて1.2秒）。
const PAGE_INTERVAL_MS = 1200;

// 429（レート制限）時の既定バックオフ。Retry-Afterヘッダーがあればそちらを優先する。
const RATE_LIMIT_BACKOFF_MS = [1200, 2000, 4000];
const MAX_RATE_LIMIT_RETRIES = RATE_LIMIT_BACKOFF_MS.length;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * URL比較用に正規化する。http/https・末尾スラッシュ・クエリ文字列の差を
 * 無視する（手入力URLとAPIが返すitemUrlの表記ゆれを吸収する。SQL側
 * ―inv_rakuten_sync_apply―の照合と同じ規則）。
 */
function normalizeUrlForMatch(url: string): string {
  return String(url || "").split("?")[0].replace(/\/+$/, "").replace(/^https?:\/\//i, "");
}

/**
 * 楽天公式のAPI Test Formと同じ形（accessKeyもクエリパラメータで渡す）で呼ぶ。
 * ヘッダ等のフォールバックは持たない（公式仕様にない方式のため）。
 * 秘密の値そのものはログに出さず、送るクエリのキー名一覧だけをログに出す。
 *
 * itemCode を渡すと、その1件だけに絞った接続テストになる（shopCodeも
 * 一緒に渡すので、自社店舗の商品であることの確認も兼ねる）。
 *
 * 429（レート制限）が返った場合は、Retry-Afterヘッダー（あれば優先）または
 * 既定のバックオフ（1.2秒→2秒→4秒）で最大 MAX_RATE_LIMIT_RETRIES 回まで
 * 自動で再試行する。戻り値の httpCalls は、この1ページ分で実際に行った
 * HTTPリクエスト数（再試行を含む）。
 */
async function fetchRakutenPage(
  applicationId: string,
  accessKey: string,
  shopCode: string,
  page: number,
  hits: number,
  itemCode?: string | null,
): Promise<{ ok: boolean; status: number; authMode: string; data: any; httpCalls: number }> {
  const params = new URLSearchParams({
    format: "json",
    applicationId,
    accessKey,
    shopCode,
    page: String(page),
    hits: String(Math.min(hits, 30)),
    availability: "0", // 在庫の有無に関わらず自社の全商品を対象にする
  });
  if (itemCode) params.set("itemCode", itemCode);

  // 値は一切出さず、キー名だけ（applicationId/accessKeyの綴り間違いが無いかの確認用）
  console.log(JSON.stringify({ rakuten_request_param_keys: Array.from(params.keys()) }));

  let res: Response;
  let data: any;
  let attempt = 0;
  for (;;) {
    attempt++;
    // 楽天Developers側の「許可Webサイト」チェック対策。Referer/Originが無いと
    // 403 REQUEST_CONTEXT_BODY_HTTP_REFERRER_MISSING になる
    res = await fetch(`${RAKUTEN_ENDPOINT}?${params.toString()}`, {
      headers: { Referer: RAKUTEN_REFERER, Origin: RAKUTEN_ORIGIN },
    });
    data = await res.json().catch(() => null);

    if (res.status === 429 && attempt <= MAX_RATE_LIMIT_RETRIES) {
      const retryAfterSec = Number(res.headers.get("Retry-After"));
      const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? retryAfterSec * 1000
        : RATE_LIMIT_BACKOFF_MS[attempt - 1];
      console.log(JSON.stringify({ page, attempt, rakuten_http_status: res.status, rate_limit_retry_ms: waitMs }));
      await sleep(waitMs);
      continue;
    }
    break;
  }

  console.log(JSON.stringify({
    referer_sent: true,
    referer_host: new URL(RAKUTEN_REFERER).host,
    page, attempt, rakuten_http_status: res.status,
  }));
  const ok = res.ok && !!data && !data.error;
  return { ok, status: res.status, authMode: "query:accessKey", data, httpCalls: attempt };
}

/**
 * 楽天URLを指定した初回同期用。itemCodeをURLから推測することはせず、
 * shopCode一覧をhits=30でページングしながら、APIが返すitemUrlと正規化して
 * 比較する。一致した1件をそのまま返す（その商品のitemCodeは、推測ではなく
 * APIレスポンスに入っている正式な値）。URLが見つかった時点で即ループを
 * 終了し、それ以上のページは取得しない（無駄なAPI呼び出しをしない）。
 *
 * 予想QPS「1リクエスト/秒」の登録に合わせ、次のページへ進む前に必ず
 * PAGE_INTERVAL_MSだけ空ける。429の再試行はfetchRakutenPage側が行う。
 */
async function findRakutenItemByUrl(
  applicationId: string,
  accessKey: string,
  shopCode: string,
  targetUrl: string,
): Promise<{ ok: boolean; status: number; item: any | null; data: any; httpCalls: number }> {
  const targetNorm = normalizeUrlForMatch(targetUrl);
  let lastData: any = null;
  let lastStatus = 0;
  let httpCalls = 0;

  for (let page = 1; page <= MAX_URL_SEARCH_PAGES; page++) {
    if (page > 1) await sleep(PAGE_INTERVAL_MS);

    const res = await fetchRakutenPage(applicationId, accessKey, shopCode, page, 30);
    httpCalls += res.httpCalls;
    lastData = res.data;
    lastStatus = res.status;
    if (!res.ok) {
      console.log(JSON.stringify({
        search_mode: "shop_url_match", page, returned_count: 0,
        url_match_found: false, rakuten_http_status: res.status,
      }));
      return { ok: false, status: res.status, item: null, data: res.data, httpCalls };
    }

    const items: any[] = Array.isArray(res.data?.Items) ? res.data.Items : [];
    const found = items.find((raw) => {
      const it = raw?.Item || raw;
      return normalizeUrlForMatch(it.itemUrl || "") === targetNorm;
    }) || null;

    console.log(JSON.stringify({
      search_mode: "shop_url_match", page, returned_count: items.length,
      url_match_found: !!found, rakuten_http_status: res.status,
    }));

    if (found) return { ok: true, status: res.status, item: found, data: res.data, httpCalls };
    if (items.length < 30) break; // 最終ページまで見た（これ以上は無い）
  }

  return { ok: true, status: lastStatus, item: null, data: lastData, httpCalls };
}

// ---- スペック抽出（商品名・商品説明から）。Node.jsで動作確認したロジックをそのまま使う ----
function hasFeature(text: string, positive: RegExp, negativeNear?: RegExp): boolean | null {
  if (!text) return null;
  const m = positive.exec(text);
  if (!m) return null;
  if (negativeNear) {
    const after = text.slice(m.index, m.index + m[0].length + 6);
    if (negativeNear.test(after)) return false;
  }
  return true;
}
const NEG = /(なし|無し|非搭載|未搭載|無い)/;

function extractSpec(name: string, caption: string): Record<string, unknown> {
  const text = [name || "", caption || ""].join("\n");
  const out: Record<string, unknown> = {};

  let m: RegExpExecArray | null;
  m = /Core\s*i([3579])[\s-]*(\d{4,5}[A-Z]{0,2})?/i.exec(text);
  if (m) {
    out.cpu = "Core i" + m[1] + (m[2] ? "-" + m[2].toUpperCase() : "");
    if (m[2]) {
      const digits = m[2].replace(/[A-Z]/gi, "");
      const gen = digits.length >= 4 ? parseInt(digits.slice(0, digits.length === 5 ? 2 : 1), 10) : null;
      if (gen && gen >= 1 && gen <= 16) out.cpu_gen = `第${gen}世代`;
    }
  } else if ((m = /Core\s*Ultra\s*([579])(?:\D*(\d{3}[A-Z]?))?/i.exec(text))) {
    out.cpu = "Core Ultra " + m[1] + (m[2] ? " " + m[2].toUpperCase() : "");
  } else if ((m = /Ryzen\s*([3579])\s*(\d{4}[A-Z]{0,2})?/i.exec(text))) {
    out.cpu = "Ryzen " + m[1] + (m[2] ? " " + m[2].toUpperCase() : "");
  } else if (/Celeron/i.test(text)) {
    out.cpu = "Celeron";
  } else if (/Pentium/i.test(text)) {
    out.cpu = "Pentium";
  } else if ((m = /Apple\s*(M[1-4]\s*(Pro|Max|Ultra)?)/i.exec(text))) {
    out.cpu = "Apple " + m[1].replace(/\s+/g, " ").trim();
  }
  if (!out.cpu_gen) {
    m = /第\s*(\d{1,2})\s*世代/.exec(text);
    if (m) out.cpu_gen = `第${m[1]}世代`;
  }

  m = /(\d{1,3})\s*GB\s*(?:の)?メモリ/i.exec(text) || /(?:メモリ|RAM)\s*[:：]?\s*(\d{1,3})\s*GB/i.exec(text);
  if (m) out.memory = m[1] + "GB";

  m = /SSD\s*[:：]?\s*(\d{1,4})\s*(GB|TB)/i.exec(text) || /(\d{1,4})\s*(GB|TB)\s*(?:の)?SSD/i.exec(text);
  if (m) {
    out.storage_type = "SSD";
    out.storage_capacity = m[1] + m[2].toUpperCase();
  } else if (
    (m = /HDD\s*[:：]?\s*(\d{1,4})\s*(GB|TB)/i.exec(text)) ||
    (m = /(\d{1,4})\s*(GB|TB)\s*(?:の)?HDD/i.exec(text))
  ) {
    out.storage_type = "HDD";
    out.storage_capacity = m[1] + m[2].toUpperCase();
  }

  m = /(\d{1,2}\.\d)\s*(?:型|インチ|inch)/i.exec(text);
  if (m) out.screen_size = m[1] + "型";

  m = /Windows\s*(11|10|8\.1|7)\s*(Pro|Home|Enterprise)?/i.exec(text);
  if (m) out.os = "Windows " + m[1] + (m[2] ? " " + m[2] : "");
  else if (/Mac\s*OS|macOS/i.exec(text)) out.os = "macOS";
  else if (/Chrome\s*OS/i.exec(text)) out.os = "Chrome OS";

  const office = hasFeature(text, /Office|オフィス|Word.{0,3}Excel|Microsoft\s*365/i, NEG);
  if (office != null) out.office_supported = office;
  const cam = hasFeature(text, /Web\s*カメラ|カメラ内蔵|カメラ付き|内蔵カメラ/i, NEG);
  if (cam != null) out.webcam = cam;
  const wifi = hasFeature(text, /Wi-?Fi|無線LAN/i, NEG);
  if (wifi != null) out.wifi = wifi;
  const bt = hasFeature(text, /Bluetooth|ブルートゥース/i, NEG);
  if (bt != null) out.bluetooth = bt;
  const numpad = hasFeature(text, /テンキー/i, NEG);
  if (numpad != null) out.numpad = numpad;

  m = /付属品\s*[:：]\s*([^\n。]{2,60})/.exec(text);
  if (m) out.accessories = m[1].trim();

  return out;
}

/** 「型番：XXXX」のように明示されている場合だけ型番として扱う。
 *  自由記述からの当てずっぽうの型番抽出は誤マッチの元になるためやらない
 *  （型番が取れない商品は、既存のinventory_channels紐付け／新規登録にまわる）。 */
function extractExplicitModel(name: string, caption: string): string | null {
  const text = [name || "", caption || ""].join("\n");
  const m = /(?:型番|品番|モデル)\s*[:：]\s*([A-Za-z0-9][A-Za-z0-9\-\/]{1,30})/.exec(text);
  return m ? m[1].trim() : null;
}

function normalizeItem(raw: any): Record<string, unknown> {
  const item = raw?.Item || raw;
  const name: string = item.itemName || "";
  const caption: string = item.itemCaption || "";
  const images: string[] = Array.isArray(item.mediumImageUrls)
    ? item.mediumImageUrls.map((x: any) => (typeof x === "string" ? x : x?.imageUrl)).filter(Boolean)
    : [];
  return {
    item_code: item.itemCode || null,
    item_url: item.itemUrl || null,
    shop_code: item.shopCode || null,
    name,
    caption,
    price: item.itemPrice ?? null,
    image_url: images[0] || null,
    images,
    maker: null, // 楽天の商品検索APIには「メーカー」専用フィールドが無いため、基本は照合結果か人の入力に任せる
    model: extractExplicitModel(name, caption),
    genre_id: item.genreId || null,
    extracted: extractSpec(name, caption),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const APP_ID_RAW = Deno.env.get("RAKUTEN_APPLICATION_ID");
    const ACCESS_KEY_RAW = Deno.env.get("RAKUTEN_ACCESS_KEY");
    const SHOP_CODE_RAW = Deno.env.get("RAKUTEN_SHOP_CODE");
    // 秘密の値そのものはログに出さない。存在確認と長さ（trim前後）だけを出す。
    // 「公式Test Formでは通るのにここで失敗する」場合、Secrets未設定やコピペ時の
    // 余分な空白・改行が無いかをここで切り分けられる。
    console.log(JSON.stringify({
      rakuten_secrets_check: {
        applicationId_exists: APP_ID_RAW != null,
        applicationId_length: APP_ID_RAW ? APP_ID_RAW.length : 0,
        applicationId_trimmed_length: APP_ID_RAW ? APP_ID_RAW.trim().length : 0,
        accessKey_exists: ACCESS_KEY_RAW != null,
        accessKey_length: ACCESS_KEY_RAW ? ACCESS_KEY_RAW.length : 0,
        shopCode: SHOP_CODE_RAW ? SHOP_CODE_RAW.trim() : null,
      },
    }));
    const APP_ID = APP_ID_RAW?.trim();
    const ACCESS_KEY = ACCESS_KEY_RAW?.trim();
    const SHOP_CODE = SHOP_CODE_RAW?.trim();
    if (!APP_ID || !ACCESS_KEY || !SHOP_CODE) {
      return json({
        error: "RAKUTEN_APPLICATION_ID / RAKUTEN_ACCESS_KEY / RAKUTEN_SHOP_CODE が未設定です。" +
          "Supabase の Edge Functions → rakuten-product-sync → Secrets に設定してください。",
      }, 500);
    }
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

    // ── 1. /zaiko の編集権限があるかを確認 ──────────────────────
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "ログインが必要です。" }, 401);

    const ures = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
    });
    const user = await ures.json();
    if (!ures.ok || !user?.email) return json({ error: "ログイン情報を確認できませんでした。" }, 401);

    const mres = await fetch(
      `${SUPABASE_URL}/rest/v1/inventory_members?email=eq.${encodeURIComponent(user.email)}&select=role`,
      { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` } },
    );
    const members = await mres.json();
    const role = Array.isArray(members) && members[0] ? members[0].role : null;
    if (!role || !["admin", "member"].includes(role)) {
      return json({ error: "この操作の権限がありません。" }, 403);
    }

    // ── 2. リクエスト内容 ──────────────────────────────────────
    // item_code（正式なitemCode）を渡すと、その1件だけを直接検索する
    // （紐付け済み＝2回目以降向け）。item_url を渡すと、itemCodeをURLから
    // 推測せず、shopCode一覧をページングしながらitemUrlが一致する1件を探す
    // （初回・itemCodeがまだ分からない商品向け）。どちらも無ければ、
    // これまで通り自社shopCodeの一覧をhits件数ぶん取得する。
    const body = await req.json().catch(() => ({}));
    const limit = Math.max(1, Math.min(Number(body?.limit) || 30, 30));
    const page = Math.max(1, Number(body?.page) || 1);
    const targetItemCode: string | null = body?.item_code ? String(body.item_code).trim() : null;
    const targetUrl: string | null = !targetItemCode && body?.item_url ? String(body.item_url).trim() : null;

    // ── 3. 楽天APIを呼ぶ（自社shopCodeだけを対象） ──────────────
    let items: any[];
    let rkData: any;
    let rkAuthMode = "query:accessKey";
    let totalApiRequests = 0;

    if (targetItemCode) {
      console.log(JSON.stringify({ search_mode: "itemCode" }));
      const rk = await fetchRakutenPage(APP_ID, ACCESS_KEY, SHOP_CODE, page, limit, targetItemCode);
      rkData = rk.data;
      rkAuthMode = rk.authMode;
      totalApiRequests = rk.httpCalls;
      console.log(JSON.stringify({ total_api_requests: totalApiRequests }));
      if (!rk.ok) {
        return json({
          error: "楽天APIの呼び出しに失敗しました（認証情報または仕様をご確認ください）。",
          status: rk.status,
          rakuten_response: rk.data,
        }, 502);
      }
      items = Array.isArray(rk.data?.Items) ? rk.data.Items.slice(0, limit) : [];
      if (items.length === 0) {
        return json({
          error: `指定した商品（${targetItemCode}）が見つかりませんでした。自社店舗（${SHOP_CODE}）の商品かご確認ください。`,
          rakuten_response: rk.data,
        }, 404);
      }
    } else if (targetUrl) {
      const found = await findRakutenItemByUrl(APP_ID, ACCESS_KEY, SHOP_CODE, targetUrl);
      rkData = found.data;
      totalApiRequests = found.httpCalls;
      console.log(JSON.stringify({ total_api_requests: totalApiRequests }));
      if (!found.ok) {
        return json({
          error: "楽天APIの呼び出しに失敗しました（認証情報または仕様をご確認ください）。",
          status: found.status,
          rakuten_response: found.data,
        }, 502);
      }
      if (!found.item) {
        return json({
          error: `指定したURL（${targetUrl}）に一致する商品が見つかりませんでした。自社店舗（${SHOP_CODE}）の商品か、URLをご確認ください。`,
          rakuten_response: found.data,
        }, 404);
      }
      items = [found.item];
    } else {
      const rk = await fetchRakutenPage(APP_ID, ACCESS_KEY, SHOP_CODE, page, limit);
      rkData = rk.data;
      rkAuthMode = rk.authMode;
      totalApiRequests = rk.httpCalls;
      console.log(JSON.stringify({ total_api_requests: totalApiRequests }));
      if (!rk.ok) {
        return json({
          error: "楽天APIの呼び出しに失敗しました（認証情報または仕様をご確認ください）。",
          status: rk.status,
          rakuten_response: rk.data,
        }, 502);
      }
      items = Array.isArray(rk.data?.Items) ? rk.data.Items.slice(0, limit) : [];
    }
    const normalized = items.map(normalizeItem);

    // ── 4. 正規化した商品データを、既存の商品マスターと照合・補完するSQL関数へ渡す ──
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/inv_rakuten_sync_apply`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_items: normalized }),
    });
    const rpcData = await rpcRes.json();
    if (!rpcRes.ok) {
      return json({ error: "商品マスターへの反映に失敗しました：" + (rpcData?.message || JSON.stringify(rpcData)) }, 502);
    }

    return json({
      auth_mode: rkAuthMode,
      fetched_count: items.length,
      total_available: rkData?.count ?? null,
      // 実機確認用：各商品でどの項目が取れた／取れなかったかを見えるようにする。
      // genreId/attributeIds等、まだ加工していない項目はraw（APIの生データ）で確認する
      // （フィールド名を推測で決め打ちしない。itemCodeの推測をやめたのと同じ理由）
      fetched_fields_sample: normalized.slice(0, 5).map((n: any, i: number) => ({
        item_code: n.item_code,
        name: n.name,
        has_caption: !!n.caption,
        has_image: !!n.image_url,
        image_count: (n.images || []).length,
        model_explicit: n.model,
        extracted: n.extracted,
        raw: items[i]?.Item || items[i],
      })),
      ...rpcData,
    });
  } catch (e) {
    return json({ error: String(e && (e as Error).message ? (e as Error).message : e) }, 500);
  }
});
