-- ============================================================
-- 販売サイトごとの「手数料・送料・目標利益」を設定できるようにする
--   （仕入CSVから6チャネルの出品価格を計算するための下ごしらえ）
--
--   何度流しても同じ結果になる（add column if not exists / on conflict do nothing /
--   create or replace）。
--
--   このmigrationですること
--     1) inventory_channel_settings に、値段を決めるための5列を足す（すべてNULL可）
--     2) 自社EC（own）の設定行を足す
--     3) 価格設定を保存する関数 inv_channel_pricing_settings_set() を作る
--
--   このmigrationがしないこと
--     ・既存の inv_channel_settings_set() は **一切触らない**
--       （管理画面URLの保存はこれまでどおり。引数も挙動もそのまま）
--     ・手数料率や送料の**初期値は入れない**。契約で変わる値なので、
--       推測で埋めずNULLのままにし、担当者が管理画面で入れる
--     ・inventory_items / inventory_channel_listings / 在庫の状態は変更しない
--       （価格を「計算した」ことと「出品した」ことは別物）
--     ・既存の販売予定価格（inventory_items.plan_price ＝ 原価×1.3）は変えない
--
--   前提：zaiko/migrations/2026-09-19-sale-flow.sql（inventory_channel_settings）
--         zaiko/migrations/2026-10-01-rpc-permission-hardening.sql（権限の棚卸し）
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 58-0) 前提の確認。無いまま進めると、あとで気づきにくい壊れかたをする
-- ------------------------------------------------------------
do $$
begin
  if to_regclass('public.inventory_channel_settings') is null then
    raise exception 'inventory_channel_settings がありません。2026-09-19-sale-flow.sql を先に流してください';
  end if;
  if to_regprocedure('public.inv_is_admin()') is null then
    raise exception 'inv_is_admin() がありません。setup.sql の基本部分が当たっているか確かめてください';
  end if;
end $$;

-- ------------------------------------------------------------
-- 58-1) 値段を決めるための5列
--
--     fee_rate            … 販売手数料率。0.10 なら10%。0以上1未満
--     fixed_cost          … 1件ごとの固定費（決済手数料・梱包材など）
--     shipping_cost       … 送料
--     target_profit_rate  … 目標利益率。0.20 なら原価の20%
--     minimum_profit_yen  … 最低利益額。目標利益率で足りないときの下限
--
--     すべてNULL可。NULLは「まだ決めていない」という意味で、
--     画面側はNULLのチャネルの価格を出さない（0として計算しない）。
-- ------------------------------------------------------------
alter table public.inventory_channel_settings
  add column if not exists fee_rate           numeric;
alter table public.inventory_channel_settings
  add column if not exists fixed_cost         numeric;
alter table public.inventory_channel_settings
  add column if not exists shipping_cost      numeric;
alter table public.inventory_channel_settings
  add column if not exists target_profit_rate numeric;
alter table public.inventory_channel_settings
  add column if not exists minimum_profit_yen numeric;

comment on column public.inventory_channel_settings.fee_rate is
  '販売手数料率。0.10 で10%。0以上1未満。NULLは未設定で、価格計算をしない。';
comment on column public.inventory_channel_settings.fixed_cost is
  '1件ごとの固定費（決済手数料・梱包材など）。NULLは未設定。';
comment on column public.inventory_channel_settings.shipping_cost is
  '送料。NULLは未設定。';
comment on column public.inventory_channel_settings.target_profit_rate is
  '目標利益率。0.20 で原価の20%。チャネルごとに変えられる。NULLは未設定。';
comment on column public.inventory_channel_settings.minimum_profit_yen is
  '最低利益額（円）。目標利益率で足りないときの下限。NULLは未設定。';

-- ------------------------------------------------------------
-- 58-2) 自社EC（own）の設定行
--
--     いまは**価格計算のためだけ**に使う。
--     在庫一覧の出品先タブには出さず、inventory_channel_listings の
--     実際の出品処理にもつながない（将来、自社EC出品を作るときに接続する）。
-- ------------------------------------------------------------
insert into public.inventory_channel_settings (channel, label, note) values
  ('own', '自社EC',
   'いまは出品価格の計算にだけ使う設定です。在庫一覧の出品先タブには出さず、実際の出品処理にもつないでいません。')
on conflict (channel) do nothing;

-- ------------------------------------------------------------
-- 58-3) 価格設定を保存する
--
--     既存の inv_channel_settings_set()（管理画面URL用）とは**別の関数**にする。
--     既存の引数・挙動を変えないため、呼び出し側の互換性が壊れない。
--
--     入れられるのは管理者だけ。表は読み取り専用のままなので security definer。
--     NULL を渡した項目は「未設定に戻す」。0 と NULL は別物として扱う
--     （0円の送料と、送料を決めていないことは意味が違う）。
-- ------------------------------------------------------------
create or replace function public.inv_channel_pricing_settings_set(
  p_channel            text,
  p_fee_rate           numeric default null,
  p_fixed_cost         numeric default null,
  p_shipping_cost      numeric default null,
  p_target_profit_rate numeric default null,
  p_minimum_profit_yen numeric default null
) returns public.inventory_channel_settings
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_ch  text := nullif(btrim(coalesce(p_channel, '')), '');
  before public.inventory_channel_settings;
  r     public.inventory_channel_settings;
  fmt   text := 'FM9,999,999,999';
