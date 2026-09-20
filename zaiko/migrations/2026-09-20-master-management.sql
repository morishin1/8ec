-- ============================================================
-- 保管場所とカテゴリーを管理者が直せるようにする
--   2026-09-20（2026-09-20-public-categories.sql の後に流す追補）
--
--   これまで保管場所もカテゴリーも、最初のデータを入れたきりで
--   画面から増やせなかった。拠点が増えても、カテゴリーを分けたくても
--   SQLを書くしかない。管理者が画面から直せるようにする。
--
--   あわせて「公開側のカテゴリー」と「/zaiko のカテゴリー」を
--   1つのマスターに寄せる。これまでは同じ表の中で
--     name        … /zaiko で出す名前（'PC'）
--     public_name … 公開側で出す名前（'パソコン'）
--   と二重に持っていたので、同じものが画面ごとに違う名前で出ていた。
--   name を正にして、public_name は「どうしても公開だけ変えたいとき」の
--   上書きとして残す（今回はすべて空にする）。
--
--   入っているもの
--     保管場所に 有効/無効（enabled）と拠点 SB C&S
--     カテゴリーに 親子（parent_id）・有効/無効・別名（aliases）
--     パソコンの子 notebook-pc / desktop-pc
--     'PC' → 'パソコン' の表記統一と、CSVの 'PC' を pc に寄せる別名
--     管理者だけが使える保管場所・カテゴリーの追加/編集/削除のRPC
--     公開ビュー inv_public_categories を親子つきで作り直す
--
--   何度流しても同じ結果になる。既存のIDも紐付けも変えない。
--
--   実行後の確認
--     select id, name, parent_id, sort_no, enabled, public_listed
--       from public.inventory_categories order by coalesce(parent_id,id), sort_no;
--     select * from public.inv_public_categories;
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 43-1) 保管場所：有効/無効と、種別「その他」
--
--     使い終わった場所を消すと履歴が読めなくなるので、基本は無効にする。
--     無効にした場所は新規登録・移動の選択肢に出さないが、
--     すでに置いてあるものの表示名は出す（「無効」の印をつける）。
-- ------------------------------------------------------------
alter table public.inventory_locations add column if not exists enabled boolean not null default true;

comment on column public.inventory_locations.enabled is
  '使えるかどうか。false は新規登録・移動の選択肢に出さない。
   すでに置いてあるものの表示には出す（名前が消えると履歴が読めなくなるため）。';
comment on column public.inventory_locations.kind is
  'site(拠点) / room(倉庫・部屋) / shelf(棚) / other(その他)';

-- 同じ親の下に同じ名前を作らせない。別の拠点に同名の「倉庫」があるのは許す
create unique index if not exists inventory_locations_uniq_name
  on public.inventory_locations (coalesce(parent_id, ''), name);

-- ------------------------------------------------------------
-- 43-2) 拠点 SB C&S
--
--     本社・柏・岩瀬の後に置く。名前に & が入るので、画面に出すときは
--     エスケープして &amp; と表示されないようにしている（app.js の esc）。
-- ------------------------------------------------------------
insert into public.inventory_locations (id, parent_id, name, kind, sort_no, enabled)
values ('L30', null, 'SB C&S', 'site', 40, true)
on conflict (id) do nothing;

-- ------------------------------------------------------------
-- 43-3) カテゴリー：親子・有効/無効・別名
--
--     parent_id  パソコン → ノートパソコン / デスクトップパソコン のような入れ子
--     enabled    使い終わったカテゴリーは消さずに無効にする
--     aliases    CSVに入っている古い表記（'PC' 'ＰＣ'…）をIDへ寄せるための別名。
--                商品は表示名ではなくIDで紐づくので、表示名を変えても切れない
-- ------------------------------------------------------------
alter table public.inventory_categories add column if not exists parent_id text;
alter table public.inventory_categories add column if not exists enabled   boolean not null default true;
alter table public.inventory_categories add column if not exists aliases   text[]  not null default '{}';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_categories_parent_fk') then
    alter table public.inventory_categories
      add constraint inventory_categories_parent_fk
      foreign key (parent_id) references public.inventory_categories(id) on delete restrict;
  end if;
end $$;

