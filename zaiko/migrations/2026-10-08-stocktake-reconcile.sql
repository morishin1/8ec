-- ============================================================
-- 月次棚卸を「帳簿在庫と現物の照合」にする
--   2026-10-08
--
--   いままでの棚卸は「現物を見た記録」でしかなく、対象には
--   status <> '廃棄' の個体がすべて入っていた。そのため
--   売却済・貸出中・予約中・販売予約のように**そもそも現物を確認できない**
--   個体まで「未確認」に並び、差異候補の数が実態より多く出ていた。
--
--   ここで対象（帳簿在庫）を「販売できる手元在庫」に絞り、
--   帳簿に載っていない現物を読んだときは expected=false で分けて数える。
--
--   このmigrationでやること
--     1) inv_start_stocktake  … 対象を status in ('在庫','出品中') にする
--     2) inv_item_op          … 棚卸確認で新しく足す行は expected=false にする
--     3) inv_stocktake_uncheck… 棚卸確認を取り消す（新規）
--     4) inv_stocktake_summary… 月次の照合結果を1棚卸1行で返す（新規・読み取り専用）
--
--   列の追加はしない。既存の inventory_stocktake_items.expected を使う。
--   在庫の状態・在庫数・出品状態・8RENT・価格には一切触れない。
--   履歴（inventory_transactions）は追記のみで、1行も消さない。
-- ============================================================


-- ------------------------------------------------------------
-- 1) 棚卸の対象＝帳簿在庫
--
--    帳簿在庫 = status in ('在庫','出品中')
--      在庫    … 手元にあって売れる
--      出品中  … 手元にあって、販売サイトに出している
--    外すもの
--      貸出中・予約中・販売予約 … お客様の手元／確保済みで、現物を見に行けない
--      売却済・廃棄             … もう持っていない
--      修理中・故障・紛失・不明 … 販売可能在庫ではない。ここを照合しても
--                                「売れる在庫が実在するか」は分からない
-- ------------------------------------------------------------
create or replace function public.inv_start_stocktake(p_scope text default null)
returns public.inventory_stocktakes
language plpgsql security invoker set search_path = public as $$
declare
  st public.inventory_stocktakes;
begin
  if not public.inv_can_edit() then
    raise exception '棚卸を始める権限がありません';
  end if;
  if exists (select 1 from public.inventory_stocktakes where status='open') then
    raise exception 'すでに実施中の棚卸があります。先に終了してください';
  end if;

  insert into public.inventory_stocktakes (actor, scope_location_id)
  values (public.inv_actor(), p_scope) returning * into st;

  insert into public.inventory_stocktake_items (stocktake_id, item_id, expected)
  select st.id, i.id, true
  from public.inventory_items i
  where i.status in ('在庫', '出品中')
    and (p_scope is null or i.location_id in (select id from public.inv_location_tree(p_scope)));

  return st;
end $$;

comment on function public.inv_start_stocktake is
  '棚卸を始める。対象（帳簿在庫）は status in (''在庫'',''出品中'') の個体だけを
   expected=true で並べる。貸出中・予約中・販売予約・売却済・廃棄は現物を確認できない／
   もう持っていないので入れない。在庫の状態は何も変えない。';


