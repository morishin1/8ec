-- ============================================================
-- 販売サイトの手数料を「1つの率」から「内訳・プラン」で持てるようにする
--   ＋ 契約が確定した料率を入れる
--   ＋ 配送サイズ（佐川急便の規格）を商品ごとに持てるようにする
--
--   何度流しても同じ結果になる（add column if not exists / coalesce で埋める /
--   create or replace）。
--
--   このmigrationですること
--     1) inventory_channel_settings に pricing_rules（jsonb・NULL可）を足す
--     2) inventory_products に shipping_size（配送サイズ・NULL可）を足す
--     3) 確定した料率を入れる（**空いている項目だけ**。入っている値は上書きしない）
--     4) 保存用の関数を2つ作る
--
--   このmigrationがしないこと
--     ・Phase 1 の5列（fee_rate / fixed_cost / shipping_cost /
--       target_profit_rate / minimum_profit_yen）の**定義は変えない**
--     ・inv_channel_settings_set() / inv_channel_pricing_settings_set() は触らない
--     ・**送料の金額は入れない**。佐川急便の運賃は契約・地域・サイズ・重量で
--       変わるので、推測で入れず未設定のままにする
--     ・inventory_items / inventory_channel_listings / 在庫の状態は変更しない
--     ・plan_price（原価×1.3）は変えない
--
--   計算そのものは画面側（zaiko/app.js）で行う。ここでは**入れられる値かどうかを
--   確かめる**だけにして、計算のきまりを2か所に分けない。
--
--   前提：zaiko/migrations/2026-10-05-channel-pricing.sql
-- ============================================================

begin;

do $$
begin
  if to_regclass('public.inventory_channel_settings') is null then
    raise exception 'inventory_channel_settings がありません。先に 2026-09-19-sale-flow.sql を流してください';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'inventory_channel_settings'
                    and column_name = 'fee_rate') then
    raise exception 'fee_rate 列がありません。先に 2026-10-05-channel-pricing.sql を流してください';
  end if;
end $$;

-- ------------------------------------------------------------
-- 59-1) 手数料の内訳・プランを持つ列
--
--     入れかた（すべて任意。無ければ fee_rate 列がそのまま使われる）
--       plan          … いま契約しているプランの名前
--       plans         … プランごとの手数料率。plan で選ぶ
--       pricing_mode  … contract（実契約）/ conservative_estimate（保守的試算）
--                       / weighted_actual（実績で重みづけ。将来）
--       fee_parts     … 手数料の内訳。{min, max} の範囲で持てる
--       excluded      … わざと計算に入れていないもの（理由つき）
--       monthly_fixed_yen … 月額の固定費。**1件あたりには割らない**
--       by_category   … 商品カテゴリごとの上書き（将来のAmazonカテゴリ別料率用）
--
--     実効手数料率の決めかた（画面側）
--       ① plans[plan]  ② fee_parts の合算  ③ fee_rate 列
-- ------------------------------------------------------------
alter table public.inventory_channel_settings
  add column if not exists pricing_rules jsonb;

comment on column public.inventory_channel_settings.pricing_rules is
  '手数料の内訳・プラン・カテゴリ別の上書き。NULLなら fee_rate 列だけを使う。
   pricing_mode が conservative_estimate のときは、fee_parts の max を合算した
   「安全側の試算値」であって実契約料率ではない。';

-- ------------------------------------------------------------
-- 59-2) 配送サイズ（佐川急便の規格）
--
--     送料は販売サイトではなく「配送会社 × サイズ × 地域」で決まるので、
--     チャネルではなく**商品**に持たせる。
--     金額はまだ入れない（契約運賃表が無いため）。サイズだけ先に決めておく。
-- ------------------------------------------------------------
alter table public.inventory_products
  add column if not exists shipping_size text;

comment on column public.inventory_products.shipping_size is
  '配送サイズ（佐川急便）。60/80/100/120/140/160/170/180/200/custom。
   NULLは未設定。送料の金額はここには持たない（契約運賃表ができてから別に持つ）。';

