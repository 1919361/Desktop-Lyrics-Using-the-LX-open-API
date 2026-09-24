/* ============================================================================
 *  Lyrics · 系统字体扫描  (scan-fonts.js)
 *  ---------------------------------------------------------------------------
 *  为什么需要它：
 *    壁纸引擎的属性面板是「静态」的 —— 选项列表写在 project.json 里，
 *    运行时没法往里塞新条目。所以「从系统扫描字体」这条路，
 *    只能走「扫描 → 把结果写进 project.json 的下拉列表」这一条。
 *
 *  它做两件事：
 *    ① 扫 Windows 的字体目录，解析每个字体文件的 name / cmap 表，
 *       拿到「英文族名 + 中文族名 + 是否含汉字」；
 *    ② 把结果写进 project.json 的 font_family.options（幂等，可反复跑），
 *       同时落一份 fonts.json 备查。
 *
 *  装了新字体之后再跑一次即可刷新列表。
 *  （2026-09-22 起字体规则：运行目录的 CustomFont.ttf/otf 优先于本列表；
 *   本脚本只负责维护下拉列表本身。）
 *
 *  用法：
 *    node scan-fonts.js                 扫描并写入
 *    node scan-fonts.js --dry           只看结果，不写文件
 *    node scan-fonts.js --dir D:\fonts  额外扫描一个目录（可重复）
 * ========================================================================== */
'use strict';

/* ========================================================================
 *  ⚠ 此脚本已停用（2026-09-22，字体规则改版）⚠
 *  字体下拉固定为「通用 3 项 + 微软雅黑/等线/黑体」，不再把系统字体灌进列表；
 *  想用某个具体字体：改名为 CustomFont.ttf / CustomFont.otf 放进本目录即可。
 *  真要恢复：node scan-fonts.js --i-am-sure
 * ======================================================================== */
if (!process.argv.includes('--i-am-sure')) {
    console.error('✖ scan-fonts.js 已停用：字体下拉固定为通用 3 项 + 微软雅黑/等线/黑体，具体字体请用 CustomFont.ttf/otf。');
    process.exit(1);
}

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const PROJECT = path.join(HERE, 'project.json');
const FONTS_JSON = path.join(HERE, 'fonts.json');

/* 扫描范围：系统字体目录 + 当前用户安装的字体目录（非管理员安装的字体在这里） */
const FONT_DIRS = [
    process.env.SystemRoot ? path.join(process.env.SystemRoot, 'Fonts') : 'C:/Windows/Fonts',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts') : ''
].filter(Boolean);

const EXT = new Set(['.ttf', '.ttc', '.otf', '.otc']);
/* 认作「含汉字」的探针码位：中 / 歌（挑两个，避免个别字体只收了一个） */
const HAN_PROBE = [0x4E2D, 0x6B4C];

/* ========================================================================== */
/*  一、字体文件解析                                                          */
/* ========================================================================== */

/* 取出这个 sfnt（单个字形集）的所有表目录 */
function readTables(buf, base) {
    if (base + 12 > buf.length) return null;
    const tag = buf.readUInt32BE(base);
    /* 0x00010000 TrueType / 'OTTO' CFF 轮廓 / 'true' 'typ1' 老式 */
    if (tag !== 0x00010000 && tag !== 0x4F54544F && tag !== 0x74727565 && tag !== 0x74797031) return null;
    const n = buf.readUInt16BE(base + 4);
    if (n <= 0 || n > 512 || base + 12 + n * 16 > buf.length) return null;
    const out = {};
    for (let i = 0; i < n; i++) {
        const p = base + 12 + i * 16;
        const name = buf.toString('latin1', p, p + 4);
        const off = buf.readUInt32BE(p + 8);
        const len = buf.readUInt32BE(p + 12);
        if (off + len <= buf.length) out[name] = { off: off, len: len };
    }
    return out;
}

/* 一个字体文件里可能有多个字形集（.ttc / .otc 字体集合），逐个取出来 */
function sfntOffsets(buf) {
    if (buf.length < 12) return [];
    if (buf.toString('latin1', 0, 4) === 'ttcf') {
        const num = buf.readUInt32BE(8);
        const out = [];
        for (let i = 0; i < num && 12 + i * 4 + 4 <= buf.length; i++) out.push(buf.readUInt32BE(12 + i * 4));
        return out;
    }
    return [0];
}

