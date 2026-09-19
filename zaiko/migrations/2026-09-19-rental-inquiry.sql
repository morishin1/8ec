-- ============================================================
-- 8EC/8RENTの公開側を「在庫販売型」から「法人向けレンタル相談型」へ
--   2026-09-19（2026-09-19-sale-flow.sql の後に流す）
--
--   何度流しても同じ結果になる（add column if not exists / create or replace）。
--
--   入っているもの
--     1) sale_description / condition_note / rental_description_manual
--     2) inv_rental_text()（構造化スペックからレンタル向け説明を自動生成）
--     3) inv_product_rental_description_set() / inv_rental_text_fill()
--     4) inv_public_catalog から 在庫数 と 楽天の販売情報 を外す
--        （availability＝ご案内可能／取り寄せ可能／ご相談ください だけにする）
--     5) inv_rental_request_create()（希望受付。実在庫は動かさない）
--     6) inv_rental_set_status()（希望受付→在庫・調達確認→個体割当→レンタル確定→貸出中）
--     7) inv_rental_allocate()（ここではじめて実在庫を確保する）
--     8) 楽天同期は事実情報だけ。商品説明の原文は sale_description へ
--
--   実行後にレンタル向け説明をまとめて作る（人が直したものは触りません）
--     select public.inv_rental_text_fill(true);
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 35-1) 楽天の販売用説明は、8ECの表示とは別に持つ
--
--     楽天の商品説明には「領収書発行可能」「メーカー保証なし」「返品について」
--     「必ず商品写真をご確認ください」など、販売向けの文言が多く入っている。
--     8RENT（レンタル）の画面にそのまま出すものではないので、原文は
--     sale_description に置いて保持だけし、公開画面には出さない。
--     8ECが出すのは rental_description（レンタル向けに作り直した文）だけ。
-- ------------------------------------------------------------
alter table public.inventory_products
  add column if not exists sale_description text,
  add column if not exists condition_note text,
  add column if not exists rental_description_manual boolean not null default false;

comment on column public.inventory_products.condition_note is
  '中古品としての状態（事実情報）。楽天の説明文からではなく、構造化して入れる。';

comment on column public.inventory_products.sale_description is
  'モール（楽天など）の商品説明の原文。販売用のデータとして持つだけで、8ECの公開画面には出さない。';
comment on column public.inventory_products.rental_description_manual is
  'レンタル向け説明を人が直したか。true のものは自動生成でも楽天同期でも上書きしない。';

-- ------------------------------------------------------------
-- 35-2) レンタル向け説明の自動生成
--
--     楽天の文をそのまま使わず、構造化済みのスペックから組み立てる。
--       1 どんな用途に向いているか
--       2 主な仕様
--       3 Office
--       4 付属品
--       5 中古品としての状態
--       6 希望台数・利用期間を送ってもらう案内
--     分かっている項目だけを書く（無い項目は書かない＝嘘を書かない）。
-- ------------------------------------------------------------
create or replace function public.inv_rental_text(p_code text)
returns text
language plpgsql stable set search_path = public as $$
declare
  p        public.inventory_products;
  v_screen numeric;
  v_mem    numeric;
  v_use    text;
  v_spec   text[] := '{}';
  v_out    text[] := '{}';
  v_office text;
  v_cond   text;
