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
--   また、棚卸では次の3つを必ず別ものとして扱う。
--     未処理       … まだ確認していない
--     現物確認済み … 現物があった              （checked_at）
--     差異確定     … 現物が無いことを人が確認した（missing_at）
--   checked_at を「見つからない」に流用しない。checked_at は**現物があった**の意味だけを持つ。
--
--   このmigrationでやること
--     1) missing_at 列          … 差異確定の日時（唯一の列追加）
--     2) inv_start_stocktake    … 対象を status in ('在庫','出品中') にする
--     3) inv_item_op            … 棚卸確認で新しく足す行は expected=false。
--                                 確認できたら差異確定（missing_at）は取り消す
--     4) inv_stocktake_uncheck  … 棚卸確認を取り消す（新規）
--     5) inv_stocktake_mark_missing   … 差異確定（新規）
--     6) inv_stocktake_unmark_missing … 差異確定の取消（新規）
--     7) inv_stocktake_summary  … 月次の照合結果を1棚卸1行で返す（新規・読み取り専用）
--
--   列の追加は missing_at の1つだけ。対象かどうかは既存の expected を使う。
--   在庫の状態・在庫数・出品状態・8RENT・価格には一切触れない。
--   履歴（inventory_transactions）は追記のみで、1行も消さない。
-- ============================================================


-- ------------------------------------------------------------
-- 1) 差異確定の日時
--
--    「現物が見つからない」を checked_at で表すと、
--    「現物があった」と「現物が無いことを確認した」が区別できなくなる。
--    列を1つだけ足して、棚卸の状態を3つに分ける。
--
--      未処理       expected=true  and checked_at is null and missing_at is null
--      現物確認済み expected=true  and checked_at is not null
--      差異確定     expected=true  and missing_at is not null
--      帳簿外現物   expected=false and checked_at is not null
-- ------------------------------------------------------------
alter table public.inventory_stocktake_items
  add column if not exists missing_at timestamptz;

comment on column public.inventory_stocktake_items.missing_at is
  '現物が無いことを人が確認した日時（差異確定）。checked_at は「現物があった」の意味を持つので流用しない。';

comment on column public.inventory_stocktake_items.checked_at is
  '現物があった日時。見つからなかったことを表すのには使わない（それは missing_at）。';


-- ------------------------------------------------------------
-- 2) 棚卸の対象＝帳簿在庫
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
-- 3) 棚卸確認：帳簿に無い現物を読んだら expected=false で足す
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
      -- checked_at だけ更新し、expected は true のまま触らない。
      -- 現物が見つかったのだから、差異確定（missing_at）は取り消す。
      -- ※ status は '不明' のままにする。状態を戻すかどうかは人が決めること
      insert into public.inventory_stocktake_items (stocktake_id, item_id, expected, checked_at)
      values (st_id, p_item_id, false, now())
      on conflict (stocktake_id, item_id)
        do update set checked_at = excluded.checked_at, missing_at = null;
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
-- 4) 棚卸確認を取り消す
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
-- 5) 差異確定：現物が見つからないことを人が確認した
--
--    画面から inv_item_op('状態変更','不明') を呼ぶだけでは、
--    その棚卸で「処理が済んだ」ことが残らない（checked_at も missing_at も NULL のまま）。
--    それだと未確認一覧に残り続け、未確認の数も減らない。
--    1トランザクションで
--      missing_at = now()
--      inventory_items.status = '不明'
--      履歴に追記
--    をまとめてやる。
--
--    '不明' が販売可能数・8RENT可能数・販売予約可能数から外れる仕組み
--    （どれも status='在庫' だけを数えている）には手を入れていない。
-- ------------------------------------------------------------
create or replace function public.inv_stocktake_mark_missing(
  p_stocktake_id bigint,
  p_item_id      text
) returns public.inventory_items
language plpgsql security invoker set search_path = public as $$
declare
  st     public.inventory_stocktakes;
  it     public.inventory_items;
  v_row  public.inventory_stocktake_items;
  v_was  text;
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
  if not v_row.expected then
    raise exception '帳簿外の現物は差異確定できません（%）', p_item_id;
  end if;
  if v_row.checked_at is not null then
    raise exception 'すでに現物を確認しています。先に「未確認に戻す」を押してください（%）', p_item_id;
  end if;
  if v_row.missing_at is not null then
    raise exception 'すでに差異確定しています（%）', p_item_id;
  end if;

  select * into it from public.inventory_items where id = p_item_id for update;
  if not found then
    raise exception '商品が見つかりません（%）', p_item_id;
  end if;
  -- お客様への約束が生きている個体は、先に返却・キャンセルしてもらう
  if it.status in ('予約中', '販売予約', '貸出中') then
    raise exception '% のため差異確定できません（先に返却・キャンセルしてください）', it.status;
  end if;
  if it.status in ('売却済', '廃棄') then
    raise exception '% は棚卸の対象ではありません', it.status;
  end if;
  if it.status = '不明' then
    raise exception 'すでに不明です（%）', p_item_id;
  end if;

  v_was := it.status;          -- 取り消すときはここへ戻す

  update public.inventory_stocktake_items
     set missing_at = now()
   where stocktake_id = p_stocktake_id and item_id = p_item_id;

  update public.inventory_items
     set status = '不明', user_name = null, loaned_at = null
   where id = p_item_id
  returning * into it;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'item', p_item_id, it.name, '棚卸差異確定',
          v_was, '不明／棚卸で現物が見つからない');

  return it;
