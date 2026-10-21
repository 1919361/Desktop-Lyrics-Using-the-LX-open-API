/* ============================================================================
 *  probe-lyrics.js —— 歌词三个问题的复现/回归脚本
 *  ---------------------------------------------------------------------------
 *  用一个"可以手动触发事件"的假 EventSource 来精确控制切歌时刻，检查：
 *    A. 焦点行的水平偏移（焦点行 vs 普通行 .lyric-main 的左缘）应该为 0；
 *    B. 切到「没有歌词」的歌时，画面上是否还留着上一首的词；
 *    C. 快速连续切歌时，歌词的**视觉位置**是否会大幅来回跳。
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
const PORT = 8881, CDP = 9398;
const BROWSER = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json' };

const pad2 = n => (n < 10 ? '0' : '') + n;
const stamp = s => { const m = Math.floor(s / 60); return '[' + pad2(m) + ':' + (s - m * 60 < 10 ? '0' : '') + (s - m * 60).toFixed(2) + ']'; };
function lrcOf(title, lines) {
  const head = '[ti:' + title + ']\n[ar:测试歌手]\n';
  return head + lines.map(([t0, txt]) => { let t = t0, o = ''; for (const ch of txt) { o += stamp(t) + ch; t += 0.42; } return o; }).join('\n');
}
/* A 歌：每 4s 一句、覆盖到 76s（4s < GAP_MIN，不会插间奏点行），
   进度 65s 时焦点行稳定落在中间某一句上 */
const LRC_A = lrcOf('A 歌', Array.from({ length: 20 }, (_, i) => [i * 4, '这是A歌的第' + (i + 1) + '句歌词']));
const LRC_B = lrcOf('B 歌', [[0, '这是B歌的第一句'], [8, '这是B歌的第二句']]);
/* C 歌：带"同刻对唱"——两句时间戳几乎相同，会被并成一组 */
const LRC_C = lrcOf('C 歌', [[0, '对唱第一句在这边'], [10, '合唱的另一句同时'], [10.0, '陪跑的第二句同时'], [20, '第三句'], [28, '第四句'], [36, '第五句'], [44, '第六句'], [52, '第七句'], [60, '第八句']]);
/* D 歌：30 行、跨度够长，用来复现"长列表 + 中段进度"下的跳变 */
const LRC_D = lrcOf('D 歌', Array.from({ length: 30 }, (_, i) => [i * 6, '这是第' + (i + 1) + '句比较长的歌词内容用来撑开行宽']));