-- ------------------------------------------------------------
-- 2) 棚卸確認：帳簿に無い現物を読んだら expected=false で足す
--
--    QRを読んだ個体が棚卸開始時の対象に入っていなかった場合、
--    これまでは expected=true で足していたため、棚卸の途中で
--    「帳簿在庫 241台」が 242台へ増えてしまっていた。
--    新しく足す行は expected=false（帳簿外現物）にして、
--    帳簿在庫の数は棚卸開始時のまま動かさない。
--    もともと対象だった行（expected=true）は on conflict で
--    checked_at だけを更新するので、true のまま変わらない。
--
--    ※ 関数まるごとの置き換えになるのは plpgsql の仕様（部分差し替えができない）。
--       変えたのは棚卸確認の分岐の expected だけで、他の分岐は現行のまま。
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
      -- 新しく足す行は「帳簿外現物」。すでに対象（expected=true）なら
      -- checked_at だけ更新し、expected は true のまま触らない
      insert into public.inventory_stocktake_items (stocktake_id, item_id, expected, checked_at)
      values (st_id, p_item_id, false, now())
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
-- 3) 棚卸確認を取り消す
--
--    画面から checked_at を直接 NULL にするだけでは足りない。
--      inventory_stocktake_items.checked_at  … 今回の確認
--      inventory_items.last_checked_at       … 最後に現物を見た日時（在庫一覧の色）
--      inventory_transactions                … 履歴
--    の3つが噛み合っているので、サーバー側でまとめて整合を取る。
--
--    last_checked_at の戻し方
--      inv_item_op は同じトランザクションの中で
--        update items set last_checked_at = now()
--        insert into transactions (occurred_at default now())
--      を実行する。plpgsql の now() はトランザクション開始時刻なので、
--      この2つは必ず同じ値になる。よって「今回の棚卸が始まる前の
--      いちばん新しい 棚卸確認 履歴の occurred_at」が、そのまま
--      前回の last_checked_at になる。
--      履歴が無ければ NULL（＝未確認）に戻す。
--
--    履歴は消さない。取り消したことも '棚卸確認取消' として追記する。
--    在庫の状態・在庫数・出品状態・8RENTは変えない。
-- ------------------------------------------------------------
create or replace function public.inv_stocktake_uncheck(
  p_stocktake_id bigint,
  p_item_id      text
) returns public.inventory_items
language plpgsql security invoker set search_path = public as $$
declare
  st     public.inventory_stocktakes;
  it     public.inventory_items;
  v_row  public.inventory_stocktake_items;
  v_prev timestamptz;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;

  select * into st from public.inventory_stocktakes where id = p_stocktake_id;
  if not found then
    raise exception '棚卸が見つかりません（%）', p_stocktake_id;
  end if;
  if st.status <> 'open' then
    raise exception '終了した棚卸は直せません';
  end if;

  select * into v_row from public.inventory_stocktake_items
   where stocktake_id = p_stocktake_id and item_id = p_item_id
   for update;
  if not found then
    raise exception 'この棚卸の対象ではありません（%）', p_item_id;
  end if;
  if v_row.checked_at is null then
    raise exception 'まだ確認していません（%）', p_item_id;
  end if;

  select * into it from public.inventory_items where id = p_item_id for update;
  if not found then
    raise exception '商品が見つかりません（%）', p_item_id;
  end if;

  select max(t.occurred_at) into v_prev
    from public.inventory_transactions t
   where t.ref_kind = 'item'
     and t.ref_id   = p_item_id
     and t.action   = '棚卸確認'
     and t.occurred_at < st.started_at;

  update public.inventory_stocktake_items
     set checked_at = null
   where stocktake_id = p_stocktake_id and item_id = p_item_id;

  update public.inventory_items
     set last_checked_at = v_prev
   where id = p_item_id
  returning * into it;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'item', p_item_id, it.name, '棚卸確認取消',
          to_char(v_row.checked_at at time zone 'Asia/Tokyo', 'YYYY/MM/DD HH24:MI') || ' の確認',
          case when v_prev is null
               then '未確認（それ以前の棚卸確認の記録なし）'
               else '前回 ' || to_char(v_prev at time zone 'Asia/Tokyo', 'YYYY/MM/DD HH24:MI')
          end);

  return it;
end $$;

comment on function public.inv_stocktake_uncheck is
  '実施中の棚卸で付けた「確認済み」を取り消す。checked_at を NULL に戻し、
   inventory_items.last_checked_at を今回の棚卸が始まる前の最新の棚卸確認へ戻す
   （記録が無ければ NULL）。''棚卸確認取消'' を履歴に追記する。履歴は消さない。
   在庫の状態・在庫数・出品状態・8RENT・価格は変えない。';


