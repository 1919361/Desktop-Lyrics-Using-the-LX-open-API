/* ============================================================================
 *  render-shot.js —— 不需要 CDP 的一次性渲染
 *  ---------------------------------------------------------------------------
 *  为什么不用 make-preview.js 那套 CDP：本机的沙箱环境下 DevTools 的
 *  WebSocket 能连上、却收不到任何回帧（连 about:blank 都拿不到
 *  Runtime.enable 的回包），于是 Page.captureScreenshot 永远不返回。
 *  Edge/Chrome 自带的 `--screenshot` 是同一套渲染管线的另一条入口，
 *  让它自己截完退出，配合 --virtual-time-budget 把定时器/动画跑到位。
 *
 *  做的事：
 *    1. 把 index.html 复制成 <工作区>/_render.html，并在 <head> 里插入桩脚本
 *       （拦 fetch / EventSource，给一首示例歌 + 一段逐字歌词 + 一张内联封面）；
 *    2. 用无头 Edge 打开它、截图到 <工作区>/_shot.png；
 *    3. 删掉这两个临时文件（除非传 --keep）。
 *
 *  用法：node tools/render/render-shot.js [宽 高] [--keep]
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..', '..');   // 工程根目录（本脚本在 tools/render/ 下）
const BROWSER = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'
].find(p => fs.existsSync(p));

const argv = process.argv.slice(2);
const nums = argv.filter(a => /^\d+$/.test(a)).map(Number);
const W = nums[0] || 1920;
const H = nums[1] || 1080;
const keep = argv.includes('--keep');
/* 诊断用：把天际屏的字改成纯红、去掉模糊、拉到最亮 ——
   用来回答"这一层到底有没有画出来"（正常参数下它是很淡的柔光，截图里容易看不见） */
const artDebug = argv.includes('--art-debug');
/* 诊断用：把封面定在翻页中途（-60°），检查 perspective 是否真的生效 ——
   若被父级 overflow:hidden 压平成 2D，画面会是"横向压扁"而不是"转过去的卡片"。 */
const flipDebug = argv.includes('--flip');
/* 诊断用：把进度/音量固定在指定比例（--p=0.04），检查小百分比下两端的圆角形状 */
const pArg = (argv.find(a => a.indexOf('--p=') === 0) || '').slice(4);

const RENDER = path.join(SRC, '_render.html');
const SHOT = path.join(SRC, '_shot.png');

/* ---- 示例数据（与 make-preview.js 一致）---- */
const SAMPLE = [
  [0, '此刻 世界安静下来'],
  [6, '只剩窗外的风 和这一首歌'],
  [12, '每个字都在慢慢亮起来'],
  [30, '跟着节奏 一起呼吸'],
  [36, '让旋律把夜色填满'],
  [42, '我们把时间 唱得很慢']
];
const pad2 = n => (n < 10 ? '0' : '') + n;
const stamp = sec => {
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return '[' + pad2(m) + ':' + (s < 10 ? '0' : '') + s.toFixed(2) + ']';
};
const LRC = SAMPLE.map(L => {
  let t = L[0], out = '';
  for (const ch of L[1]) { out += stamp(t) + ch; t += 0.45; }
  return out;
}).join('\\n');

const COVER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640">'
  + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
  + '<stop offset="0" stop-color="#241a52"/><stop offset="0.45" stop-color="#5b3fa8"/>'
  + '<stop offset="0.78" stop-color="#c66a9e"/><stop offset="1" stop-color="#ffb27a"/>'
  + '</linearGradient>'
  + '<radialGradient id="glow" cx="0.5" cy="0.66" r="0.46">'
  + '<stop offset="0" stop-color="#ffe2bd" stop-opacity="0.95"/>'
  + '<stop offset="1" stop-color="#ff8a5c" stop-opacity="0"/></radialGradient>'
  + '<linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">'
  + '<stop offset="0" stop-color="#120c26" stop-opacity="0.35"/>'
  + '<stop offset="1" stop-color="#0a0718" stop-opacity="0.9"/></linearGradient></defs>'
  + '<rect width="640" height="640" fill="url(#g)"/>'
  + '<circle cx="320" cy="410" r="250" fill="url(#glow)"/>'
  + '<circle cx="320" cy="410" r="132" fill="#ffe9cd" opacity="0.94"/>'
  + '<rect y="452" width="640" height="188" fill="url(#sea)"/>'
  + '<g fill="#0b0718" opacity="0.55"><circle cx="150" cy="118" r="2.5"/>'
  + '<circle cx="232" cy="72" r="1.8"/><circle cx="404" cy="96" r="2.2"/>'
  + '<circle cx="512" cy="150" r="1.6"/><circle cx="558" cy="70" r="2.4"/></g></svg>';
