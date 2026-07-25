-- ============================================================
-- 問い合わせ・見積もりフォームの内容を Slack に通知する
--   サイト各ページのフォーム（トップ／PC／クラウド情シス／AI開発／会社概要）から
--   contact_submissions に1件登録されるたびに、Slackへ自動投稿します。
--
--   Slack の Webhook URL はブラウザ側には一切置きません。
--   （置くと URL を知った誰でもチャンネルに投稿できてしまうため）
--   Supabase の Vault に保管し、データベースのトリガーがサーバー側で送信します。
--
--   前提：admin/contact/supabase-setup.sql を先に実行しておくこと
-- ============================================================


-- ------------------------------------------------------------
-- 【手順1】Slack 側で「受信 Webhook（Incoming Webhook）」を作る
-- ------------------------------------------------------------
--   1. https://api.slack.com/apps → 「Create New App」→「From scratch」
--   2. アプリ名（例：8ec お問い合わせ通知）と、通知したいワークスペースを選ぶ
--   3. 左メニュー「Incoming Webhooks」を開き、スイッチを On
--   4. 「Add New Webhook to Workspace」→ 通知先チャンネルを選んで許可
--   5. 表示される https://hooks.slack.com/services/... をコピー
--
-- ------------------------------------------------------------
-- 【手順2】pg_net（DBから外部へHTTPを送る拡張）を有効にする
-- ------------------------------------------------------------
create extension if not exists pg_net;


-- ------------------------------------------------------------
-- 【手順3】Webhook URL を Vault に保存する
--   下の 'https://hooks.slack.com/services/XXXX/YYYY/ZZZZ' を、
--   手順1でコピーしたURLに置き換えてから、この部分だけを実行してください。
--   （URLは暗号化されて保存され、この後の再実行では書き換えになります）
-- ------------------------------------------------------------
do $$
declare v_url text := 'https://hooks.slack.com/services/XXXX/YYYY/ZZZZ';   -- ← ここを差し替える
declare v_id  uuid;
begin
  if v_url like '%XXXX/YYYY/ZZZZ%' then
    raise notice 'Slack の Webhook URL がまだ差し替えられていません。手順3のURLを書き換えてから実行してください。';
    return;
  end if;
  select id into v_id from vault.secrets where name = 'slack_webhook_url';
  if v_id is null then
    perform vault.create_secret(v_url, 'slack_webhook_url', '問い合わせフォームのSlack通知先');
    raise notice 'Slack の Webhook URL を保存しました。';
  else
    perform vault.update_secret(v_id, v_url, 'slack_webhook_url', '問い合わせフォームのSlack通知先');
    raise notice 'Slack の Webhook URL を更新しました。';
  end if;
end $$;


-- ------------------------------------------------------------
-- 【手順4】通知本体（ここから下はそのまま実行してください）
-- ------------------------------------------------------------