end $$;

comment on function public.inv_stocktake_mark_missing is
  '棚卸で「現物が見つからない」と人が確定したときだけ呼ぶ。missing_at を立て、
   個体の状態を ''不明'' にし、''棚卸差異確定'' を履歴に追記する。
   未確認のまま自動で呼ばれることはない。予約中・販売予約・貸出中は拒否する。';


-- ------------------------------------------------------------
-- 6) 差異確定の取消（誤操作を戻す）
--
--    missing_at を消して未処理へ戻し、状態を差異確定の前へ戻す。
--    ただし**まだ '不明' のままのときだけ**戻す。あとから人が別の状態に
--    変えていたら、それを上書きしないでそのままにする。
-- ------------------------------------------------------------
create or replace function public.inv_stocktake_unmark_missing(
  p_stocktake_id bigint,
  p_item_id      text
) returns public.inventory_items
language plpgsql security invoker set search_path = public as $$
declare
  st     public.inventory_stocktakes;
  it     public.inventory_items;
  v_row  public.inventory_stocktake_items;
  v_back text;
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
  if v_row.missing_at is null then
    raise exception '差異確定していません（%）', p_item_id;
  end if;

  select * into it from public.inventory_items where id = p_item_id for update;
  if not found then
    raise exception '商品が見つかりません（%）', p_item_id;
  end if;

  update public.inventory_stocktake_items
     set missing_at = null
   where stocktake_id = p_stocktake_id and item_id = p_item_id;

  -- '不明' のままなら、差異確定する前の状態へ戻す。
  -- 戻り先は推測せず、差異確定のときに履歴へ残した before_value をそのまま使う。
  -- 棚卸の対象は 在庫・出品中 だけなので、それ以外が入っていたら在庫に寄せる。
  if it.status = '不明' then
    select t.before_value into v_back
      from public.inventory_transactions t
     where t.ref_kind = 'item' and t.ref_id = p_item_id
       and t.action = '棚卸差異確定'
       and t.occurred_at >= st.started_at
     order by t.occurred_at desc
     limit 1;
    if v_back is null or v_back not in ('在庫', '出品中') then
      v_back := '在庫';
    end if;
    update public.inventory_items set status = v_back where id = p_item_id
    returning * into it;
  else
    -- 人があとから別の状態にしている。上書きしない
    v_back := it.status || '（そのまま）';
  end if;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'item', p_item_id, it.name, '棚卸差異確定取消',
          '不明', v_back);

  return it;
end $$;

comment on function public.inv_stocktake_unmark_missing is
  '差異確定を取り消して未処理へ戻す。状態が ''不明'' のままのときだけ、
   差異確定のときに履歴へ残した元の状態（在庫／出品中）へ戻す。
   人があとから別の状態にしていたら上書きしない。履歴は消さず追記する。';