-- ------------------------------------------------------------
-- 59-3) 確定した料率を入れる
--
--     **空いている項目だけ**入れる（coalesce）。すでに担当者が入れた値は
--     上書きしない。送料（shipping_cost）はどのサイトにも入れない。
-- ------------------------------------------------------------
update public.inventory_channel_settings set
  fee_rate           = coalesce(fee_rate, 0.077),   -- Yahoo!オークションストア契約
  fixed_cost         = coalesce(fixed_cost, 0),
  target_profit_rate = coalesce(target_profit_rate, 0.30),
  minimum_profit_yen = coalesce(minimum_profit_yen, 0),
  pricing_rules      = coalesce(pricing_rules, jsonb_build_object(
    'plan', 'store',
    'pricing_mode', 'contract',
    'plans', jsonb_build_object('normal', 0.100, 'store', 0.077)))
 where channel = 'yahuoku';

update public.inventory_channel_settings set
  fee_rate           = coalesce(fee_rate, 0.091),   -- 保守的試算（内訳の上限合算）
  fixed_cost         = coalesce(fixed_cost, 0),
  target_profit_rate = coalesce(target_profit_rate, 0.30),
  minimum_profit_yen = coalesce(minimum_profit_yen, 0),
  note               = coalesce(note, '') ||
    case when coalesce(note, '') = '' then '' else ' / ' end ||
    '手数料 9.1% は内訳の上限を足した【保守的試算】です。実契約料率ではありません。',
  pricing_rules      = coalesce(pricing_rules, jsonb_build_object(
    'plan', 'standard',
    'pricing_mode', 'conservative_estimate',
    'fee_parts', jsonb_build_object(
      'システム利用料',                  jsonb_build_object('min', 0.020, 'max', 0.045,
        'note', 'PC 2.0〜4.0% / モバイル 2.5〜4.5%。月商帯とPC・モバイル比率で変わる'),
      '楽天ポイント原資',                jsonb_build_object('min', 0.010, 'max', 0.010),
      '安全性・利便性向上システム利用料', jsonb_build_object('min', 0.001, 'max', 0.001),
      '楽天ペイ',                        jsonb_build_object('min', 0.025, 'max', 0.035)),
    'excluded', jsonb_build_object(
      'アフィリエイト', '全注文に発生するわけではないので、基本の価格計算には入れない。実績利益で見る',
      '月額出店料',     '65,000円/月。1件あたりには割らない'),
    'monthly_fixed_yen', 65000))
 where channel = 'rakuten';

update public.inventory_channel_settings set
  fee_rate           = coalesce(fee_rate, 0.084),   -- 主力商品向けの標準値
  fixed_cost         = coalesce(fixed_cost, 0),
  target_profit_rate = coalesce(target_profit_rate, 0.30),
  minimum_profit_yen = coalesce(minimum_profit_yen, 0),
  pricing_rules      = coalesce(pricing_rules, jsonb_build_object(
    'pricing_mode', 'contract',
    'by_category', '{}'::jsonb))   -- カテゴリ別料率はここへ足していく
 where channel = 'amazon';

update public.inventory_channel_settings set
  fee_rate           = coalesce(fee_rate, 0.10),
  fixed_cost         = coalesce(fixed_cost, 0),
  target_profit_rate = coalesce(target_profit_rate, 0.30),
  minimum_profit_yen = coalesce(minimum_profit_yen, 0),
  pricing_rules      = coalesce(pricing_rules, jsonb_build_object('pricing_mode', 'contract'))
 where channel = 'mercari';

update public.inventory_channel_settings set
  fee_rate           = coalesce(fee_rate, 0.05),
  fixed_cost         = coalesce(fixed_cost, 0),
  target_profit_rate = coalesce(target_profit_rate, 0.30),
  minimum_profit_yen = coalesce(minimum_profit_yen, 0),
  pricing_rules      = coalesce(pricing_rules, jsonb_build_object('pricing_mode', 'contract'))
 where channel = 'yahoo_free';