-- Slack の mrkdwn で意味を持つ文字をエスケープする
create or replace function public.slack_escape(p text) returns text
language sql immutable as $$
  select replace(replace(replace(coalesce(p,''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
$$;

-- 送信元ページのコードを日本語名にする
create or replace function public.contact_source_label(p text) returns text
language sql immutable as $$
  select case coalesce(p,'')
    when 'top'     then 'トップページ'
    when 'pc'      then 'PCレンタル'
    when 'cloud'   then 'クラウド情シス'
    when 'ai-dev'  then 'AI・業務システム開発'
    when 'company' then '会社概要'
    when 'general' then 'その他'
    else coalesce(nullif(p,''), 'その他')
  end
$$;

create or replace function public.contact_notify_slack() returns trigger
language plpgsql security definer set search_path = public, vault, net as $$
declare
  v_url    text;
  v_fields jsonb := '[]'::jsonb;
  v_blocks jsonb;
  v_body   jsonb;
  v_when   text;
begin
  -- 通知先が未設定なら、何もせず投函だけ成功させる
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'slack_webhook_url' limit 1;
  if v_url is null or btrim(v_url) = '' then
    return new;
  end if;

  v_when := to_char(coalesce(new.created_at, now()) at time zone 'Asia/Tokyo', 'YYYY/MM/DD HH24:MI');

  -- 入力があった項目だけを並べる（Slackは空文字のフィールドを受け付けないため）
  v_fields := v_fields || jsonb_build_array(
    jsonb_build_object('type','mrkdwn','text','*お名前*' || E'\n' || public.slack_escape(new.name)));
  if coalesce(btrim(new.company),'') <> '' then
    v_fields := v_fields || jsonb_build_array(
      jsonb_build_object('type','mrkdwn','text','*会社名*' || E'\n' || public.slack_escape(new.company)));
  end if;
  if coalesce(btrim(new.email),'') <> '' then
    v_fields := v_fields || jsonb_build_array(
      jsonb_build_object('type','mrkdwn','text','*メール*' || E'\n' || public.slack_escape(new.email)));
  end if;
  if coalesce(btrim(new.phone),'') <> '' then
    v_fields := v_fields || jsonb_build_array(
      jsonb_build_object('type','mrkdwn','text','*電話*' || E'\n' || public.slack_escape(new.phone)));
  end if;
  v_fields := v_fields || jsonb_build_array(
    jsonb_build_object('type','mrkdwn','text','*ご相談種別*' || E'\n' || public.slack_escape(coalesce(nullif(btrim(new.inquiry_type),''),'未選択'))));
  v_fields := v_fields || jsonb_build_array(
    jsonb_build_object('type','mrkdwn','text','*送信元ページ*' || E'\n' || public.slack_escape(public.contact_source_label(new.source))));

  v_blocks := jsonb_build_array(
    jsonb_build_object(
      'type','header',
      'text', jsonb_build_object('type','plain_text','text','🔔 お問い合わせ・見積もり依頼が届きました','emoji',true)),
    jsonb_build_object('type','section','fields', v_fields)
  );

  -- 本文（長い場合はSlackの上限に配慮して2500文字で切る）
  if coalesce(btrim(new.message),'') <> '' then
    v_blocks := v_blocks || jsonb_build_array(
      jsonb_build_object('type','section','text',
        jsonb_build_object('type','mrkdwn','text','*内容*' || E'\n' ||
          public.slack_escape(left(new.message, 2500)))));
  end if;

  v_blocks := v_blocks || jsonb_build_array(
    jsonb_build_object('type','actions','elements', jsonb_build_array(
      jsonb_build_object(
        'type','button','style','primary',
        'text', jsonb_build_object('type','plain_text','text','管理画面で対応する','emoji',true),
        'url','https://www.8ec.jp/admin/contact/'))),
    jsonb_build_object('type','context','elements', jsonb_build_array(
      jsonb_build_object('type','mrkdwn','text','受信 ' || v_when || '（JST）　管理番号 `' || new.id::text || '`')))
  );

  v_body := jsonb_build_object(
    -- text はスマホの通知プレビューやSlack検索に使われる
    'text', '新しいお問い合わせ：' || public.slack_escape(new.name) || ' 様（' ||
            public.contact_source_label(new.source) || '）',
    'blocks', v_blocks);

  -- pg_net は非同期でキューに積むだけなので、Slackが遅くても投函はブロックされない
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type','application/json'),
    body    := v_body
  );

  return new;
exception when others then
  -- 通知に失敗しても、お客様の送信自体は必ず成功させる
  raise warning 'Slack通知に失敗しました: %', sqlerrm;
  return new;
end $$;

drop trigger if exists contact_submissions_slack_notify on public.contact_submissions;
create trigger contact_submissions_slack_notify
  after insert on public.contact_submissions
  for each row execute function public.contact_notify_slack();


-- ------------------------------------------------------------
-- 【手順5】動作確認
--   下の1行を実行すると、テストの問い合わせが1件登録されてSlackに通知が飛びます。
--   確認できたら、管理画面（/admin/contact/）からその1件を削除してください。
-- ------------------------------------------------------------
-- select public.contact_public_submit('top','テスト太郎','テスト株式会社','test@example.com','03-0000-0000','Slack通知のテストです。','お見積もり');

-- 送信の結果を見る（status 200 なら成功。エラー時はここに理由が出ます）
-- select id, status_code, content, created from net._http_response order by id desc limit 5;

notify pgrst, 'reload schema';
