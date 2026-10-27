-- ============================================================
-- 片付け：3引数の inv_item_sell_channel を落とす
--   2026-10-16
--
--   **このSQLは、新しいコードが Production に出て、本番でQR販売を
--   1件ためして確認したあとに実行してください。**
--
--   順番
--     1. 2026-10-15-sold-price-input.sql を実行（4引数を足す。3引数はそのまま）
--     2. 新しいコードを Production へ出す（4引数を呼ぶ）
--     3. 本番でQR販売を1件ためす（実売価格を入れて売れること）
--     4. ← ここでこのSQLを実行（3引数を落とす）
--
--   3 を飛ばしてこれを実行しても、**新しいコードが出ていれば動きます**
--   （新しいコードは4引数しか呼びません）。古いコードが残っている状態で
--   実行すると、その間だけQR販売が「関数が見つかりません」になります。
--
--   落とすのは3引数の形だけです。4引数の形・売却の本体（inv_item_sell /
--   inv_item_op）・売却取消・登録価格を読む関数には触りません。
--   何度実行しても安全です（if exists）。
-- ============================================================

drop function if exists public.inv_item_sell_channel(text, text, text);


-- ------------------------------------------------------------
-- 確認（5項目）
-- ------------------------------------------------------------
select '3引数の形は落ちている' as kind,
       case when to_regprocedure('public.inv_item_sell_channel(text,text,text)') is null
            then 'OK' else 'NG まだある' end as result
union all
select '4引数の形（実売価格を受け取る）は残っている',
       case when to_regprocedure('public.inv_item_sell_channel(text,text,numeric,text)') is not null
            then 'OK' else 'NG 落としすぎ' end
union all
select '社員は4引数の形を呼べる',
       case when has_function_privilege('authenticated',
              'public.inv_item_sell_channel(text,text,numeric,text)', 'execute')
            then 'OK' else 'NG' end
union all
select 'anonは呼べない',
       case when has_function_privilege('anon',
              'public.inv_item_sell_channel(text,text,numeric,text)', 'execute')
            then 'NG anonが呼べる' else 'OK' end
union all
select '売却の本体・取消・登録価格の関数はそのまま',
       case when to_regprocedure('public.inv_item_sell(text,text,text,text)') is not null
             and to_regprocedure('public.inv_item_sell_undo(text,text)') is not null
             and to_regprocedure('public.inv_item_channel_price(text,text)') is not null
            then 'OK' else 'NG' end
union all
select 'inv_item_sell_channel の形は1つだけ',
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'inv_item_sell_channel') || '個';