update public.inventory_channel_settings set
  fee_rate           = coalesce(fee_rate, 0),       -- 自社ECは販売手数料なし
  fixed_cost         = coalesce(fixed_cost, 0),
  target_profit_rate = coalesce(target_profit_rate, 0.30),
  minimum_profit_yen = coalesce(minimum_profit_yen, 0),
  pricing_rules      = coalesce(pricing_rules, jsonb_build_object('pricing_mode', 'contract'))
 where channel = 'own';

-- ------------------------------------------------------------
-- 59-4) pricing_rules を保存する
--
--     中身の形を確かめてから入れる。おかしな率が入ると、最低販売価格の
--     割り算（1 - 手数料率）が0や負になって、画面が黙って変な値を出す。
-- ------------------------------------------------------------
create or replace function public.inv_channel_pricing_rules_set(
  p_channel text,
  p_rules   jsonb default null
) returns public.inventory_channel_settings
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_ch   text := nullif(btrim(coalesce(p_channel, '')), '');
  v_mode text;
  before jsonb;
  r      public.inventory_channel_settings;
  k      text;
  v      jsonb;
  v_sum  numeric := 0;
begin
  if not public.inv_is_admin() then
    raise exception '販売価格の設定は管理者だけが変えられます';
  end if;
  if v_ch is null then
    raise exception '販売サイトを選んでください';
  end if;
  if v_ch not in ('rakuten', 'amazon', 'mercari', 'yahuoku', 'yahoo_free', 'own') then
    raise exception '価格設定の対象ではない販売サイトです：%（rakuten / amazon / mercari / yahuoku / yahoo_free / own のどれかです）', v_ch;
  end if;

  if p_rules is not null then
    if jsonb_typeof(p_rules) <> 'object' then
      raise exception '手数料の内訳は { } の形で入れてください';
    end if;
    -- 知らないキーは受け取らない（打ち間違いが黙って捨てられないように）
    for k in select jsonb_object_keys(p_rules) loop
      if k not in ('plan', 'plans', 'pricing_mode', 'fee_parts', 'excluded',
                   'monthly_fixed_yen', 'by_category') then
        raise exception '知らない項目です：%', k;
      end if;
    end loop;

    v_mode := p_rules ->> 'pricing_mode';
    if v_mode is not null and v_mode not in ('contract', 'conservative_estimate', 'weighted_actual') then
      raise exception 'pricing_mode は contract / conservative_estimate / weighted_actual のどれかです（いまは %）', v_mode;
    end if;

    -- プランごとの率
    if p_rules ? 'plans' then
      if jsonb_typeof(p_rules -> 'plans') <> 'object' then
        raise exception 'plans は { プラン名: 率 } の形で入れてください';
      end if;
      for k, v in select * from jsonb_each(p_rules -> 'plans') loop
        if jsonb_typeof(v) <> 'number' or (v)::numeric < 0 or (v)::numeric >= 1 then
          raise exception 'plans.% は0以上1未満の数で入れてください（0.077 で7.7%%）', k;
        end if;
      end loop;
      if p_rules ? 'plan' and not (p_rules -> 'plans' ? (p_rules ->> 'plan')) then
        raise exception 'plan「%」が plans にありません', p_rules ->> 'plan';
      end if;
    end if;

    -- 手数料の内訳
    if p_rules ? 'fee_parts' then
      if jsonb_typeof(p_rules -> 'fee_parts') <> 'object' then
        raise exception 'fee_parts は { 項目名: {min, max} } の形で入れてください';
      end if;
      for k, v in select * from jsonb_each(p_rules -> 'fee_parts') loop
        if jsonb_typeof(v) <> 'object' or not (v ? 'min') or not (v ? 'max') then
          raise exception 'fee_parts.% は {"min": 率, "max": 率} の形で入れてください', k;
        end if;
        if jsonb_typeof(v -> 'min') <> 'number' or jsonb_typeof(v -> 'max') <> 'number' then
          raise exception 'fee_parts.% の min と max は数で入れてください', k;
        end if;
        if (v ->> 'min')::numeric < 0 or (v ->> 'max')::numeric < (v ->> 'min')::numeric then
          raise exception 'fee_parts.% は 0 ≦ min ≦ max で入れてください', k;
        end if;
        v_sum := v_sum + (v ->> 'max')::numeric;
      end loop;
      if v_sum >= 1 then
        raise exception '内訳の上限を足すと100%% を超えます（合計 %）。1未満になるように入れてください', v_sum;
      end if;
    end if;

    if p_rules ? 'monthly_fixed_yen' then
      if jsonb_typeof(p_rules -> 'monthly_fixed_yen') <> 'number'
         or (p_rules ->> 'monthly_fixed_yen')::numeric < 0 then
        raise exception 'monthly_fixed_yen は0以上の数で入れてください';
      end if;
    end if;
  end if;

  select pricing_rules into before from public.inventory_channel_settings where channel = v_ch;

  insert into public.inventory_channel_settings (channel, pricing_rules)
  values (v_ch, p_rules)
  on conflict (channel) do update set pricing_rules = p_rules
  returning * into r;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'channel', v_ch, coalesce(r.label, v_ch), '手数料の内訳を変えた',
          coalesce(before::text, '（設定なし）'),
          coalesce(p_rules::text, '（設定なし）'));
  return r;