const COVER = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(COVER_SVG);

const STUB = [
  '<script>',
  'window.__LRC = "' + LRC + '";',
  '(function(){var of=window.fetch;',
  '  window.fetch=function(u,x){ var s=String(u);',
  "    if(s.indexOf('/lyric-all')>=0) return Promise.resolve(new Response(JSON.stringify({lyric:window.__LRC}),{status:200,headers:{'Content-Type':'application/json'}}));",
  "    if(s.indexOf('/status')>=0) return Promise.resolve(new Response(JSON.stringify({status:'playing',name:'示例曲目',singer:'示例歌手',duration:200,progress:31.2,playbackRate:1,collect:true,volume:74,mute:false,picUrl:'" + COVER + "'}),{status:200,headers:{'Content-Type':'application/json'}}));",
  '    return of.apply(this,arguments);};})();',
  '(function(){var OE=window.EventSource; if(!OE) return;',
  '  var P=function(u,c){};',
  '  P.prototype.addEventListener=function(){}; P.prototype.removeEventListener=function(){};',
  '  P.prototype.close=function(){}; P.CONNECTING=0; P.OPEN=1; P.CLOSED=2;',
  '  window.EventSource=P;})();',
  '</script>'
].join('\n');

if (!BROWSER) { console.error('✖ 找不到 Edge / Chrome'); process.exit(1); }

let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
if (html.indexOf('we-glue.js') < 0) { console.error('✖ index.html 里没有 we-glue.js 引用'); process.exit(1); }
/* 桩必须排在 we-glue.js 之前：we-glue 会包一层 fetch，桩要能包住原始 fetch */
html = html.replace('<script src="we-glue.js"></script>', STUB + '\n    <script src="we-glue.js"></script>');
if (artDebug) {
  html = html.replace('</head>', '<style>.bg-char{color:#ff0000 !important;filter:none !important;opacity:1 !important}</style>\n</head>');
}
if (flipDebug) {
  html = html.replace('</head>',
    '<style>.np-art{transform:perspective(1600px) rotateY(-60deg) scale(1) !important;opacity:1 !important}</style>\n</head>');
}
if (pArg) {
  html = html.replace('</head>',
    '<style>#seekWrap{--p:' + pArg + ' !important}#volRange{--v:' + pArg + ' !important}</style>\n</head>');
}
fs.writeFileSync(RENDER, html, 'utf8');

const args = [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--force-device-scale-factor=1',
  '--allow-file-access-from-files',
  '--window-size=' + W + ',' + H,
  '--virtual-time-budget=7000',
  '--screenshot=' + SHOT,
  'file:///' + RENDER.replace(/\\/g, '/')
];
console.log('渲染 ' + W + '×' + H);
const t0 = Date.now();
const r = spawnSync(BROWSER, args, { stdio: 'inherit', timeout: 90000 });
console.log('退出码', r.status, '耗时', ((Date.now() - t0) / 1000).toFixed(1) + 's', r.error ? String(r.error) : '');

if (fs.existsSync(SHOT)) {
  console.log('✔ ' + SHOT + ' (' + (fs.statSync(SHOT).size / 1024).toFixed(0) + ' KB)');
} else {
  console.error('✖ 没有产出截图');
}
if (!keep) {
  try { fs.unlinkSync(RENDER); } catch (e) { }
}
