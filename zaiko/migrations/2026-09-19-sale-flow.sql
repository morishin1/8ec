-- ============================================================
-- 売却の入力ミスを減らし、売却後の販売サイト対応をたどれるようにする
--   2026-09-19（2026-09-19-rakuten-orders.sql の後に流す）
--
--   何度流しても同じ結果になる（add column if not exists / create or replace）。
--
--   入っているもの
--     1) inventory_items.sold_channel（どこへ売ったか）
--     2) 販売サイトの管理画面URL（listingのadmin_url と チャネルごとの設定）
--        ※ モールの管理画面URLは推測で直書きせず、店舗が確かめて入れる値として持つ
--     3) inv_item_op の売却履歴に 売却先・原価・利益 を載せる
--     4) inv_item_sell()（売却先つきで1台を売却済にする）
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 34-1) 売却の記録を増やす
--     どこへ売ったか（売却先）を個体に持たせる。履歴だけを見ても
--     「どこへ・いくらで・原価は・利益は」が分かるようにする。
-- ------------------------------------------------------------
alter table public.inventory_items add column if not exists sold_channel text;

comment on column public.inventory_items.sold_channel is
  'どこへ売ったか（楽天／Amazon／メルカリ／ヤフオク／Yahoo!フリマ／8EC・店頭／法人販売／自由入力）。
   出品先（inventory_channels）とは別で、実際に売れた先を1つだけ持つ。';

-- ------------------------------------------------------------
-- 34-2) 販売サイトの管理画面URL
--
--     売れたあと、販売サイト側の在庫を直しにいく導線をここから作る。
--     モールの管理画面URLは店舗の契約や画面改定で変わるので、
--     コードに直書きせず、店舗ごとに設定してもらう値として持つ。
--       admin_home_url          … 管理画面のトップ（ログイン先）
--       admin_item_url_template … 商品ごとの画面。{manage} {sku} {item_code} を差し替える
--     商品ごとに確実なURLが分かっているときは、listing の admin_url が最優先。
--
--     いまは人が管理画面で在庫を直す運用。将来モールのAPIで在庫数を
--     更新できるようになったら、この設定行に接続情報を足して自動化する
--     （画面側は「販売サイト側の対応済み」を押す操作のままでよい）。
-- ------------------------------------------------------------
alter table public.inventory_channel_listings add column if not exists admin_url text;

comment on column public.inventory_channel_listings.admin_url is
  'その商品の、販売サイト管理画面の直リンク（人が確認して入れる）。空ならチャネルの設定から組み立てる。';

create table if not exists public.inventory_channel_settings (
  channel                 text primary key,
  label                   text,
  admin_home_url          text,
  admin_item_url_template text,
  auto_stock_update       boolean not null default false,  -- 将来APIで在庫を自動更新するとき true
  note                    text,
  updated_at              timestamptz default now()
);

comment on table public.inventory_channel_settings is
  '販売サイトごとの設定。管理画面URLは店舗の契約や画面改定で変わるため、コードに直書きせずここに持つ。
   auto_stock_update は将来モールのAPIで在庫数を自動更新できるようになったときの切り替え用。';

drop trigger if exists inventory_channel_settings_touch on public.inventory_channel_settings;
create trigger inventory_channel_settings_touch before update on public.inventory_channel_settings
  for each row execute function public.inv_touch();

-- 既定はURL空。実際のURLは各店舗が管理画面で確かめて入れる（推測で入れない）
insert into public.inventory_channel_settings (channel, label, note) values
  ('rakuten',    '楽天',          '楽天RMSの商品管理画面。RMSにログインして対象商品を開き、そのURLを設定してください。'),
  ('amazon',     'Amazon',        'セラーセントラルの在庫管理画面のURLを設定してください。'),
  ('mercari',    'メルカリ',      'メルカリShopsの商品編集画面のURLを設定してください。'),
  ('yahuoku',    'ヤフオク',      'Yahoo!オークションの出品管理画面のURLを設定してください。'),
  ('yahoo_free', 'ヤフーフリマ',  'Yahoo!フリマの出品管理画面のURLを設定してください。'),
  ('other',      'その他',        null),
  ('notion',     'Notion',        null)
on conflict (channel) do nothing;

alter table public.inventory_channel_settings enable row level security;

drop policy if exists inventory_channel_settings_read on public.inventory_channel_settings;
create policy inventory_channel_settings_read on public.inventory_channel_settings
  for select to authenticated using (public.inv_role() in ('admin','member','viewer'));

