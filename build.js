#!/usr/bin/env node
/* ============================================================================
 *  build.js —— 由桌面的 lyrics.html 生成壁纸工程的 index.html
 *  ---------------------------------------------------------------------------
 *  做法：不复制、不魔改，只在 </head> 前插两行引用：
 *      <link rel="stylesheet" href="we-glue.css">
 *      <script src="we-glue.js"></script>
 *  we-glue.js 在 lyrics.html 自己的脚本之前执行，所以能定义好
 *  window.wallpaperPropertyListener、代理 fetch / EventSource、
 *  并把用户属性翻译成 CSS 变量。
 *
 *  这样 lyrics.html 保持原样（继续能双击打开、继续能独立迭代），
 *  壁纸工程这边只要重跑一次本脚本就同步到最新版。
 *
 *  用法：
 *      node build.js                       # 用 ..\lyrics.html
 *      node build.js D:\path\to\lyrics.html
 * ========================================================================== */

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const OUT_HTML = path.join(HERE, 'index.html');
const OUT_PHOTO = path.join(HERE, 'backpicture.jpg');
const START = '<!-- ==== WE-INJECT-START ==== -->';
const END = '<!-- ==== WE-INJECT-END ==== -->';

const srcArg = process.argv[2];
const SRC = srcArg
    ? path.resolve(srcArg)
    : path.resolve(HERE, '..', 'lyrics.html');

function fail(msg) {
    console.error('\n[build] 失败：' + msg + '\n');
    process.exit(1);
}

/* ---------------------------------------------------------------- 1. 读源文件 */
if (!fs.existsSync(SRC)) fail('找不到源文件 ' + SRC);
let html = fs.readFileSync(SRC, 'utf8');

/* 上一次生成的 index.html 里有没有注入段 —— 只用来汇报「首建 / 覆盖」，
   注入块正常只存在于 index.html，源 lyrics.html 里不该有。 */
let hadPrev = false;
if (fs.existsSync(OUT_HTML)) {
    try {
        hadPrev = fs.readFileSync(OUT_HTML, 'utf8').indexOf(START) >= 0;
    } catch (e) { /* 读不了就当首建 */ }
}

/* 兜底：万一源文件被污染了（有人手改过），也剔干净，保证反复运行结果一致 */
const block = new RegExp('\\s*' + START + '[\\s\\S]*?' + END, 'g');
if (!block.test(html)) {
    /* 正常情况：源文件干净 */
} else {
    console.log('[build] 注意：源文件 ' + path.basename(SRC) +
        ' 里发现了注入块，已剔除（源文件本不该有这一段）');
}
html = html.replace(block, '');

if (html.indexOf('</head>') < 0) fail('源文件里没有 </head>，结构不对');
if (html.indexOf('id="dockWrap"') < 0) fail('源文件里没有 #dockWrap，可能不是 lyrics.html');

/* ------------------------------------------------------------ 2. 注入引用 */
/* 源文件是 CRLF，注入内容照它的换行符来，避免生成「半 CRLF 半 LF」的混合文件 */
const EOL = /\r\n/.test(html) ? '\r\n' : '\n';
const inject = [
    '    ' + START,
    '    <!-- 壁纸引擎选项层：由 build.js 自动注入，重跑 build.js 会覆盖本段 -->',
    '    <link rel="stylesheet" href="we-glue.css">',
    '    <script src="we-glue.js"></script>',
    '    ' + END,
    ''
].join(EOL);

html = html.replace('</head>', inject + '</head>');

/* 标题区分一下，方便在壁纸引擎里认出来（可选，失败不影响） */
html = html.replace(/<title>([\s\S]*?)<\/title>/,
    '<title>$1 · Wallpaper Engine</title>');

fs.writeFileSync(OUT_HTML, html, 'utf8');

/* ------------------------------------------------------- 3. 背景图（可选） */
let photoMsg = '已存在，未覆盖';
if (!fs.existsSync(OUT_PHOTO)) {
    const srcPhoto = path.resolve(path.dirname(SRC), 'backpicture.jpg');
    if (fs.existsSync(srcPhoto)) {
        fs.copyFileSync(srcPhoto, OUT_PHOTO);
        photoMsg = '已从 ' + srcPhoto + ' 复制';
    } else {
        photoMsg = '未找到（工程会用默认深色渐变）';
    }
}

/* ------------------------------------------------------------- 4. 汇报 */
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('\n[build] 完成');
console.log('  源文件   ' + SRC + '  (' + kb(fs.statSync(SRC).size) + ')');
console.log('  输出     ' + OUT_HTML + '  (' + kb(fs.statSync(OUT_HTML).size) + ')');
console.log('  覆盖旧注入 ' + (hadPrev ? '是（重新生成了 index.html）' : '无（首次生成）'));
console.log('  背景图   ' + photoMsg);
console.log('  行数     ' + html.split('\n').length + '\n');
