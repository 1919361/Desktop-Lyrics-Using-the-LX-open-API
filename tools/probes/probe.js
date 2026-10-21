/* ============================================================================
 *  probe.js —— 在无头浏览器里量一次布局，把关键元素的位置/尺寸/计算样式打出来
 *  ---------------------------------------------------------------------------
 *  为什么需要它：截图只能"看"，看不出"为什么偏了"。这里直接读
 *  getBoundingClientRect + getComputedStyle，定位布局问题的第一现场。
 *
 *  注意：Chromium 需要命名管道做进程内通信，在工作区沙箱里会被拒，
 *  所以这条命令要在全权限下跑（和 render-shot.js 一样）。
 *
 *  用法：node tools/probes/probe.js [宽 高]
 * ========================================================================== */
'use strict';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SRC = path.join(__dirname, '..', '..');   // 工程根目录（本脚本在 tools/probes/ 下）
const PORT = 8861;
const CDP = 9396;
const BROWSER = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const argv = process.argv.slice(2);
const nums = argv.filter(a => /^\d+$/.test(a)).map(Number);
const W = nums[0] || 1920, H = nums[1] || 1080;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json' };

const SAMPLE = [[0, '此刻 世界安静下来'], [6, '只剩窗外的风 和这一首歌'], [12, '每个字都在慢慢亮起来'], [30, '跟着节奏 一起呼吸'], [36, '让旋律把夜色填满']];
const pad2 = n => (n < 10 ? '0' : '') + n;
const stamp = s => { const m = Math.floor(s / 60); return '[' + pad2(m) + ':' + (s - m * 60 < 10 ? '0' : '') + (s - m * 60).toFixed(2) + ']'; };
const LRC = SAMPLE.map(([t0, txt]) => { let t = t0, o = ''; for (const ch of txt) { o += stamp(t) + ch; t += 0.45; } return o; }).join('\\n');
const STUB = `<script>
window.__LRC = "${LRC}";
(function(){var of=window.fetch;
  window.fetch=function(u,x){ var s=String(u);
    if(s.indexOf('/lyric-all')>=0) return Promise.resolve(new Response(JSON.stringify({lyric:window.__LRC}),{status:200,headers:{'Content-Type':'application/json'}}));
    if(s.indexOf('/status')>=0) return Promise.resolve(new Response(JSON.stringify({status:'playing',name:'示例曲目名称比较长的情况',singer:'示例歌手 A / 示例歌手 B',duration:200,progress:31.2,playbackRate:1,collect:true,volume:74,mute:false,picUrl:''}),{status:200,headers:{'Content-Type':'application/json'}}));
    return of.apply(this,arguments);};})();
(function(){var OE=window.EventSource; if(!OE) return;
  var P=function(u,c){};P.prototype.addEventListener=function(){};P.prototype.removeEventListener=function(){};
  P.prototype.close=function(){};P.CONNECTING=0;P.OPEN=1;P.CLOSED=2;window.EventSource=P;})();
</script>`;

const EXPR = `JSON.stringify((function(){
  function box(sel){
    var el = document.querySelector(sel);
    if (!el) return null;
    var r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return { sel: sel, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
             padL: cs.paddingLeft, padR: cs.paddingRight, font: cs.fontSize, align: cs.alignItems,
             origin: cs.transformOrigin, transform: cs.transform };
  }
  var lines = [].slice.call(document.querySelectorAll('#lyricList .lyric-line'));
  return {
    stage: box('#lyricStage'),
    playerCol: box('.player-col'),
    npInner: box('.np-inner'),
    npArt: box('.np-art'),
    meta: box('.np-meta'),
    name: box('.track-name'),
    singer: box('.track-singer'),
    progress: box('#seekWrap'),
    dock: box('#playerDock'),
    bar: box('#playerBar'),
    conn: box('#connBar'),
    lyricCol: box('.lyric-col'),
    lyricScroll: box('.lyric-scroll'),
    lyricList: box('.lyric-list'),
    artLayer: box('.bg-art-layer'),
    firstLine: box('#lyricList .lyric-line'),
    activeLine: box('#lyricList .lyric-line.active'),
    lineCount: lines.length,
    lefts: lines.slice(0, 8).map(function(l){ return Math.round(l.getBoundingClientRect().left); }),
    artChars: document.querySelectorAll('.bg-char').length,
    artRevealed: document.querySelectorAll('.bg-char.revealed').length,
    artSample: [].slice.call(document.querySelectorAll('.bg-char')).slice(0, 6).map(function(el){
      var r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      return { t: (el.textContent||'').trim(), x: Math.round(r.left), y: Math.round(r.top),
               w: Math.round(r.width), h: Math.round(r.height),
               op: cs.opacity, f: cs.filter, c: cs.color, fs: cs.fontSize, z: cs.zIndex };
    }),
    layerInfo: (function(){
      var L = document.querySelector('.bg-art-layer'), cs = getComputedStyle(L);
      var b = document.querySelector('.bg-batch');
      var stack = document.elementsFromPoint(440, 740).slice(0, 6).map(function(e){
        return (e.id || e.className || e.tagName) + ' z=' + getComputedStyle(e).zIndex;
      });
      return { display: cs.display, opacity: cs.opacity, z: cs.zIndex, children: L.children.length,
               batchKids: b ? b.children.length : -1,
               batchOpacity: b ? getComputedStyle(b).opacity : '',
               batchTransform: b ? getComputedStyle(b).transform : '',
               stackAtCover: stack };
    })(),
    zArt: getComputedStyle(document.querySelector('.bg-art-layer')).zIndex,
    zPlayer: getComputedStyle(document.querySelector('.player-col')).zIndex,
    zLyric: getComputedStyle(document.querySelector('.lyric-col')).zIndex
  };
})())`;

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  for (const f of ['index.html', 'we-glue.css', 'we-glue.js']) fs.copyFileSync(path.join(SRC, f), path.join(root, f));
  let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  html = html.replace('<script src="we-glue.js"></script>', STUB + '\n    <script src="we-glue.js"></script>');
  fs.writeFileSync(path.join(root, 'index.html'), html, 'utf8');

  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0].replace(/^\//, '')) || 'index.html';
    fs.readFile(path.join(root, rel), (e, b) => {
      if (e) { res.writeHead(404); res.end('404'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream' });
      res.end(b);
    });
  });
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));

  const edge = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--window-size=' + W + ',' + H,
    '--remote-debugging-port=' + CDP, '--user-data-dir=' + path.join(root, 'p'),
    'http://127.0.0.1:' + PORT + '/index.html'], { stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 25 && !page; i++) {
    await sleep(400);
    try {
      const l = await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json();
      page = l.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch (e) { }
  }
  if (!page) { console.error('no page'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/index.html' });
  await sleep(3200);
  const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true });
  const val = r.result && r.result.result && r.result.result.value;
  if (!val) console.log('EVAL FAILED', JSON.stringify(r).slice(0, 400));
  else {
    const o = JSON.parse(val);
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v && v.sel) console.log(k.padEnd(11), 'x=' + String(v.x).padStart(5), 'y=' + String(v.y).padStart(5), 'w=' + String(v.w).padStart(5), 'h=' + String(v.h).padStart(4), '| padL=' + v.padL, 'font=' + v.font, 'align=' + v.align, 'origin=' + v.origin);
      else console.log(k.padEnd(11), JSON.stringify(v));
    }
  }
  try { ws.close(); } catch (e) { }
  try { edge.kill(); } catch (e) { }
  try { server.close(); } catch (e) { }
  await sleep(200);
  process.exit(0);
})().catch(e => { console.error('FATAL', e && e.message); process.exit(9); });
