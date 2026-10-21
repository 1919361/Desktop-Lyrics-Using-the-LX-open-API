/* ============================================================================
 *  probe-strike.js —— 「唱完那行的划线 + 隐藏」
 *  ---------------------------------------------------------------------------
 *  检查：
 *    ① 唱片变成 played 时出现 .lyric-strike，且 scaleX 从 0 长到 1；
 *    ② 线长 ≈ 文字宽度（从文字左缘到右缘，不是整行盒子）；
 *    ③ 线划到末尾时该行不透明度已接近 0（"线到尽头正好消失"）；
 *    ④ 拖进度条（跳变）时不划线、也不留残余；
 *    ⑤ 粒子层已彻底移除（页面上不该再有 .lyric-fx / i 元素）。
 *  注意：Chromium 需要命名管道做进程内通信，要在全权限下跑。
 * ========================================================================== */
'use strict';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SRC = path.join(__dirname, '..', '..');   // 工程根目录（本脚本在 tools/probes/ 下）
const PORT = 8917, CDP = 9405;
const BROWSER = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json' };

const pad2 = n => (n < 10 ? '0' : '') + n;
const stamp = s => { const m = Math.floor(s / 60); return '[' + pad2(m) + ':' + (s - m * 60 < 10 ? '0' : '') + (s - m * 60).toFixed(2) + ']'; };
const TIMES = [0, 3, 6, 9, 12, 15, 18];
const LRC = TIMES.map((t, i) => {
  let s = t, o = '';
  for (const ch of ('第' + (i + 1) + '句测试歌词')) { o += stamp(s) + ch; s += 0.3; }
  return o;
}).join('\n');

