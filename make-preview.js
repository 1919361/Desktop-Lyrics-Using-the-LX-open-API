#!/usr/bin/env node
/**
 * 重新生成 preview.jpg（壁纸引擎里显示的缩略图）
 * ---------------------------------------------------------------------------
 *  用无头 Edge + CDP 把 index.html 渲染成图。为了让缩略图好看，测试期间会把
 *  LX Music 的接口用桩数据顶掉（一首示例曲目 + 一组歌词），所以：
 *
 *      · 不需要真的开着 LX Music
 *      · 不会碰到你正在播放的播放器
 *
 *  用法：
 *      node make-preview.js                # 1920×1080，质量 88
 *      node make-preview.js 1280 720       # 自定义尺寸
 *      node make-preview.js 1920 1080 --raw   # 不用桩数据，截「等待播放」的真实状态
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SRC = __dirname;
const OUT = path.join(SRC, 'preview.jpg');
const PORT = 8843;
const CDP = 9393;

const argv = process.argv.slice(2);
const raw = argv.includes('--raw');
const nums = argv.filter(a => /^\d+$/.test(a)).map(Number);
const W = nums[0] || 1920;
const H = nums[1] || 1080;

const BROWSERS = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
];
const BROWSER = BROWSERS.find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png',
    '.json': 'application/json'
};

/* 示例歌词：写成「逐字带时间戳」的形式（[mm:ss.xx]字[mm:ss.xx]字…）。
   只有逐字时间戳才能让原页面生成 .lyric-char 元素，
   否则当前这一句是一整块纯文本 —— 缩略图就看不出「逐字扫光 + 当前字光晕」这个招牌效果。 */
const SAMPLE = [
    [0, '此刻 世界安静下来'],
    [6, '只剩窗外的风 和这一首歌'],
    [12, '每个字都在慢慢亮起来'],
    [30, '跟着节奏 一起呼吸'],
    [36, '让旋律把夜色填满'],
    [42, '我们把时间 唱得很慢'],
    [48, '直到天亮之前'],
    [54, '都别停下来']
];
const pad2 = n => (n < 10 ? '0' : '') + n;
function stamp(sec) {
    const m = Math.floor(sec / 60), s = sec - m * 60;
    return '[' + pad2(m) + ':' + (s < 10 ? '0' : '') + s.toFixed(2) + ']';
}
const LRC = SAMPLE.map(function (L) {
    let t = L[0], out = '';
    for (const ch of L[1]) { out += stamp(t) + ch; t += 0.45; }
    return out;
}).join('\\n');

/* 播放位置停在第 4 句刚开口的地方。
   页面会在两次状态轮询之间自己“外推”播放进度，所以截图时进度比这里给的值大一点 ——
   与其猜偏移量，不如后面「等到唱到第 5 个字再截」。 */
const PROGRESS = 30.3;

/* 桩：拦掉 fetch / EventSource，播放状态固定成上面那个位置 */
const INJECT = `
window.__LRC = "${LRC}";
(function(){var of=window.fetch;
  window.fetch=function(u,x){ var s=String(u);
    if(s.indexOf('/lyric-all')>=0) return Promise.resolve(new Response(JSON.stringify({lyric:window.__LRC}),{status:200,headers:{'Content-Type':'application/json'}}));
    if(s.indexOf('/status')>=0) return Promise.resolve(new Response(JSON.stringify({status:'playing',name:'示例曲目',singer:'示例歌手',albumName:'',duration:200,progress:${PROGRESS},playbackRate:1,collect:true,volume:74,mute:false,picUrl:''}),{status:200,headers:{'Content-Type':'application/json'}}));
    return of.apply(this,arguments);};})();
(function(){var OE=window.EventSource; if(!OE) return;
  var P=function(u,c){ this.__u=String(u); };
  P.prototype.addEventListener=function(){}; P.prototype.removeEventListener=function(){};
  P.prototype.close=function(){}; P.CONNECTING=0; P.OPEN=1; P.CLOSED=2;
  window.EventSource=P;})();
`;