create or replace function public.inv_channel_settings_set(
  p_channel  text,
  p_home     text default null,
  p_template text default null,
  p_note     text default null
) returns public.inventory_channel_settings
language plpgsql security invoker set search_path = public as $$
declare
  r public.inventory_channel_settings;
begin
  if not public.inv_is_admin() then
    raise exception '販売サイトの設定は管理者だけが変えられます';
  end if;
  insert into public.inventory_channel_settings (channel, admin_home_url, admin_item_url_template, note)
  values (p_channel, nullif(btrim(coalesce(p_home,'')),''),
          nullif(btrim(coalesce(p_template,'')),''), nullif(btrim(coalesce(p_note,'')),''))
  on conflict (channel) do update
    set admin_home_url          = nullif(btrim(coalesce(p_home,'')),''),
        admin_item_url_template = nullif(btrim(coalesce(p_template,'')),''),
        note                    = coalesce(nullif(btrim(coalesce(p_note,'')),''), public.inventory_channel_settings.note)
  returning * into r;
  return r;
end $$;

comment on function public.inv_channel_settings_set is
  '販売サイトの管理画面URL（トップ・商品ごとのひな形）を設定する。管理者だけ。';

-- ------------------------------------------------------------
-- 34-2b) 売却の履歴に 売却先・原価・利益 を載せる（inv_item_op の作り直し）
--     setup.sql の最新の定義をそのまま持ってきて、売却の行だけ足している。
-- ------------------------------------------------------------
create or replace function public.inv_item_op(
  p_item_id text,
  p_action  text,
  p_value   text default null,
  p_note    text default null
) returns public.inventory_items
language plpgsql
security invoker
set search_path = public
as $$
declare
  it       public.inventory_items;
  actor    text := public.inv_actor();
  v_before text;
  v_after  text;
  st_id    bigint;
  v_sold   numeric;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;

  select * into it from public.inventory_items where id = p_item_id for update;
  if not found then
    raise exception '商品が見つかりません（%）', p_item_id;
  end if;

  if p_action = '貸出' then
    if coalesce(p_value,'') = '' then raise exception '利用者を選んでください'; end if;
    if it.status <> '在庫' then raise exception '「在庫」のものだけ貸し出せます（いまは %）', it.status; end if;
    v_before := it.status;
    v_after  := '貸出中（' || p_value || '）';
    update public.inventory_items
       set status='貸出中', user_name=p_value, loaned_at=now()
     where id=p_item_id returning * into it;
    insert into public.inventory_loans (item_id, user_name, actor) values (p_item_id, p_value, actor);

  elsif p_action = '返却' then
    if it.status <> '貸出中' then raise exception '貸出中のものだけ返却できます（いまは %）', it.status; end if;
    v_before := '貸出中（' || coalesce(it.user_name,'') || '）';
    v_after  := '在庫（' || public.inv_location_path(it.location_id) || '）';
    update public.inventory_items
       set status='在庫', user_name=null, loaned_at=null
     where id=p_item_id returning * into it;
    update public.inventory_loans set returned_at=now()
     where item_id=p_item_id and returned_at is null;

  elsif p_action = '移動' then
    if coalesce(p_value,'') = '' then raise exception '移動先を選んでください'; end if;
    v_before := public.inv_location_path(it.location_id);
    v_after  := public.inv_location_path(p_value);
    update public.inventory_items set location_id=p_value where id=p_item_id returning * into it;

  elsif p_action = '社内使用' then
    v_before := it.status;
    v_after  := '社内使用' || coalesce('（' || nullif(p_value,'') || '）', '');
    update public.inventory_items
       set status='社内使用', user_name=nullif(p_value,''), loaned_at=null
     where id=p_item_id returning * into it;

  elsif p_action = '売却' then
    -- 実際に売れた価格を受け取る。原価と突き合わせて利益が出せる。
    -- 原価が入っていない（0）ものは、売値をそのまま利益と書くと嘘になるので利益は出さない
    v_sold := nullif(regexp_replace(coalesce(p_value,''), '[^0-9.-]', '', 'g'), '')::numeric;
    v_before := it.status;
    -- 履歴だけ見て「どこへ・いくらで・原価は・利益は」が分かるようにする。
    -- 売却先（sold_channel）は inv_item_sell が先に入れている
    v_after  := '売却済'
                || coalesce('（' || nullif(btrim(coalesce(it.sold_channel,'')),'') || '）', '')
                || coalesce('（' || to_char(v_sold, 'FM9,999,999,999') || '円'
                   || case when coalesce(it.cost,0) > 0
                        then '／原価 ' || to_char(it.cost, 'FM9,999,999,999') || '円'
                          || '／利益 ' || to_char(v_sold - it.cost, 'FM9,999,999,999') || '円'
                        else '' end || '）', '');
    update public.inventory_items
       set status='売却済', sold_price=coalesce(v_sold, it.sold_price), user_name=null, loaned_at=null
     where id=p_item_id returning * into it;

  elsif p_action = '予約解除' then
    -- 楽天など販売チャネルの受注確保（inv_sale_reserve）を、発送前に取り消す。
    -- 8RENTの予約中はここでは扱わない（inv_rental_set_status の「キャンセル」を使う）
    if it.status <> '販売予約' then
      raise exception '販売予約中のものだけ予約解除できます（いまは %）', it.status;
    end if;
    v_before := it.status;
    v_after  := '在庫';
    update public.inventory_items set status='在庫' where id=p_item_id returning * into it;

  elsif p_action in ('状態変更','廃棄') then
    if p_action = '廃棄' and not public.inv_is_admin() then
      raise exception '廃棄は管理者だけができます';
    end if;
    v_before := it.status;
    v_after  := case when p_action='廃棄' then '廃棄' else coalesce(p_value, it.status) end;
    update public.inventory_items
       set status = v_after,
           user_name = case when v_after in ('貸出中','社内使用') then it.user_name else null end,
           loaned_at = case when v_after = '貸出中' then it.loaned_at else null end
     where id=p_item_id returning * into it;

  elsif p_action = '棚卸確認' then
    v_before := it.status;
    v_after  := it.status || '（確認済み）';
    update public.inventory_items set last_checked_at=now() where id=p_item_id returning * into it;
    select id into st_id from public.inventory_stocktakes where status='open' limit 1;
    if st_id is not null then
      insert into public.inventory_stocktake_items (stocktake_id, item_id, expected, checked_at)
      values (st_id, p_item_id, true, now())
      on conflict (stocktake_id, item_id) do update set checked_at = excluded.checked_at;
    end if;

  else
    raise exception '知らない操作です（%）', p_action;
  end if;

  insert into public.inventory_transactions (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (actor, 'item', p_item_id, it.name,
          case p_action when '廃棄' then '廃棄' else p_action end,
          v_before, v_after || coalesce('／' || nullif(p_note,''), ''));

  return it;
end $$;

-- ------------------------------------------------------------
-- 34-3) 売却を記録する（売却先つき）
--     状態の変更と履歴は これまでどおり inv_item_op('売却') に任せる。
--     ここは「どこへ売ったか」を先に入れてから渡すだけで、規則は二重に持たない。
-- ------------------------------------------------------------
create or replace function public.inv_item_sell(
  p_item_id text,
  p_channel text default null,
  p_price   text default null,
  p_note    text default null
) returns public.inventory_items
language plpgsql security invoker set search_path = public as $$
declare
  it public.inventory_items;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  update public.inventory_items
     set sold_channel = nullif(btrim(coalesce(p_channel,'')),'')
   where id = p_item_id;
  if not found then
    raise exception '商品が見つかりません（%）', p_item_id;
  end if;
  it := public.inv_item_op(p_item_id, '売却', p_price, p_note);
  return it;
end $$;

comment on function public.inv_item_sell is
  '売却先つきで1台を売却済にする。状態変更と履歴は inv_item_op(''売却'') と同じものを通す。';

create or replace function public.inv_listing_admin_url_set(
  p_code    text,
  p_channel text,
  p_url     text
) returns public.inventory_channel_listings
language plpgsql security invoker set search_path = public as $$
declare
  r public.inventory_channel_listings;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  update public.inventory_channel_listings
     set admin_url = nullif(btrim(coalesce(p_url,'')),'')
   where product_code = p_code and channel = p_channel
  returning * into r;
  if not found then
    raise exception 'この商品の出品情報がありません（% / %）', p_code, p_channel;
  end if;
  return r;
end $$;

comment on function public.inv_listing_admin_url_set is
  'その商品の販売サイト管理画面URL（直リンク）を入れ直す。人が管理画面で確かめた値だけを入れる。';

grant execute on function public.inv_listing_admin_url_set(text,text,text) to authenticated;

grant select on public.inventory_channel_settings to authenticated;
grant execute on function public.inv_channel_settings_set(text,text,text,text) to authenticated;
grant execute on function public.inv_item_sell(text,text,text,text) to authenticated;

commit;
