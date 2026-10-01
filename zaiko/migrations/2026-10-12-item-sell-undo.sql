-- ============================================================
-- 売却済を取り消す（誤って別の個体を販売済みにしたとき）
--   2026-10-12
--
--   倉庫でQRを取り違えて、違う個体を「販売済み」にしてしまうことがある。
--   いまは戻す手段が無く、状態を手で直すと在庫数と履歴が食い違う。
--
--   **戻る状態は固定しない。履歴から取る。**
--   inv_item_op は売却のとき before_value に「売却の直前の状態」をそのまま
--   書いている（古い版も同じ）。
--     action='売却' / before_value='在庫' / after_value='売却済（楽天）（12,000円…）'
--   なので、その1行を読めば 在庫／出品中／販売予約 のどれへ戻すかが分かる。
--   **履歴から分からないときは推測しない。** エラーにして人に任せる。
--
--   直せないもの・やらないこと
--     楽天など外部の販売サイトへの再出品はしない（モール側は人が直す）
--     既存の「売却」履歴は消さない（追記のみの表なので消す権限も無い）
--     inventory_sale_orders（モールの注文）は触らない
--
--   権限は既存の inv_can_edit()。
--     admin  … 可
--     member … 可（倉庫で取り違えに気づくのはこの人たち）
--     viewer … 不可
-- ============================================================


-- ------------------------------------------------------------
-- 取消の材料をまとめて返す（取消の本体と、確認画面の両方がこれを使う）
--
--   back   … 戻る状態。無ければ null
--   orders … この個体が割り当たっているモールの受注明細（キャンセル済みは除く）
--
--   戻る状態は履歴から取る。**推測はしない。**
--   inv_item_op は売却のとき before_value に「売却の直前の状態」をそのまま
--   書いている（古い版も同じ）。
--
--   **使い終わった売却を拾わない。**
--   売却A → 売却取消A → （SQLなどで status だけ売却済） と進んだとき、
--   いちばん新しい売却の行は A だが、それはすでに取り消されていて
--   「いまの売却済」とは無関係。その状態へ戻すと嘘になる。
--   そこで「その売却より後に 売却取消 が無いこと」を条件に入れる。
--     売却A → 売却取消A → 売却B          … B だけが候補（正しく B の前の状態へ戻る）
--     売却A → 売却取消A → status だけ売却済 … 候補なし（null。戻さない）
--   同じ時刻の行があっても狂わないよう (occurred_at, id) の組で前後を見る。
--
--   棚卸確認は after_value が '売却済（確認済み）' になるが状態を変えていないので、
--   before_value が売却前になりうる状態の行だけを見て外す。
--
--   戻せない状態（戻すと情報が欠ける）は最初から候補にしない。
--     貸出中・社内使用 … 利用者（user_name）が売却時に消えており、誰に貸していたかを
--                        復元できない。推測で戻さず、人が貸出からやり直す
--     売却済・廃棄     … 戻し先として意味がない
-- ------------------------------------------------------------
drop function if exists public.inv_item_sell_undo_target(text);

create or replace function public.inv_item_sell_undo_info(p_item_id text)
returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'back',
      (select t.before_value
         from public.inventory_transactions t
        where t.ref_kind = 'item'
          and t.ref_id   = p_item_id
          and t.action in ('売却', '状態変更')
          and t.after_value like '売却済%'
          and btrim(coalesce(t.before_value, ''))
              = any (array['在庫','出品中','予約中','販売予約','修理中','故障','紛失','不明'])
          -- その売却より後に「売却取消」があるなら、それはもう使い終わった売却
          and not exists (
                select 1 from public.inventory_transactions u
                 where u.ref_kind = 'item'
                   and u.ref_id   = p_item_id
                   and u.action   = '売却取消'
                   and (u.occurred_at, u.id) > (t.occurred_at, t.id))
        order by t.occurred_at desc, t.id desc
        limit 1),
    'orders',
      (select coalesce(jsonb_agg(jsonb_build_object(
                'id', o.id, 'channel', o.channel, 'order_number', o.order_number,
                'line_number', o.line_number, 'unit_no', o.unit_no, 'status', o.status)
              order by o.id), '[]'::jsonb)
         from public.inventory_sale_orders o
        where o.item_id = p_item_id
          and o.status <> 'キャンセル'))
$$;

comment on function public.inv_item_sell_undo_info is
  '売却取消の材料。back＝戻る状態（履歴の action=''売却'' の before_value。すでに取り消された
   売却は拾わない。決められなければ null）、orders＝その個体が割り当たっているモールの受注明細。
   読むだけで何も変えない。確認画面と取消の本体が同じこれを通る。';


