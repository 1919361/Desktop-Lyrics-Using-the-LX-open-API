/* ============================================================================
 *  probe-flip.js —— 封面翻页后"封面是否还在"
 *  ---------------------------------------------------------------------------
 *  复现路径：SSE 推两次不同的 picUrl，每次翻页结束（约 0.9s）后检查：
 *    · .np-art 的计算 transform 是否回到 none（不是停在 rotateY(±90°)）；
 *    · 卡片渲染宽度 ≈ 布局宽度（没有被转向侧面压扁成 0）；
 *    · <img> 是否 .visible 且有解码后的尺寸。
 *  注意：Chromium 需要命名管道做进程内通信，要在全权限下跑。
 * ========================================================================== */
'use strict';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SRC = path.join(__dirname, '..', '..');   // 工程根目录（本脚本在 tools/probes/ 下）
const PORT = 8921, CDP = 9407;
const BROWSER = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json' };

function svgCover(c1, c2) {
  const s = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">'
    + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
    + '<stop offset="0" stop-color="' + c1 + '"/><stop offset="1" stop-color="' + c2 + '"/>'
    + '</linearGradient></defs><rect width="300" height="300" fill="url(#g)"/>'
    + '<circle cx="150" cy="150" r="70" fill="rgba(255,255,255,0.5)"/></svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
}
const COVER_A = svgCover('#2b3a8f', '#6f5cff');
const COVER_B = svgCover('#8f2b3a', '#ff9c5c');

const STUB = `<script>
window.__pic = ${JSON.stringify(COVER_A)};
(function(){var of=window.fetch;
  window.fetch=function(u,x){ var s=String(u);
    if(s.indexOf('/lyric-all')>=0) return Promise.resolve(new Response(JSON.stringify({lyric:'[00:00.00]第一句[00:08.00]第二句'}),{status:200,headers:{'Content-Type':'application/json'}}));
    if(s.indexOf('/status')>=0) return Promise.resolve(new Response(JSON.stringify({status:'playing',name:'翻页测试',singer:'测试',duration:200,progress:3,playbackRate:1,collect:false,volume:74,mute:false,picUrl:window.__pic}),{status:200,headers:{'Content-Type':'application/json'}}));
    if(s.indexOf('/seek')>=0||s.indexOf('/volume')>=0||s.indexOf('/mute')>=0) return Promise.resolve(new Response('{}',{status:200}));
    return of.apply(this,arguments);};})();
(function(){
  var insts=[];
  function P(u,c){ this._l={}; insts.push(this); }
  P.prototype.addEventListener=function(n,f){ (this._l[n]=this._l[n]||[]).push(f); };
  P.prototype.removeEventListener=function(){};
  P.prototype.close=function(){};
  P.CONNECTING=0;P.OPEN=1;P.CLOSED=2;
  window.EventSource=P;
  window.__emit=function(n,v){ insts.forEach(function(ins){ (ins._l[n]||[]).forEach(function(f){ try{ f({data:JSON.stringify(v)}); }catch(e){} }); }); };
})();
</script>`;

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-'));
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
    '--window-size=1920,1080', '--remote-debugging-port=' + CDP,
    '--user-data-dir=' + path.join(root, 'p'), 'http://127.0.0.1:' + PORT + '/index.html'], { stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 25 && !page; i++) {
    await sleep(400);
    try { const l = await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json(); page = l.find(t => t.type === 'page' && t.webSocketDebuggerUrl); } catch (e) { }
  }
  if (!page) { console.error('no page'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  const js = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const state = () => js(`JSON.stringify((function(){
    var card = document.getElementById('npArt');
    var img = document.getElementById('albumArt');
    var cs = getComputedStyle(card);
    var r = card.getBoundingClientRect();
    return { tf: cs.transform, w: Math.round(r.width), layoutW: card.offsetWidth,
             ratio: card.offsetWidth ? Math.round(r.width / card.offsetWidth * 100) / 100 : null,
             imgVisible: img.classList.contains('visible'), natW: img.naturalWidth,
             src: (img.getAttribute('src')||'').slice(0, 40) };
  })())`);

  await send('Page.enable'); await send('Runtime.enable');
  await sleep(3000);
  console.log('初始:', await state());

  /* 第一次换封面 */
  await js(`window.__pic = ${JSON.stringify(COVER_B)}; window.__emit('picUrl', window.__pic);`);
  await sleep(200);
  console.log('翻页中(200ms):', await state());
  await sleep(1200);
  console.log('翻页后(1.4s):', await state());

  /* 第二次换封面 */
  await js(`window.__pic = ${JSON.stringify(COVER_A)}; window.__emit('picUrl', window.__pic);`);
  await sleep(1400);
  console.log('再翻一次后:', await state());

  /* 边界：翻到一半又换一次（取消旧动画的那条路径） */
  await js(`window.__pic = ${JSON.stringify(COVER_B)}; window.__emit('picUrl', window.__pic);`);
  await sleep(150);
  await js(`window.__pic = ${JSON.stringify(COVER_A)}; window.__emit('picUrl', window.__pic);`);
  await sleep(1500);
  console.log('翻到一半又换一次:', await state());

  try { ws.close(); } catch (e) { }
  try { edge.kill(); } catch (e) { }
  try { server.close(); } catch (e) { }
  await sleep(200);
  process.exit(0);
})().catch(e => { console.error('FATAL', e && e.message); process.exit(9); });