begin
  select * into p from public.inventory_products where code = p_code;
  if not found then
    return null;
  end if;

  v_screen := nullif(regexp_replace(coalesce(p.screen_size,''), '[^0-9.]', '', 'g'), '')::numeric;
  v_mem    := nullif(regexp_replace(coalesce(p.memory_size,''), '[^0-9]',   '', 'g'), '')::numeric;

  -- 1) どんな用途に向いているか。画面の大きさとメモリから、言い切れる範囲だけ書く
  v_use := case
    when v_screen is null then null
    when v_screen <= 13.5 then coalesce(p.screen_size,'') || 'の持ち運びやすいノートPC。'
    when v_screen <= 14.9 then coalesce(p.screen_size,'') || 'の標準的なサイズのノートPC。'
    else coalesce(p.screen_size,'') || 'の大画面ノートPC。'
  end;
  if v_use is not null then
    v_use := v_use || case
      when p.cpu is null and v_mem is null then 'オフィスワークの基本的な用途に向いています。'
      when v_mem is not null and v_mem >= 16 then
        coalesce(p.cpu || '・', '') || 'メモリ' || coalesce(p.memory_size,'') ||
        'を搭載し、複数アプリを使う事務作業やオンライン会議にも対応しやすい構成です。'
      when v_mem is not null then
        coalesce(p.cpu || '・', '') || 'メモリ' || coalesce(p.memory_size,'') ||
        'を搭載し、文書作成・表計算・オンライン会議などの事務作業に向いた構成です。'
      else coalesce(p.cpu, '') || 'を搭載しています。'
    end;
    v_out := array_append(v_out, v_use);
  end if;

  -- 2) 主な仕様。分かっているものだけを並べる
  if nullif(btrim(coalesce(p.cpu,'')),'')  is not null then v_spec := array_append(v_spec, btrim(p.cpu)); end if;
  if nullif(btrim(coalesce(p.memory_size,'')),'') is not null then v_spec := array_append(v_spec, btrim(p.memory_size)); end if;
  if nullif(btrim(coalesce(p.storage_capacity,'')),'') is not null then
    v_spec := array_append(v_spec, btrim(coalesce(p.storage_type || ' ', '') || p.storage_capacity));
  end if;
  if nullif(btrim(coalesce(p.screen_size,'')),'') is not null then v_spec := array_append(v_spec, btrim(p.screen_size)); end if;
  if nullif(btrim(coalesce(p.os,'')),'') is not null then v_spec := array_append(v_spec, btrim(p.os)); end if;
  if p.webcam   is true then v_spec := array_append(v_spec, 'Webカメラ'); end if;
  if p.wifi     is true then v_spec := array_append(v_spec, 'Wi-Fi'); end if;
  if p.bluetooth is true then v_spec := array_append(v_spec, 'Bluetooth'); end if;
  if p.numpad   is true then v_spec := array_append(v_spec, 'テンキー'); end if;
  if coalesce(array_length(v_spec, 1), 0) > 0 then
    v_out := array_append(v_out, '主な仕様：' || array_to_string(v_spec, ' / '));
  end if;

  -- 3) Office。付けられるかどうかは申込のオプションとして伝える
  v_office := case when coalesce(p.office_supported, false)
    then 'Office：ご希望に応じてOffice付きでご用意できます（申込時にお選びください）。'
    else 'Office：この機種はOfficeなしでのご用意となります。' end;
  v_out := array_append(v_out, v_office);

  -- 4) 付属品
  if nullif(btrim(coalesce(p.accessories,'')),'') is not null then
    v_out := array_append(v_out, '付属品：' || btrim(p.accessories));
  end if;

  -- 5) 中古品としての状態
  v_cond := nullif(btrim(coalesce(p.condition_note,'')), '');
  v_out := array_append(v_out, '状態：' || coalesce(v_cond,
    '中古品です。動作を確認したうえで、クリーニングしてお渡しします。外観に使用に伴う小傷がある場合があります。'));

  -- 6) 希望を送ってもらう案内
  v_out := array_append(v_out,
    'ご希望の台数・利用期間・Officeの有無をお知らせください。在庫・調達状況を確認のうえ担当者よりご案内します。');

  return array_to_string(v_out, E'\n');
end $$;

comment on function public.inv_rental_text is
  'レンタル向け説明を、構造化済みのスペックから組み立てる。楽天の販売用の文は使わない。
   分かっている項目だけを書く（用途／主な仕様／Office／付属品／状態／希望の送りかた）。';