(async () => {
    if (!BROWSER) { console.error('✖ 没找到 Edge / Chrome，无法截图。'); process.exit(1); }
    if (!fs.existsSync(path.join(SRC, 'index.html'))) {
        console.error('✖ 找不到 index.html，先跑 build.js。'); process.exit(1);
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'we-preview-'));
    const root = path.join(tmp, 'site');
    fs.mkdirSync(root, { recursive: true });
    for (const f of ['index.html', 'we-glue.css', 'we-glue.js', 'backpicture.jpg']) {
        const from = path.join(SRC, f);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(root, f));
    }
    /* index.html 里的 preview 引用不参与渲染，但 404 会刷控制台，放个占位 */
    fs.writeFileSync(path.join(root, 'preview.jpg'), Buffer.alloc(0));

    const server = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0].replace(/^\//, '')) || 'index.html';
        const p = path.join(root, rel);
        fs.readFile(p, (e, b) => {
            if (e) { res.writeHead(404); res.end('404'); return; }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' });
            res.end(b);
        });
    });
    await new Promise(r => server.listen(PORT, '127.0.0.1', r));

    console.log('渲染 ' + W + '×' + H + (raw ? '（真实状态，不用桩数据）' : '（示例曲目桩数据）'));

    const edge = spawn(BROWSER, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars',
        '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1',
        `--remote-debugging-port=${CDP}`,
        `--user-data-dir=${path.join(tmp, 'p')}`,
        `http://127.0.0.1:${PORT}/index.html`
    ], { stdio: 'ignore' });

    const cleanup = () => {
        try { edge.kill(); } catch (e) {}
        try { server.close(); } catch (e) {}
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    };

    let page = null;
    for (let i = 0; i < 30 && !page; i++) {
        await sleep(500);
        try {
            const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
            page = l.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
        } catch (e) {}
    }
    if (!page) { cleanup(); console.error('✖ 浏览器没起来。'); process.exit(1); }

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const pending = new Map();
    ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params) => new Promise(res => {
        const mid = ++id; pending.set(mid, res);
        ws.send(JSON.stringify({ id: mid, method, params }));
    });

    await send('Page.enable');
    if (!raw) await send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT });

    /* 强制精确视口，不受窗口边框影响 */
    await send('Emulation.setDeviceMetricsOverride',
        { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });

    /* 等页面把歌词拉完、动画跑起来，再等「当前这句唱到第 5 个字」——
       这样缩略图里既有已点亮的字、又有一个正在扫光的字，
       比盲等固定秒数稳（进度是页面自己外推的，和给定值不严格相等）。 */
    const examine = `JSON.stringify((()=>{
        const a=document.querySelector('.lyric-line.active');
        if(!a) return {ready:false};
        return { ready:true,
                 text:(a.textContent||'').trim(),
                 chars:a.querySelectorAll('.lyric-char').length,
                 sung:a.querySelectorAll('.lyric-char.sung').length };
    })())`;

    await sleep(2200);
    let state = null;
    for (let i = 0; i < 40; i++) {                 /* 最多再等 8 秒 */
        const r = await send('Runtime.evaluate', { expression: examine, returnByValue: true });
        try { state = JSON.parse(r.result.result.value); } catch (e) { state = null; }
        if (state && state.ready && state.chars > 0 && state.sung >= 5) break;
        await sleep(200);
    }
    await sleep(900);                                 /* 让扫光动画再推进一点 */
    if (state) console.log('定格在：' + JSON.stringify(state));

    const shot = await send('Page.captureScreenshot',
        { format: 'jpeg', quality: 88, captureBeyondViewport: false });

    if (!shot.result || !shot.result.data) {
        cleanup();
        console.error('✖ 截图失败。');
        process.exit(1);
    }
    const buf = Buffer.from(shot.result.data, 'base64');
    fs.writeFileSync(OUT, buf);
    cleanup();

    console.log('✔ 已写出 ' + OUT + '（' + (buf.length / 1024).toFixed(0) + ' KB）');
    process.exit(0);
})().catch(e => { console.error('✖ ' + e); process.exit(1); });