-- ------------------------------------------------------------
-- モールの受注明細から、この個体の割り当てだけを外す
--
--   inventory_sale_orders は authenticated に insert/update/delete を渡していない
--   （書けるのは security definer の関数だけ）ので、既存の inv_sale_order_link と
--   同じ形にする：security definer ＋ 関数の中で inv_can_edit()。
--
--   **外部のモールへは何も送らない。** 8EC の中の紐付けを外すだけ。
--   戻す先を '受注' にするのは、既存の inv_sale_order_link() が
--     item_id が null で、キャンセル済みでない明細
--   にしか商品を割り当てられず、割り当てたあとに status を '受注' にするため。
--   つまり「個体の割り当て待ち」を表すのがこの状態で、推測で決めた値ではない。
--   取込を流し直しても、item_id が null のあいだは何も起きない
--   （発送の反映は status='受注' かつ item_id is not null のときだけ）。
-- ------------------------------------------------------------
create or replace function public.inv_sale_order_unlink(
  p_order_id bigint,
  p_item_id  text,
  p_note     text default null
) returns public.inventory_sale_orders
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  r public.inventory_sale_orders;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into r from public.inventory_sale_orders where id = p_order_id for update;
  if not found then
    raise exception '受注明細が見つかりません（%）', p_order_id;
  end if;
  -- 取り違えた個体の割り当てだけを外す。別の個体が割り当たっている明細には触らない
  if r.item_id is distinct from p_item_id then
    raise exception 'この明細には別の個体が割り当たっています（%）', coalesce(r.item_id, 'なし');
  end if;
  if r.status = 'キャンセル' then
    return r;                      -- キャンセル済みは触らない
  end if;

  update public.inventory_sale_orders
     set item_id = null,
         status  = '受注',          -- ＝「個体の割り当て待ち」。inv_sale_order_link で割り当て直す
         note    = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_order_id
  returning * into r;
  return r;
end $$;

comment on function public.inv_sale_order_unlink is
  '受注明細から、指定した個体の割り当てだけを外して「個体の割り当て待ち（受注）」へ戻す。
   別の個体が割り当たっている明細は触らない。外部のモールへは何も送らない。
   割り当て直しは既存の inv_sale_order_link() で行う。';


-- ------------------------------------------------------------
-- 売却取消
--
--   二重取消の防止は「いま売却済か」で見る。取り消すと status が
--   売却前の状態へ戻るので、2回目は必ずここで止まる。
--
--   売却のときだけ入る値（sold_price / sold_channel）は空に戻す。
--   誤売却の金額と売却先が残ると、ダッシュボードの売上・粗利に混ざるため。
--   user_name / loaned_at は売却時に null にされており、戻す先の状態
--   （在庫・出品中・販売予約）では使わないので、null のままにする。
-- ------------------------------------------------------------
create or replace function public.inv_item_sell_undo(
  p_item_id text,
  p_note    text default null
) returns public.inventory_items
language plpgsql security invoker set search_path = public as $$
declare
  it     public.inventory_items;
  v_prev text;
  v_was  text;
  v_info jsonb;
  v_ord  jsonb;
  v_ords text[] := '{}';
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;

  select * into it from public.inventory_items where id = p_item_id for update;
  if not found then
    raise exception '商品が見つかりません（%）', p_item_id;
  end if;

  -- 1) いま売却済のものだけ。取消済み・もともと売却済でないものはここで止まる
  if it.status <> '売却済' then
    raise exception '「売却済」のものだけ取り消せます（いまは %）', it.status;
  end if;

  -- 2) 戻る状態は履歴から取る。**推測しない。**判定は確認画面と同じ1つの関数に任せる
  v_info := public.inv_item_sell_undo_info(p_item_id);
  v_prev := v_info ->> 'back';
  if v_prev is null then
    raise exception
      '売却前の状態が履歴から決められないので取り消せません（%）。'
      '売却の履歴が無い／いちばん新しい売却はすでに取り消し済み／'
      '売却前が貸出中・社内使用（利用者を復元できない）、のどれかです。'
      'もとの操作からやり直してください', p_item_id;
  end if;

  -- 3) 戻す。売却のときだけ入る値は空にする
  v_was := '売却済'
           || coalesce('（' || nullif(btrim(coalesce(it.sold_channel, '')), '') || '）', '')
           || coalesce('（' || to_char(it.sold_price, 'FM9,999,999,999') || '円）', '');

  update public.inventory_items
     set status       = v_prev,
         sold_price   = null,
         sold_channel = null,
         user_name    = null,
         loaned_at    = null
   where id = p_item_id
  returning * into it;

  -- 4) モールの受注明細に割り当たっていたら、**8EC の中の紐付けだけ**を外す。
  --    外さないと「この注文は個体Aへ発送済み」という記録が残り、個体Aは在庫に戻るので
  --    中のデータが食い違う。外部のモールへは何も送らない。
  for v_ord in select * from jsonb_array_elements(coalesce(v_info -> 'orders', '[]'::jsonb)) loop
    perform public.inv_sale_order_unlink((v_ord ->> 'id')::bigint, p_item_id,
      p_item_id || ' の販売済みを取り消したため割り当てを解除しました。別の個体を割り当ててください');
    v_ords := v_ords || ((v_ord ->> 'channel') || ' 注文 ' || (v_ord ->> 'order_number'));
  end loop;

  -- 5) 履歴。**「売却」の行は消さない。**「売却取消」を足して 売却 → 売却取消 と並べる
  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'item', p_item_id, it.name, '売却取消',
          v_was,
          v_prev
          || coalesce('／' || nullif(btrim(coalesce(p_note, '')), ''), '')
          || case when array_length(v_ords, 1) is null then ''
                  else '／割り当て解除 ' || array_to_string(v_ords, '・') end);

  return it;
