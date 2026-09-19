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
//   商品画像の流れ（8ECの表示時に楽天APIは呼ばない）:
//     inventory_channel_listings（channel='rakuten' の itemCode / 掲載URL）
//       → この関数が楽天APIから商品画像URLを取得
//       → inventory_products.images に保存（image_url は人が指定したメイン画像
//          専用なので同期では触らない）
//       → inv_public_catalog → 8ec.jp が商品マスターから読む
//     まとめ実行のモード（body.mode）:
//       'missing' … 写真がまだ1枚も無い掲載商品だけ（既定のまとめ実行）
//       'all'     … 楽天に掲載している商品すべて
//       どちらも自社shopCodeの商品一覧をページングして取得し（1req/秒）、
//       itemCode か掲載URLで商品マスターと突き合わせて1商品ずつ反映する。
//       商品1件ごとに楽天APIを呼ばないので、呼び出し回数は商品数ではなくページ数。
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

// 楽天の商品検索APIは hits 最大30・page 最大100（＝最大3000件）。
// レスポンスの pageCount（総ページ数）まで見にいき、安全のため100ページで頭打ちにする。
// 固定ページ数で打ち切ると、後ろのページにある商品が「見つからない」ことになる
// （P-00537 が5ページ＝150件の打ち切りで見つからなかった例）。
const RAKUTEN_MAX_PAGE = 100;