-- ------------------------------------------------------------
-- 35-3) レンタル向け説明の保存（/zaikoの商品詳細から）
--     人が直したものは manual を立てて、自動生成でも楽天同期でも上書きしない。
-- ------------------------------------------------------------
create or replace function public.inv_product_rental_description_set(
  p_code   text,
  p_text   text default null,
  p_manual boolean default true
) returns public.inventory_products
language plpgsql security invoker set search_path = public as $$
declare
  pr public.inventory_products;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  update public.inventory_products
     set rental_description        = nullif(btrim(coalesce(p_text,'')), ''),
         rental_description_manual = coalesce(p_manual, true)
   where code = p_code
  returning * into pr;
  if not found then
    raise exception '商品が見つかりません（%）', p_code;
  end if;
  return pr;
end $$;

comment on function public.inv_product_rental_description_set is
  'レンタル向け説明を入れ直す。p_manual=true（人が直した）なら、以後は自動生成・楽天同期で上書きしない。';

-- まだ手を入れていない商品に、自動生成のレンタル向け説明をまとめて入れる
create or replace function public.inv_rental_text_fill(p_only_empty boolean default true)
returns integer
language plpgsql security invoker set search_path = public as $$
declare
  v_n integer := 0;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  update public.inventory_products p
     set rental_description = public.inv_rental_text(p.code)
   where p.kind = 'individual'
     and coalesce(p.rental_description_manual, false) = false
     and (not coalesce(p_only_empty, true)
          or nullif(btrim(coalesce(p.rental_description,'')), '') is null);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

comment on function public.inv_rental_text_fill is
  '人が直していない商品のレンタル向け説明を、自動生成で埋める。p_only_empty=false なら作り直す。';

-- ------------------------------------------------------------
-- 35-4) 公開カタログ：在庫数と楽天の販売情報を出さない
--
--     8ECは「いまある在庫から1台選ぶサイト」ではなく、
--     「必要なスペック・台数・期間を送ってもらい、こちらで用意するサービス」。
--     法人のお客様に「残り1台」と見せると複数台を借りられない印象になるので、
--     実在庫数（available / rental_available / total_owned）は公開しない。
--     楽天は裏側の販売チャネルなので、掲載・販売価格・商品URL・販売可能台数も出さない
--     （sale_listed / sale_available / sale_url は内部の inv_channel_stock_feed に残す）。
--
--     代わりに出すのは、数を伴わない状態だけ：
--       ご案内可能   … いま貸せる個体がある
--       取り寄せ可能 … 在庫は無いが調達して用意できる
--       ご相談ください … どちらでもない（それでも希望は受け付ける）
--
--     説明文は rental_description（レンタル向けに作り直した文）だけを出す。
--     楽天の販売用の文（sale_description / description）は公開しない。
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
  and coalesce(p.rental_enabled, false) = true;

comment on view public.inv_public_catalog is
  '8ECトップ／8RENTが読む公開カタログ。rental_enabled=true の商品だけを出す。
   在庫数（available / rental_available / total_owned）と楽天の販売情報
   （sale_listed / sale_available / sale_url / sale_price）は公開しない。
   用意できるかどうかは availability（ご案内可能／取り寄せ可能／ご相談ください）だけで表す。
   説明は rental_description（レンタル向けに作り直した文）のみ。
   社内で数量を見るときは inv_channel_stock_feed（authenticated専用）を使う。';

grant select on public.inv_public_catalog to anon, authenticated;

