-- ============================================================
-- 販売（8EC BUY）とレンタル（8RENT）を、1つの商品マスタで扱えるようにする
--   2026-09-21（2026-09-21-deals.sql の後に流す追補）
--
--   これまで公開側に出せたのは「レンタルできる商品」だけだった。
--   inv_public_catalog は rental_enabled = true で絞っているので、
--   売るだけの商品は公開画面に存在しない。
--   販売の情報も inventory_channel_listings（楽天の出品）しか無く、
--   それは「楽天に出しているか」であって、8ECが法人向けに売る価格ではない。
--
--   ここでやること
--     商品（inventory_products）に販売の列を足す。
--     販売用の別テーブルは作らない。同じ1商品が
--       販売のみ / レンタルのみ / 販売・レンタル両方
--     のどれにもなれるようにする。
--
--   入っているもの
--     inventory_products.sale_enabled               販売する／しない（既定 false）
--     inventory_products.sale_price                 法人向け販売価格（未設定なら「お見積り」）
--     inventory_products.sale_condition             新品 / 整備済み / 中古
--     inventory_products.sale_procurement_available 在庫が無くても取り寄せられる
--     inv_public_products                           公開ビュー（レンタルと販売の両方）
--     inv_public_catalog                            これまでどおり（互換。レンタルぶんだけ返す）
--     inv_product_sale_set()                        /zaiko の商品詳細から販売設定を変える
--     inventory_deals.product_code / want           商品からの購入相談を案件につなぐ
--
--   やらないこと
--     楽天の価格（inventory_channel_listings.price）と販売予定価格
--     （inventory_items.plan_price）を sale_price へ自動でコピーしない。
--     どちらも「社内の参考値」で、法人向けの公開価格ではないため。
--     /zaiko では参考価格として画面に出すだけにする。
--
--     sale_enabled の既定は false。これを流しただけでは、どの商品も
--     公開画面に「販売中」としては出ない。売るものは人が選ぶ。
--
--     楽天連携・inventory_items・在庫ロック（inv_reserve_available_item）・
--     inv_sale_reserve() には触れない。Stripeもまだ入れない。
--
--   何度流しても同じ結果になる。
--
--   実行後の確認
--     select code, name, sale_enabled, sale_price, sale_condition
--       from public.inventory_products where sale_enabled;      -- 最初は0件
--     select count(*) from public.inv_public_products;          -- 公開商品（レンタル＋販売）
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 45-1) 商品に「販売」の情報を持たせる
--
--     レンタル側（rental_enabled / rental_price_month / procurement_available）と
--     同じ形をそろえる。どちらか片方だけ true でも、両方 true でもよい。
-- ------------------------------------------------------------
alter table public.inventory_products
  add column if not exists sale_enabled               boolean not null default false,
  add column if not exists sale_price                 integer,
  add column if not exists sale_condition             text,
  add column if not exists sale_procurement_available boolean not null default false;

comment on column public.inventory_products.sale_enabled is
  '法人向けに販売する商品として公開するか。既定は false。
   楽天に出品しているかどうか（inventory_channel_listings）とは別の判断。';
comment on column public.inventory_products.sale_price is
  '法人向けの公開販売価格（税抜・円）。未設定なら公開画面は「販売価格はお見積り」と出す。
   楽天の出品価格や inventory_items.plan_price（社内の販売予定価格）を
   ここへ自動でコピーしない。値は人が決めて入れる。';
comment on column public.inventory_products.sale_condition is
  '新品 / 整備済み / 中古。公開画面に出す。未設定なら状態バッジを出さない。';
comment on column public.inventory_products.sale_procurement_available is
  '手元に在庫が無くても、仕入先から取り寄せて販売できるか。
   公開画面では「取り寄せ可能」と出る。仕入先の社名は公開しない。';

-- 状態の言い方をそろえる（自由文にすると公開画面の表記が割れるため）
alter table public.inventory_products
  drop constraint if exists inventory_products_sale_condition_chk;
alter table public.inventory_products
  add constraint inventory_products_sale_condition_chk
  check (sale_condition is null or sale_condition in ('新品', '整備済み', '中古'));

-- 価格は0円や極端な値を弾く（0円は「無料」ではなく入力漏れのことが多い）
alter table public.inventory_products
  drop constraint if exists inventory_products_sale_price_chk;
alter table public.inventory_products
  add constraint inventory_products_sale_price_chk
  check (sale_price is null or (sale_price > 0 and sale_price <= 100000000));

create index if not exists inventory_products_sale_idx
  on public.inventory_products (sale_enabled) where sale_enabled;

