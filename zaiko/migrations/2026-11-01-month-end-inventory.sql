-- 8EC: 月末在庫の固定記録（2026-11-01）
-- 重要: 本マイグレーションを適用しても過去月末は復元しない。
-- 指定月末が過ぎた後、初回に取得した帳簿状態を変更不可で保存する。
-- 自動実行は zaiko/month-end-cron-setup.sql を別途設定する。

create table if not exists public.inventory_month_end_snapshots (
  month_end date primary key,
  captured_at timestamptz not null default now(),
  captured_by text not null,
  item_count integer not null default 0,
  quantity_units bigint not null default 0,
  saleable_units bigint not null default 0,
  cost_total numeric not null default 0,
  missing_cost_units bigint not null default 0,
  constraint inventory_month_end_last_day check (
    month_end = (date_trunc('month', month_end)::date + interval '1 month - 1 day')::date
  )
);

create table if not exists public.inventory_month_end_lines (
  month_end date not null references public.inventory_month_end_snapshots(month_end) on delete restrict,
  kind text not null check (kind in ('item','quantity')),
  ref_id text not null,
  product_code text,
  name text not null,
  model text,
  status text,
  location_id text,
  location_name text,
  qty integer not null check (qty > 0),
  unit_cost numeric,
  total_cost numeric,
  purchased_on date,
  primary key(month_end, kind, ref_id)
);

create index if not exists inv_month_end_lines_month_product_idx
  on public.inventory_month_end_lines (month_end, product_code);

alter table public.inventory_month_end_snapshots enable row level security;
alter table public.inventory_month_end_lines enable row level security;
drop policy if exists inv_month_snapshots_admin_read on public.inventory_month_end_snapshots;
create policy inv_month_snapshots_admin_read on public.inventory_month_end_snapshots
  for select to authenticated using (public.inv_is_admin());
drop policy if exists inv_month_lines_admin_read on public.inventory_month_end_lines;
create policy inv_month_lines_admin_read on public.inventory_month_end_lines
  for select to authenticated using (public.inv_is_admin());

revoke all on table public.inventory_month_end_snapshots from public, anon, authenticated;
revoke all on table public.inventory_month_end_lines from public, anon, authenticated;
grant select on public.inventory_month_end_snapshots to authenticated;
grant select on public.inventory_month_end_lines to authenticated;

-- 管理者／DBセッションだけが実行でき、同じ月の再実行は保存済みを返す。
-- 月末を過ぎてから保存するため、遅れて保存した記録は captured_at から判別できる。
create or replace function public.inv_month_end_capture(p_month_end date default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_month date := coalesce(p_month_end, date_trunc('month', (now() at time zone 'Asia/Tokyo'))::date - 1);
  v_row public.inventory_month_end_snapshots%rowtype;
begin
  if not public.inv_can_maintain() then
    raise exception '月末在庫を確定できるのは管理者だけです';
  end if;
  if v_month is null or v_month <> (date_trunc('month', v_month)::date + interval '1 month - 1 day')::date then
    raise exception '月末日を指定してください';
  end if;
  if v_today <= v_month then
    raise exception '月末が終了してから保存できます';
  end if;

  perform pg_advisory_xact_lock(24011, (extract(year from v_month)::integer * 100 + extract(month from v_month)::integer));
  select * into v_row from public.inventory_month_end_snapshots where month_end = v_month;
  if found then
    return to_jsonb(v_row);
  end if;

  insert into public.inventory_month_end_snapshots (month_end, captured_by)
  values (v_month, case when public.inv_is_db_session() then '自動処理 / DB'
                        else public.inv_actor() end);

  -- 「保有」には販売可能以外の社内使用・貸出中等を含む。売却済・廃棄は含めない。
  -- 原価不明は NULL のまま保存し、合計を過大評価しない。
  insert into public.inventory_month_end_lines
    (month_end, kind, ref_id, product_code, name, model, status,
     location_id, location_name, qty, unit_cost, total_cost, purchased_on)
  select v_month, 'item', i.id, i.product_code, i.name, i.model, i.status,
         i.location_id, l.name, 1,
         case when i.cost > 0 then i.cost else null end,
         case when i.cost > 0 then i.cost else null end,
         i.purchased_on
    from public.inventory_items i
    left join public.inventory_locations l on l.id = i.location_id
   where i.status not in ('売却済', '廃棄');

  -- 数量管理品は別枠。単価未設定は原価未登録として記録する。
  insert into public.inventory_month_end_lines
    (month_end, kind, ref_id, product_code, name, model, status,
     location_id, location_name, qty, unit_cost, total_cost, purchased_on)
  select v_month, 'quantity', p.code, p.code, p.name, p.model, '数量管理',
         p.location_id, l.name, p.qty,
         case when p.unit_price > 0 then p.unit_price else null end,
         case when p.unit_price > 0 then p.unit_price * p.qty else null end,
         null
    from public.inventory_products p
    left join public.inventory_locations l on l.id = p.location_id
   where p.kind = 'quantity' and p.qty > 0;

  update public.inventory_month_end_snapshots s
     set item_count = (select count(*) from public.inventory_month_end_lines
                        where month_end = v_month and kind = 'item'),
         quantity_units = (select coalesce(sum(qty), 0) from public.inventory_month_end_lines
                            where month_end = v_month and kind = 'quantity'),
         saleable_units = (select coalesce(sum(qty), 0) from public.inventory_month_end_lines
                           where month_end = v_month and status in ('在庫', '出品中')),
         cost_total = (select coalesce(sum(total_cost), 0) from public.inventory_month_end_lines
                       where month_end = v_month),
         missing_cost_units = (select coalesce(sum(qty), 0) from public.inventory_month_end_lines
                              where month_end = v_month and unit_cost is null)
   where s.month_end = v_month
   returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

revoke all on function public.inv_month_end_capture(date) from public, anon;
grant execute on function public.inv_month_end_capture(date) to authenticated;

comment on table public.inventory_month_end_snapshots is
  '初回確定の月末帳簿スナップショット。capture日時が月末から遅い場合、締め後の操作が含まれ得るため要確認。';
comment on table public.inventory_month_end_lines is
  '月末に凍結した個体・数量管理在庫（売却済・廃棄は除く）。原価不明はNULL。';