const STUB = `<script>
window.__LRC = ${JSON.stringify(LRC)};
window.__t0 = performance.now();
window.__prog = function(){ return 1 + (performance.now() - window.__t0) / 1000; };
(function(){var of=window.fetch;
  window.fetch=function(u,x){ var s=String(u);
    if(s.indexOf('/lyric-all')>=0) return Promise.resolve(new Response(JSON.stringify({lyric:window.__LRC}),{status:200,headers:{'Content-Type':'application/json'}}));
    if(s.indexOf('/status')>=0) return Promise.resolve(new Response(JSON.stringify({status:'playing',name:'划线测试',singer:'测试',duration:60,progress:window.__prog(),playbackRate:1,collect:false,volume:74,mute:false,picUrl:''}),{status:200,headers:{'Content-Type':'application/json'}}));
    if(s.indexOf('/seek')>=0||s.indexOf('/volume')>=0||s.indexOf('/mute')>=0) return Promise.resolve(new Response('{}',{status:200}));
    return of.apply(this,arguments);};})();
(function(){var OE=window.EventSource; if(!OE) return;
  var P=function(u,c){};P.prototype.addEventListener=function(){};P.prototype.removeEventListener=function(){};
  P.prototype.close=function(){};P.CONNECTING=0;P.OPEN=1;P.CLOSED=2;window.EventSource=P;})();
</script>`;

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strike-'));
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

  await send('Page.enable'); await send('Runtime.enable');
  await sleep(1200);

  /* 先确认粒子层已被移除 */
  console.log('残留检查（应为 0/0）:',
    await js("document.querySelectorAll('.lyric-fx').length"),
    await js("document.querySelectorAll('#lyricList i').length"));

  /* 采样器：played 行的划线数量 / scaleX / 不透明度 / 线宽 / 文字宽 */
  await js(`window.__sm = [];
    window.__smT = setInterval(function(){
      var rows = document.querySelectorAll('#lyricList .lyric-line');
      var played = null;
      for (var i=0;i<rows.length;i++) if (rows[i].classList.contains('played')) { played = rows[i]; break; }
      var bars = document.querySelectorAll('#strikeLayer .lyric-strike');
      var bar = bars.length ? bars[0] : null;
      var m = played ? played.querySelector('.lyric-main') : null;
      var k = null;
      if (bar) { var tr = getComputedStyle(bar).transform; var mm = /scale\\(([-\\d.]+)/.exec(tr); if (!mm) mm = /matrix\\(([-\\d.]+)/.exec(tr); k = mm ? Math.round(parseFloat(mm[1]) * 100) / 100 : null; }
      window.__sm.push({
        t: Math.round(performance.now()),
        n: bars.length,
        k: k,
        op: bar ? Math.round(+getComputedStyle(bar).opacity * 100) / 100 : null,
        barW: bar ? Math.round(bar.getBoundingClientRect().width) : null,
        txtW: m ? Math.round(m.getBoundingClientRect().width) : null,
        lineOp: played ? Math.round(+getComputedStyle(played).opacity * 100) / 100 : null
      });
    }, 60);`);

  /* 顺手抓一张"划到一半"的图 */
  let shotBuf = null;
  for (let i = 0; i < 200 && !shotBuf; i++) {
    await sleep(30);
    const st = await js(`(function(){var b=document.querySelector('#strikeLayer .lyric-strike');
      if(!b) return 0; var tr=getComputedStyle(b).transform; var m=/scale\\(([-\\d.]+)/.exec(tr); if(!m) m=/matrix\\(([-\\d.]+)/.exec(tr); return m?parseFloat(m[1]):0;})()`);
    if (st > 0.35 && st < 0.85) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      if (shot && shot.result && shot.result.data) shotBuf = Buffer.from(shot.result.data, 'base64');
    }
  }
  if (shotBuf) {
    fs.writeFileSync(path.join(SRC, '_strike.png'), shotBuf);
    console.log('划线瞬间截图 ->', path.join(SRC, '_strike.png'));
  }

  await sleep(9000);
  const log = JSON.parse(await js('JSON.stringify(window.__sm||[])'));
  console.log('前 12 条原始采样:', JSON.stringify(log.slice(0, 12)));
  const withBar = log.filter(x => x.n > 0);
  console.log('\n=== ① 划线过程 ===');
  console.log(' 有划线的采样点数:', withBar.length, '/', log.length);
  const ks = withBar.map(x => x.k);
  console.log(' scaleX 取值范围:', Math.min(...ks), '→', Math.max(...ks), '（应从 0 长到 1）');
  console.log(' 前 6 帧:', JSON.stringify(withBar.slice(0, 6).map(x => [x.k, x.op])));
  console.log(' 后 6 帧:', JSON.stringify(withBar.slice(-6).map(x => [x.k, x.op])));
  const mid = withBar[Math.floor(withBar.length / 2)];
  console.log(' 线宽/文字宽:', mid && mid.barW, '/', mid && mid.txtW, '（应基本相等）');

  /* ② 拖进度条：不该划线 */
  const seek = JSON.parse(await js(`JSON.stringify((function(){
    var e = document.getElementById('seekTrack'); var r = e.getBoundingClientRect();
    return { x: Math.round(r.left + r.width * 0.6), y: Math.round(r.top + r.height/2) };
  })())`));
  await js('window.__sm.length = 0;');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: seek.x, y: seek.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: seek.x, y: seek.y, button: 'left', clickCount: 1 });
  await sleep(2500);
  const after = JSON.parse(await js('JSON.stringify(window.__sm||[])'));
  console.log('\n=== ② 拖动进度条（跳变） ===');
  console.log(' 跳转后出现划线的采样点数:', after.filter(x => x.n > 0).length, '（应为 0）');
  console.log(' 跳转后残留划线元素:', await js("document.querySelectorAll('#lyricList .lyric-strike').length"));

  await js('clearInterval(window.__smT);');
  try { ws.close(); } catch (e) { }
  try { edge.kill(); } catch (e) { }
  try { server.close(); } catch (e) { }
  await sleep(200);
  process.exit(0);
}
main().catch(e => { console.error('FATAL', e && e.message); process.exit(9); });