function decodeName(buf, rec) {
    const p = rec.off, len = rec.len;
    if (p + len > buf.length) return '';
    /* 平台 3（Windows）与 0（Unicode）都是 UTF-16BE；平台 1（Mac）按 MacRoman 当 latin1 处理 */
    if (rec.platform === 3 || rec.platform === 0) {
        let s = '';
        for (let i = 0; i + 1 < len; i += 2) s += String.fromCharCode(buf.readUInt16BE(p + i));
        return s;
    }
    return buf.toString('latin1', p, p + len);
}

/* 从 name 表里挑出「英文族名 / 中文族名」 */
function readNames(buf, tables) {
    const t = tables['name'];
    if (!t || t.len < 6) return null;
    const base = t.off;
    const count = buf.readUInt16BE(base + 2);
    const strOff = base + buf.readUInt16BE(base + 4);
    if (count > 4096) return null;

    const en = {}, zh = {};
    for (let i = 0; i < count; i++) {
        const p = base + 6 + i * 12;
        if (p + 12 > buf.length) break;
        const platform = buf.readUInt16BE(p);
        const encoding = buf.readUInt16BE(p + 2);
        const language = buf.readUInt16BE(p + 4);
        const nameID = buf.readUInt16BE(p + 6);
        const len = buf.readUInt16BE(p + 8);
        const off = buf.readUInt16BE(p + 10);
        if (nameID !== 1 && nameID !== 4 && nameID !== 16) continue;
        const rec = { off: strOff + off, len: len, platform: platform };
        const s = decodeName(buf, rec);
        if (!s) continue;
        const isZh = platform === 3 && (language === 0x0804 || language === 0x0404 || language === 0x0C04 || language === 0x1004);
        const isEn = (platform === 3 && language === 0x0409) || platform === 0 || (platform === 1 && language === 0);
        if (isZh) zh[nameID] = s;
        else if (isEn) en[nameID] = s;
        else if (encoding === 1) en[nameID] = en[nameID] || s;   /* 其它语言的西文名，兜底 */
    }
    /* 16 = 排版族名（Typographic Family），比 1 更准；没有就退回 1 */
    const pick = m => m[16] || m[1] || (m[4] || '').replace(/\s+(Regular|Bold|Italic|Light|Medium|Book|Oblique|Semibold|SemiBold|Black|Thin|ExtraLight|DemiBold|Heavy)$/i, '').trim();
    const e = pick(en), z = pick(zh);
    if (!e && !z) return null;
    return { en: e || '', zh: z || '' };
}

/* ---- cmap：判断这个字体有没有汉字 -------------------------------------- */

function cmapHas(cmapBuf, cp) {
    if (cmapBuf.length < 4) return false;
    const n = cmapBuf.readUInt16BE(2);
    if (n <= 0 || n > 64) return false;
    for (let i = 0; i < n; i++) {
        const p = 4 + i * 8;
        if (p + 8 > cmapBuf.length) break;
        const off = cmapBuf.readUInt32BE(p + 4);
        if (off + 2 > cmapBuf.length) continue;
        const fmt = cmapBuf.readUInt16BE(off);
        if (fmt === 4 && has4(cmapBuf, off, cp)) return true;
        if (fmt === 12 && has12(cmapBuf, off, cp)) return true;
    }
    return false;
}

function has4(b, off, cp) {
    if (cp > 0xFFFF || off + 14 > b.length) return false;
    const segX2 = b.readUInt16BE(off + 6);
    const seg = segX2 / 2;
    if (!seg) return false;
    const endBase = off + 14, startBase = endBase + segX2 + 2;
    const deltaBase = startBase + segX2, rangeBase = deltaBase + segX2;
    if (rangeBase + segX2 > b.length) return false;
    for (let i = 0; i < seg; i++) {
        const end = b.readUInt16BE(endBase + i * 2);
        if (end < cp) continue;
        const start = b.readUInt16BE(startBase + i * 2);
        if (start > cp) return false;
        const delta = b.readInt16BE(deltaBase + i * 2);
        const range = b.readUInt16BE(rangeBase + i * 2);
        if (range === 0) return ((cp + delta) & 0xFFFF) !== 0;
        const at = rangeBase + i * 2 + range + (cp - start) * 2;
        if (at + 2 > b.length) return false;
        const g = b.readUInt16BE(at);
        return g !== 0 && (((g + delta) & 0xFFFF) !== 0);
    }
    return false;
}

function has12(b, off, cp) {
    if (off + 16 > b.length) return false;
    const n = b.readUInt32BE(off + 12);
    if (n > 100000) return false;
    let lo = 0, hi = n - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const p = off + 16 + mid * 12;
        if (p + 12 > b.length) return false;
        const s = b.readUInt32BE(p), e = b.readUInt32BE(p + 4);
        if (cp < s) hi = mid - 1;
        else if (cp > e) lo = mid + 1;
        else return b.readUInt32BE(p + 8) !== 0;
    }
    return false;
}