end $$;

comment on function public.inv_item_sell_undo is
  '誤って売却済にした1台を、売却の直前の状態へ戻す。戻り先は履歴（action=''売却'' の
   before_value）から取り、分からなければ戻さずエラーにする。sold_price / sold_channel は
   空に戻す。既存の「売却」履歴は消さず、「売却取消」を足す。外部販売サイトへの再出品はしない。';


-- ------------------------------------------------------------
-- 権限
--
--   2026-10-01-rpc-permission-hardening.sql の配り直しは「そのとき存在した関数」への
--   1回きりの処理なので、あとから足した関数には効かない。既定では PUBLIC に EXECUTE が
--   付き anon からも呼べてしまうため、明示的に配り直す。
--   関数の中で inv_can_edit() が見る（admin・member は可、viewer は不可）。
-- ------------------------------------------------------------
revoke all on function public.inv_item_sell_undo_info(text) from public, anon, service_role;
grant execute on function public.inv_item_sell_undo_info(text) to authenticated;

revoke all on function public.inv_sale_order_unlink(bigint, text, text) from public, anon, service_role;
grant execute on function public.inv_sale_order_unlink(bigint, text, text) to authenticated;

revoke all on function public.inv_item_sell_undo(text, text) from public, anon, service_role;
grant execute on function public.inv_item_sell_undo(text, text) to authenticated;


-- ------------------------------------------------------------
-- 確認
-- ------------------------------------------------------------
select '関数がある' as kind,
       case when to_regprocedure('public.inv_item_sell_undo(text,text)') is not null
             and to_regprocedure('public.inv_item_sell_undo_info(text)') is not null
             and to_regprocedure('public.inv_sale_order_unlink(bigint,text,text)') is not null
            then 'OK 3つとも' else 'NG' end as result
union all
select '古い名前の関数は残っていない',
       case when to_regprocedure('public.inv_item_sell_undo_target(text)') is null
            then 'OK' else 'NG 残っている' end
union all
select '戻り先の判定は1か所だけ',
       case when pg_get_functiondef('public.inv_item_sell_undo(text,text)'::regprocedure)
                 like '%public.inv_item_sell_undo_info(p_item_id)%'
            then 'OK 確認画面と同じ関数を通る' else 'NG' end
union all
select '売却済のときだけ取り消せる',
       case when pg_get_functiondef('public.inv_item_sell_undo(text,text)'::regprocedure)
                 like '%if it.status <> ''売却済'' then%'
            then 'OK' else 'NG' end
union all
select '戻り先は履歴から取る（固定していない）',
       case when pg_get_functiondef('public.inv_item_sell_undo_info(text)'::regprocedure)
                 like '%from public.inventory_transactions t%'
             and pg_get_functiondef('public.inv_item_sell_undo_info(text)'::regprocedure)
                 like '%t.before_value%'
            then 'OK' else 'NG' end
