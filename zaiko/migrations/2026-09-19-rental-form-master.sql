-- ============================================================
-- 8RENTの商品分類を、マスター情報としてDBに確定させる
--   2026-09-19（2026-09-19-rental-text-by-category.sql の後に流す追補）
--
--   これまでの状態
--     rental_form が17商品すべて null のままで、説明の生成が
--     スペックからの推定に頼っていた。その結果、本番で誤判定が出ていた。
--       LATITUDE5420   → desktop（画面サイズが未入力のノートPC）
--       CF-LV9RDQVS    → desktop（同上）
--       16-AG0005AU    → desktop（同上）
--       PROBOOK445G11  → desktop（同上）
--       IPHONE15/256GB → monitor（画面サイズだけ入っていた）
--
--   このmigrationですること
--     1) 17商品の rental_form / rental_listing_type を確定値で保存する
--     2) P-00415（LCD-AS224F）の誤ったスペック「9型」を直す
--     3) 説明の生成は明示された rental_form だけを見るようにする
--        （未分類の商品を desktop / monitor などへ断定しない）
--
--   推定（inv_rental_form）は、未分類の商品を洗い出すときの目安としては残します。
--   人が直した説明（rental_description_manual=true）は触りません。
--   何度流しても同じ結果になります。
--
--   実行後に、説明を作り直してください（人が直したものは対象外）
--     select public.inv_rental_text_fill(false);
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 38-1) 17商品のレンタル区分を確定値として保存する
--
--     これまでは rental_form が全商品 null のままで、説明の生成が
--     スペックからの推定に頼っていた。その結果、画面サイズが入っていない
--     ノートPCが desktop に、画面サイズだけ入っている iPhone が monitor に
--     判定されていた。推定を賢くするのではなく、分類をマスター情報として確定する。
--
--     値は人が決めたもの。ここに無い商品は触らない（未分類のまま）。
-- ------------------------------------------------------------
update public.inventory_products p
   set rental_form         = v.form,
       rental_listing_type = v.listing
  from (values
    ('P-00410', 'notebook',   'standalone'),
    ('P-00411', 'notebook',   'standalone'),
    ('P-00415', 'monitor',    'standalone'),
    ('P-00416', 'notebook',   'standalone'),
    ('P-00418', 'notebook',   'standalone'),
    ('P-00419', 'notebook',   'standalone'),
    ('P-00422', 'notebook',   'standalone'),
    ('P-00424', 'notebook',   'standalone'),
    ('P-00428', 'notebook',   'standalone'),
    ('P-00429', 'notebook',   'standalone'),
    ('P-00430', 'notebook',   'standalone'),
    ('P-00435', 'desktop',    'standalone'),
    ('P-00490', 'other',      'not_public'),
    ('P-00521', 'notebook',   'standalone'),
    ('P-00535', 'peripheral', 'option'),
    ('P-00536', 'notebook',   'standalone'),
    ('P-00537', 'notebook',   'standalone')
  ) as v(code, form, listing)
 where p.code = v.code
   and (p.rental_form is distinct from v.form
        or p.rental_listing_type is distinct from v.listing);

-- ------------------------------------------------------------
-- 38-2) P-00415（LCD-AS224F）の誤ったスペックを直す
--
--     モニターなのに spec に「9型」が入っていた（取り込み時の取り違え）。
--     正しい値を推測で書くことはしない。モールから取り込んだ原文
--     （sale_description）に画面サイズが書かれていればそれを採り、
--     書かれていなければ誤った値を消して空にする。
--     空になった場合は /zaiko の商品詳細で正しい値を入れてください。
-- ------------------------------------------------------------
update public.inventory_products
   set screen_size = coalesce(
         nullif(btrim(coalesce(screen_size, '')), ''),
         -- 原文に「21.5型」「23インチ」のような2桁の表記があればそれを使う
         (select (regexp_match(coalesce(sale_description, '') || ' ' || coalesce(name, ''),
                               '([0-9]{2}(?:\.[0-9])?)\s*(?:型|インチ|inch)', 'i'))[1] || '型')
       ),
       -- spec に入っていた誤った「9型」は消す（モニターのサイズとして成り立たない）
       spec = case when btrim(coalesce(spec, '')) ~ '^9\s*型$' then null else spec end
 where code = 'P-00415';

