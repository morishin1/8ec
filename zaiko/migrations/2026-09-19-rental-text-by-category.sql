-- ============================================================
-- レンタル説明を、商品のかたちごとに作り分ける
--   2026-09-19（2026-09-19-rental-text-fill-admin-fix.sql の後に流す追補）
--
--   直すこと（本番の生成結果を見て分かった問題）
--     ・セキュリティワイヤーセットやモニターにも「Officeなし」が出ていた
--     ・型番しか分からない商品（G83/HS）の説明がほぼ空だった
--     ・8RENTは希望を伺って用意するサービスなのに、Officeを一律
--       「Officeなしでのご用意となります」と断定していた
--
--   本番では公開中の商品がすべて category_id='pc' で、モニターも
--   セキュリティワイヤーもPC扱いになっている。カテゴリでは出し分けられないので、
--   レンタル用の区分（rental_form / rental_listing_type）を別に持たせる。
--
--   入っているもの
--     1) rental_form / rental_listing_type / office_unavailable
--     2) inv_rental_form()（未分類のときは、分かっている事実だけから推定）
--     3) inv_rental_text() をかたちごとのひな形に作り直す
--     4) inv_product_rental_form_set()（/zaikoから区分を設定）
--     5) inv_rental_unclassified()（未分類のまま公開している商品の一覧）
--     6) inv_public_catalog は standalone の商品だけを出す
--
--   何度流しても同じ結果になる。
--   人が直した説明（rental_description_manual=true）は触りません。
--
--   実行後に、説明を作り直す（人が直したものは対象外）
--     select public.inv_rental_text_fill(false);
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 37-1) 商品の「かたち」と「公開のしかた」を持たせる
--
--     本番では公開中17商品がすべて category_id='pc' で、モニターも
--     セキュリティワイヤーもPC扱いになっている。カテゴリだけでは
--     文章を出し分けられないので、レンタル向けの区分を別に持つ。
--
--     rental_form … 説明文のひな形を決める
--       notebook   ノートPC
--       desktop    デスクトップPC
--       monitor    モニター
--       peripheral 周辺機器・アクセサリ
--       other      上記以外
--       null       未分類（分かっている事実から推定する。推定できなければ
--                  かたちを断定しない文章にする）
--
--     rental_listing_type … 8ECでの出しかたを決める
--       standalone 単品でレンタルできる。商品カードとして公開する
--       option     PCレンタルのオプション（セキュリティワイヤーなど）。
--                  単独のカードにはせず、申込時のオプションとして扱う
--       not_public 公開しない
-- ------------------------------------------------------------
alter table public.inventory_products
  add column if not exists rental_form         text,
  add column if not exists rental_listing_type text not null default 'standalone',
  add column if not exists office_unavailable  boolean not null default false;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_products_rental_form_chk') then
    alter table public.inventory_products add constraint inventory_products_rental_form_chk
      check (rental_form is null or rental_form in ('notebook','desktop','monitor','peripheral','other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'inventory_products_rental_listing_type_chk') then
    alter table public.inventory_products add constraint inventory_products_rental_listing_type_chk
      check (rental_listing_type in ('standalone','option','not_public'));
  end if;
end $$;

comment on column public.inventory_products.rental_form is
  'レンタル説明のひな形を決める区分（notebook/desktop/monitor/peripheral/other）。
   nullは未分類で、分かっている事実から推定する。推定できなければかたちを断定しない文章にする。';
comment on column public.inventory_products.rental_listing_type is
  '8ECでの出しかた。standalone=単品レンタルとしてカード公開／option=PCレンタルのオプション（単独公開しない）／not_public=公開しない。';
comment on column public.inventory_products.office_unavailable is
  'Officeを付けられないことがはっきりしている商品だけ true。
   office_supported=false は「不可」ではなく「未確認」なので、これとは別に持つ。';

-- ------------------------------------------------------------
-- 37-2) 未分類のときに、分かっている事実だけから「かたち」を推定する
--     キーワードや商品名からの当て推量はしない。列に値があるかどうかだけで決める。
-- ------------------------------------------------------------
create or replace function public.inv_rental_form(p public.inventory_products)
returns text
language sql immutable set search_path = pg_catalog, public as $$
  select case
    when nullif(btrim(coalesce(p.rental_form,'')), '') is not null then btrim(p.rental_form)
    -- CPU・OS・メモリのどれかが分かっていればPC。画面があればノート、なければ据え置き
    when nullif(btrim(coalesce(p.cpu,'')),'') is not null
      or nullif(btrim(coalesce(p.os,'')),'') is not null
      or nullif(btrim(coalesce(p.memory_size,'')),'') is not null
      then case when nullif(btrim(coalesce(p.screen_size,'')),'') is not null
                then 'notebook' else 'desktop' end
    -- PCの手がかりが何も無く、画面サイズだけ分かっていればモニター
    when nullif(btrim(coalesce(p.screen_size,'')),'') is not null then 'monitor'
    else null            -- 分からない。かたちを断定しない
  end;
$$;

comment on function public.inv_rental_form is
  'レンタル説明のひな形に使う区分。rental_form が入っていればそれを使い、未分類なら
   登録済みのスペックの有無だけから推定する（商品名やキーワードからの推測はしない）。
   推定できなければ null を返し、呼び出し側でかたちを断定しない文章にする。';

-- ------------------------------------------------------------
-- 37-3) レンタル向け説明の生成（商品のかたちごとにひな形を分ける）
--
--     Office と「この機種」という言いかたはPCのときだけ使う。
--     モニター・周辺機器には出さない。
--     スペックが足りない商品は、空同然の説明ではなく、条件を伺う文章にする。
--     分からないスペックを推測して書くことはしない。
-- ------------------------------------------------------------
create or replace function public.inv_rental_text(p_code text)
returns text
language plpgsql stable set search_path = public, pg_catalog as $$
declare
  p        public.inventory_products;
  v_form   text;
  v_screen numeric;
  v_mem    numeric;
  v_spec   text[] := '{}';
  v_out    text[] := '{}';
  v_head   text;
  v_has    boolean;
  v_label  text;
  v_unit   text;