-- ------------------------------------------------------------
-- 35-5) 申込は「希望条件の送信」にする
--
--     お客様に個体を選ばせないのはこれまでどおりだが、申込の時点で
--     個体を予約することもやめる（法人は台数・期間の相談から始まるため）。
--       希望受付      … 条件と台数だけを受け取った状態。在庫は動かさない
--       在庫・調達確認 … 社内で用意できるか確かめている
--       個体割当      … 実在庫を確保した（個体が 予約中 になる）
--       レンタル確定  … お客様と条件が決まった
--       貸出中        … 発送した
--       返却済み／キャンセル
--     在庫が無くても希望受付はできる。無い個体を仮に作って予約することはしない。
-- ------------------------------------------------------------
create or replace function public.inv_rental_request_create(
  p_codes      text[],
  p_name       text,
  p_qty        integer default 1,
  p_company    text default null,
  p_email      text default null,
  p_phone      text default null,
  p_start      date    default null,
  p_months     integer default null,
  p_office     boolean default false,
  p_message    text    default null,
  p_conditions jsonb   default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_codes  text[];
  v_keys   text[];
  v_key    text;
  v_req_id bigint;
begin
  if p_name is null or btrim(p_name) = '' then
    raise exception 'お名前を入力してください';
  end if;
  if coalesce(p_qty, 1) < 1 or coalesce(p_qty, 1) > 500 then
    raise exception '台数は1〜500台でお願いします（それ以上はご相談ください）';
  end if;

  -- 機種が指定されていれば、公開中のものだけに絞る。指定が無くても受け付ける
  -- （「条件だけ送る」相談も8RENTの入口なので断らない）
  if p_codes is not null and coalesce(array_length(p_codes, 1), 0) > 0 then
    select array_agg(code order by code), array_agg(distinct public.inv_model_key(maker, model, code))
      into v_codes, v_keys
      from public.inventory_products
     where code = any(p_codes) and kind = 'individual' and coalesce(rental_enabled, false);
    if coalesce(array_length(v_keys, 1), 0) > 1 then
      raise exception '別々の機種はまとめて申し込めません';
    end if;
    v_key := v_keys[1];
  end if;

  insert into public.inventory_rental_requests
    (product_code, item_id, item_ids, qty, procure_qty, office, model_key, conditions,
     customer_name, company, email, phone, start_date, months, message, status)
  values
    (v_codes[1], null, '{}', p_qty, p_qty, coalesce(p_office, false), v_key,
     coalesce(p_conditions, '{}'::jsonb),
     btrim(p_name), nullif(btrim(coalesce(p_company,'')),''),
     nullif(btrim(coalesce(p_email,'')),''), nullif(btrim(coalesce(p_phone,'')),''),
     p_start, p_months, nullif(btrim(coalesce(p_message,'')),''), '希望受付')
  returning id into v_req_id;

  return jsonb_build_object('request_id', v_req_id, 'status', '希望受付', 'qty', p_qty);
end $$;

comment on function public.inv_rental_request_create is
  '8RENTからの「希望条件の送信」。条件と台数だけを受け取り、実在庫は動かさない（status=希望受付）。
   在庫が無くても受け付ける。個体の確保は社内で inv_rental_allocate を実行したときだけ行う。';

grant execute on function public.inv_rental_request_create(text[],text,integer,text,text,text,date,integer,boolean,text,jsonb) to anon;

-- ------------------------------------------------------------
-- 35-6) 申込の状態を進める（希望受付から始まる流れに合わせる）
--       希望受付 → 在庫・調達確認 → 個体割当 → レンタル確定 → 貸出中 → 返却済み
--       個体割当 は inv_rental_allocate（実在庫の確保）が行う。
--       どの段階からでもキャンセルでき、確保済みの個体は在庫へ戻す。
-- ------------------------------------------------------------
create or replace function public.inv_rental_set_status(
  p_request_id bigint,
  p_status     text
) returns public.inventory_rental_requests
language plpgsql security invoker set search_path = public as $$
declare
  r     public.inventory_rental_requests;
  it    public.inventory_items;
  v_ids text[];
  v_id  text;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  if p_status not in ('在庫・調達確認','レンタル確定','貸出中','返却済み','キャンセル') then
    raise exception '知らない状態です（%）', p_status;
  end if;

  select * into r from public.inventory_rental_requests where id = p_request_id for update;
  if not found then
    raise exception '申込が見つかりません（%）', p_request_id;
  end if;
  if r.status in ('返却済み','キャンセル') then
    raise exception 'この申込はすでに「%」で終わっています', r.status;
  end if;

  v_ids := case when coalesce(array_length(r.item_ids, 1), 0) > 0 then r.item_ids
                when r.item_id is not null then array[r.item_id]
                else '{}'::text[] end;

  if p_status = '在庫・調達確認' then
    if r.status <> '希望受付' then
      raise exception '「希望受付」の申込だけ確認中にできます（いまは %）', r.status;
    end if;

  elsif p_status = 'レンタル確定' then
    if r.status <> '個体割当' then
      raise exception '個体を割り当ててから確定してください（いまは %）', r.status;
    end if;

  elsif p_status = '貸出中' then
    if r.status <> 'レンタル確定' then
      raise exception '「レンタル確定」の申込だけ発送できます（いまは %）', r.status;
    end if;
    if coalesce(array_length(v_ids, 1), 0) = 0 then
      raise exception '個体が割り当てられていません';
    end if;
    foreach v_id in array v_ids loop
      select * into it from public.inventory_items where id = v_id for update;
      if coalesce(it.status, '') <> '予約中' then
        raise exception '予約中の個体だけ貸出中にできます（% は %）', v_id, coalesce(it.status, '個体なし');
      end if;
      update public.inventory_items
         set status = '貸出中', user_name = r.customer_name, loaned_at = now()
       where id = v_id;
    end loop;

  elsif p_status = '返却済み' then
    if coalesce(array_length(v_ids, 1), 0) = 0 then
      raise exception '個体が割り当てられていません';
    end if;
    foreach v_id in array v_ids loop
      select * into it from public.inventory_items where id = v_id for update;
      if coalesce(it.status, '') <> '貸出中' then
        raise exception '貸出中の個体だけ返却済みにできます（% は %）', v_id, coalesce(it.status, '個体なし');
      end if;
      update public.inventory_items
         set status = '在庫', user_name = null, loaned_at = null
       where id = v_id;
    end loop;

  elsif p_status = 'キャンセル' then
    -- どの段階からでも取り消せる。確保済みの個体だけ在庫に戻す（発送済みは返却で扱う）
    foreach v_id in array coalesce(v_ids, '{}'::text[]) loop
      select * into it from public.inventory_items where id = v_id for update;
      if coalesce(it.status, '') = '貸出中' then
        raise exception '発送済みです。「返却済みにする」を使ってください（% は 貸出中）', v_id;
      end if;
      if coalesce(it.status, '') = '予約中' then
        update public.inventory_items set status = '在庫' where id = v_id;
      end if;
    end loop;
  end if;

  foreach v_id in array coalesce(v_ids, '{}'::text[]) loop
    insert into public.inventory_transactions (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (public.inv_actor(), 'item', v_id, r.customer_name, 'レンタル' || p_status, r.status, p_status);
  end loop;

  update public.inventory_rental_requests set status = p_status where id = p_request_id
  returning * into r;
  return r;
end $$;

comment on function public.inv_rental_set_status is
  'レンタル申込の状態を進める（希望受付 → 在庫・調達確認 → 個体割当 → レンタル確定 → 貸出中 → 返却済み）。
   紐づく個体の状態も同じトランザクションで連動させる。';

-- ------------------------------------------------------------
-- 35-7) 個体割当。ここではじめて実在庫を確保する
-- ------------------------------------------------------------
create or replace function public.inv_rental_allocate(p_request_id bigint)
returns public.inventory_rental_requests
language plpgsql security invoker set search_path = public as $$
declare
  r       public.inventory_rental_requests;
  v_ids   text[];
  v_codes text[];
  v_code  text;
  v_item  text;
  v_need  integer;
  i       integer;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into r from public.inventory_rental_requests where id = p_request_id for update;
  if not found then
    raise exception '申込が見つかりません（%）', p_request_id;
  end if;
  if r.status not in ('希望受付','在庫・調達確認','個体割当') then
    raise exception '「%」の申込には個体を割り当てられません', r.status;
  end if;
  if r.model_key is null and r.product_code is null then
    raise exception '機種が決まっていません。先に商品を決めてから割り当ててください';
  end if;

  v_ids := case when coalesce(array_length(r.item_ids, 1), 0) > 0 then r.item_ids
                when r.item_id is not null then array[r.item_id]
                else '{}'::text[] end;
  v_need := greatest(coalesce(r.qty, 1) - coalesce(array_length(v_ids, 1), 0), 0);

  if v_need > 0 then
    select array_agg(p.code order by p.code) into v_codes
      from public.inventory_products p
     where p.kind = 'individual'
       and coalesce(p.rental_enabled, false)
       and (not coalesce(r.office, false) or coalesce(p.office_supported, false))
       and (case when r.model_key is null then p.code = r.product_code
                 else public.inv_model_key(p.maker, p.model, p.code) = r.model_key end);
    if coalesce(array_length(v_codes, 1), 0) = 0 then
      raise exception 'この機種はいまレンタルを受け付けていません（商品の8RENT掲載を確認してください）';
    end if;
    for i in 1..v_need loop
      v_item := null;
      foreach v_code in array v_codes loop
        v_item := public.inv_reserve_available_item(v_code, '予約中', true);
        exit when v_item is not null;
      end loop;
      exit when v_item is null;
      v_ids := array_append(v_ids, v_item);
      insert into public.inventory_transactions
        (actor, ref_kind, ref_id, label, action, before_value, after_value)
      values (public.inv_actor(), 'item', v_item, r.customer_name, '予約', '在庫',
              '予約中（申込 #' || r.id || '）');
    end loop;
  end if;

  update public.inventory_rental_requests
     set item_ids    = v_ids,
         item_id     = coalesce(v_ids[1], item_id),
         procure_qty = greatest(coalesce(r.qty, 1) - coalesce(array_length(v_ids, 1), 0), 0),
         status      = case when coalesce(array_length(v_ids, 1), 0) >= coalesce(r.qty, 1)
                            then '個体割当' else '在庫・調達確認' end
   where id = p_request_id
  returning * into r;
  return r;