end $$;

comment on function public.inv_channel_pricing_rules_set is
  '販売サイトの手数料の内訳・プランを保存する。管理者だけ。
   実効手数料率の計算は画面側で行い、ここでは入れられる値かだけを確かめる。
   在庫も出品情報も変更しない。';

-- ------------------------------------------------------------
-- 59-5) 商品の配送サイズを保存する
-- ------------------------------------------------------------
create or replace function public.inv_product_shipping_size_set(
  p_code text,
  p_size text default null
) returns public.inventory_products
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_size text := nullif(btrim(coalesce(p_size, '')), '');
  before text;
  r      public.inventory_products;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  if v_size is not null
     and v_size not in ('60','80','100','120','140','160','170','180','200','custom') then
    raise exception '知らない配送サイズです：%（60/80/100/120/140/160/170/180/200/custom）', v_size;
  end if;

  select shipping_size into before from public.inventory_products where code = p_code;

  update public.inventory_products set shipping_size = v_size
   where code = p_code returning * into r;
  if not found then
    raise exception '商品が見つかりません（%）', p_code;
  end if;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'product', p_code, coalesce(nullif(r.name, ''), r.code),
          '配送サイズを決めた', coalesce(before, '未設定'), coalesce(v_size, '未設定'));
  return r;
end $$;

comment on function public.inv_product_shipping_size_set is
  '商品の配送サイズ（佐川急便の規格）を決める。送料の金額はここでは持たない。
   在庫も価格も変更しない。';

-- ------------------------------------------------------------
-- 59-6) 権限
--     作り直すと PUBLIC への EXECUTE が既定で付き直るので、必ず外してから配る。
-- ------------------------------------------------------------
revoke all on function public.inv_channel_pricing_rules_set(text, jsonb) from public, anon;
grant execute on function public.inv_channel_pricing_rules_set(text, jsonb) to authenticated;
revoke all on function public.inv_product_shipping_size_set(text, text) from public, anon;
grant execute on function public.inv_product_shipping_size_set(text, text) to authenticated;

commit;

-- 確認用（実行しなくてよい）
--   select channel, fee_rate, target_profit_rate, minimum_profit_yen,
--          shipping_cost, pricing_rules ->> 'pricing_mode' as mode
--     from public.inventory_channel_settings
--    where channel in ('rakuten','amazon','mercari','yahuoku','yahoo_free','own')
--    order by channel;