comment on column public.inventory_categories.parent_id is
  '親カテゴリー。パソコン → ノートパソコン / デスクトップパソコン のような入れ子に使う。';
comment on column public.inventory_categories.enabled is
  '使えるかどうか。false は新規登録の候補に出さない。既存商品では名前を出し「無効」の印をつける。';
comment on column public.inventory_categories.aliases is
  'CSV取込などで受け付ける別名。表示名を変えても取込が壊れないようにするためのもの。';
comment on column public.inventory_categories.name is
  'カテゴリー名。/zaiko も公開側もこれを出す（1つのマスターを正とする）。
   公開側だけ別の名前にしたいときだけ public_name を入れる。';
comment on column public.inventory_categories.public_name is
  '公開側だけ別名にしたいときの上書き。空なら name を使う。通常は空。';
comment on column public.inventory_categories.public_sort is
  '公開側だけ並びを変えたいときの上書き。空なら sort_no を使う。通常は空。';

create index if not exists inventory_categories_parent_idx
  on public.inventory_categories (parent_id, sort_no);

-- 同じ親の下に同じ名前を作らせない
create unique index if not exists inventory_categories_uniq_name
  on public.inventory_categories (coalesce(parent_id, ''), name);

-- ------------------------------------------------------------
-- 43-4) 表示名を1つにそろえる
--
--     これまで /zaiko は name（'PC'）、公開側は public_name（'パソコン'）を
--     出していたので、同じカテゴリーが画面ごとに違う名前で見えていた。
--     公開側の表記を name に移し、public_name は空にする。
--     古い name は aliases に残すので、その名前で書かれたCSVも取り込める。
-- ------------------------------------------------------------
update public.inventory_categories c
   set aliases = (
         select array_agg(distinct a) from unnest(
           c.aliases || array[c.name, btrim(coalesce(c.public_name, ''))]) a
          where btrim(coalesce(a, '')) <> ''
             and btrim(a) is distinct from btrim(coalesce(nullif(btrim(coalesce(c.public_name,'')),''), c.name)))
 where btrim(coalesce(c.public_name, '')) <> ''
   and btrim(c.public_name) is distinct from c.name;

update public.inventory_categories
   set name = btrim(public_name),
       public_name = null
 where btrim(coalesce(public_name, '')) <> ''
   and btrim(public_name) is distinct from name;

-- 並びも1つにする（public_sort は「公開だけ変えたいとき」の上書きに戻す）
update public.inventory_categories
   set sort_no = public_sort, public_sort = null
 where public_sort is not null and public_sort is distinct from sort_no;

-- CSVで昔から使われている表記を、パソコンの別名として受け付ける。
-- 'ノートPC' 'デスクトップPC' はここには入れない（子カテゴリーの別名なので、
-- 親に付けると どちらに寄せるか決まらなくなる）
update public.inventory_categories
   set aliases = (select array_agg(distinct a)
                    from unnest(aliases || array['PC','ＰＣ','パソコン']) a
                   where btrim(coalesce(a,'')) <> '' and btrim(a) <> name)
 where id = 'pc';

-- ------------------------------------------------------------
-- 43-5) パソコンの子カテゴリー
--
--     既存のPC商品を型番や商品名から機械的に振り分けることはしない
--     （「ProBook」だからノート、と決めつけると必ず外れる）。
--     いまある商品は親の「パソコン」のまま（＝未分類）にしておき、
--     管理者が商品ごとに選び直す。新しく登録するときは子を選んでもらう。
-- ------------------------------------------------------------
insert into public.inventory_categories
  (id, name, kind, code_prefix, sort_no, parent_id, enabled, public_listed, public_icon, aliases)
values
  ('notebook-pc', 'ノートパソコン',       'individual', 'PC', 11, 'pc', true, true, 'laptop_mac',      array['ノートPC','ノート','notebook']),
  ('desktop-pc',  'デスクトップパソコン', 'individual', 'PC', 12, 'pc', true, true, 'desktop_windows', array['デスクトップPC','デスクトップ','desktop'])
on conflict (id) do nothing;

-- すでに入っているときも、親と並びだけはこの通りにそろえる
update public.inventory_categories
   set parent_id = 'pc', public_listed = true, enabled = true
 where id in ('notebook-pc', 'desktop-pc');