-- ------------------------------------------------------------
-- 7) 月次の照合結果（読み取り専用・1棚卸1行）
--
--    ブラウザで inventory_stocktake_items を何千行も読んで数えなくて済むように、
--    集計はDB側でやる。
--
--      帳簿在庫   expected = true
--      確認済み   expected = true  かつ checked_at is not null
--      差異確定   expected = true  かつ checked_at is null かつ missing_at is not null
--      未確認     expected = true  かつ checked_at is null かつ missing_at is null
--      帳簿外現物 expected = false かつ checked_at is not null
--
--    差異確定は**その棚卸の missing_at から正確に数える**。履歴を期間で切って
--    推測したりはしない（棚卸以外の理由で不明にしたものが混ざるため）。
-- ------------------------------------------------------------
drop view if exists public.inv_stocktake_summary;
create view public.inv_stocktake_summary as
select
  s.id                 as stocktake_id,
  s.started_at,
  s.closed_at,
  s.status,
  s.actor,
  s.scope_location_id,
  c.book::integer      as book_count,
  c.checked::integer   as checked_count,
  c.missing::integer   as missing_count,
  (c.book - c.checked - c.missing)::integer as unchecked_count,
  c.extra::integer     as extra_count
from public.inventory_stocktakes s
left join lateral (
  select
    count(*) filter (where i.expected)                                  as book,
    count(*) filter (where i.expected and i.checked_at is not null)      as checked,
    count(*) filter (where i.expected and i.checked_at is null
                       and i.missing_at is not null)                     as missing,
    count(*) filter (where not i.expected and i.checked_at is not null)  as extra
  from public.inventory_stocktake_items i
  where i.stocktake_id = s.id
) c on true;

comment on view public.inv_stocktake_summary is
  '棚卸1回を1行にまとめた照合結果。帳簿在庫・現物確認済み・差異確定・未確認・帳簿外現物を返す。
   差異確定はその棚卸の missing_at から数えるので、履歴を期間で切った近似ではない。
   社内用（anonには出さない）。';


-- ------------------------------------------------------------
-- 8) 権限
--
--    2026-10-01-rpc-permission-hardening.sql の一括配り直しは
--    「そのとき存在した関数」に対する1回きりの処理なので、
--    あとから足した関数には効かない。既定では PUBLIC に EXECUTE が付き
--    anon からも呼べてしまうため、ここで明示的に落として配り直す。
-- ------------------------------------------------------------
revoke all on function public.inv_stocktake_uncheck(bigint, text) from public, anon, service_role;
grant execute on function public.inv_stocktake_uncheck(bigint, text) to authenticated;

revoke all on function public.inv_stocktake_mark_missing(bigint, text) from public, anon, service_role;
grant execute on function public.inv_stocktake_mark_missing(bigint, text) to authenticated;

revoke all on function public.inv_stocktake_unmark_missing(bigint, text) from public, anon, service_role;
grant execute on function public.inv_stocktake_unmark_missing(bigint, text) to authenticated;

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
select '差異確定の列',
       case when exists (select 1 from information_schema.columns
                          where table_schema='public' and table_name='inventory_stocktake_items'
                            and column_name='missing_at')
            then 'OK missing_at がある' else 'NG' end
union all
select '確認できたら差異確定を取り消す',
       case when pg_get_functiondef('public.inv_item_op(text,text,text,text)'::regprocedure)
                 like '%checked_at = excluded.checked_at, missing_at = null%'
            then 'OK' else 'NG' end
union all
select '差異確定は missing_at から数える',
       case when pg_get_viewdef('public.inv_stocktake_summary'::regclass) like '%missing_at%'
             and pg_get_viewdef('public.inv_stocktake_summary'::regclass) not like '%occurred_at%'
            then 'OK 履歴の推測ではない' else 'NG' end
union all
select 'anonが呼べないこと（' || f || '）',
       case when has_function_privilege('anon', f || '(bigint,text)', 'execute')
            then 'NG anonが呼べる' else 'OK anonは呼べない' end
  from unnest(array['public.inv_stocktake_uncheck',
                    'public.inv_stocktake_mark_missing',
                    'public.inv_stocktake_unmark_missing']) as f
union all
select '社員が呼べること（' || f || '）',
       case when has_function_privilege('authenticated', f || '(bigint,text)', 'execute')
            then 'OK 社員は呼べる' else 'NG' end
  from unnest(array['public.inv_stocktake_uncheck',
                    'public.inv_stocktake_mark_missing',
                    'public.inv_stocktake_unmark_missing']) as f
union all
select '集計ビューの権限（anon）',
       case when has_table_privilege('anon', 'public.inv_stocktake_summary', 'select')
            then 'NG anonが読める' else 'OK anonは読めない' end
union all
select '集計ビューの権限（社員）',
       case when has_table_privilege('authenticated', 'public.inv_stocktake_summary', 'select')
            then 'OK 社員は読める' else 'NG' end;
