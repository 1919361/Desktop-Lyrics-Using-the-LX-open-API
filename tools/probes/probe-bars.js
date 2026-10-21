/* ============================================================================
 *  probe-bars.js —— 用无头浏览器实测两条滑条的交互
 *  ---------------------------------------------------------------------------
 *  ① 进度条：能不能拖（pointer-events 有没有被父级 none 继承掉）、拖动是否真的
 *     改了 --p 并发出 /seek；
 *  ② 音量条：拖动**过程中**是否就实时下发 /volume（而不是松手才发一次）。
 *
 *  注意：Chromium 需要命名管道做进程内通信，在工作区沙箱里会被拒，
 *  这条命令要在全权限下跑。
 * ========================================================================== */
'use strict';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SRC = path.join(__dirname, '..', '..');   // 工程根目录（本脚本在 tools/probes/ 下）
const PORT = 8871, CDP = 9397;
const BROWSER = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json' };

const SAMPLE = [[0, '此刻 世界安静下来'], [6, '只剩窗外的风 和这一首歌'], [12, '每个字都在慢慢亮起来'], [30, '跟着节奏 一起呼吸']];
const pad2 = n => (n < 10 ? '0' : '') + n;
const stamp = s => { const m = Math.floor(s / 60); return '[' + pad2(m) + ':' + (s - m * 60 < 10 ? '0' : '') + (s - m * 60).toFixed(2) + ']'; };
const LRC = SAMPLE.map(([t0, txt]) => { let t = t0, o = ''; for (const ch of txt) { o += stamp(t) + ch; t += 0.45; } return o; }).join('\\n');
const STUB = `<script>
window.__LRC = "${LRC}"; window.__seekCalls = 0; window.__volCalls = 0;
(function(){var of=window.fetch;
  window.fetch=function(u,x){ var s=String(u);
    if(s.indexOf('/lyric-all')>=0) return Promise.resolve(new Response(JSON.stringify({lyric:window.__LRC}),{status:200,headers:{'Content-Type':'application/json'}}));
    if(s.indexOf('/seek')>=0){ window.__seekCalls++; return Promise.resolve(new Response('{}',{status:200})); }
    if(s.indexOf('/volume')>=0){ window.__volCalls++; return Promise.resolve(new Response('{}',{status:200})); }
    if(s.indexOf('/mute')>=0) return Promise.resolve(new Response('{}',{status:200}));
    if(s.indexOf('/status')>=0) return Promise.resolve(new Response(JSON.stringify({status:'playing',name:'示例曲目',singer:'示例歌手',duration:200,progress:31.2,playbackRate:1,collect:false,volume:74,mute:false,picUrl:''}),{status:200,headers:{'Content-Type':'application/json'}}));
    return of.apply(this,arguments);};})();
(function(){var OE=window.EventSource; if(!OE) return;
  var P=function(u,c){};P.prototype.addEventListener=function(){};P.prototype.removeEventListener=function(){};
  P.prototype.close=function(){};P.CONNECTING=0;P.OPEN=1;P.CLOSED=2;window.EventSource=P;})();
</script>`;

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bars-'));
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
  const evalJS = async (expr, cla) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, includeCommandLineAPI: !!cla });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const rect = sel => evalJS(`JSON.stringify((function(){var e=document.querySelector('${sel}'); if(!e) return null;
    var r=e.getBoundingClientRect(), cs=getComputedStyle(e);
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), w:Math.round(r.width), pe:cs.pointerEvents, listeners:(typeof getEventListeners==='function')?Object.keys(getEventListeners(e)):[]};})())`);

  await send('Page.enable');
  await send('Runtime.enable');
  await sleep(3000);

  /* ---------------- ① 进度条拖动 ---------------- */
  const seek = JSON.parse(await rect('#seekTrack'));
  console.log('进度条:', seek.pe, '| listeners', JSON.stringify(seek.listeners), '| w', seek.w);
  const p0 = await evalJS("document.getElementById('seekWrap').style.getPropertyValue('--p')");
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: seek.x - seek.w / 4, y: seek.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: seek.x + seek.w / 4, y: seek.y, button: 'left' });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: seek.x + seek.w / 4, y: seek.y, button: 'left', clickCount: 1 });
  await sleep(500);
  const p1 = await evalJS("document.getElementById('seekWrap').style.getPropertyValue('--p')");
  console.log('拖动后 --p:', p0, '->', p1, '| /seek 调用', await evalJS('window.__seekCalls'));

  /* ---------------- ② 音量条拖动（中途就要发） ---------------- */
  await sleep(1200);
  const vol = JSON.parse(await rect('#volRange'));
  console.log('\n音量条:', vol.pe, '| w', vol.w);
  const vBefore = await evalJS('window.__volCalls');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: vol.x - vol.w / 2 + 2, y: vol.y, button: 'left', clickCount: 1 });
  const during = [];
  for (let i = 1; i <= 5; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vol.x - vol.w / 2 + (vol.w * i / 6), y: vol.y, button: 'left' });
    await sleep(60);
    during.push(await evalJS('window.__volCalls'));
  }
  console.log('拖动途中的 /volume 次数:', JSON.stringify(during), '（松手前就应该 > 0）');
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: vol.x, y: vol.y, button: 'left', clickCount: 1 });
  await sleep(400);
  console.log('松手后累计:', await evalJS('window.__volCalls'), '（起始', vBefore, '）');
  console.log('--v =', await evalJS("document.getElementById('volRange').style.getPropertyValue('--v')"));

  try { ws.close(); } catch (e) { }
  try { edge.kill(); } catch (e) { }
  try { server.close(); } catch (e) { }
  await sleep(200);
  process.exit(0);
})().catch(e => { console.error('FATAL', e && e.message); process.exit(9); });