// Edge Functionの実行時間が尽きる前に区切るための目安（ミリ秒）。
// ここで止めたときは next_page を返し、続きから再開できるようにする。
const PAGE_TIME_BUDGET_MS = 90_000;

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
  startPage = 1,
): Promise<{
  ok: boolean; status: number; item: any | null; data: any; httpCalls: number;
  matchedBy: "url" | "itemCode" | null; totalCount: number | null; pageCount: number | null;
  scannedPages: number; nextPage: number | null;
}> {
  const targetNorm = normalizeUrlForMatch(targetUrl);
  let lastData: any = null;
  let lastStatus = 0;
  let httpCalls = 0;
  let pageCount: number | null = null;
  let totalCount: number | null = null;
  let scanned = 0;
  const startedAt = Date.now();

  for (let page = Math.max(1, startPage); page <= RAKUTEN_MAX_PAGE; page++) {
    if (page > Math.max(1, startPage)) await sleep(PAGE_INTERVAL_MS);

    const res = await fetchRakutenPage(applicationId, accessKey, shopCode, page, 30);
    httpCalls += res.httpCalls;
    lastData = res.data;
    lastStatus = res.status;
    scanned++;
    if (!res.ok) {
      console.log(JSON.stringify({
        search_mode: "shop_url_match", page, returned_count: 0,
        url_match_found: false, rakuten_http_status: res.status,
      }));
      return {
        ok: false, status: res.status, item: null, data: res.data, httpCalls,
        matchedBy: null, totalCount, pageCount, scannedPages: scanned, nextPage: null,
      };
    }

    // 楽天が返す総件数・総ページ数。これに従ってページングする（固定ページ数で打ち切らない）
    totalCount = Number.isFinite(Number(res.data?.count)) ? Number(res.data.count) : totalCount;
    pageCount = Number.isFinite(Number(res.data?.pageCount)) ? Number(res.data.pageCount) : pageCount;

    const items: any[] = Array.isArray(res.data?.Items) ? res.data.Items : [];
    // URLで一致（itemCodeはURLから推測しない。APIが返す正式な値だけを使う）
    let matchedBy: "url" | "itemCode" | null = null;
    const found = items.find((raw) => {
      const it = raw?.Item || raw;
      if (normalizeUrlForMatch(it.itemUrl || "") === targetNorm) { matchedBy = "url"; return true; }
      // 掲載URLの代わりに正式なitemCodeを渡された場合にも拾えるようにする
      if (it.itemCode && String(it.itemCode) === targetUrl.trim()) { matchedBy = "itemCode"; return true; }
      return false;
    }) || null;

    console.log(JSON.stringify({
      search_mode: "shop_url_match", page, returned_count: items.length,
      total_count: totalCount, page_count: pageCount, scanned_pages: scanned,
      matched_by: matchedBy, url_match_found: !!found, rakuten_http_status: res.status,
    }));

    if (found) {
      return {
        ok: true, status: res.status, item: found, data: res.data, httpCalls,
        matchedBy, totalCount, pageCount, scannedPages: scanned, nextPage: null,
      };
    }
    if (pageCount != null && page >= Math.min(pageCount, RAKUTEN_MAX_PAGE)) break;  // 最終ページまで見た
    if (items.length < 30) break;                                                   // これ以上は無い
    if (Date.now() - startedAt > PAGE_TIME_BUDGET_MS) {
      // 時間切れ。続きのページ番号を返して、呼び出し元から再開できるようにする
      console.log(JSON.stringify({ search_mode: "shop_url_match", time_budget_reached: true, next_page: page + 1 }));
      return {
        ok: true, status: lastStatus, item: null, data: lastData, httpCalls,
        matchedBy: null, totalCount, pageCount, scannedPages: scanned, nextPage: page + 1,
      };
    }
  }

  return {
    ok: true, status: lastStatus, item: null, data: lastData, httpCalls,
    matchedBy: null, totalCount, pageCount, scannedPages: scanned, nextPage: null,
  };
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

/**
 * 楽天の画像URLは末尾に縮小指定が付く（例 …/cabinet/img.jpg?_ex=128x128）。
 * この _ex を外すと、店舗がアップロードした元サイズの画像が返るので、
 * 商品詳細で大きく出しても粗くならない。_ex 以外のクエリは残す
 * （将来ほかのパラメータが増えても壊さないため）。
 */
function hiResImageUrl(raw: string): string {
  const u = String(raw || "").trim();
  if (!u) return u;
  const q = u.indexOf("?");
  if (q < 0) return u;
  const base = u.slice(0, q);
  const rest = u.slice(q + 1).split("&").filter((kv) => kv && !/^_ex=/i.test(kv));
  return rest.length ? base + "?" + rest.join("&") : base;
}

function normalizeItem(raw: any): Record<string, unknown> {
  const item = raw?.Item || raw;
  const name: string = item.itemName || "";
  const caption: string = item.itemCaption || "";
  // medium（無ければ small）のURLから縮小指定を外し、元サイズの画像として保存する。
  // 同じ画像がサイズ違いで重複しないよう、_ex を外したあとで重複を除く
  const rawUrls: string[] = [item.mediumImageUrls, item.smallImageUrls]
    .filter(Array.isArray)
    .flatMap((arr: any[]) => arr.map((x: any) => (typeof x === "string" ? x : x?.imageUrl)))
    .filter(Boolean);
  const images: string[] = [];
  for (const u of rawUrls) {
    const hi = hiResImageUrl(u);
    if (hi && images.indexOf(hi) < 0) images.push(hi);
  }
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

/**
 * まとめ同期（mode='missing' / 'all'）。
 *   1. inv_rakuten_sync_targets で対象商品（楽天に掲載していて、写真が無い／全部）を取る
 *   2. 自社shopCodeの商品一覧をページングして取得（1req/秒）。itemCodeと掲載URLで索引を作る
 *   3. 対象1件ずつ inv_rakuten_apply_one で商品マスターへ反映（画像は images に入る）
 * 商品ごとに楽天APIを呼ばないので、API呼び出し回数は「商品数」ではなく「ページ数」。
 */
async function syncTargets(
  cfg: { appId: string; accessKey: string; shopCode: string; supabaseUrl: string; anon: string; token: string },
  scope: "missing" | "all",
  startPage = 1,
  onlyCodes: string[] | null = null,
): Promise<Record<string, unknown>> {
  // ── 1. 対象商品 ──
  // 失敗したぶんだけやり直すときは、対象一覧（all）から商品コードで絞る。
  // 全件を取り直さないので、楽天APIの呼び出しも必要なぶんで済む。
  const pick = onlyCodes && onlyCodes.length ? new Set(onlyCodes.map(String)) : null;
  const tres = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/inv_rakuten_sync_targets`, {
    method: "POST",
    headers: { apikey: cfg.anon, Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_scope: pick ? "all" : scope }),
  });
  const targets = await tres.json();
  if (!tres.ok) {
    return { error: "同期する商品の一覧を取れませんでした：" + (targets?.message || JSON.stringify(targets)) };
  }
  let list: any[] = Array.isArray(targets) ? targets : [];
  if (pick) list = list.filter((t) => pick.has(String(t.code)));
  if (list.length === 0) {
    return {
      mode: scope, retry_of: pick ? onlyCodes : null,
      target_count: 0, fetched_count: 0, api_requests: 0,
      images_ok: 0, updated: 0, unchanged: 0, failed: 0, not_found: [], failures: [], details: [],
    };
  }

  // ── 2. 自社商品一覧をページングして索引を作る ──
  const wantCodes = new Set(list.map((t) => String(t.item_code || "")).filter(Boolean));
  const wantUrls = new Set(list.map((t) => (t.url ? normalizeUrlForMatch(String(t.url)) : "")).filter(Boolean));
  const byCode = new Map<string, any>();
  const byUrl = new Map<string, any>();
  let fetched = 0;
  let apiRequests = 0;
  let pagesRead = 0;

  let pageCount: number | null = null;
  let totalCount: number | null = null;
  let nextPage: number | null = null;
  const startedAt = Date.now();

  for (let page = Math.max(1, startPage); page <= RAKUTEN_MAX_PAGE; page++) {
    if (page > Math.max(1, startPage)) await sleep(PAGE_INTERVAL_MS);
    const rk = await fetchRakutenPage(cfg.appId, cfg.accessKey, cfg.shopCode, page, 30);
    apiRequests += rk.httpCalls;
    pagesRead++;
    if (!rk.ok) {
      return { error: "楽天APIの呼び出しに失敗しました（認証情報または仕様をご確認ください）。", status: rk.status, rakuten_response: rk.data };
    }
    // 楽天が返す総件数・総ページ数に従ってページングする（固定ページ数で打ち切らない）
    totalCount = Number.isFinite(Number(rk.data?.count)) ? Number(rk.data.count) : totalCount;
    pageCount = Number.isFinite(Number(rk.data?.pageCount)) ? Number(rk.data.pageCount) : pageCount;

    const items: any[] = Array.isArray(rk.data?.Items) ? rk.data.Items : [];
    fetched += items.length;
    for (const raw of items) {
      const it = raw?.Item || raw;
      if (it?.itemCode) byCode.set(String(it.itemCode), raw);
      if (it?.itemUrl) byUrl.set(normalizeUrlForMatch(String(it.itemUrl)), raw);
    }
    // 欲しいものが全部そろったら、残りのページは読まない
    const gotAll = list.every((t) =>
      (t.item_code && byCode.has(String(t.item_code))) ||
      (t.url && byUrl.has(normalizeUrlForMatch(String(t.url)))));
    console.log(JSON.stringify({
      sync_scope: scope, page, returned_count: items.length,
      total_count: totalCount, page_count: pageCount, scanned_pages: pagesRead,
      matched_so_far: list.filter((t) =>
        (t.item_code && byCode.has(String(t.item_code))) ||
        (t.url && byUrl.has(normalizeUrlForMatch(String(t.url))))).length,
    }));
    if (gotAll) break;
    if (pageCount != null && page >= Math.min(pageCount, RAKUTEN_MAX_PAGE)) break;
    if (items.length < 30) break;
    if (Date.now() - startedAt > PAGE_TIME_BUDGET_MS) { nextPage = page + 1; break; }
  }
  console.log(JSON.stringify({
    sync_scope: scope, targets: list.length, total_count: totalCount, page_count: pageCount,
    scanned_pages: pagesRead, fetched, api_requests: apiRequests, next_page: nextPage,
  }));

  // ── 3. 1商品ずつ商品マスターへ反映 ──
  let imagesOk = 0, updated = 0, unchanged = 0, urlMismatches = 0;
  const notFound: any[] = [];
  const details: any[] = [];
  // 写真が入らなかったものは、理由を分けて記録する（全部やり直さずに済むように）
  //   not_found_by_item_code … external_item_code はあるが楽天側に無い
  //   not_found_by_url       … URLでしか探せず、そのURLが楽天側に無い（listing URL不一致）
  //   no_key                 … itemCodeもURLも無く、照合の手がかりが無い
  //   no_images_in_api       … 楽天では見つかったが、APIレスポンスに画像が無い
  //   api_error              … 反映RPC・APIがエラーを返した
  //   not_searched           … 時間切れで全ページを見きれていない
  const failures: any[] = [];
  const fail = (t: any, reason: string, detail?: string) => {
    failures.push({
      code: t.code, name: t.name || null, reason,
      detail: detail || null,
      item_code: t.item_code || null, url: t.url || null,
    });
  };

  for (const t of list) {
    const byCodeHit = t.item_code ? byCode.get(String(t.item_code)) : null;
    const byUrlHit = !byCodeHit && t.url ? byUrl.get(normalizeUrlForMatch(String(t.url))) : null;
    const raw = byCodeHit || byUrlHit || null;
    const matchedBy: "itemCode" | "url" | null = byCodeHit ? "itemCode" : (byUrlHit ? "url" : null);
    if (!raw) {
      // 全ページ見たうえで見つからなければ「楽天API検索対象外」。
      // 途中で時間切れしたときは searched_all=false にして、続きから再開できることを示す
      notFound.push({
        code: t.code, name: t.name, item_code: t.item_code || null, url: t.url || null,
        searched_all: nextPage == null,
      });
      if (nextPage != null) fail(t, "not_searched", `${pagesRead}/${pageCount ?? "—"}ページまで確認`);
      else if (t.item_code) fail(t, "not_found_by_item_code", String(t.item_code));
      else if (t.url) fail(t, "not_found_by_url", String(t.url));
      else fail(t, "no_key");
      continue;
    }
    const norm = normalizeItem(raw);
    const res = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/inv_rakuten_apply_one`, {
      method: "POST",
      headers: { apikey: cfg.anon, Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_code: t.code, p_item: norm }),
    });
    const out = await res.json().catch(() => null);
    if (!res.ok) {
      details.push({ code: t.code, name: t.name, ok: false, reason: out?.message || `HTTP ${res.status}` });
      fail(t, "api_error", out?.message || `HTTP ${res.status}`);
      continue;
    }
    const imagesAdded = !!out?.images_added;
    if (imagesAdded) imagesOk++;
    if (out?.changed) updated++; else unchanged++;
    // 楽天では見つかったのに写真が入らなかった＝APIレスポンスに画像が無い。
    // もともと写真がある商品（all指定の見直し）は、入らなくても失敗ではない
    if (!imagesAdded && !Number(t.image_count) && !t.has_main_image) {
      fail(t, "no_images_in_api", norm.item_code ? String(norm.item_code) : null);
    }
    // URLで見つけた商品は、APIが返した正式なitemCodeが external_item_code に保存される
    // （inv_rakuten_apply_one が空のときだけ埋める）。次回からはitemCodeで直接照合できる
    const savedCode = !!out?.external_item_code_saved;
    // 保存済みURLが楽天の正式URLと違っていたら、更新候補として記録されている
    const urlMismatch = !!out?.url_mismatch;
    if (urlMismatch) urlMismatches++;
    console.log(JSON.stringify({
      applied: t.code, matched_by: matchedBy, item_code: norm.item_code,
      images_added: imagesAdded, image_count: out?.image_count ?? 0,
      external_item_code_saved: savedCode ? norm.item_code : null,
      url_mismatch: urlMismatch,
      url_saved: urlMismatch ? out?.url_saved ?? null : null,
      url_candidate: urlMismatch ? out?.url_candidate ?? null : null,
    }));
    details.push({
      code: t.code, name: t.name, ok: true, images_added: imagesAdded,
      image_count: out?.image_count ?? 0, changed: !!out?.changed, item_code: norm.item_code,
      matched_by: matchedBy, external_item_code_saved: savedCode,
      url_mismatch: urlMismatch,
      url_saved: out?.url_saved ?? null,
      url_candidate: out?.url_candidate ?? null,
    });
  }

  return {
    mode: scope,
    target_count: list.length,
    fetched_count: fetched,
    total_count: totalCount,
    page_count: pageCount,
    scanned_pages: pagesRead,
    pages_read: pagesRead,
    next_page: nextPage,          // 時間切れで途中まで見た場合、続きのページ番号
    api_requests: apiRequests,
    images_ok: imagesOk,
    updated,
    unchanged,
    url_mismatches: urlMismatches,   // 掲載URLが楽天側と違っていた商品の数
    failed: failures.length,
    failures,                        // 商品ごとの理由（reason で分類）
    not_found: notFound,
    details,
    retry_of: pick ? onlyCodes : null,
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
    // 商品コードを渡された場合、その商品の不足情報だけを埋める（照合はしない）
    const targetCode: string | null = body?.code ? String(body.code).trim() : null;
    const mode: string = String(body?.mode || "").trim();

    // ── まとめ同期（画像が無い商品だけ／楽天掲載の全商品） ──
    if (mode === "missing" || mode === "all") {
      const startPage = Math.max(1, Math.min(Number(body?.start_page) || 1, RAKUTEN_MAX_PAGE));
      // codes を渡されたら、その商品だけをやり直す（失敗分の再試行）
      const onlyCodes: string[] | null = Array.isArray(body?.codes)
        ? body.codes.map((c: unknown) => String(c).trim()).filter(Boolean).slice(0, 500)
        : null;
      const out = await syncTargets({
        appId: APP_ID, accessKey: ACCESS_KEY, shopCode: SHOP_CODE,
        supabaseUrl: SUPABASE_URL, anon: SUPABASE_ANON, token,
      }, mode, startPage, onlyCodes);
      return json(out, (out as any)?.error ? 502 : 200);
    }

    // ── 3. 楽天APIを呼ぶ（自社shopCodeだけを対象） ──────────────
    let items: any[];
    let rkData: any;
    let rkAuthMode = "query:accessKey";
    let totalApiRequests = 0;
    let urlSearch: Record<string, unknown> = {};

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
      const startPage = Math.max(1, Math.min(Number(body?.start_page) || 1, RAKUTEN_MAX_PAGE));
      const found = await findRakutenItemByUrl(APP_ID, ACCESS_KEY, SHOP_CODE, targetUrl, startPage);
      rkData = found.data;
      totalApiRequests = found.httpCalls;
      urlSearch = {
        total_count: found.totalCount, page_count: found.pageCount,
        scanned_pages: found.scannedPages, matched_by: found.matchedBy, next_page: found.nextPage,
      };
      console.log(JSON.stringify({ total_api_requests: totalApiRequests, ...urlSearch }));
      if (!found.ok) {
        return json({
          error: "楽天APIの呼び出しに失敗しました（認証情報または仕様をご確認ください）。",
          status: found.status,
          rakuten_response: found.data,
        }, 502);
      }
      if (!found.item) {
        // 途中で時間切れした場合は「見つからなかった」ではなく「続きから再開」を案内する。
        // 全ページ（最大100ページ）見たうえで無ければ、そのとき初めて楽天API検索対象外
        return json({
          error: found.nextPage
            ? `${found.scannedPages}ページまで確認しましたが、まだ見つかっていません（全${found.pageCount ?? '—'}ページ）。「続きから探す」でこのまま続けてください。`
            : `指定したURL（${targetUrl}）に一致する商品が、自社店舗（${SHOP_CODE}）の全${found.pageCount ?? '—'}ページ（${found.totalCount ?? '—'}件）に見つかりませんでした（楽天API検索対象外）。掲載URLと、いま出品中かをご確認ください。`,
          ...urlSearch,
          rakuten_response: found.nextPage ? undefined : found.data,
        }, found.nextPage ? 200 : 404);
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

    // 商品コードを指定された1件モードは、照合を挟まずその商品へ直接反映する
    // （どの商品の写真を取りにきたかが最初から決まっているため）
    if (targetCode && normalized.length === 1) {
      const one = await fetch(`${SUPABASE_URL}/rest/v1/rpc/inv_rakuten_apply_one`, {
        method: "POST",
        headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ p_code: targetCode, p_item: normalized[0] }),
      });
      const oneOut = await one.json().catch(() => null);
      if (!one.ok) {
        return json({ error: "商品マスターへの反映に失敗しました：" + (oneOut?.message || JSON.stringify(oneOut)) }, 502);
      }
      return json({
        mode: "one",
        ...urlSearch,
        target_count: 1,
        fetched_count: 1,
        images_ok: oneOut?.images_added ? 1 : 0,
        updated: oneOut?.changed ? 1 : 0,
        unchanged: oneOut?.changed ? 0 : 1,
        failed: 0,
        not_found: [],
        details: [{
          code: targetCode, name: normalized[0].name, ok: true,
          images_added: !!oneOut?.images_added, image_count: oneOut?.image_count ?? 0,
          changed: !!oneOut?.changed, item_code: normalized[0].item_code,
          matched_by: (urlSearch.matched_by as string) || (targetItemCode ? "itemCode" : null),
          external_item_code_saved: !!oneOut?.external_item_code_saved,
          url_mismatch: !!oneOut?.url_mismatch,
          url_saved: oneOut?.url_saved ?? null,
          url_candidate: oneOut?.url_candidate ?? null,
        }],
        url_mismatches: oneOut?.url_mismatch ? 1 : 0,
      });
    }

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
        image_sample: ((n.images || []) as string[])[0] || null,
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