-- ------------------------------------------------------------
-- 4) 月次の照合結果（読み取り専用・1棚卸1行）
--
--    ブラウザで inventory_stocktake_items を何千行も読んで数えなくて済むように、
--    集計はDB側でやる。新しい列は作らず、既存の3つのテーブルだけで組み立てる。
--
--      帳簿在庫   expected = true
--      確認済み   expected = true  かつ checked_at is not null
--      未確認     帳簿在庫 − 確認済み
--      帳簿外現物 expected = false かつ checked_at is not null
--      不明へ変更 棚卸の期間中（started_at 〜 closed_at）に status を不明にした回数
--
--    「不明へ変更」は期間で切った近似。履歴に棚卸IDを持たせていないので、
--    棚卸中に別の理由で不明にしたものも混ざる。画面ではその旨を書く。
-- ------------------------------------------------------------
drop view if exists public.inv_stocktake_summary;
create view public.inv_stocktake_summary as
select
  s.id                as stocktake_id,
  s.started_at,
  s.closed_at,
  s.status,
  s.actor,
  s.scope_location_id,
  c.book::integer     as book_count,
  c.checked::integer  as checked_count,
  (c.book - c.checked)::integer as unchecked_count,
  c.extra::integer    as extra_count,
  u.unknown_count::integer      as unknown_count
from public.inventory_stocktakes s
left join lateral (
  select
    count(*) filter (where i.expected)                                  as book,
    count(*) filter (where i.expected and i.checked_at is not null)      as checked,
    count(*) filter (where not i.expected and i.checked_at is not null)  as extra
  from public.inventory_stocktake_items i
  where i.stocktake_id = s.id
) c on true
left join lateral (
  select count(*) as unknown_count
  from public.inventory_transactions t
  where t.ref_kind = 'item'
    and t.action   = '状態変更'
    and (t.after_value = '不明' or t.after_value like '不明／%')
    and t.occurred_at >= s.started_at
    and t.occurred_at <= coalesce(s.closed_at, now())
) u on true;

comment on view public.inv_stocktake_summary is
  '棚卸1回を1行にまとめた照合結果。帳簿在庫・確認済み・未確認・帳簿外現物・
   期間中に不明へ変更した数を返す。社内用（anonには出さない）。';


-- ------------------------------------------------------------
-- 5) 権限
--
--    2026-10-01-rpc-permission-hardening.sql の一括配り直しは
--    「そのとき存在した関数」に対する1回きりの処理なので、
--    あとから足した関数には効かない。既定では PUBLIC に EXECUTE が付き
--    anon からも呼べてしまうため、ここで明示的に落として配り直す。
-- ------------------------------------------------------------
revoke all on function public.inv_stocktake_uncheck(bigint, text) from public, anon, service_role;
grant execute on function public.inv_stocktake_uncheck(bigint, text) to authenticated;

revoke all on public.inv_stocktake_summary from public, anon;
grant select on public.inv_stocktake_summary to authenticated;


-- ------------------------------------------------------------
-- 確認
-- ------------------------------------------------------------
select '棚卸の対象条件' as kind,
       case when pg_get_functiondef('public.inv_start_stocktake(text)'::regprocedure)
                 like '%status in (''在庫'', ''出品中'')%'
            then 'OK 帳簿在庫だけ' else 'NG' end as result
union all
select '帳簿外現物',
       case when pg_get_functiondef('public.inv_item_op(text,text,text,text)'::regprocedure)
                 like '%values (st_id, p_item_id, false, now())%'
            then 'OK expected=false で足す' else 'NG' end
union all
select '取消RPCの権限',
       case when has_function_privilege('anon', 'public.inv_stocktake_uncheck(bigint,text)', 'execute')
            then 'NG anonが呼べる' else 'OK anonは呼べない' end
union all
select '取消RPCの権限（社員）',
       case when has_function_privilege('authenticated', 'public.inv_stocktake_uncheck(bigint,text)', 'execute')
            then 'OK 社員は呼べる' else 'NG' end
union all
select '集計ビューの権限',
       case when has_table_privilege('anon', 'public.inv_stocktake_summary', 'select')
            then 'NG anonが読める' else 'OK anonは読めない' end;