begin
  select * into p from public.inventory_products where code = p_code;
  if not found then
    return null;
  end if;
  v_form   := public.inv_rental_form(p);
  v_screen := nullif(regexp_replace(coalesce(p.screen_size,''), '[^0-9.]', '', 'g'), '')::numeric;
  v_mem    := nullif(regexp_replace(coalesce(p.memory_size,''), '[^0-9]',   '', 'g'), '')::numeric;
  -- PCらしさの手がかりがあるか（Officeの案内を出してよいか）
  v_has := nullif(btrim(coalesce(p.cpu,'')),'') is not null
        or nullif(btrim(coalesce(p.os,'')),'') is not null
        or nullif(btrim(coalesce(p.memory_size,'')),'') is not null
        or nullif(btrim(coalesce(p.storage_capacity,'')),'') is not null;
  v_label := case v_form when 'notebook' then 'ノートPC' when 'desktop' then 'デスクトップPC'
                         when 'monitor' then 'モニター' when 'peripheral' then '周辺機器' end;
  v_unit  := case when v_form in ('monitor','peripheral','other') then '数量' else '台数' end;

  -- ① どんな用途に向いているか
  if v_form in ('notebook','desktop') then
    if v_has then
      v_head := case
        when v_form = 'desktop' then '法人の事務作業向けのデスクトップPCです。'
        when v_screen is null then '法人の事務作業向けのノートPCです。'
        when v_screen <= 13.5 then coalesce(p.screen_size,'') || 'の持ち運びやすいノートPCです。'
        when v_screen <= 14.9 then coalesce(p.screen_size,'') || 'の標準的なサイズのノートPCです。'
        else coalesce(p.screen_size,'') || 'の大画面ノートPCです。' end;
      v_head := v_head || case
        when v_mem is not null and v_mem >= 16 then
          coalesce(p.cpu || '・', '') || 'メモリ' || coalesce(p.memory_size,'') ||
          'を搭載し、複数のアプリを並行して使う事務作業やオンライン会議にも対応しやすい構成です。'
        when v_mem is not null then
          coalesce(p.cpu || '・', '') || 'メモリ' || coalesce(p.memory_size,'') ||
          'を搭載し、文書作成・表計算・オンライン会議などの事務作業に向いた構成です。'
        when p.cpu is not null then p.cpu || 'を搭載しています。'
        else '' end;
    else
      -- 型番しか分からない。仕様を推測せず、条件を伺う文章にする
      v_head := '法人利用向けの' || coalesce(v_label, 'PC') || 'です。詳細な仕様は、ご希望条件に合わせてご案内します。';
    end if;
  elsif v_form = 'monitor' then
    v_head := coalesce(nullif(p.screen_size,'') || 'の', '') || '法人のオフィス利用向けのモニターです。'
           || case when v_has then '' else '設置環境やご利用台数に合わせてご案内します。' end;
  elsif v_form = 'peripheral' then
    v_head := '法人でのご利用向けの周辺機器です。PCと合わせてのご利用にも対応します。';
  else
    v_head := '法人向けにレンタルできる機器です。詳細な仕様やご利用条件は、ご希望に合わせてご案内します。';
  end if;
  v_out := array_append(v_out, v_head);

  -- ② 主な仕様。かたちごとに出す項目を変える。分かっているものだけ書く
  if v_form in ('notebook','desktop') then
    if nullif(btrim(coalesce(p.cpu,'')),'')  is not null then v_spec := array_append(v_spec, btrim(p.cpu)); end if;
    if nullif(btrim(coalesce(p.memory_size,'')),'') is not null then v_spec := array_append(v_spec, btrim(p.memory_size)); end if;
    if nullif(btrim(coalesce(p.storage_capacity,'')),'') is not null then
      v_spec := array_append(v_spec, btrim(coalesce(p.storage_type || ' ', '') || p.storage_capacity));
    end if;
    if nullif(btrim(coalesce(p.screen_size,'')),'') is not null then v_spec := array_append(v_spec, btrim(p.screen_size)); end if;
    if nullif(btrim(coalesce(p.os,'')),'') is not null then v_spec := array_append(v_spec, btrim(p.os)); end if;
    if p.webcam    is true then v_spec := array_append(v_spec, 'Webカメラ'); end if;
    if p.wifi      is true then v_spec := array_append(v_spec, 'Wi-Fi'); end if;
    if p.bluetooth is true then v_spec := array_append(v_spec, 'Bluetooth'); end if;
    if p.numpad    is true then v_spec := array_append(v_spec, 'テンキー'); end if;
  elsif v_form = 'monitor' then
    -- モニターにCPU・OS・カメラ・Officeは出さない
    if nullif(btrim(coalesce(p.screen_size,'')),'') is not null then v_spec := array_append(v_spec, btrim(p.screen_size)); end if;
    if nullif(btrim(coalesce(p.spec,'')),'') is not null then v_spec := array_append(v_spec, btrim(p.spec)); end if;
  else
    if nullif(btrim(coalesce(p.spec,'')),'') is not null then v_spec := array_append(v_spec, btrim(p.spec)); end if;
  end if;
  if coalesce(array_length(v_spec, 1), 0) > 0 then
    v_out := array_append(v_out, '主な仕様：' || array_to_string(v_spec, ' / '));
  end if;

  -- ③ Office。PCのときだけ。8RENTは希望を伺って用意するので、原則は「ご相談ください」
  if v_form in ('notebook','desktop') or (v_form is null and v_has) then
    v_out := array_append(v_out, case
      when coalesce(p.office_unavailable, false)
        then 'Office：この商品はOfficeの追加に対応できません。'
      when coalesce(p.office_supported, false)
        then 'Office：ご希望に応じてOffice付きでご用意できます。お申し込み時にお知らせください。'
      else 'Office：Officeの有無はお申し込み時にご希望をお知らせください。ご希望に応じてOffice環境をご案内します。'
    end);
  end if;

  -- ④ 付属品・接続まわり
  if nullif(btrim(coalesce(p.accessories,'')),'') is not null then
    v_out := array_append(v_out,
      case when v_form = 'monitor' then '接続・付属品：' else '付属品：' end || btrim(p.accessories));
  end if;

  -- ⑤ 中古品としての状態
  v_out := array_append(v_out, '状態：' || coalesce(nullif(btrim(coalesce(p.condition_note,'')), ''),
    '中古品です。動作を確認したうえで、クリーニングしてお渡しします。外観に使用に伴う小傷がある場合があります。'));

  -- ⑥ 希望を送ってもらう案内
  v_out := array_append(v_out,
    'ご希望の' || v_unit || '・利用期間'
    || case when v_form in ('notebook','desktop') or (v_form is null and v_has) then '・Officeの有無' else '' end
    || 'をお知らせください。在庫・調達状況を確認のうえ担当者よりご案内します。');

  return array_to_string(v_out, E'\n');