end $$;

comment on function public.inv_rental_allocate is
  '申込に8RENT対象の在庫から個体を割り当てる。台数がそろったら「個体割当」に進む。
   足りないぶんは procure_qty に残し、仮の個体は作らない。';

-- 旧：申込と同時に在庫を押さえる入口は使わない（希望受付から始める）
drop function if exists public.inv_rental_apply(text[],text,integer,text,text,text,date,integer,boolean,text,jsonb);
drop function if exists public.inv_rental_request(text,text,text,text,text,date,integer,text);

grant execute on function public.inv_rental_allocate(bigint) to authenticated;
grant execute on function public.inv_rental_text(text) to authenticated;
grant execute on function public.inv_rental_text_fill(boolean) to authenticated;
grant execute on function public.inv_product_rental_description_set(text,text,boolean) to authenticated;

-- ------------------------------------------------------------
-- 35-8) 楽天から取り込むのは事実情報だけにする
--     商品説明の原文は sale_description に置き、8ECが出す description /
--     rental_description には触らない（レンタル向けの文は自前で作る）。
--     CPU・メモリ・ストレージ・画面・OS・カメラ・Wi-Fi・Bluetooth・テンキー・
--     Office・付属品などの構造化項目は、これまでどおり空欄だけを埋める。
-- ------------------------------------------------------------
create or replace function public.inv_rakuten_apply_one(
  p_code text,
  p_item jsonb
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  ex           jsonb := coalesce(p_item->'extracted', '{}'::jsonb);
  v_code_saved   boolean := false;
  v_url_mismatch boolean := false;
  v_old_url      text;
  v_item_code  text  := nullif(btrim(coalesce(p_item->>'item_code','')), '');
  v_url        text  := nullif(btrim(coalesce(p_item->>'item_url','')), '');
  v_price      numeric;
  before_row   public.inventory_products;
  after_row    public.inventory_products;
  before_snap  jsonb;
  after_snap   jsonb;
  v_chan_new   boolean := false;
  v_changed    boolean;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;

  select * into before_row from public.inventory_products where code = p_code for update;
  if not found then
    raise exception '商品が見つかりません（%）', p_code;
  end if;
  before_snap := to_jsonb(before_row) - 'updated_at' - 'rakuten_synced_at';

  v_price := nullif(p_item->>'price', '')::numeric;

  update public.inventory_products set
    maker             = coalesce(nullif(maker,''), nullif(p_item->>'maker','')),
    model             = coalesce(nullif(model,''), nullif(p_item->>'model','')),
    -- モールの商品説明は販売向けの文言（領収書・保証・返品・会社概要など）が多い。
    -- 8ECのレンタル画面には出さないので、原文は sale_description に置くだけにする。
    -- description（8EC以外でも使う一般の説明）と rental_description には触らない
    sale_description  = coalesce(nullif(sale_description,''), nullif(p_item->>'caption','')),
    -- 画像は images（楽天から取り込んだ写真）にだけ入れる。image_url は
    -- 「人が/zaikoで指定したメイン画像」専用にして、同期では一切触らない。
    -- 公開ページは image_url → images[0] の順に見るので、これで写真は出る
    -- 縮小指定（?_ex=128x128）が付いていたらここでも外す。Edge Function側でも
    -- 外しているが、古い版から呼ばれても粗い画像を保存しないための保険
    images            = case when jsonb_array_length(coalesce(images,'[]'::jsonb)) = 0
                              and jsonb_typeof(p_item->'images') = 'array'
                         then (select coalesce(jsonb_agg(u order by ord), '[]'::jsonb)
                                 from (select public.inv_img_hires(x) as u, min(ord) as ord
                                         from jsonb_array_elements_text(p_item->'images')
                                              with ordinality t(x, ord)
                                        where btrim(x) <> ''
                                        group by 1) q)
                         else images end,
    cpu               = coalesce(nullif(cpu,''), nullif(ex->>'cpu','')),
    cpu_gen           = coalesce(nullif(cpu_gen,''), nullif(ex->>'cpu_gen','')),
    memory_size       = coalesce(nullif(memory_size,''), nullif(ex->>'memory','')),
    storage_type      = coalesce(nullif(storage_type,''), nullif(ex->>'storage_type','')),
    storage_capacity  = coalesce(nullif(storage_capacity,''), nullif(ex->>'storage_capacity','')),
    screen_size       = coalesce(nullif(screen_size,''), nullif(ex->>'screen_size','')),
    os                = coalesce(nullif(os,''), nullif(ex->>'os','')),
    office_supported  = coalesce(office_supported, (nullif(ex->>'office_supported',''))::boolean, false),
    webcam            = coalesce(webcam, (nullif(ex->>'webcam',''))::boolean),
    wifi              = coalesce(wifi, (nullif(ex->>'wifi',''))::boolean),
    bluetooth         = coalesce(bluetooth, (nullif(ex->>'bluetooth',''))::boolean),
    numpad            = coalesce(numpad, (nullif(ex->>'numpad',''))::boolean),
    accessories       = coalesce(nullif(accessories,''), nullif(ex->>'accessories','')),
    rakuten_synced_at = now()
  where code = p_code
  returning * into after_row;

  after_snap := to_jsonb(after_row) - 'updated_at' - 'rakuten_synced_at';
  v_changed := before_snap is distinct from after_snap;

  -- 出品先（楽天）への紐付けは、商品×チャネルの掲載情報テーブルへ。
  -- 楽天のitemCodeは external_item_code に入れる（sku はスタッフ入力欄なので混同しない）。
  -- 初回だけ作る。すでにあれば external_item_code/url が空のときだけ埋める
  -- （出品状態・価格・skuなど、スタッフが手で入れた値は変えない）
  if v_item_code is not null then
    if not exists (select 1 from public.inventory_channel_listings
                    where product_code = p_code and channel = 'rakuten') then
      insert into public.inventory_channel_listings
        (product_code, channel, state, external_item_code, url, price, api_synced_at, api_sync_status,
         url_checked_at, updated_at)
      values (p_code, 'rakuten', '出品中', v_item_code, v_url, v_price, now(), 'ok', now(), now());
      v_chan_new := true;
      v_code_saved := true;
    else
      -- 保存済みURLと、APIが返した正式なURLを見比べる。
      -- 違っていたら勝手に書き換えず、更新候補（url_candidate）として残して人に見せる
      -- （古い商品ページのURLが残っていると、itemCodeが分かるまで商品を見つけられないため）
      select nullif(btrim(coalesce(url,'')), '') into v_old_url
        from public.inventory_channel_listings
       where product_code = p_code and channel = 'rakuten';
      if v_url is not null and v_old_url is not null
         and public.inv_norm_url(v_old_url) is distinct from public.inv_norm_url(v_url) then
        v_url_mismatch := true;
      end if;
      -- 掲載URLしか無かった商品も、ここでAPIが返した正式なitemCodeを覚える。
      -- 次回からはURLの総当たりではなく、itemCodeで直接照合できる
      -- （itemCodeをURLから推測することはしない）
      select nullif(btrim(coalesce(external_item_code,'')), '') is null
        into v_code_saved
        from public.inventory_channel_listings
       where product_code = p_code and channel = 'rakuten';

      update public.inventory_channel_listings set
        external_item_code = coalesce(nullif(btrim(coalesce(external_item_code,'')), ''), v_item_code),
        url = coalesce(url, v_url),                       -- 空のときだけ入れる
        url_candidate = case when v_url_mismatch then v_url else null end,  -- 違っていれば候補に、同じなら消す
        url_checked_at = now(),
        api_synced_at = now(),
        api_sync_status = 'ok',
        updated_at = case when external_item_code is null or url is null or v_url_mismatch
                          then now() else updated_at end
      where product_code = p_code and channel = 'rakuten';

      if v_url_mismatch then
        insert into public.inventory_transactions
          (actor, ref_kind, ref_id, label, action, before_value, after_value)
        values ('楽天連携', 'product', p_code, coalesce(after_row.name, after_row.model),
                '掲載URL差異', v_old_url, v_url || '（更新候補）');
      end if;
    end if;
  end if;

  if v_changed or v_chan_new then
    insert into public.inventory_transactions (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values ('楽天連携', 'product', p_code, coalesce(after_row.name, after_row.model), '楽天連携で補完',
            null, coalesce(v_item_code, ''));
  end if;

  return jsonb_build_object(
    'product', to_jsonb(after_row),
    'changed', (v_changed or v_chan_new),
    -- 掲載URLしか無かった商品に、正式なitemCodeを保存できたか
    'external_item_code_saved', coalesce(v_code_saved, false),
    'external_item_code', v_item_code,
    -- 保存済みURLが楽天の正式URLと違っていたか（違えば url_candidate に入れてある）
    'url_mismatch', coalesce(v_url_mismatch, false),
    'url_saved', v_old_url,
    'url_candidate', case when v_url_mismatch then v_url end,
    -- 画像が0枚から入ったか（同期結果の「画像取得成功 ○件」に使う）
    'images_added', (jsonb_array_length(coalesce(before_row.images,'[]'::jsonb)) = 0
                     and jsonb_array_length(coalesce(after_row.images,'[]'::jsonb)) > 0),
    'image_count', jsonb_array_length(coalesce(after_row.images,'[]'::jsonb)));
end $$;

grant execute on function public.inv_rakuten_apply_one(text,jsonb) to authenticated;

commit;
