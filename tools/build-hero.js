/**
 * トップページのヒーロー画像を組み立てる。
 *
 *   node tools/build-hero.js
 *
 * 商品一覧で使っている assets/product-art.js の機器イラストをそのまま並べるので、
 * ヒーローと商品カードの画風が揃う。写真素材を使わないため権利の問題も起きない。
 *
 * 出力: assets/hero-devices.svg
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
global.window = {};
require(path.join(ROOT, 'assets', 'product-art.js'));
const ART = global.window.EightProductArt;

const W = 1600;
const H = 760;

/* 機器1台。product-art.js の描画をそのまま入れ子のSVGとして置く。
   deg を付けると少し傾けて、棚に並べただけの整列感を崩す */
function device(type, cx, baseY, scale, opts) {
  const o = opts || {};
  const w = 200 * scale;
  const h = 140 * scale;
  const x = cx - w / 2;
  const y = baseY - h;                       // 接地する床の高さを揃える
  const art = ART.svg({}, { type, bare: true });
  const inner = art.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  const rot = o.deg ? ` rotate(${o.deg} ${w / 2} ${h})` : '';
  return (
    `<g transform="translate(${x} ${y})${rot}" opacity="${o.op == null ? 1 : o.op}">` +
    `<svg width="${w}" height="${h}" viewBox="0 0 200 140" overflow="visible">${inner}</svg>` +
    '</g>'
  );
}

/* AIツール側のモチーフ。プロンプト入力とその応答を、機器の上に浮かせる */
function promptCard(x, y, scale) {
  const s = (n) => n * scale;
  return `<g transform="translate(${x} ${y}) scale(${scale})">
    <rect x="0" y="0" width="300" height="176" rx="18" fill="#fff" opacity=".97"/>
    <rect x="0" y="0" width="300" height="176" rx="18" fill="none" stroke="#dbe3f5" stroke-width="1.5"/>
    <g transform="translate(22 24)">
      <circle cx="13" cy="13" r="13" fill="url(#heroSpark)"/>
      <path d="M13 5.5l1.9 4.6 4.6 1.9-4.6 1.9L13 18.5l-1.9-4.6L6.5 12l4.6-1.9z" fill="#fff"/>
      <rect x="38" y="6" width="104" height="7" rx="3.5" fill="#16305c" opacity=".82"/>
      <rect x="38" y="19" width="66" height="6" rx="3" fill="#8792a8" opacity=".6"/>
    </g>
    <rect x="22" y="72" width="256" height="8" rx="4" fill="#c9d3f4"/>
    <rect x="22" y="90" width="212" height="8" rx="4" fill="#dbe3f5"/>
    <rect x="22" y="108" width="238" height="8" rx="4" fill="#dbe3f5"/>
    <g transform="translate(22 132)">
      <rect x="0" y="0" width="74" height="26" rx="13" fill="#eaeefb"/>
      <rect x="14" y="10" width="46" height="6" rx="3" fill="#4f63c4" opacity=".65"/>
      <rect x="84" y="0" width="60" height="26" rx="13" fill="#eaeefb"/>
      <rect x="98" y="10" width="32" height="6" rx="3" fill="#4f63c4" opacity=".5"/>
      <rect x="212" y="0" width="66" height="26" rx="13" fill="#16305c"/>
      <rect x="228" y="10" width="34" height="6" rx="3" fill="#fff" opacity=".9"/>
    </g>
  </g>`;
}

/* 小さめのAIチップ。「AIが動いている」気配だけ出す */
function chip(x, y, scale, w) {
  return `<g transform="translate(${x} ${y}) scale(${scale})">
    <rect x="0" y="0" width="${w}" height="40" rx="20" fill="#fff" opacity=".95"/>
    <rect x="0" y="0" width="${w}" height="40" rx="20" fill="none" stroke="#dbe3f5" stroke-width="1.4"/>
    <circle cx="21" cy="20" r="9" fill="url(#heroSpark)"/>
    <path d="M21 15l1.3 3.2 3.2 1.3-3.2 1.3L21 25l-1.3-3.2-3.2-1.3 3.2-1.3z" fill="#fff"/>
    <rect x="38" y="16" width="${w - 56}" height="7" rx="3.5" fill="#16305c" opacity=".5"/>
  </g>`;
}