begin
  if not public.inv_is_admin() then
    raise exception '販売価格の設定は管理者だけが変えられます';
  end if;
  if v_ch is null then
    raise exception '販売サイトを選んでください';
  end if;
  -- 価格設定をするのはこの6サイトだけ。打ち間違いで知らない行が増えないよう、
  -- 画面だけでなくここでも止める（inventory_channel_settings は upsert のため）
  if v_ch not in ('rakuten', 'amazon', 'mercari', 'yahuoku', 'yahoo_free', 'own') then
    raise exception '価格設定の対象ではない販売サイトです：%（rakuten / amazon / mercari / yahuoku / yahoo_free / own のどれかです）', v_ch;
  end if;

  -- 手数料率が1以上だと、最低販売価格の割り算（1 - fee_rate）が0や負になる
  if p_fee_rate is not null and (p_fee_rate < 0 or p_fee_rate >= 1) then
    raise exception '手数料率は0以上1未満で入れてください（0.10 で10%%）。いまは %', p_fee_rate;
  end if;
  if p_target_profit_rate is not null and p_target_profit_rate < 0 then
    raise exception '目標利益率にマイナスは入れられません（いまは %）', p_target_profit_rate;
  end if;
  if p_fixed_cost is not null and p_fixed_cost < 0 then
    raise exception '固定費にマイナスは入れられません（いまは %）', p_fixed_cost;
  end if;
  if p_shipping_cost is not null and p_shipping_cost < 0 then
    raise exception '送料にマイナスは入れられません（いまは %）', p_shipping_cost;
  end if;
  if p_minimum_profit_yen is not null and p_minimum_profit_yen < 0 then
    raise exception '最低利益額にマイナスは入れられません（いまは %）', p_minimum_profit_yen;
  end if;

  select * into before from public.inventory_channel_settings where channel = v_ch;

  insert into public.inventory_channel_settings
    (channel, fee_rate, fixed_cost, shipping_cost, target_profit_rate, minimum_profit_yen)
  values
    (v_ch, p_fee_rate, p_fixed_cost, p_shipping_cost, p_target_profit_rate, p_minimum_profit_yen)
  on conflict (channel) do update
    set fee_rate           = p_fee_rate,
        fixed_cost         = p_fixed_cost,
        shipping_cost      = p_shipping_cost,
        target_profit_rate = p_target_profit_rate,
        minimum_profit_yen = p_minimum_profit_yen
  returning * into r;

  -- 値付けの根拠になる設定なので、いつ誰が変えたかを履歴に残す
  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (
    public.inv_actor(), 'channel', v_ch, coalesce(r.label, v_ch), '販売価格の設定を変えた',
    case when before.channel is null then '（設定なし）' else
      format('手数料 %s／固定費 %s／送料 %s／目標利益率 %s／最低利益 %s',
             coalesce(to_char(before.fee_rate * 100, fmt) || '%', '未設定'),
             coalesce(to_char(before.fixed_cost, fmt) || '円', '未設定'),
             coalesce(to_char(before.shipping_cost, fmt) || '円', '未設定'),
             coalesce(to_char(before.target_profit_rate * 100, fmt) || '%', '未設定'),
             coalesce(to_char(before.minimum_profit_yen, fmt) || '円', '未設定')) end,
    format('手数料 %s／固定費 %s／送料 %s／目標利益率 %s／最低利益 %s',
           coalesce(to_char(r.fee_rate * 100, fmt) || '%', '未設定'),
           coalesce(to_char(r.fixed_cost, fmt) || '円', '未設定'),
           coalesce(to_char(r.shipping_cost, fmt) || '円', '未設定'),
           coalesce(to_char(r.target_profit_rate * 100, fmt) || '%', '未設定'),
           coalesce(to_char(r.minimum_profit_yen, fmt) || '円', '未設定')));

  return r;
end $$;

comment on function public.inv_channel_pricing_settings_set is
  '販売サイトごとの手数料・固定費・送料・目標利益率・最低利益額を保存する。管理者だけ。
   管理画面URLの inv_channel_settings_set() とは別の関数で、そちらの引数も挙動も変えない。
   NULLは「未設定に戻す」。0円とNULLは別物として扱う。
   この関数は在庫も出品情報も変更しない。';

-- ------------------------------------------------------------
-- 58-4) 権限
--
--     関数を作り直すと PUBLIC への EXECUTE が既定で付き直るので、
--     ここで必ず外してから社員向けに配り直す（2026-10-01 と同じ考えかた）。
-- ------------------------------------------------------------
revoke all on function public.inv_channel_pricing_settings_set(
  text, numeric, numeric, numeric, numeric, numeric) from public, anon;
grant execute on function public.inv_channel_pricing_settings_set(
  text, numeric, numeric, numeric, numeric, numeric) to authenticated;

commit;

-- 確認用（実行しなくてよい）
--   select channel, label, fee_rate, fixed_cost, shipping_cost,
--          target_profit_rate, minimum_profit_yen
--     from public.inventory_channel_settings order by channel;
