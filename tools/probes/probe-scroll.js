/* ============================================================================
 *  probe-scroll.js —— 快速换句时"焦点行到底有没有居中"
 *  ---------------------------------------------------------------------------
 *  假设（用户提出）：两句挨得很近时，第一句的居中动画还没跑完就被第二句打断，
 *  居中就此失效，直到下一句才恢复。
 *
 *  验证方式：让播放进度真实推进（progress 从 8s 起），每隔 60ms 采样
 *  「焦点行 .lyric-main 的中心 Y」与「滚动容器中心 Y」的差值。
 *  真正居中的句子上，稳定后这个差值应该 ≈ 0（几像素以内）。
 *
 *  注意：Chromium 需要命名管道做进程内通信，要在全权限下跑。
 * ========================================================================== */
'use strict';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SRC = path.join(__dirname, '..', '..');   // 工程根目录（本脚本在 tools/probes/ 下）
const PORT = 8903, CDP = 9401;
const BROWSER = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json' };

const pad2 = n => (n < 10 ? '0' : '') + n;
const stamp = s => { const m = Math.floor(s / 60); return '[' + pad2(m) + ':' + (s - m * 60 < 10 ? '0' : '') + (s - m * 60).toFixed(2) + ']'; };

/* 慢句 8/14s；快句 20/20.6/21.2/21.8/22.4s；再慢句 30s
   （快句用来复现"上一句还没居中就被下一句顶掉"） */
const TIMES = [0, 4, 8, 14, 20, 20.6, 21.2, 21.8, 22.4, 30, 36];
const TEXT = ['第一句', '第二句', '慢句甲', '慢句乙', '快句一', '快句二', '快句三', '快句四', '快句五', '收尾慢句', '最后一句'];
const LRC = TIMES.map((t, i) => {
  let s = t, o = '';
  for (const ch of TEXT[i]) { o += stamp(s) + ch; s += 0.3; }
  return o;
}).join('\n');