function sparkle(x, y, r, op) {
  return `<path transform="translate(${x} ${y}) scale(${r})"
    d="M0 -1l.32.68L1 0l-.68.32L0 1l-.32-.68L-1 0l.68-.32z"
    fill="#4f63c4" opacity="${op}"/>`;
}

/* 機器どうしをつなぐ点線。ばらばらに置いた機器を「一式」に見せる */
function link(x1, y1, x2, y2, op) {
  return `<path d="M${x1} ${y1}C${(x1 + x2) / 2} ${y1} ${(x1 + x2) / 2} ${y2} ${x2} ${y2}"
    fill="none" stroke="#4f63c4" stroke-width="2" stroke-dasharray="2 9"
    stroke-linecap="round" opacity="${op}"/>`;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"
  width="${W}" height="${H}" role="img"
  aria-label="ノートPC・モニター・サーバー・ネットワーク機器とAIツールが並んだイメージ">
<defs>
  <linearGradient id="heroWash" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#f7f9fd"/>
    <stop offset="0.55" stop-color="#eef2fb"/>
    <stop offset="1" stop-color="#e3eaf8"/>
  </linearGradient>
  <radialGradient id="heroSpark">
    <stop offset="0" stop-color="#7d8ce8"/>
    <stop offset="1" stop-color="#4f63c4"/>
  </radialGradient>
  <linearGradient id="heroDesk" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#d7e0f2" stop-opacity=".85"/>
    <stop offset="1" stop-color="#d7e0f2" stop-opacity="0"/>
  </linearGradient>
</defs>

<rect width="${W}" height="${H}" fill="url(#heroWash)"/>

<!-- 奥行きを出すためのぼかした円 -->
<circle cx="1120" cy="180" r="300" fill="#4f63c4" opacity=".08"/>
<circle cx="1480" cy="470" r="215" fill="#7a5bd0" opacity=".05"/>
<circle cx="760" cy="520" r="200" fill="#2f5fa8" opacity=".05"/>

<!-- 機器を載せている面 -->
<rect x="0" y="600" width="${W}" height="160" fill="url(#heroDesk)"/>
<rect x="620" y="600" width="${W}" height="1.5" fill="#c3cfe8" opacity=".45"/>

<!-- つながっている感じの点線 -->
${link(700, 505, 980, 435, 0.28)}
${link(980, 435, 1290, 470, 0.28)}
${link(1290, 470, 1520, 415, 0.26)}
${link(880, 300, 1150, 390, 0.22)}

<!-- 本文が乗る左側は空けて、右半分に大きめの機器を重ねて置く -->
${device('monitor', 700, 604, 1.85, { deg: -2 })}
${device('server', 1010, 598, 1.95, {})}
${device('swtch', 1300, 604, 1.9, { deg: 1.5 })}
${device('ap', 1530, 598, 1.6, {})}

<!-- 手前に重ねる列。奥の機器と重ねることで「集まっている」感じにする -->
${device('laptop', 862, 752, 2.15, {})}
${device('tablet', 1156, 744, 1.35, { deg: 3 })}
${device('storage', 1420, 748, 1.15, { deg: -2 })}
${device('keyboard', 1596, 744, 1.05, { deg: -3, op: 0.92 })}

<!-- AIツール側。機器の上に浮かせて「AIツールも一緒に」を出す -->
${promptCard(742, 128, 1.15)}
${chip(1152, 214, 1.05, 220)}
${chip(1330, 116, 0.95, 176)}

${sparkle(1116, 138, 16, 0.5)}
${sparkle(1560, 250, 12, 0.42)}
${sparkle(690, 96, 10, 0.35)}
${sparkle(1268, 330, 9, 0.3)}
</svg>
`;

const out = path.join(ROOT, 'assets', 'hero-devices.svg');
fs.writeFileSync(out, svg);
console.log(`${path.relative(ROOT, out)} を書き出しました（${(svg.length / 1024).toFixed(0)} KB）`);