-- ------------------------------------------------------------
-- 43-6) 商品とカテゴリーの紐付けについて
--
--     ここで 'PC' → 'pc' のようなデータ移行は要りません。
--     inventory_products.category_id と inventory_items.category_id は
--     inventory_categories(id) への外部キーなので、'PC' という値はそもそも
--     入りません。商品はもともとIDで紐づいています。
--
--     画面に 'PC' と出ていたのは、IDではなく表示名（name）が 'PC' だったため。
--     43-4 で name を 'パソコン' にそろえたので、商品の紐付けは一切触らずに
--     すべての画面の表記が変わります。
--
--     CSVに書かれた 'PC' という文字は、43-4 で入れた別名（aliases）と
--     inv_category_resolve() が pc へ寄せます。
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 43-7) 保管場所の追加・編集（管理者だけ）
--
--     自分自身や自分の子孫を親にすると輪ができて、パスをたどる処理が
--     止まらなくなる。ここで断る。
-- ------------------------------------------------------------
create or replace function public.inv_location_save(
  p_id      text default null,
  p_name    text default null,
  p_kind    text default 'shelf',
  p_parent  text default null,
  p_sort    integer default null,
  p_enabled boolean default true
) returns public.inventory_locations
language plpgsql
security invoker
set search_path = public
as $$
declare
  r      public.inventory_locations;
  v_id   text := nullif(btrim(coalesce(p_id, '')), '');
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_par  text := nullif(btrim(coalesce(p_parent, '')), '');
  v_cur  text;
  n      integer;
begin
  if not public.inv_is_admin() then
    raise exception '保管場所を直せるのは管理者だけです';
  end if;
  if v_name is null then
    raise exception '名称を入れてください';
  end if;
  if p_kind not in ('site', 'room', 'shelf', 'other') then
    raise exception '種別は 拠点・倉庫・棚・その他 のどれかです（%）', p_kind;
  end if;
  if v_par is not null and not exists (select 1 from public.inventory_locations where id = v_par) then
    raise exception '親の保管場所が見つかりません（%）', v_par;
  end if;

  -- 自分自身・自分の子孫を親にしない（親をたどって自分に戻らないか見る）
  if v_id is not null and v_par is not null then
    if v_par = v_id then
      raise exception '自分自身を親にはできません';
    end if;
    v_cur := v_par;
    for n in 1..50 loop
      select parent_id into v_cur from public.inventory_locations where id = v_cur;
      exit when v_cur is null;
      if v_cur = v_id then
        raise exception '自分の下にある場所を親にはできません（入れ子が輪になります）';
      end if;
    end loop;
  end if;

  if exists (select 1 from public.inventory_locations
              where name = v_name
                and coalesce(parent_id, '') = coalesce(v_par, '')
                and (v_id is null or id <> v_id)) then
    raise exception '同じ場所の下に「%」がすでにあります', v_name;
  end if;

  if v_id is null then
    -- L1, L2 … と同じ形で採番する（棚QRのURLに入るキーなので短く保つ）
    select 'L' || (coalesce(max(nullif(regexp_replace(id, '^L', ''), '')::integer), 0) + 1)::text
      into v_id
      from public.inventory_locations
     where id ~ '^L[0-9]+$';
    insert into public.inventory_locations (id, parent_id, name, kind, sort_no, enabled)
    values (v_id, v_par, v_name, p_kind,
            coalesce(p_sort, (select coalesce(max(sort_no), 0) + 10 from public.inventory_locations
                               where coalesce(parent_id, '') = coalesce(v_par, ''))),
            coalesce(p_enabled, true))
    returning * into r;
  else
    update public.inventory_locations
       set name = v_name, kind = p_kind, parent_id = v_par,
           sort_no = coalesce(p_sort, sort_no), enabled = coalesce(p_enabled, enabled)
     where id = v_id
    returning * into r;
    if not found then
      raise exception '保管場所が見つかりません（%）', v_id;
    end if;
  end if;
  return r;
end $$;

comment on function public.inv_location_save is
  '保管場所を足す・直す（管理者だけ）。IDを渡さなければ新規、渡せば更新。
   自分自身や自分の子孫は親にできない。同じ親の下に同じ名前は作れない。';