const STUB = `<script>
window.__LRC = ${JSON.stringify(LRC)};
window.__t0 = performance.now();
window.__prog = function(){ return 8 + (performance.now() - window.__t0) / 1000; };
(function(){var of=window.fetch;
  window.fetch=function(u,x){ var s=String(u);
    if(s.indexOf('/lyric-all')>=0) return Promise.resolve(new Response(JSON.stringify({lyric:window.__LRC}),{status:200,headers:{'Content-Type':'application/json'}}));
    /* progress 必须真的在走：写常量的话，10 秒一次的 /status 会把它硬对齐回起点 */
    if(s.indexOf('/status')>=0) return Promise.resolve(new Response(JSON.stringify({status:'playing',name:'滚动测试',singer:'测试',duration:120,progress:window.__prog(),playbackRate:1,collect:false,volume:74,mute:false,picUrl:''}),{status:200,headers:{'Content-Type':'application/json'}}));
    if(s.indexOf('/seek')>=0||s.indexOf('/volume')>=0||s.indexOf('/mute')>=0) return Promise.resolve(new Response('{}',{status:200}));
    return of.apply(this,arguments);};})();
(function(){var OE=window.EventSource; if(!OE) return;
  var P=function(u,c){};P.prototype.addEventListener=function(){};P.prototype.removeEventListener=function(){};
  P.prototype.close=function(){};P.CONNECTING=0;P.OPEN=1;P.CLOSED=2;window.EventSource=P;})();
</script>`;

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scr-'));
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
  let id = 0; const pending = new Map(); const dbg = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      const txt = (m.params.args || []).map(a => (a.value !== undefined ? a.value : (a.description || ''))).join(' ');
      if (/滚动/.test(txt)) dbg.push(txt);
    }
  };
  const send = (method, params) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  const js = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Page.enable'); await send('Runtime.enable');
  await sleep(2600);

  /* 页面里装一个采样器：每 60ms 记录焦点行相对容器中心的偏移 */
  await js(`window.__sc = [];
    window.__scTimer = setInterval(function(){
      var sc = document.getElementById('lyricScroll');
      var el = document.querySelector('.lyric-line.active .lyric-main');
      if (!sc || !el) return;
      var sr = sc.getBoundingClientRect(), er = el.getBoundingClientRect();
      window.__sc.push({ t: Math.round(performance.now()),
                         txt: (document.querySelector('.lyric-line.active')||{}).textContent || '',
                         off: Math.round(((er.top + er.height/2) - (sr.top + sr.height/2)) * 10) / 10,
                         st: Math.round(sc.scrollTop),
                         tf: (document.getElementById('lyricList').style.transform || '').slice(0, 24) });
    }, 60);`);

  await sleep(26000);          // 覆盖快句段（progress 8 → 34）
  await js('clearInterval(window.__scTimer);');
  const log = JSON.parse(await js('JSON.stringify(window.__sc||[])'));
  console.log('采样点数', log.length);

  /* 按"焦点行文本"分组：看每一句稳定后的 |偏移| 最大值 */
  const byLine = new Map();
  log.forEach(s => {
    if (!byLine.has(s.txt)) byLine.set(s.txt, []);
    byLine.get(s.txt).push(s);
  });
  console.log('\n每句 … 该句出现期间 |偏移| 的最大值（0 = 始终居中）:');
  for (const [txt, arr] of byLine) {
    const maxOff = Math.max(...arr.map(s => Math.abs(s.off)));
    const tail = arr.slice(-3).map(s => s.off);
    console.log('  ' + txt.padEnd(6), 'n=' + String(arr.length).padStart(3),
                '| max|off|=' + String(maxOff).padStart(6) + 'px',
                '| 末尾偏移', JSON.stringify(tail));
  }

  /* 逐帧最大位移（视觉跳动） */
  let worst = 0, at = null;
  for (let i = 1; i < log.length; i++) {
    const d = Math.abs(log[i].st - log[i - 1].st);
    if (d > worst) { worst = d; at = [log[i - 1], log[i]]; }
  }
  console.log('\nscrollTop 单帧最大跳变:', worst, 'px @', JSON.stringify(at));

  /* ---- 最后一句：唱完之后应该**保持高亮**（不收起） ---- */
  const beforeSeek = await js(`JSON.stringify((function(){
    var rows = [].slice.call(document.querySelectorAll('#lyricList .lyric-line'));
    var last = rows[rows.length - 1];
    return { rows: rows.length, lastClass: last ? last.className : null,
             lastText: last ? (last.textContent||'').trim().slice(0,12) : null,
             activeText: (document.querySelector('.lyric-line.active')||{}).textContent || null };
  })())`);
  console.log('\n跳到最后（点进度条 92%）前:', beforeSeek);

  /* 点进度条 92% 处：progress 直接跳到 ~110s，远超最后一句的 endTime */
  const seek = JSON.parse(await js(`JSON.stringify((function(){
    var e = document.getElementById('seekTrack'); var r = e.getBoundingClientRect();
    return { x: Math.round(r.left + r.width * 0.92), y: Math.round(r.top + r.height/2) };
  })())`));
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: seek.x, y: seek.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: seek.x, y: seek.y, button: 'left', clickCount: 1 });
  await sleep(1500);
  console.log('跳到末尾后:', await js(`JSON.stringify((function(){
    var rows = [].slice.call(document.querySelectorAll('#lyricList .lyric-line'));
    var last = rows[rows.length - 1];
    var act = document.querySelector('.lyric-line.active');
    return { lastText: last ? (last.textContent||'').trim().slice(0,12) : null,
             lastClass: last ? last.className : null,
             lastIsActive: !!(last && last.classList.contains('active')),
             activeText: act ? (act.textContent||'').trim().slice(0,12) : null };
  })())`));

  try { ws.close(); } catch (e) { }
  try { edge.kill(); } catch (e) { }
  try { server.close(); } catch (e) { }
  await sleep(200);
  process.exit(0);
})().catch(e => { console.error('FATAL', e && e.message); process.exit(9); });
