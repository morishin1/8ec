/* 8EC: 月末在庫（管理者専用、記録済み月の読み取り＋CSV） */
'use strict';
const monthEndUi = { loaded: false, list: [], selected: '', lines: [], error: '', busy: false };

function monthEndErrorText(error) {
  if (!error) return '';
  if (/does not exist|schema cache|PGRST205|42883|42P01/i.test((error.message || '') + ' ' + (error.code || ''))) {
    return '月末在庫のSQLがまだ適用されていません（2026-11-01-month-end-inventory.sql）。';
  }
  return error.message || '読み込みに失敗しました';
}
async function loadMonthEnds() {
  if (!canAdmin() || monthEndUi.busy) return;
  monthEndUi.busy = true;
  monthEndUi.error = '';
  if (ui.screen === 'monthEnd') render();
  try {
    const { data, error } = await sb.from('inventory_month_end_snapshots')
      .select('*').order('month_end', { ascending: false }).limit(120);
    if (error) throw error;
    monthEndUi.list = data || [];
    monthEndUi.loaded = true;
    if (!monthEndUi.list.some(m => m.month_end === monthEndUi.selected)) {
      monthEndUi.selected = (monthEndUi.list[0] || {}).month_end || '';
    }
    await fetchMonthEndLines();
  } catch (e) {
    monthEndUi.error = monthEndErrorText(e);
  } finally {
    monthEndUi.busy = false;
    if (ui.screen === 'monthEnd') render();
  }
}

async function fetchMonthEndLines() {
  monthEndUi.lines = [];
  if (!monthEndUi.selected) return;
  // PostgRESTの既定1000行で一覧が途中までにならないようにページ読み込み。
  for (let page = 0; page < 100; page++) {
    const { data, error } = await sb.from('inventory_month_end_lines')
      .select('kind,ref_id,product_code,name,model,status,location_name,qty,unit_cost,total_cost,purchased_on')
      .eq('month_end', monthEndUi.selected).order('kind').order('ref_id')
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (error) throw error;
    monthEndUi.lines.push(...(data || []));
    if (!data || data.length < 1000) return;
  }
  throw new Error('明細が10万行を超えました。全件取得を確認してください');
}
async function selectMonthEnd(month) {
  monthEndUi.selected = month;
  monthEndUi.busy = true;
  monthEndUi.error = '';
  render();
  try {
    await fetchMonthEndLines();
  } catch (e) { monthEndUi.error = monthEndErrorText(e); }
  finally { monthEndUi.busy = false; render(); }
}