-- ------------------------------------------------------------
-- 45-2) 公開ビュー：レンタルと販売をまとめて1つ
--
--     rental_enabled = true か sale_enabled = true のどちらかなら出す。
--     公開画面はこの1つを読めば、カードに
--       レンタル欄（月額・ご案内可能／取り寄せ可能）
--       販売欄（価格・状態・在庫あり／取り寄せ可能）
--     の出し分けができる。
--
--     数量は出さない。
--       レンタル … これまでどおり availability の3語だけ
--       販売     … 在庫あり / 取り寄せ可能 / ご相談ください の3語だけ
--     「残り1台」を法人のお客様に見せない方針はそのまま。
--
--     rental_enabled はビューの中で「単品でレンタル公開してよいか」に直す
--     （rental_listing_type が option / not_public のものは false にする）。
--     販売だけの商品がレンタル商品として出てしまうのを防ぐため。
-- ------------------------------------------------------------
-- 先に互換ビューを落とす（inv_public_products に依存しているので、
-- 残したまま作り直そうとすると2回目以降の実行が止まる）
drop view if exists public.inv_public_catalog;
drop view if exists public.inv_public_products;
create view public.inv_public_products as
with avail as (
  select product_code,
         count(*) filter (where status = '在庫'
                            and coalesce(rental_eligible, false)) as rental_available,
         count(*) filter (where status = '在庫')                  as in_stock
    from public.inventory_items
   group by product_code
)
select
  p.code, p.name, p.model, p.maker, p.category_id, c.name as category_name,
  public.inv_model_key(p.maker, p.model, p.code)                    as model_key,
  p.spec,
  coalesce(nullif(p.image_url,''),
           (select x from jsonb_array_elements_text(coalesce(p.images,'[]'::jsonb)) x
             where btrim(x) <> '' limit 1))                        as image_url,
  coalesce(p.images,'[]'::jsonb)                                    as images,
  coalesce(nullif(p.rental_image_url,''), nullif(p.image_url,''),
           (select x from jsonb_array_elements_text(coalesce(p.images,'[]'::jsonb)) x
             where btrim(x) <> '' limit 1))                        as rental_image_url,
  case when jsonb_array_length(coalesce(p.rental_images,'[]'::jsonb)) > 0
       then p.rental_images else coalesce(p.images,'[]'::jsonb) end as rental_images,
  p.cpu, p.cpu_gen, p.memory_size, p.storage_type, p.storage_capacity,
  p.screen_size, p.os, p.webcam, p.wifi, p.bluetooth, p.numpad, p.accessories,
  p.condition_note, p.office_supported,
  p.rental_form, p.rental_listing_type,
  -- レンタル（8RENT）。単品で公開してよいものだけ true
  (coalesce(p.rental_enabled, false)
     and coalesce(p.rental_listing_type, 'standalone') = 'standalone')  as rental_enabled,
  coalesce(p.procurement_available, false)                          as procurement_available,
  case when coalesce(a.rental_available, 0) > 0 then 'ご案内可能'
       when coalesce(p.procurement_available, false) then '取り寄せ可能'
       else 'ご相談ください' end                                    as availability,
  p.rental_price_month, p.rental_min_months, p.trial_eligible, p.rental_tags,
  nullif(btrim(coalesce(p.rental_description,'')), '')              as rental_description,
  -- 販売（8EC BUY）
  coalesce(p.sale_enabled, false)                                   as sale_enabled,
  p.sale_price,
  p.sale_condition,
  coalesce(p.sale_procurement_available, false)                     as sale_procurement_available,
  case when not coalesce(p.sale_enabled, false) then null
       when coalesce(a.in_stock, 0) > 0 then '在庫あり'
       when coalesce(p.sale_procurement_available, false) then '取り寄せ可能'
       else 'ご相談ください' end                                    as sale_availability,
  p.updated_at
from public.inventory_products p
left join public.inventory_categories c on c.id = p.category_id
left join avail a on a.product_code = p.code
where p.kind = 'individual'
  and (
        (coalesce(p.rental_enabled, false)
           and coalesce(p.rental_listing_type, 'standalone') = 'standalone')
     or coalesce(p.sale_enabled, false)
      );

comment on view public.inv_public_products is
  '公開画面（/ ・/rent ・/buy）が読む1つのカタログ。レンタルできる商品と販売する商品の両方を返す。
   同じ商品が両方に対応していれば、rental_enabled と sale_enabled の両方が true になる。
   在庫数は出さない（レンタルは availability、販売は sale_availability の言葉だけ）。
   楽天のURL・出品価格は出さない。社内で数量を見るときは inv_channel_stock_feed を使う。';