-- ------------------------------------------------------------
-- 43-8) 保管場所を消してよいか
--
--     使い終わった場所は「削除」ではなく「無効」にする。
--     消してしまうと、そこに置いてあった履歴（移動・棚卸）の行き先が
--     読めなくなるため。理由と件数を返す。
-- ------------------------------------------------------------
create or replace function public.inv_location_delete_check(p_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  l       public.inventory_locations;
  reasons jsonb := '[]'::jsonb;
  n       integer;
  v_path  text;
begin
  select * into l from public.inventory_locations where id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'found', false,
      'reasons', jsonb_build_array('この保管場所は見つかりません。'::text));
  end if;

  select count(*) into n from public.inventory_locations where parent_id = p_id;
  if n > 0 then
    reasons := reasons || to_jsonb(('この下に保管場所が ' || n || '件あります。別の保管場所へ移動するか、無効にしてください。')::text);
  end if;

  -- 個体の論理削除（deleted_at）は別のブランチで入る列なので、あっても無くても
  -- 同じように数えられる形にしている（列が無ければ to_jsonb に出てこない＝null）
  select count(*) into n from public.inventory_items i
   where i.location_id = p_id and (to_jsonb(i) ->> 'deleted_at') is null;
  if n > 0 then
    reasons := reasons || to_jsonb(('個体が ' || n || '台置かれています。別の保管場所へ移動するか、無効にしてください。')::text);
  end if;

  select count(*) into n from public.inventory_products where location_id = p_id;
  if n > 0 then
    reasons := reasons || to_jsonb(('数量管理の品目が ' || n || '件置かれています。別の保管場所へ移動するか、無効にしてください。')::text);
  end if;

  -- 移動の履歴。inv_item_op('移動') は保管場所をフルパスの文字列で残すので、
  -- そのパスで引き当てる（履歴の表に保管場所IDを持たせていないため）
  v_path := public.inv_location_path(p_id);
  if coalesce(v_path, '') <> '' then
    select count(*) into n from public.inventory_transactions
     where ref_kind = 'item' and action = '移動'
       and (before_value = v_path or after_value = v_path or after_value like v_path || '／%');
    if n > 0 then
      reasons := reasons || to_jsonb(('移動の履歴が ' || n || '件あります。別の保管場所へ移動するか、無効にしてください。')::text);
    end if;
  end if;

  select count(*) into n from public.inventory_stocktakes where scope_location_id = p_id;
  if n > 0 then
    reasons := reasons || to_jsonb(('棚卸の記録が ' || n || '件あります。別の保管場所へ移動するか、無効にしてください。')::text);
  end if;

  return jsonb_build_object('ok', jsonb_array_length(reasons) = 0, 'found', true,
    'id', l.id, 'name', l.name, 'reasons', reasons);
end $$;

comment on function public.inv_location_delete_check is
  '保管場所を消してよいかを返す。だめなときは件数と「別の保管場所へ移動するか、無効にしてください」を返す。';

create or replace function public.inv_location_delete(p_id text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  l   public.inventory_locations;
  chk jsonb;
begin
  if not public.inv_is_admin() then
    raise exception '保管場所を消せるのは管理者だけです';
  end if;
  select * into l from public.inventory_locations where id = p_id for update;
  if not found then
    raise exception '保管場所が見つかりません（%）', p_id;
  end if;
  -- 押すまでのあいだに物が置かれていることがあるので、ここでもう一度見る
  chk := public.inv_location_delete_check(p_id);
  if not (chk ->> 'ok')::boolean then
    raise exception '%', (select string_agg(value, ' ') from jsonb_array_elements_text(chk -> 'reasons'));
  end if;
  delete from public.inventory_locations where id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id, 'name', l.name);
end $$;

comment on function public.inv_location_delete is
  '空で使われていない保管場所を消す（管理者だけ）。関連データは道連れにしない。';