/* 解析一个文件 —— 可能产出多个条目（字体集合） */
function parseFile(file) {
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) { return []; }
    const out = [];
    for (const base of sfntOffsets(buf)) {
        let tables;
        try { tables = readTables(buf, base); } catch (e) { tables = null; }
        if (!tables) continue;
        let names = null;
        try { names = readNames(buf, tables); } catch (e) { names = null; }
        if (!names) continue;
        let cjk = false;
        if (tables['cmap']) {
            try {
                const t = tables['cmap'];
                const sub = buf.subarray(t.off, t.off + t.len);
                cjk = HAN_PROBE.every(function (cp) { return cmapHas(sub, cp); });
            } catch (e) { cjk = false; }
        }
        out.push({ en: names.en, zh: names.zh, cjk: cjk, file: path.basename(file) });
    }
    return out;
}

/* ========================================================================== */
/*  二、扫描                                                                  */
/* ========================================================================== */

/* 这几个放在列表最前面（装了才出现），其余按「含汉字优先 + 字母序」排 */
const PINNED = [
    'microsoft yahei', '微软雅黑',
    'source han sans', '思源黑体', 'noto sans sc',
    'microsoft jhenghei', 'simsun', '宋体', 'simhei', '黑体',
    'kaiti', '楷体', 'fangsong', '仿宋', 'dengxian', '等线',
    'lxgw wenkai', 'harmonyos sans', 'misans', 'pingfang sc'
];

function scan(dirs) {
    const found = [];
    const seenName = new Set();
    const skipped = [];
    let files = 0;

    for (const dir of dirs) {
        let list;
        try { list = fs.readdirSync(dir); } catch (e) { continue; }
        for (const name of list) {
            if (name.startsWith('.')) continue;
            if (!EXT.has(path.extname(name).toLowerCase())) continue;
            files++;
            const entries = parseFile(path.join(dir, name));
            if (!entries.length) { skipped.push(name); continue; }
            for (const e of entries) {
                /* CSS 用英文族名最稳（中文名也认，但英文名跨语言一致）；
                   有些字体没有英文名，就退回中文名 */
                const value = e.en || e.zh;
                const label = e.zh || e.en;
                if (!value) continue;
                const key = value.toLowerCase();
                if (seenName.has(key)) continue;
                seenName.add(key);
                found.push({ value: value, label: label, alt: e.zh && e.en && e.zh !== e.en ? e.en : '', cjk: e.cjk, file: e.file });
            }
        }
    }

    const rank = f => {
        const i = PINNED.indexOf(f.value.toLowerCase());
        if (i >= 0) return i;
        const j = PINNED.indexOf(f.label);
        return j >= 0 ? j : 1000;
    };
    found.sort(function (a, b) {
        if (a.cjk !== b.cjk) return a.cjk ? -1 : 1;
        const ra = rank(a), rb = rank(b);
        if (ra !== rb) return ra - rb;
        return a.value.toLowerCase() < b.value.toLowerCase() ? -1 : 1;
    });
    return { fonts: found, files: files, skipped: skipped };
}

/* ========================================================================== */
/*  三、写进 project.json                                                     */
/* ========================================================================== */

const T = '\t';
/* 前面的固定项：不改变字体 + 三个通用族 */
const HEAD_OPTIONS = [
    { label: '通用 · 无衬线（sans-serif）', value: 'sans-serif' },
    { label: '通用 · 衬线（serif）', value: 'serif' },
    { label: '通用 · 等宽（monospace）', value: 'monospace' }
];

function buildOptions(fonts) {
    const opts = HEAD_OPTIONS.slice();
    for (const f of fonts) {
        /* 中文名 + 英文名都给出来，方便对照；不含汉字的标一下，
           不然两百多条里挑不出能显示歌词的 */
        let label = f.label;
        if (f.alt) label += ' / ' + f.alt;
        if (!f.cjk) label += ' · 无汉字';
        opts.push({ label: label, value: f.value });
    }
    return opts;
}

