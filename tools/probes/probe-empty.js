/* ============================================================================
 *  probe-empty.js —— 「纯音乐单句歌词被判成没有歌词」+「没有歌词反复闪烁」
 *  ---------------------------------------------------------------------------
 *  · 捕获页面 console（能看清归属校验到底判了什么）
 *  · 采样 #lyricList 的文本与 opacity，抓"每几秒闪一下"
 *  注意：Chromium 需要命名管道做进程内通信，要在全权限下跑。
 * ========================================================================== */
'use strict';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SRC = path.join(__dirname, '..', '..');   // 工程根目录（本脚本在 tools/probes/ 下）
const PORT = 8891, CDP = 9399;
const BROWSER = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json' };

/* 三种"纯音乐"歌词形态：无标签 / 有标签且与歌名一致 / 有标签但与歌名不同 */
const K1 = '纯音乐，请欣赏';
const V_NO_TAG = '[00:00.00]纯音乐，请欣赏';
const V_TAG_OK = '[ti:测试纯音乐]\n[ar:测试歌手]\n[00:00.00]纯音乐，请欣赏';
const V_TAG_BAD = '[ti:完全不相干的歌名]\n[ar:别的歌手]\n[00:00.00]纯音乐，请欣赏';

const STUB = `<script>
window.__variant = 'noTag';
window.__song = 'instr';
window.__V = ${JSON.stringify({ noTag: V_NO_TAG, tagOk: V_TAG_OK, tagBad: V_TAG_BAD })};
(function(){var of=window.fetch;
  window.fetch=function(u,x){ var s=String(u);
    if(s.indexOf('/lyric-all')>=0){
      var t = window.__song === 'empty' ? '' : window.__V[window.__variant];
      return Promise.resolve(new Response(JSON.stringify({lyric:t,lxlyric:t}),{status:200,headers:{'Content-Type':'application/json'}}));
    }
    if(s.indexOf('/status')>=0){
      var nm = window.__song === 'empty' ? '安静的歌' : (window.__name || '测试纯音乐');
      return Promise.resolve(new Response(JSON.stringify({status:'playing',name:nm,singer:'测试歌手',duration:200,progress:3,playbackRate:1,collect:false,volume:74,mute:false,picUrl:''}),{status:200,headers:{'Content-Type':'application/json'}}));
    }
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'));
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
  let id = 0; const pending = new Map(); const logs = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      const txt = (m.params.args || []).map(a => (a.value !== undefined ? a.value : (a.description || a.type))).join(' ');
      logs.push({ type: m.params.type, txt: String(txt).slice(0, 160) });
    }
  };
  const send = (method, params) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  const js = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const state = () => js("JSON.stringify((function(){var l=document.getElementById('lyricList'); return { lines: document.querySelectorAll('#lyricList .lyric-line').length, empty: !!document.querySelector('#lyricList .empty-lyric'), text: (l.textContent||'').trim().slice(0,24), op: +getComputedStyle(l).opacity };})())");

  await send('Page.enable'); await send('Runtime.enable');
  await sleep(3000);

  console.log('=== ① 单句「纯音乐，请欣赏」的三种形态 ===');
  let seq = 0;
  for (const [name, label] of [['noTag', '无 [ti]/[ar] 标签'], ['tagOk', '[ti]/[ar] 与歌名一致'], ['tagBad', '[ti]/[ar] 与歌名不符']]) {
    logs.length = 0;
    /* 每次换一个歌名，才会真正触发一次重拉（否则 name 事件被判为"没变"） */
    seq++;
    await js(`window.__variant='${name}'; window.__song='instr'; window.__name='测试纯音乐'+${seq}; window.__emit('name', '测试纯音乐'+${seq});`);
    await sleep(1800);
    console.log(` ${name}（${label}）→`, await state());
    const interesting = logs.filter(l => /歌词/.test(l.txt)).map(l => l.txt);
    if (interesting.length) interesting.slice(0, 4).forEach(t => console.log('     console:', t));
  }

  console.log('\n=== ② 「没有歌词」状态下等 22 秒，看会不会闪 ===');
  await js("window.__song='empty'; window.__emit('name','安静的歌');");
  await sleep(1800);
  console.log(' 切到无歌词的歌 →', await state());
  const samples = [];
  for (let i = 0; i < 44; i++) {           // 44 × 500ms = 22s
    samples.push({ t: i * 0.5, s: JSON.parse(await state()) });
    await sleep(500);
  }
  const dips = samples.filter(x => x.s.op < 0.99);
  console.log(' 采样', samples.length, '次；opacity < 0.99 的次数:', dips.length);
  dips.slice(0, 12).forEach(d => console.log('   t=' + d.t + 's  op=' + d.s.op + '  text=' + JSON.stringify(d.s.text)));
  const texts = [...new Set(samples.map(x => x.s.text))];
  console.log(' 出现过的文本:', JSON.stringify(texts));

  try { ws.close(); } catch (e) { }
  try { edge.kill(); } catch (e) { }
  try { server.close(); } catch (e) { }
  await sleep(200);
  process.exit(0);
})().catch(e => { console.error('FATAL', e && e.message); process.exit(9); });