end $$;

comment on function public.inv_rental_text is
  'レンタル向け説明を、商品のかたち（ノートPC／デスクトップPC／モニター／周辺機器）ごとのひな形で組み立てる。
   OfficeとPC向けの言い回しはPCのときだけ使う。スペックが足りない商品は、推測せずに
   条件を伺う文章にする。楽天の販売用の文は使わない。';

-- ------------------------------------------------------------
-- 37-4) 区分の設定（/zaikoの商品詳細から）
-- ------------------------------------------------------------
create or replace function public.inv_product_rental_form_set(
  p_code        text,
  p_form        text default null,
  p_listing     text default null,
  p_office_ng   boolean default null
) returns public.inventory_products
language plpgsql security invoker set search_path = public, pg_catalog as $$
declare
  pr public.inventory_products;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  if p_form is not null and nullif(btrim(p_form),'') is not null
     and btrim(p_form) not in ('notebook','desktop','monitor','peripheral','other') then
    raise exception '知らない区分です（%）', p_form;
  end if;
  if p_listing is not null and btrim(p_listing) not in ('standalone','option','not_public') then
    raise exception '知らない出しかたです（%）', p_listing;
  end if;
  update public.inventory_products
     set rental_form         = case when p_form is null then rental_form
                                    else nullif(btrim(p_form), '') end,
         rental_listing_type = coalesce(nullif(btrim(coalesce(p_listing,'')), ''), rental_listing_type),
         office_unavailable  = coalesce(p_office_ng, office_unavailable)
   where code = p_code
  returning * into pr;
  if not found then
    raise exception '商品が見つかりません（%）', p_code;
  end if;
  return pr;