union all
select '取り消し済みの古い売却は拾わない',
       case when pg_get_functiondef('public.inv_item_sell_undo_info(text)'::regprocedure)
                 like '%u.action   = ''売却取消''%'
             and pg_get_functiondef('public.inv_item_sell_undo_info(text)'::regprocedure)
                 like '%(u.occurred_at, u.id) > (t.occurred_at, t.id)%'
            then 'OK' else 'NG' end
union all
select '戻り先の判定は読むだけ（何も変えない）',
       case when pg_get_functiondef('public.inv_item_sell_undo_info(text)'::regprocedure)
                 ~* '(insert|update|delete)\s'
            then 'NG 書いている' else 'OK' end
union all
select '分からないときは戻さない',
       case when pg_get_functiondef('public.inv_item_sell_undo(text,text)'::regprocedure)
                 like '%if v_prev is null then%'
            then 'OK' else 'NG' end
union all
select '売却の金額と売却先を空に戻す',
       case when pg_get_functiondef('public.inv_item_sell_undo(text,text)'::regprocedure)
                 like '%sold_price   = null,%'
             and pg_get_functiondef('public.inv_item_sell_undo(text,text)'::regprocedure)
                 like '%sold_channel = null,%'
            then 'OK' else 'NG' end
union all
select 'モールの注文は中の割り当てだけ外す',
       case when pg_get_functiondef('public.inv_sale_order_unlink(bigint,text,text)'::regprocedure)
                 like '%set item_id = null,%'
             and pg_get_functiondef('public.inv_sale_order_unlink(bigint,text,text)'::regprocedure)
                 like '%status  = ''受注'',%'
            then 'OK 受注（割り当て待ち）へ戻す' else 'NG' end
union all
select '別の個体が割り当たった明細は触らない',
       case when pg_get_functiondef('public.inv_sale_order_unlink(bigint,text,text)'::regprocedure)
                 like '%if r.item_id is distinct from p_item_id then%'
            then 'OK' else 'NG' end
union all
select '履歴を消していない（足すだけ）',
       case when pg_get_functiondef('public.inv_item_sell_undo(text,text)'::regprocedure)
                 ~* '(delete|update)\s+(from\s+)?public\.inventory_transactions'
            then 'NG 消している' else 'OK' end
union all
select '売却取消を履歴に残す',
       case when pg_get_functiondef('public.inv_item_sell_undo(text,text)'::regprocedure)
                 like '%''売却取消'',%'
            then 'OK' else 'NG' end
union all
select '権限は既存の inv_can_edit()',
       case when pg_get_functiondef('public.inv_item_sell_undo(text,text)'::regprocedure)
                 like '%if not public.inv_can_edit() then%'
             and pg_get_functiondef('public.inv_sale_order_unlink(bigint,text,text)'::regprocedure)
                 like '%if not public.inv_can_edit() then%'
            then 'OK' else 'NG' end
union all
select 'anonは呼べない',
       case when has_function_privilege('anon', 'public.inv_item_sell_undo(text,text)', 'execute')
              or has_function_privilege('anon', 'public.inv_item_sell_undo_info(text)', 'execute')
              or has_function_privilege('anon', 'public.inv_sale_order_unlink(bigint,text,text)', 'execute')
            then 'NG anonが呼べる' else 'OK' end
union all
select '社員は呼べる（中で権限を見る）',
       case when has_function_privilege('authenticated', 'public.inv_item_sell_undo(text,text)', 'execute')
             and has_function_privilege('authenticated', 'public.inv_item_sell_undo_info(text)', 'execute')
             and has_function_privilege('authenticated', 'public.inv_sale_order_unlink(bigint,text,text)', 'execute')
            then 'OK' else 'NG' end
union all
select '受注明細を直接書ける人は増えていない',
       case when has_table_privilege('authenticated', 'public.inventory_sale_orders', 'update')
              or has_table_privilege('authenticated', 'public.inventory_sale_orders', 'insert')
              or has_table_privilege('authenticated', 'public.inventory_sale_orders', 'delete')
            then 'NG 直接書ける' else 'OK 関数経由だけ' end
union all
select 'いま売却済の個体数',
       (select count(*)::text from public.inventory_items where status = '売却済') || '台'
union all
select 'うち売却の履歴がある（取り消せる）',
       (select count(*)::text from public.inventory_items i
         where i.status = '売却済'
           and public.inv_item_sell_undo_info(i.id) ->> 'back' is not null) || '台'
union all
select 'うちモールの注文が紐付いている',
       (select count(*)::text from public.inventory_items i
         where i.status = '売却済'
           and jsonb_array_length(public.inv_item_sell_undo_info(i.id) -> 'orders') > 0) || '台';
