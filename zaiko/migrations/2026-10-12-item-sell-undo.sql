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
-- 戻る先を履歴から1つ決める（取消の本体と、確認画面の両方がこれを使う）
--
--   inv_item_op は売却のとき before_value に「売却の直前の状態」をそのまま
--   書いている（古い版も同じ）。その最後の1行を読むだけ。**推測はしない。**
--   棚卸確認は after_value が '売却済（確認済み）' になるが状態を変えていないので、
--   before_value が '売却済' の行を外して拾わないようにする。
--
--   戻せないとき（履歴が無い／戻すと情報が欠ける状態）は null を返す。
--   確認画面は「取り消せません」と出し、取消の本体はエラーにする。
--     貸出中・社内使用 … 利用者（user_name）が売却時に消えており、誰に貸していたかを
--                        復元できない。推測で戻さず、人が貸出からやり直す
--     売却済・廃棄     … 戻し先として意味がない
-- ------------------------------------------------------------
create or replace function public.inv_item_sell_undo_target(p_item_id text)
returns text
language sql stable security invoker set search_path = public as $$
  select t.before_value
    from public.inventory_transactions t
   where t.ref_kind = 'item'
     and t.ref_id   = p_item_id
     and t.action in ('売却', '状態変更')
     and t.after_value like '売却済%'
     and btrim(coalesce(t.before_value, ''))
         = any (array['在庫','出品中','予約中','販売予約','修理中','故障','紛失','不明'])
   order by t.occurred_at desc, t.id desc
   limit 1
$$;

comment on function public.inv_item_sell_undo_target is
  '売却を取り消したときに戻る状態を、履歴（action=''売却'' の before_value）から1つ返す。
   戻せないとき（履歴が無い／貸出中など復元できない状態）は null。読むだけで何も変えない。';


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
  v_prev := public.inv_item_sell_undo_target(p_item_id);
  if v_prev is null then
    raise exception
      '売却前の状態が履歴から決められないので取り消せません（%）。'
      '売却の履歴が無いか、売却前が貸出中・社内使用（利用者を復元できない）です。'
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

  -- 4) 履歴。**「売却」の行は消さない。**「売却取消」を足して 売却 → 売却取消 と並べる
  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'item', p_item_id, it.name, '売却取消',
          v_was, v_prev || coalesce('／' || nullif(btrim(coalesce(p_note, '')), ''), ''));

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
revoke all on function public.inv_item_sell_undo_target(text) from public, anon, service_role;
grant execute on function public.inv_item_sell_undo_target(text) to authenticated;

revoke all on function public.inv_item_sell_undo(text, text) from public, anon, service_role;
grant execute on function public.inv_item_sell_undo(text, text) to authenticated;


-- ------------------------------------------------------------
-- 確認
-- ------------------------------------------------------------
select '関数がある' as kind,
       case when to_regprocedure('public.inv_item_sell_undo(text,text)') is not null
             and to_regprocedure('public.inv_item_sell_undo_target(text)') is not null
            then 'OK 2つとも' else 'NG' end as result
union all
select '戻り先の判定は1か所だけ',
       case when pg_get_functiondef('public.inv_item_sell_undo(text,text)'::regprocedure)
                 like '%public.inv_item_sell_undo_target(p_item_id)%'
            then 'OK 確認画面と同じ関数を通る' else 'NG' end
union all
select '売却済のときだけ取り消せる',
       case when pg_get_functiondef('public.inv_item_sell_undo(text,text)'::regprocedure)
                 like '%if it.status <> ''売却済'' then%'
            then 'OK' else 'NG' end
union all
select '戻り先は履歴から取る（固定していない）',
       case when pg_get_functiondef('public.inv_item_sell_undo_target(text)'::regprocedure)
                 like '%from public.inventory_transactions t%'
             and pg_get_functiondef('public.inv_item_sell_undo_target(text)'::regprocedure)
                 like '%select t.before_value%'
            then 'OK' else 'NG' end
union all
select '戻り先の判定は読むだけ（何も変えない）',
       case when pg_get_functiondef('public.inv_item_sell_undo_target(text)'::regprocedure)
                 ~* '(insert|update|delete)\s'
            then 'NG 書いている' else 'OK' end
union all
select '確認画面の判定も anon は呼べない',
       case when has_function_privilege('anon', 'public.inv_item_sell_undo_target(text)', 'execute')
            then 'NG anonが呼べる' else 'OK' end
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
            then 'OK' else 'NG' end
union all
select 'anonは呼べない',
       case when has_function_privilege('anon', 'public.inv_item_sell_undo(text,text)', 'execute')
            then 'NG anonが呼べる' else 'OK' end
union all
select '社員は呼べる（中で権限を見る）',
       case when has_function_privilege('authenticated', 'public.inv_item_sell_undo(text,text)', 'execute')
            then 'OK' else 'NG' end
union all
select 'モールの注文は触らない',
       case when pg_get_functiondef('public.inv_item_sell_undo(text,text)'::regprocedure)
                 like '%inventory_sale_orders%'
            then 'NG 触っている' else 'OK' end
union all
select 'いま売却済の個体数',
       (select count(*)::text from public.inventory_items where status = '売却済') || '台'
union all
select 'うち売却の履歴がある（取り消せる）',
       (select count(*)::text from public.inventory_items i
         where i.status = '売却済'
           and exists (select 1 from public.inventory_transactions t
                        where t.ref_kind='item' and t.ref_id = i.id
                          and t.action in ('売却','状態変更')
                          and t.after_value like '売却済%'
                          and coalesce(btrim(t.before_value),'') not in ('','売却済'))) || '台';