-- これまでの公開ビューは残す（8ECトップの旧版・外部からの参照が壊れないように）。
-- 中身は inv_public_products のレンタルぶんと同じ。列の並びもこれまでどおり。
create view public.inv_public_catalog as
select
  code, name, model, maker, category_id, category_name, model_key, spec,
  image_url, images, rental_image_url, rental_images,
  cpu, cpu_gen, memory_size, storage_type, storage_capacity,
  screen_size, os, webcam, wifi, bluetooth, numpad, accessories,
  condition_note, office_supported, rental_form, rental_listing_type,
  rental_enabled, procurement_available, availability,
  rental_price_month, rental_min_months, trial_eligible, rental_tags,
  rental_description, updated_at
from public.inv_public_products
where rental_enabled;

comment on view public.inv_public_catalog is
  '8RENT（レンタル）の公開カタログ。inv_public_products のレンタルぶん。
   列の並びは以前のままにしてある（既存のページがそのまま読めるように）。
   新しい画面は inv_public_products を読み、販売とレンタルを1枚のカードで出す。';

-- ------------------------------------------------------------
-- 45-3) 販売設定（/zaiko の商品詳細から）
--
--     楽天の出品価格や販売予定価格は見ない。ここで入った値だけを公開する。
-- ------------------------------------------------------------
create or replace function public.inv_product_sale_set(
  p_code        text,
  p_enabled     boolean,
  p_price       integer default null,
  p_condition   text default null,
  p_procurement boolean default null
) returns public.inventory_products
language plpgsql security invoker set search_path = public as $$
declare
  pr       public.inventory_products;
  v_before text;
  v_after  text;
  v_cond   text;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;

  v_cond := nullif(btrim(coalesce(p_condition, '')), '');
  if v_cond is not null and v_cond not in ('新品', '整備済み', '中古') then
    raise exception '商品の状態は 新品 / 整備済み / 中古 のいずれかでお願いします（%）', v_cond;
  end if;
  if p_price is not null and (p_price <= 0 or p_price > 100000000) then
    raise exception '販売価格は1円〜1億円の範囲で入れてください（%）', p_price;
  end if;

  select * into pr from public.inventory_products where code = p_code for update;
  if not found then
    raise exception '商品が見つかりません（%）', p_code;
  end if;

  v_before := (case when coalesce(pr.sale_enabled, false) then '販売する' else '販売しない' end)
              || ' / ' || coalesce(pr.sale_price::text, '価格未設定')
              || ' / ' || coalesce(pr.sale_condition, '状態未設定')
              || (case when coalesce(pr.sale_procurement_available, false) then ' / 取り寄せ可' else '' end);

  update public.inventory_products
     set sale_enabled               = coalesce(p_enabled, false),
         sale_price                 = p_price,
         sale_condition             = v_cond,
         sale_procurement_available = coalesce(p_procurement, false)
   where code = p_code
  returning * into pr;

  v_after := (case when pr.sale_enabled then '販売する' else '販売しない' end)
             || ' / ' || coalesce(pr.sale_price::text, '価格未設定')
             || ' / ' || coalesce(pr.sale_condition, '状態未設定')
             || (case when pr.sale_procurement_available then ' / 取り寄せ可' else '' end);

  if v_before is distinct from v_after then
    insert into public.inventory_transactions
      (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (public.inv_actor(), 'product', p_code, coalesce(pr.name, pr.model), '販売設定',
            v_before, v_after);
  end if;

  return pr;
end $$;

comment on function public.inv_product_sale_set is
  '商品を法人向けに販売するかどうかと、公開販売価格・状態・取り寄せ可否を決める。
   楽天の出品価格や inventory_items.plan_price は見ない（参考値であって公開価格ではないため）。
   価格が未設定でも販売はできる（公開画面は「販売価格はお見積り」と出す）。';

-- ------------------------------------------------------------
-- 45-4) 商品からの購入相談を案件につなぐ
--
--     /buy の商品カードの［この商品を購入相談する］は
--     /quote?mode=buy&code=P-00424 を開く。届いた案件に、
--     どの商品の話か（product_code）と、購入希望なのかどうか（want）を残す。
--
--     want は「お客様の希望」であって決定ではない。購入希望で届いても、
--     スタッフがレンタルのほうが合うと判断すれば、そう提案してよい。
-- ------------------------------------------------------------
alter table public.inventory_deals
  add column if not exists product_code text
    references public.inventory_products(code) on delete set null,
  add column if not exists want text;

comment on column public.inventory_deals.product_code is
  'どの商品を見て相談が始まったか。商品が決まっていない相談では null。';