async function captureLastMonth() {
  if (!canAdmin() || monthEndUi.busy) return;
  const d = new Date();
  const local = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Tokyo', year:'numeric', month:'2-digit', day:'2-digit' }).format(d);
  const [year, month] = local.split('-').map(Number);
  const last = new Date(Date.UTC(year, month - 1, 0)).toISOString().slice(0,10);
  if (!window.confirm(last + 'の月末在庫を、現在の帳簿状態で確定します。\\n' +
    '締め後に入出庫や売却があった場合、正確な月末の値にはなりません。\\n' +
    '保存後は上書きできません。実行しますか？')) return;
  monthEndUi.busy = true; monthEndUi.error = ''; render();
  try {
    const { error } = await sb.rpc('inv_month_end_capture', { p_month_end: last });
    if (error) throw error;
    monthEndUi.selected = last;
    monthEndUi.busy = false;
    await loadMonthEnds();
    toast(last + 'の在庫を保存しました');
  } catch(e) {
    monthEndUi.error = monthEndErrorText(e);
    monthEndUi.busy = false;
    render();
  }
}
function downloadMonthEndCsv() {
  const m = monthEndUi.selected, l = monthEndUi.lines;
  if (!canAdmin() || !m || !l.length || monthEndUi.busy) return;
  const columns = ['基準月末','区分','管理番号／商品コード','商品コード','商品名','型番','当時の状態',
                   '当時の保管場所','数量','当時の単価（原価）','当時の原価合計','仕入日'];
  const rows = [columns].concat(l.map(r => [m, r.kind === 'item' ? '個体' : '数量',
    r.ref_id, r.product_code || '', r.name, r.model || '', r.status || '', r.location_name || '',
    r.qty, r.unit_cost == null ? '' : r.unit_cost,
    r.total_cost == null ? '' : r.total_cost, r.purchased_on || '' ]));
  const name = '8EC_月末在庫_' + m + '.csv';
  window.EightCsv.download(name, window.EightCsv.blob(window.EightCsv.build(rows)));
  toast(l.length + '行を書き出しました');
}
function viewMonthEnd() {
  if (!canAdmin()) return '<div class="empty">管理者のみ閲覧できます。</div>';
  const options = monthEndUi.list.map(m => '<option value="' + esc(m.month_end) +
    '"' + (m.month_end === monthEndUi.selected ? ' selected' : '') + '>' +
    esc(m.month_end) + '</option>').join('');
  const sel = monthEndUi.list.find(m => m.month_end === monthEndUi.selected);
  const num = n => Number(n || 0).toLocaleString('ja-JP');
  const val = n => '¥' + num(n);
  const late = sel && (new Date(sel.captured_at).getTime() >
    new Date(sel.month_end + 'T23:59:59+09:00').getTime() + 10*60000);
  const intro = '<div class="meta" style="margin:10px 0 20px">' +
    '月末の帳簿在庫を保存して、毎月比較できます。売却済・廃棄は対象外。' +
    '販売可能品と貸出・社内使用等は区別し、数量品も含みます。</div>';
  const controls = '<div class="card" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:18px">' +
    '<label>年月　<select class="input" onchange="selectMonthEnd(this.value)" ' +
    (monthEndUi.busy || !options ? 'disabled' : '') + '>' +
    (options || '<option>記録なし</option>') + '</select></label>' +
    '<button class="btn sm ghost" onclick="loadMonthEnds()" ' +
    (monthEndUi.busy ? 'disabled' : '') + '>更新</button>' +
    '<button class="btn sm ghost" onclick="downloadMonthEndCsv()" ' +
    (!sel || monthEndUi.busy ? 'disabled' : '') + '>CSVダウンロード</button>' +
    '<button class="btn sm ghost" onclick="captureLastMonth()" ' +
    (monthEndUi.busy ? 'disabled' : '') + '>前月末を手動確定</button></div>';
  const err = monthEndUi.error ? '<div class="card" style="margin-bottom:16px;color:#b91c1c">' +
    esc(monthEndUi.error) + '</div>' : '';
  if (monthEndUi.busy) return '<h1>月末在庫</h1>' + intro + controls + err + '<div class="empty">読み込み中…</div>';
  if (!sel) return '<h1>月末在庫</h1>' + intro + controls + err +
    '<div class="empty">確定済み月末在庫はまだありません。11月末分は2026年12月1日（日本時間）に初めて保存できます。' +
    '自動取得には月末処理（cron）設定が必要です。</div>';
  const kpi = (label, value, sub) => '<div class="kpi"><div class="lbl">' + esc(label) +
    '</div><div class="v num">' + value + '</div><div class="n">' + esc(sub || '') + '</div></div>';
  const summary = '<div class="kpis">' +
    kpi('保有個体', num(sel.item_count)+'台', '売却済・廃棄を除く') +
    kpi('数量管理品', num(sel.quantity_units)+'点', '消耗品など') +
    kpi('販売可能', num(sel.saleable_units)+'台', '在庫・出品中の個体') +
    kpi('原価合計', val(sel.cost_total), '原価未登録は含めない') +
    kpi('原価未登録', num(sel.missing_cost_units)+'点', '合計金額は暫定') +
    '</div>';
  const note = '<div class="meta" style="margin:14px 0 18px">' +
    '取得日時：' + esc(fmtDT(sel.captured_at)) +
    (late ? '　<strong style="color:#b91c1c">月末を過ぎてから取得。締め後の操作による差異に注意。</strong>' :
    '　月末直後に取得') +
    '　※物理棚卸数とは別の帳簿記録です。</div>';
  const trs = monthEndUi.lines.map(r=>'<tr>' +
    '<td>' + esc(r.ref_id) + '</td><td>' + esc(r.model || r.name) + '</td>' +
    '<td>' + esc(r.status) + '</td><td>' + esc(r.location_name || '未設定') + '</td>' +
    '<td style="text-align:right">' + num(r.qty) + '</td>' +
    '<td style="text-align:right">' + (r.unit_cost == null ? '要確認' : val(r.unit_cost)) + '</td>' +
    '<td style="text-align:right">' + (r.total_cost == null ? '—' : val(r.total_cost)) + '</td>' +
    '</tr>').join('');
  return '<h1>月末在庫</h1>' + intro + controls + err + summary + note +
    '<div class="sec">月末の明細 <span class="secn">' + num(monthEndUi.lines.length) + '行</span></div>' +
    '<div style="overflow:auto;max-height:60vh"><table class="tbl" style="width:100%;min-width:840px">' +
    '<thead><tr><th>管理番号</th><th>商品・型番</th><th>状態</th><th>場所</th><th>数量</th><th>原価単価</th><th>原価合計</th></tr></thead>' +
    '<tbody>' + trs + '</tbody></table></div>';
}