const STUB = `<script>
window.__song = 'A';
window.__LRC_A = ${JSON.stringify(LRC_A)};
window.__LRC_B = ${JSON.stringify(LRC_B)};
window.__LRC_C = ${JSON.stringify(LRC_C)};
window.__LRC_D = ${JSON.stringify(LRC_D)};
(function(){var of=window.fetch;
  window.fetch=function(u,x){ var s=String(u);
    if(s.indexOf('/lyric-all')>=0){
      var t = window.__song === 'A' ? window.__LRC_A
            : window.__song === 'B' ? ''
            : window.__song === 'C' ? window.__LRC_C
            : window.__song === 'E' ? window.__LRC_A     /* E：洛雪仍回上一首的词 */
            : window.__LRC_D;
      return Promise.resolve(new Response(JSON.stringify({lyric:t,lxlyric:t}),{status:200,headers:{'Content-Type':'application/json'}}));
    }
    if(s.indexOf('/status')>=0){
      var nm = window.__song + ' 歌';
      return Promise.resolve(new Response(JSON.stringify({status:'playing',name:nm,singer:'测试歌手',duration:200,progress:65,playbackRate:1,collect:false,volume:74,mute:false,picUrl:''}),{status:200,headers:{'Content-Type':'application/json'}}));
    }
    if(s.indexOf('/seek')>=0||s.indexOf('/volume')>=0||s.indexOf('/mute')>=0) return Promise.resolve(new Response('{}',{status:200}));
    return of.apply(this,arguments);};})();
(function(){
  var insts=[];
  function P(url,cfg){ this._l={}; insts.push(this); }
  P.prototype.addEventListener=function(n,f){ (this._l[n]=this._l[n]||[]).push(f); };
  P.prototype.removeEventListener=function(){};
  P.prototype.close=function(){};
  P.CONNECTING=0;P.OPEN=1;P.CLOSED=2;
  window.EventSource=P;
  window.__emit=function(n,v){ insts.forEach(function(ins){ (ins._l[n]||[]).forEach(function(f){ try{ f({data:JSON.stringify(v)}); }catch(e){} }); }); };
})();
</script>`;

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lyr-'));
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
    if (r.result && r.result.exceptionDetails) return 'ERR:' + JSON.stringify(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description);
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Page.enable'); await send('Runtime.enable');
  await sleep(3000);

  /* ---------------- A. 焦点行水平偏移 ---------------- */
  console.log('A) 焦点行水平位置');
  console.log(await js(`JSON.stringify((function(){
    var act = document.querySelector('.lyric-line.active');
    var norm = document.querySelector('.lyric-line:not(.active):not(.simul):not(.gap-line)');
    var am = act ? (act.querySelector('.lyric-main') || act) : null;
    var nm = norm ? (norm.querySelector('.lyric-main') || norm) : null;
    var a = am ? am.getBoundingClientRect() : null, n = nm ? nm.getBoundingClientRect() : null;
    return { activeIsGap: act ? act.classList.contains('gap-line') : null,
             hasActive: !!act,
             lineClasses: [].slice.call(document.querySelectorAll('.lyric-line')).slice(0, 10).map(function(e){ return e.className; }),
             activeMainLeft: a?Math.round(a.left*10)/10:null,
             normalMainLeft: n?Math.round(n.left*10)/10:null,
             delta: (a&&n)?Math.round((a.left-n.left)*10)/10:null,
             lineOrigin: act?getComputedStyle(act).transformOrigin:null,
             pad: act?getComputedStyle(act).paddingLeft:null };
  })())`));

  /* ---------------- B. 切到没有歌词的歌 ---------------- */
  console.log('\nB) 切到「没有歌词」的歌');
  console.log('  切换前 #lyricList 行数:', await js("document.querySelectorAll('#lyricList .lyric-line').length"));
  await js("window.__song='B'; window.__emit('name','B 歌');");
  await sleep(1600);
  console.log('  切换后行数:', await js("document.querySelectorAll('#lyricList .lyric-line').length"),
              '| 文本:', JSON.stringify(String(await js("document.querySelector('#lyricList').textContent.trim().slice(0,40)"))));

  /* ---------------- B2. 洛雪仍返回上一首歌词（归属不符） ---------------- */
  console.log('\nB2) 切到 E 歌，但 /lyric-all 仍返回 A 歌的歌词（归属不符）');
  await js("window.__song='A'; window.__emit('name','A 歌');");
  await sleep(1200);
  console.log('  先回到 A 歌，行数:', await js("document.querySelectorAll('#lyricList .lyric-line').length"));
  await js("window.__song='E'; window.__emit('name','E 歌');");
  await sleep(2000);   // 归属校验会重试 2 次（260ms 间隔）后放弃
  console.log('  切到 E 后行数:', await js("document.querySelectorAll('#lyricList .lyric-line').length"),
              '| 文本:', JSON.stringify(String(await js("document.querySelector('#lyricList').textContent.trim().slice(0,40)"))));

  /* ---------------- C. 快速切歌时的视觉跳动 ---------------- */
  console.log('\nC) 快速切歌（D/B/C/A 轮换，每 80ms，共 9 次；长列表 + 中段进度）');
  await js(`window.__jsLog = []; window.__jsTimer = setInterval(function(){
      var el = document.querySelector('#lyricList');
      var sc = document.getElementById('lyricScroll');
      if (!el || !sc) return;
      window.__jsLog.push({ t: Math.round(performance.now()), top: Math.round(el.getBoundingClientRect().top), st: sc.scrollTop, op: +getComputedStyle(el).opacity, tf: (el.style.transform||'').slice(0,28), n: document.querySelectorAll('#lyricList .lyric-line').length });
    }, 25);`);
  for (let i = 0; i < 9; i++) {
    const song = ['D', 'B', 'C', 'A'][i % 4];
    const name = song + ' 歌';
    await js(`window.__song='${song}'; window.__emit('name','${name}');`);
    await sleep(80);
  }
  await sleep(2000);
  await js('clearInterval(window.__jsTimer);');
  const log = JSON.parse(await js('JSON.stringify(window.__jsLog||[])'));
  console.log('  采样点数', log.length);
  /* 找相邻采样里视觉位置的最大跳变 */
  let worst = 0, worstAt = null;
  for (let i = 1; i < log.length; i++) {
    const d = Math.abs(log[i].top - log[i - 1].top);
    if (d > worst) { worst = d; worstAt = [log[i - 1], log[i]]; }
  }
  console.log('  单次采样内最大视觉位移:', worst, 'px @', JSON.stringify(worstAt));
  const tops = log.map(x => x.top);
  console.log('  视觉位置范围:', Math.min(...tops), '..', Math.max(...tops), '（跨度', Math.max(...tops) - Math.min(...tops), 'px）');
  console.log('  末态行数:', log[log.length - 1] && log[log.length - 1].n);
  /* ★ 只统计"看得见"的跳变：列表在淡出期间 opacity 是 0，
     此时位置再怎么变，观众也看不到 —— 那正是我们用来藏住重排的手段。 */
  const jumps = [];
  for (let i = 1; i < log.length; i++) {
    const d = Math.abs(log[i].top - log[i - 1].top);
    const visible = Math.min(log[i].op, log[i - 1].op) > 0.05;
    if (d >= 8) jumps.push({ d, visible, from: log[i - 1], to: log[i] });
  }
  const vis = jumps.filter(j => j.visible);
  console.log('  ≥8px 的跳变:', jumps.length, '次，其中**可见**的:', vis.length, '次');
  vis.slice(0, 8).forEach(j => console.log('   ✱', j.d, 'px  op', j.from.op, '→', j.to.op,
    '| st', j.from.st, '→', j.to.st, '| 行', j.from.n, '→', j.to.n));

  try { ws.close(); } catch (e) { }
  try { edge.kill(); } catch (e) { }
  try { server.close(); } catch (e) { }
  await sleep(200);
  process.exit(0);
})().catch(e => { console.error('FATAL', e && e.message); process.exit(9); });