comment on column public.inventory_deals.want is
  '購入希望 / レンタル希望 / 未定。お客様の希望で、確定ではない。
   購入とレンタルのどちらで出すかは、社内で中身を見てから決める。';

alter table public.inventory_deals
  drop constraint if exists inventory_deals_want_chk;
alter table public.inventory_deals
  add constraint inventory_deals_want_chk
  check (want is null or want in ('購入希望', 'レンタル希望', '未定'));

-- 引数が増えるので、古い定義を落としてから作り直す（同名の別シグネチャを残さない）
drop function if exists public.inv_deal_create(
  text, text, text, text, text, integer, integer, date, integer, text, jsonb, text[], text, text);

create or replace function public.inv_deal_create(
  p_name         text,
  p_company      text default null,
  p_email        text default null,
  p_phone        text default null,
  p_purpose      text default null,
  p_headcount    integer default null,
  p_qty          integer default null,
  p_start        date default null,
  p_months       integer default null,
  p_grade        text default null,
  p_spec         jsonb default '{}'::jsonb,
  p_services     text[] default '{}',
  p_message      text default null,
  p_source       text default 'quote',
  p_product_code text default null,
  p_want         text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_id   bigint;
  v_code text;
  v_want text;
begin
  if p_name is null or btrim(p_name) = '' then
    raise exception 'ご担当者名を入力してください';
  end if;
  if coalesce(p_qty, 0) < 0 or coalesce(p_qty, 0) > 5000 then
    raise exception '台数は0〜5000台でお願いします（それ以上はお電話でご相談ください）';
  end if;
  if coalesce(p_headcount, 0) < 0 or coalesce(p_headcount, 0) > 5000 then
    raise exception '人数は0〜5000名でお願いします';
  end if;
  if p_months is not null and (p_months < 0 or p_months > 120) then
    raise exception '利用期間は0〜120ヶ月でお願いします';
  end if;
  if p_grade is not null and p_grade not in ('budget', 'standard', 'latest', 'any') then
    raise exception 'ご希望の方針が正しくありません（%）', p_grade;
  end if;

  v_want := nullif(btrim(coalesce(p_want, '')), '');
  if v_want is not null and v_want not in ('購入希望', 'レンタル希望', '未定') then
    v_want := '未定';   -- 知らない値は落とさず「未定」にする（相談を取りこぼさない）
  end if;

  -- 知らない商品コードで落とさない。公開ページのリンクは古くなることがあるので、
  -- 見つからなければ商品を付けずに受け付ける（相談そのものは受ける）
  v_code := nullif(btrim(coalesce(p_product_code, '')), '');
  if v_code is not null
     and not exists (select 1 from public.inventory_products where code = v_code) then
    v_code := null;
  end if;

  insert into public.inventory_deals
    (source, status, company, customer_name, email, phone,
     purpose, headcount, qty, start_date, months, grade, spec, services, message,
     product_code, want)
  values
    (coalesce(nullif(btrim(coalesce(p_source, '')), ''), 'quote'), '希望受付',
     nullif(btrim(coalesce(p_company, '')), ''), btrim(p_name),
     nullif(btrim(coalesce(p_email, '')), ''), nullif(btrim(coalesce(p_phone, '')), ''),
     nullif(btrim(coalesce(p_purpose, '')), ''), p_headcount, p_qty, p_start, p_months,
     p_grade, coalesce(p_spec, '{}'::jsonb), coalesce(p_services, '{}'),
     nullif(btrim(coalesce(p_message, '')), ''),
     v_code, v_want)
  returning id into v_id;

  return jsonb_build_object('deal_id', v_id, 'status', '希望受付');
end $$;

comment on function public.inv_deal_create is
  '法人ITまるごと見積・商品からの購入相談の送信口。匿名から呼べる。
   保存するだけで、決済も個体の確保もしない。商品コードが付いていても在庫は押さえない。';

-- ------------------------------------------------------------
-- 45-5) 権限
-- ------------------------------------------------------------
grant select on public.inv_public_products to anon, authenticated;
grant select on public.inv_public_catalog  to anon, authenticated;

revoke all on function public.inv_product_sale_set(text, boolean, integer, text, boolean) from public;
grant execute on function public.inv_product_sale_set(text, boolean, integer, text, boolean) to authenticated;

revoke all on function public.inv_deal_create(
  text,text,text,text,text,integer,integer,date,integer,text,jsonb,text[],text,text,text,text) from public;
grant execute on function public.inv_deal_create(
  text,text,text,text,text,integer,integer,date,integer,text,jsonb,text[],text,text,text,text) to anon, authenticated;

commit;
