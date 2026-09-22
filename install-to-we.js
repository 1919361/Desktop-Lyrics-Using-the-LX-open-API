#!/usr/bin/env node
/**
 * 把本工程安装到 Wallpaper Engine 的本地工程目录
 * ---------------------------------------------------------------------------
 *  壁纸引擎的「已安装」列表只认它自己 projects\myprojects\ 下的目录，
 *  桌面上这份工程它看不见。这个脚本做三件事：
 *
 *    1. 自动找到壁纸引擎装在哪（读 Steam 的 libraryfolders.vdf，再退化到常见路径）
 *    2. 把工程文件复制到 <引擎>\projects\myprojects\<名字>\
 *    3. 告诉你接下来在引擎里怎么点
 *
 *  用法：
 *      node install-to-we.js                    # 默认名字 GLyricsImmersive
 *      node install-to-we.js 我的歌词壁纸        # 自定义工程目录名
 *      node install-to-we.js --list             # 只列出候选安装位置，不复制
 *      node install-to-we.js --target "D:\path\to\wallpaper_engine"
 *      node install-to-we.js --no-scan          # 不刷新字体列表，直接装
 *
 *  重复执行是安全的：会先清掉目标目录再整体复制。
 */
'use strict';

/* ========================================================================
 *  ⚠ 此脚本已停用（2026-09-22，工作流迁移）⚠
 *
 *  本目录（…\myprojects\index）现在就是 Wallpaper Engine 的工程本体：
 *  所有修改直接改这里的文件，改完在引擎里「重新载入」即可，没有安装步骤。
 *
 *  这个脚本的行为是"清空目标目录再整包复制"——误跑会克隆出第二个工程
 *  （两个目录带着同一个 workshopid，创意工坊的更新对象就会出乱子），
 *  所以默认直接拒绝执行。真要恢复旧的两步安装流程，加 --i-am-sure。
 * ======================================================================== */
if (!process.argv.includes('--i-am-sure')) {
    console.error('✖ install-to-we.js 已停用：本目录就是 WE 工程本体，直接修改这里的文件即可。');
    console.error('  （确实要恢复旧的两步安装流程：node install-to-we.js --i-am-sure）');
    process.exit(1);
}

const fs = require('fs');
const path = require('path');
const os = require('os');

const SRC = __dirname;
const DEFAULT_NAME = 'GLyricsImmersive';

/* 要被复制过去的东西。index.html 是入口，其余是它的依赖。 */
const PAYLOAD = [
    'project.json', 'index.html', 'we-glue.js', 'we-glue.css',
    'backpicture.jpg', 'preview.jpg', 'README.md'
];

/* ------------------------------------------------------------------------
 *  1. 找壁纸引擎
 * ---------------------------------------------------------------------- */

const STEAM_ROOTS = [
    'C:/Program Files (x86)/Steam', 'C:/Program Files/Steam',
    'D:/Steam', 'E:/Steam', 'F:/Steam'
];

/** 从 Steam 的 libraryfolders.vdf 里刨出所有库目录 */
function steamLibraries() {
    const libs = [];
    for (const root of STEAM_ROOTS) {
        const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
        if (!fs.existsSync(vdf)) continue;
        const txt = fs.readFileSync(vdf, 'utf8');
        /* "path"		"D:\\SteamLibrary"   —— 只要 path 那一行，够用了 */
        const re = /"path"\s+"([^"]+)"/g;
        let m;
        while ((m = re.exec(txt))) libs.push(m[1].replace(/\\\\/g, '/'));
    }
    /* 有些安装没写 vdf，直接按常见布局兜底 */
    for (const root of STEAM_ROOTS) libs.push(root);
    return [...new Set(libs)];
}

/** 判定一个目录是不是壁纸引擎根目录 */
function looksLikeWE(dir) {
    if (!dir || !fs.existsSync(dir)) return false;
    try {
        if (!fs.statSync(dir).isDirectory()) return false;
    } catch (e) { return false; }
    /* wallpaper64.exe 一定在根；projects 目录也是标志 */
    return fs.existsSync(path.join(dir, 'wallpaper64.exe')) ||
        fs.existsSync(path.join(dir, 'projects', 'myprojects'));
}

function findWE() {
    const found = [];
    for (const lib of steamLibraries()) {
        const we = path.join(lib, 'steamapps', 'common', 'wallpaper_engine');
        if (looksLikeWE(we) && !found.includes(we)) found.push(we);
    }
    return found;
}