-- ------------------------------------------------------------
-- 43-9) カテゴリーの追加・編集（管理者だけ）
--
--     IDは作るときだけ決める。あとから変えると、商品・個体・URL・公開側の
--     紐付けが一斉に切れるので、更新では受け付けない。
--     表示名を変えても商品はIDで紐づいているので切れない。
-- ------------------------------------------------------------
create or replace function public.inv_category_save(
  p_id      text default null,
  p_name    text default null,
  p_kind    text default 'individual',
  p_parent  text default null,
  p_icon    text default null,
  p_sort    integer default null,
  p_enabled boolean default true,
  p_public  boolean default false,
  p_prefix  text default null
) returns public.inventory_categories
language plpgsql
security invoker
set search_path = public
as $$
declare
  r      public.inventory_categories;
  v_id   text := nullif(btrim(lower(coalesce(p_id, ''))), '');
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_par  text := nullif(btrim(coalesce(p_parent, '')), '');
  v_cur  text;
  v_base text;
  n      integer;
begin
  if not public.inv_is_admin() then
    raise exception 'カテゴリーを直せるのは管理者だけです';
  end if;
  if v_name is null then
    raise exception '表示名を入れてください';
  end if;
  if p_kind not in ('individual', 'quantity') then
    raise exception '管理方式は 個体管理 か 数量管理 です（%）', p_kind;
  end if;
  if v_par is not null and not exists (select 1 from public.inventory_categories where id = v_par) then
    raise exception '親カテゴリーが見つかりません（%）', v_par;
  end if;

  if v_id is not null and v_par is not null then
    if v_par = v_id then
      raise exception '自分自身を親にはできません';
    end if;
    v_cur := v_par;
    for n in 1..50 loop
      select parent_id into v_cur from public.inventory_categories where id = v_cur;
      exit when v_cur is null;
      if v_cur = v_id then
        raise exception '自分の下にあるカテゴリーを親にはできません（入れ子が輪になります）';
      end if;
    end loop;
  end if;

  if exists (select 1 from public.inventory_categories
              where name = v_name
                and coalesce(parent_id, '') = coalesce(v_par, '')
                and (v_id is null or id <> v_id)) then
    raise exception '同じ場所に「%」がすでにあります', v_name;
  end if;

  if v_id is null or not exists (select 1 from public.inventory_categories where id = v_id) then
    -- 新規。IDは英数字とハイフンだけにする（URL・公開ビューに出るため）
    -- 名前からIDを作るのは、名前が英数字だけのときに限る。
    -- 「タブレットPC」から 'pc' を作ると、中身と合わない紛らわしいIDになるため。
    -- 日本語が混じる名前は cat-1, cat-2 … にする（IDはURLと公開ビューに出るので英数字だけにする）
    if v_id is null and v_name ~ '^[A-Za-z0-9][A-Za-z0-9 ._-]*$' then
      v_id := btrim(regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'), '-');
    end if;
    v_id := btrim(regexp_replace(coalesce(v_id, ''), '[^a-z0-9-]+', '-', 'g'), '-');
    if v_id = '' or v_id !~ '^[a-z0-9][a-z0-9-]*$' then
      select 'cat-' || (coalesce(max(nullif(regexp_replace(id, '^cat-', ''), '')::integer), 0) + 1)::text
        into v_id
        from public.inventory_categories
       where id ~ '^cat-[0-9]+$';
    end if;
    -- 名前から作ったIDが埋まっていたら、末尾に番号を足す
    -- （「タブレットPC」→ pc が埋まっている → pc-2）。
    -- IDを人が指定したときだけは、黙って別のIDにせずエラーにする
    if exists (select 1 from public.inventory_categories where id = v_id) then
      if nullif(btrim(lower(coalesce(p_id, ''))), '') is not null then
        raise exception 'カテゴリーID「%」はすでに使われています。別のIDを指定してください', v_id;
      end if;
      v_base := v_id;
      for n in 2..99 loop
        v_id := v_base || '-' || n::text;
        exit when not exists (select 1 from public.inventory_categories where id = v_id);
      end loop;
      if exists (select 1 from public.inventory_categories where id = v_id) then
        raise exception 'カテゴリーIDを決められませんでした。IDを指定してください';
      end if;
    end if;
    insert into public.inventory_categories
      (id, name, kind, code_prefix, sort_no, parent_id, enabled, public_listed, public_icon)
    values
      (v_id, v_name, p_kind, nullif(btrim(coalesce(p_prefix, '')), ''),
       coalesce(p_sort, (select coalesce(max(sort_no), 0) + 10 from public.inventory_categories
                          where coalesce(parent_id, '') = coalesce(v_par, ''))),
       v_par, coalesce(p_enabled, true), coalesce(p_public, false),
       nullif(btrim(coalesce(p_icon, '')), ''))
    returning * into r;
  else
    update public.inventory_categories
       set name = v_name, kind = p_kind, parent_id = v_par,
           code_prefix = coalesce(nullif(btrim(coalesce(p_prefix, '')), ''), code_prefix),
           sort_no = coalesce(p_sort, sort_no),
           enabled = coalesce(p_enabled, enabled),
           public_listed = coalesce(p_public, public_listed),
           public_icon = coalesce(nullif(btrim(coalesce(p_icon, '')), ''), public_icon)
     where id = v_id
    returning * into r;
  end if;
  return r;
end $$;

comment on function public.inv_category_save is
  'カテゴリーを足す・直す（管理者だけ）。IDは作るときだけ決まり、あとから変えられない
   （変えると商品・個体・URL・公開側の紐付けが一斉に切れるため）。表示名を変えても
   商品はIDで紐づいているので切れない。';

-- ------------------------------------------------------------
-- 43-10) カテゴリーを消してよいか
-- ------------------------------------------------------------
create or replace function public.inv_category_delete_check(p_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  c       public.inventory_categories;
  reasons jsonb := '[]'::jsonb;
  n       integer;
  n_pub   integer;
begin
  select * into c from public.inventory_categories where id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'found', false,
      'reasons', jsonb_build_array('このカテゴリーは見つかりません。'::text));
  end if;

  select count(*) into n from public.inventory_categories where parent_id = p_id;
  if n > 0 then
    reasons := reasons || to_jsonb(('この下にカテゴリーが ' || n || '件あります。先に付け替えるか、無効にしてください。')::text);
  end if;

  select count(*) into n from public.inventory_products where category_id = p_id;
  select count(*) into n_pub from public.inventory_products
   where category_id = p_id and coalesce(rental_enabled, false);
  if n_pub > 0 then
    reasons := reasons || to_jsonb(('公開中・8RENT対象の商品が ' || n_pub || '件あります。別のカテゴリーへ移すか、無効にしてください。')::text);
  elsif n > 0 then
    reasons := reasons || to_jsonb(('商品が ' || n || '件ぶら下がっています。別のカテゴリーへ移すか、無効にしてください。')::text);
  end if;

  select count(*) into n from public.inventory_items i
   where i.category_id = p_id and (to_jsonb(i) ->> 'deleted_at') is null;
  if n > 0 then
    reasons := reasons || to_jsonb(('個体が ' || n || '台ぶら下がっています。別のカテゴリーへ移すか、無効にしてください。')::text);
  end if;

  return jsonb_build_object('ok', jsonb_array_length(reasons) = 0, 'found', true,
    'id', c.id, 'name', c.name,
    'products', (select count(*) from public.inventory_products where category_id = p_id),
    'reasons', reasons);