-- ------------------------------------------------------------
-- 38-3) 説明の生成は、明示された rental_form だけを使う
--
--     推定（inv_rental_form）は「未分類の商品を洗い出すときの目安」として残すが、
--     公開文の生成には使わない。未分類のまま断定的な文（ノートPC／デスクトップ／
--     モニター）を出さないため。未分類の商品は、かたちを言わずに
--     分かっている仕様だけを並べる。
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
  v_unit   text;
begin
  select * into p from public.inventory_products where code = p_code;
  if not found then
    return null;
  end if;
  -- 明示された区分だけを使う。未分類なら推定しない
  v_form   := nullif(btrim(coalesce(p.rental_form, '')), '');
  v_screen := nullif(regexp_replace(coalesce(p.screen_size,''), '[^0-9.]', '', 'g'), '')::numeric;
  v_mem    := nullif(regexp_replace(coalesce(p.memory_size,''), '[^0-9]',   '', 'g'), '')::numeric;
  -- PCとして扱ってよい手がかりがあるか（Officeの案内を出してよいか）
  v_has := nullif(btrim(coalesce(p.cpu,'')),'') is not null
        or nullif(btrim(coalesce(p.os,'')),'') is not null
        or nullif(btrim(coalesce(p.memory_size,'')),'') is not null
        or nullif(btrim(coalesce(p.storage_capacity,'')),'') is not null;
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
      v_head := '法人利用向けの'
             || case v_form when 'desktop' then 'デスクトップPC' else 'ノートPC' end
             || 'です。詳細な仕様は、ご希望条件に合わせてご案内します。';
    end if;
  elsif v_form = 'monitor' then
    v_head := coalesce(nullif(p.screen_size,'') || 'の', '') || '法人のオフィス利用向けのモニターです。'
           || case when nullif(btrim(coalesce(p.screen_size,'')),'') is null
                   then '設置環境やご利用台数に合わせてご案内します。' else '' end;
  elsif v_form = 'peripheral' then
    v_head := '法人でのご利用向けの周辺機器です。PCと合わせてのご利用にも対応します。';
  else
    -- 未分類、または other。かたちを断定しない
    v_head := '法人向けにレンタルできる機器です。詳細な仕様やご利用条件は、ご希望に合わせてご案内します。';
  end if;
  v_out := array_append(v_out, v_head);

  -- ② 主な仕様。分かっているものだけ書く。モニターにCPU・OSは出さない
  if v_form = 'monitor' then
    if nullif(btrim(coalesce(p.screen_size,'')),'') is not null then v_spec := array_append(v_spec, btrim(p.screen_size)); end if;
    if nullif(btrim(coalesce(p.spec,'')),'') is not null then v_spec := array_append(v_spec, btrim(p.spec)); end if;
  elsif v_form = 'peripheral' then
    if nullif(btrim(coalesce(p.spec,'')),'') is not null then v_spec := array_append(v_spec, btrim(p.spec)); end if;
  else
    -- ノートPC・デスクトップPC・未分類は、入っている事実をそのまま並べる
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
  end if;
  if coalesce(array_length(v_spec, 1), 0) > 0 then
    v_out := array_append(v_out, '主な仕様：' || array_to_string(v_spec, ' / '));
  end if;

  -- ③ Office。PCと明示された商品か、未分類でもPCの手がかりがある商品だけ。
  --    8RENTは希望を伺って用意するので、原則は「ご相談ください」
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
  'レンタル向け説明を、明示された rental_form のひな形で組み立てる。
   未分類の商品は、かたち（ノートPC／デスクトップ／モニター）を断定せず、
   分かっている仕様だけを並べる。推定（inv_rental_form）は未分類の洗い出し用で、
   公開文の生成には使わない。OfficeとPC向けの言い回しはPCのときだけ使う。';

comment on function public.inv_rental_form is
  '未分類の商品を洗い出すときの目安。登録済みスペックの有無だけから、かたちの候補を返す
   （商品名やキーワードからの推測はしない）。公開文の生成には使わない
   （断定を避けるため、生成は明示された rental_form だけを見る）。';

-- ------------------------------------------------------------
-- 38-4) 確認：分類の結果と、未分類のまま残っているもの
-- ------------------------------------------------------------
select p.code,
       coalesce(p.name, p.model)            as 商品名,
       p.rental_form                        as かたち,
       p.rental_listing_type                as 出しかた,
       coalesce(p.screen_size, '—')         as 画面サイズ,
       coalesce(p.spec, '—')                as spec
  from public.inventory_products p
 where p.kind = 'individual' and coalesce(p.rental_enabled, false)
 order by p.code;

commit;