end $$;

comment on function public.inv_product_rental_form_set is
  '商品のレンタル区分（かたち・8ECでの出しかた・Office不可）を設定する。渡さなかった項目は変えない。';

-- ------------------------------------------------------------
-- 37-5) 区分が決まっていない公開商品を洗い出す
--     機械的に公開してよいかを人が確認するための一覧。
-- ------------------------------------------------------------
create or replace function public.inv_rental_unclassified()
returns table (code text, name text, rental_form text, listing_type text, 推定 text, 手がかり text)
language sql stable set search_path = public, pg_catalog as $$
  select p.code, coalesce(p.name, p.model), p.rental_form, p.rental_listing_type,
         coalesce(public.inv_rental_form(p), '推定できません'),
         nullif(concat_ws(' / ', nullif(p.cpu,''), nullif(p.memory_size,''),
                          nullif(p.storage_capacity,''), nullif(p.screen_size,''), nullif(p.os,'')), '')
    from public.inventory_products p
   where p.kind = 'individual'
     and coalesce(p.rental_enabled, false)
     and p.rental_form is null
   order by p.code;
$$;

comment on function public.inv_rental_unclassified is
  'レンタル区分（rental_form）が未設定のまま公開している商品の一覧。
   rental_enabled=true だから機械的に公開してよい、とはしないための確認用。';

grant execute on function public.inv_rental_form(public.inventory_products) to authenticated;
grant execute on function public.inv_product_rental_form_set(text,text,text,boolean) to authenticated;
grant execute on function public.inv_rental_unclassified() to authenticated;


-- ------------------------------------------------------------
-- 37-6) 公開カタログに区分を足し、単品レンタルの商品だけを出す
-- ------------------------------------------------------------
drop view if exists public.inv_public_catalog;
create view public.inv_public_catalog as
with avail as (
  select product_code,
         count(*) filter (where status = '在庫'
                            and coalesce(rental_eligible, false)) as rental_available
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
  -- 事実としてのスペック（条件で選んでもらうために出す）
  p.cpu, p.cpu_gen, p.memory_size, p.storage_type, p.storage_capacity,
  p.screen_size, p.os, p.webcam, p.wifi, p.bluetooth, p.numpad, p.accessories,
  p.condition_note, p.office_supported,
  p.rental_form, p.rental_listing_type,
  -- レンタル（8EC）。台数は出さず、用意できるかどうかだけ
  coalesce(p.rental_enabled, false)                                 as rental_enabled,
  coalesce(p.procurement_available, false)                          as procurement_available,
  case when coalesce(a.rental_available, 0) > 0 then 'ご案内可能'
       when coalesce(p.procurement_available, false) then '取り寄せ可能'
       else 'ご相談ください' end                                    as availability,
  p.rental_price_month, p.rental_min_months, p.trial_eligible, p.rental_tags,
  -- 8ECが出す説明はレンタル向けの文だけ（楽天の販売用の文は出さない）
  nullif(btrim(coalesce(p.rental_description,'')), '')              as rental_description,
  p.updated_at
from public.inventory_products p
left join public.inventory_categories c on c.id = p.category_id
left join avail a on a.product_code = p.code
where p.kind = 'individual'
  and coalesce(p.rental_enabled, false) = true
  -- 単品でレンタルできる商品だけをカードに出す。
  -- option（PCレンタルのオプション。セキュリティワイヤーなど）と
  -- not_public は、商品カードとしては公開しない
  and coalesce(p.rental_listing_type, 'standalone') = 'standalone';

comment on view public.inv_public_catalog is
  '8ECトップ／8RENTが読む公開カタログ。rental_enabled=true の商品だけを出す。
   在庫数（available / rental_available / total_owned）と楽天の販売情報
   （sale_listed / sale_available / sale_url / sale_price）は公開しない。
   用意できるかどうかは availability（ご案内可能／取り寄せ可能／ご相談ください）だけで表す。
   説明は rental_description（レンタル向けに作り直した文）のみ。
   rental_listing_type が standalone の商品だけを出す（option・not_public は出さない）。
   社内で数量を見るときは inv_channel_stock_feed（authenticated専用）を使う。';

grant select on public.inv_public_catalog to anon, authenticated;

commit;