end $$;

comment on function public.inv_category_delete_check is
  'カテゴリーを消してよいかを返す。だめなときは紐付いている件数と、移し替えを促す文を返す。';

create or replace function public.inv_category_delete(p_id text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  c   public.inventory_categories;
  chk jsonb;
begin
  if not public.inv_is_admin() then
    raise exception 'カテゴリーを消せるのは管理者だけです';
  end if;
  select * into c from public.inventory_categories where id = p_id for update;
  if not found then
    raise exception 'カテゴリーが見つかりません（%）', p_id;
  end if;
  chk := public.inv_category_delete_check(p_id);
  if not (chk ->> 'ok')::boolean then
    raise exception '%', (select string_agg(value, ' ') from jsonb_array_elements_text(chk -> 'reasons'));
  end if;
  delete from public.inventory_categories where id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id, 'name', c.name);
end $$;

comment on function public.inv_category_delete is
  '空で使われていないカテゴリーを消す（管理者だけ）。商品や個体は道連れにしない。';

-- ------------------------------------------------------------
-- 43-11) CSV取込のカテゴリー正規化
--
--     取込のとき、'PC' のような昔の表記や表示名で書かれた値を
--     カテゴリーIDへ寄せる。見つからないものは勝手に作らず null を返して
--     エラー一覧に出す（知らないカテゴリーが黙って増えると、あとで
--     どれが正しいのか分からなくなるため）。
-- ------------------------------------------------------------
create or replace function public.inv_category_resolve(p_value text, p_kind text default null)
returns text
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with v as (select btrim(coalesce(p_value, '')) as t)
  select c.id
    from public.inventory_categories c, v
   where v.t <> ''
     and (p_kind is null or c.kind = p_kind)
     and (lower(c.id) = lower(v.t)
          or c.name = v.t
          or exists (select 1 from unnest(c.aliases) a where btrim(a) = v.t))
   order by (lower(c.id) = lower(v.t)) desc, (c.name = v.t) desc, c.sort_no
   limit 1;