/* 精确替换 project.json 里某个键的整个对象块（保证其余字节一个不动） */
function replaceBlock(text, key, build) {
    /* 锚点不能写死 '"key": {' —— WE 编辑器会把 project.json 重排成
       "key" : \r\n { 的格式（冒号两侧带空格、花括号在下一行）。
       所以先按正则找键名，再以匹配到的那个 '{' 作为块起点。 */
    const m = new RegExp('"' + key + '"\\s*:\\s*\\{').exec(text);
    if (!m) throw new Error('project.json 里找不到 "' + key + '"');
    const i = m.index;
    const anchorLen = m[0].length;
    let depth = 0, k = i + anchorLen - 1, inStr = false, esc = false;
    for (; k < text.length; k++) {
        const c = text[k];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) throw new Error('"' + key + '" 的对象块括号不配对，project.json 可能被改坏了');
    /* 匹配到的 '{'（即 k 的初始值）就是要替换的起点，k 是它配对的那个 '}' */
    const start = i + anchorLen - 1;
    return { text: text.slice(0, start) + build() + text.slice(k + 1), from: start, to: k + 1 };
}

function optionsText(opts, value, order) {
    const L3 = T.repeat(3), L4 = T.repeat(4);
    const lines = opts.map(function (o) {
        return L4 + '{ "label": ' + JSON.stringify(o.label) + ', "value": ' + JSON.stringify(o.value) + ' }';
    });
    return '{\n'
        + L3 + '"order": ' + JSON.stringify(order === undefined ? 37 : order) + ',\n'
        + L3 + '"text": "字体（歌词 / 天际屏）",\n'
        + L3 + '"type": "combo",\n'
        + L3 + '"value": ' + JSON.stringify(value) + ',\n'
        + L3 + '"options": [\n' + lines.join(',\n') + '\n' + L3 + ']\n'
        + T.repeat(2) + '}';
}

/* ========================================================================== */
/*  四、主流程                                                                */
/* ========================================================================== */

function main() {
    const argv = process.argv.slice(2);
    const dry = argv.indexOf('--dry') >= 0;
    const dirs = FONT_DIRS.slice();
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--dir' && argv[i + 1]) dirs.push(argv[++i]);
    }

    const raw = fs.readFileSync(PROJECT, 'utf8');
    const proj = JSON.parse(raw);                         /* 顺便校验 JSON 没被改坏 */
    const props = proj.general && proj.general.properties;
    if (!props || !props.font_family) {
        console.error('✖ project.json 里没有 general.properties.font_family，先补上这个键再扫');
        process.exit(1);
    }

    const res = scan(dirs);
    const cjk = res.fonts.filter(f => f.cjk).length;
    console.log('扫描目录：');
    dirs.forEach(d => console.log('  ' + d));
    console.log('字体文件 ' + res.files + ' 个，解析失败 ' + res.skipped.length + ' 个');
    if (res.skipped.length) console.log('  跳过：' + res.skipped.join('、'));
    console.log('可用字族 ' + res.fonts.length + ' 个，其中含汉字 ' + cjk + ' 个');

    const opts = buildOptions(res.fonts);
    const prev = props.font_family.value || 'system';
    /* 原来选的字体如果还在列表里就保留，否则回到「跟随原样式」，
       免得壁纸引擎里那一项变成空白 */
    /* 原选择不在列表里时，落到第一个真实字体（列表按「中文优先」排序，
       通用三项在最前面，跳过它们） */
    const firstReal = (opts.find(o => o.value !== 'sans-serif' && o.value !== 'serif' && o.value !== 'monospace') || opts[opts.length - 1]).value;
    const keep = opts.some(o => o.value === prev) ? prev : firstReal;
    if (keep !== prev) console.log('注意：原来选的「' + prev + '」已不在列表中，已改选「' + firstReal + '」');

    if (dry) {
        console.log('\n（--dry 模式，没有写文件）前 12 项：');
        opts.slice(0, 12).forEach(o => console.log('  ' + o.label));
        return;
    }

    /* 字体属性在面板里的位置（order）跟随工程现状，不写死 ——
       之前硬编码 37，重跑一次就会把面板顺序改掉 */
    const prevOrder = (props.font_family && typeof props.font_family.order === 'number')
        ? props.font_family.order : 37;
    const next = replaceBlock(raw, 'font_family', function () { return optionsText(opts, keep, prevOrder); }).text;
    JSON.parse(next);                                     /* 写之前再验一次 */
    fs.writeFileSync(PROJECT, next);

    fs.writeFileSync(FONTS_JSON, JSON.stringify({
        scannedAt: new Date().toISOString(),
        dirs: dirs,
        files: res.files, families: res.fonts.length, cjk: cjk,
        fonts: res.fonts
    }, null, 2) + '\n');

    console.log('✔ 已写入 project.json 的 font_family.options（' + opts.length + ' 项）');
    console.log('✔ 已写出 fonts.json 备查');
    console.log('\n前 14 项预览：');
    opts.slice(0, 14).forEach(o => console.log('  ' + o.label));
}

main();