/* ------------------------------------------------------------------------
 *  2. 复制
 * ---------------------------------------------------------------------- */

function copyProject(dest) {
    fs.mkdirSync(dest, { recursive: true });
    const copied = [], skipped = [];
    for (const f of PAYLOAD) {
        const from = path.join(SRC, f);
        if (!fs.existsSync(from)) { skipped.push(f); continue; }
        fs.copyFileSync(from, path.join(dest, f));
        copied.push(f);
    }
    return { copied, skipped };
}

/* ------------------------------------------------------------------------
 *  main
 * ---------------------------------------------------------------------- */

function main() {
    const argv = process.argv.slice(2);
    const listOnly = argv.includes('--list');
    const ti = argv.indexOf('--target');
    const forced = ti >= 0 ? argv[ti + 1] : null;
    const nameArg = argv.find(a => !a.startsWith('--') &&
        (!forced || a !== forced));

    if (!fs.existsSync(path.join(SRC, 'project.json'))) {
        console.error('✖ 找不到 project.json —— 请在 Lyrics 工程目录里运行本脚本。');
        process.exit(1);
    }

    console.log('源目录：' + SRC);

    /* 字体下拉列表是「扫出来的」，装机之前先刷一次，免得带过去一份旧清单。
       扫描失败不算致命（比如换了台机器路径不对），照常安装。 */
    if (argv.indexOf('--no-scan') < 0 && fs.existsSync(path.join(SRC, 'scan-fonts.js'))) {
        try {
            require('child_process').execFileSync(process.execPath,
                [path.join(SRC, 'scan-fonts.js')], { cwd: SRC, stdio: 'inherit' });
        } catch (e) {
            console.log('（字体扫描失败，继续安装：' +
                (e && e.message ? e.message.split('\n')[0] : e) + '）');
        }
        console.log('');
    }

    const candidates = forced ? [forced] : findWE();

    if (listOnly || candidates.length === 0) {
        console.log('\n候选安装位置：');
        if (candidates.length === 0) console.log('  （没找到，请用 --target 手动指定）');
        for (const c of candidates) {
            const ok = looksLikeWE(c);
            console.log('  ' + (ok ? '✔' : '✖') + ' ' + c);
        }
        if (listOnly) return;
        console.error('\n✖ 没找到壁纸引擎。用 --target 指定，例如：\n' +
            '  node install-to-we.js --target "D:\\SteamLibrary\\steamapps\\common\\wallpaper_engine"');
        process.exit(2);
    }

    const we = candidates.find(looksLikeWE) || candidates[0];
    if (!looksLikeWE(we)) {
        console.error('✖ ' + we + ' 看起来不是壁纸引擎目录（这里没有 wallpaper64.exe）。');
        process.exit(2);
    }

    const name = nameArg || DEFAULT_NAME;
    const dest = path.join(we, 'projects', 'myprojects', name);

    console.log('引擎目录：' + we);
    console.log('安装到　：' + dest);

    /* 清掉旧版（如果存在），避免残留文件影响 */
    if (fs.existsSync(dest)) {
        const old = fs.readdirSync(dest);
        fs.rmSync(dest, { recursive: true, force: true });
        console.log('（已清理旧目录，原有 ' + old.length + ' 个文件）');
    }

    const { copied, skipped } = copyProject(dest);

    console.log('\n✔ 复制完成，' + copied.length + ' 个文件：');
    for (const f of copied) console.log('    ' + f);
    if (skipped.length) {
        console.log('· 跳过（源里没有，不影响运行）：' + skipped.join(', '));
    }

    /* 读一下 project.json 的标题，报给用户看 */
    let title = name;
    try {
        title = JSON.parse(fs.readFileSync(path.join(SRC, 'project.json'), 'utf8')).title || name;
    } catch (e) { /* 忽略 */ }

    console.log('\n接下来：');
    console.log('  1. 打开 Wallpaper Engine（若已开着，右键托盘图标 → 重新载入/刷新）');
    console.log('  2. 左侧「已安装」里找到「' + title + '」');
    console.log('  3. 右侧属性面板就是全部可调选项');
    console.log('\n反过来：想在编辑器里改完再同步回桌面这份，把');
    console.log('  ' + path.join(dest, 'project.json'));
    console.log('  复制回 ' + path.join(SRC, 'project.json') + ' 即可。');
}

try { main(); } catch (e) {
    console.error('✖ 出错：' + (e && e.message ? e.message : e));
    process.exit(1);
}