$$;

comment on function public.inv_category_resolve is
  'CSVなどに書かれたカテゴリーの値（ID・表示名・別名）をカテゴリーIDへ寄せる。
   見つからなければ null。知らないカテゴリーを自動で作ることはしない。';

-- ------------------------------------------------------------
-- 43-12) 公開ビューを親子つきで作り直す
--
--     公開側のカテゴリーは、この1つのマスターから出す。
--     公開用の別マスターは作らない（二重管理すると必ずずれる）。
--     子（ノートパソコン・デスクトップパソコン）も返す。トップには親だけを
--     タイルで出し、親を選んだあとの絞り込みに子を使う。
--     無効（enabled=false）と非公開（public_listed=false）は返さない。
--     親が無効・非公開なら、子も出さない。
-- ------------------------------------------------------------
drop view if exists public.inv_public_categories;
create view public.inv_public_categories as
with live as (
  -- 列は名前で並べる（表に列を足した順で定義が変わらないように）
  select c.id, c.name, c.parent_id, c.sort_no,
         c.public_name, c.public_icon, c.public_sort
    from public.inventory_categories c
   where c.enabled and c.public_listed
)
select l.id,
       coalesce(nullif(btrim(coalesce(l.public_name, '')), ''), l.name)            as name,
       coalesce(nullif(btrim(coalesce(l.public_icon, '')), ''), 'devices_other')   as icon,
       coalesce(l.public_sort, l.sort_no, 0)                                       as sort_no,
       l.parent_id
  from live l
 where l.parent_id is null
    or exists (select 1 from live p where p.id = l.parent_id)
 order by coalesce(l.public_sort, l.sort_no, 0), l.id;

comment on view public.inv_public_categories is
  '公開画面の「カテゴリーから探す」に出すカテゴリー。/zaiko と同じ1つのマスターから出す。
   商品が0件でも消えない。無効・非公開は返さない。親が出ていない子も返さない。
   parent_id が入っている行は子カテゴリーで、トップのタイルではなく親を選んだあとの
   絞り込みに使う。';

grant select on public.inv_public_categories to anon, authenticated;

-- ------------------------------------------------------------
-- 43-13) 実行権限
--
--     anon（公開キー）には渡さない。Webアプリからは authenticated だけが呼べて、
--     関数の中の inv_is_admin() でさらに管理者に絞る。
-- ------------------------------------------------------------
revoke all on function public.inv_location_save(text,text,text,text,integer,boolean) from public;
revoke all on function public.inv_location_delete_check(text) from public;
revoke all on function public.inv_location_delete(text) from public;
revoke all on function public.inv_category_save(text,text,text,text,text,integer,boolean,boolean,text) from public;
revoke all on function public.inv_category_delete_check(text) from public;
revoke all on function public.inv_category_delete(text) from public;
revoke all on function public.inv_category_resolve(text,text) from public;

grant execute on function public.inv_location_save(text,text,text,text,integer,boolean) to authenticated;
grant execute on function public.inv_location_delete_check(text) to authenticated;
grant execute on function public.inv_location_delete(text) to authenticated;
grant execute on function public.inv_category_save(text,text,text,text,text,integer,boolean,boolean,text) to authenticated;
grant execute on function public.inv_category_delete_check(text) to authenticated;
grant execute on function public.inv_category_delete(text) to authenticated;
grant execute on function public.inv_category_resolve(text,text) to authenticated;

commit;
