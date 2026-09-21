/* ============================================================================
 *  Lyrics · Wallpaper Engine 选项桥  (we-glue.js)
 *  ---------------------------------------------------------------------------
 *  这个脚本在 lyrics.html 自身脚本「之前」加载（放在 <head> 末尾），做两件事：
 *
 *    ① 把壁纸引擎的用户属性翻译成 CSS 变量 —— 视觉部分全部由 we-glue.css 消费；
 *    ② 打三处 CSS 管不到的补丁：
 *         · API 地址（原代码里是常量，这里用 fetch / EventSource 代理改写）
 *         · 背景律动强度（原代码每帧写行内 opacity，只能包一层壳来调）
 *         · 音频律动（壁纸引擎独有的能力，原页面没有）
 *
 *  全都有默认值，而且默认值等于原表现；直接双击 index.html 在普通浏览器里
 *  打开也能跑（此时壁纸引擎的 API 不存在，一切保持原样）。
 * ========================================================================== */
(function () {
    'use strict';

    var root = document.documentElement;          /* <head> 阶段就存在，变量写在它身上 */
    var API_DEFAULT = 'http://127.0.0.1:23330';

    /* ========================================================================
     *  可调状态
     *  下面每个默认值 == lyrics.html 里的原始硬编码值。改了这里就等于改了默认。
     * ====================================================================== */
    var S = {
        /* 背景图片 */
        bgOn: true,
        bgFile: '',
        bgBright: 0.62, bgBlur: 2.5, bgSat: 1.06, bgContrast: 1,
        bgZoom: 1, bgPos: 'center', bgVig: 1,
        /* 氛围。pulse = 动态背景（专辑主色 + fBm 云雾）的律动强度；
           pulsePhoto = 有背景图时那块动态背景的可见度，默认 0 = 有照片就让位给它
           （照片本身已有明暗层次，再叠一层云雾会把画面搅浑、也抢歌词的视觉焦点）。
           想留一点氛围时把它调上去即可。 */
        pulse: 1, pulsePhoto: 0, audio: 0, bgDebug: false,
        /* 这两个颜色不是随手挑的：它们是原样式里 rgb(200,220,255) 和
           rgb(140,200,255) 反算成 0~1 小数的结果。写成 0.78/0.86/0.55/0.82
           这类"看着差不多"的值，四舍五入后会差 1 个色阶，
           「不调任何选项」时的渲染就和原版对不上了。 */
        artOn: true, artOpacity: 1, artColor: '0.7843 0.8627 1',
        /* 歌词 */
        lyricScale: 1, activeScale: 2, dimK: 1,
        align: 'center', padX: null, lineHeight: null,
        /* 字体：一套设置同时管「歌词」和「天际屏背景字」，由 fontTarget 决定作用范围 */
        fontFamily: 'system', fontCustom: '', fontTarget: 'both', fontFile: '',
        sweep: true, charDim: 0.28, glow: 1, gapOn: true,
        /* 翻译歌词：默认值 == 源 CSS 里的硬编码值（0.52 / 0.72 / 白） */
        transOn: true, transScale: 0.3, transOpacity: 0.85, transColor: '1 1 1',
        /* 播放控件 */
        uiScale: 1, lift: 0,
        glassBlur: 24, glassSat: 1.85, glassBright: 1.06, glassRadius: 26,
        sheen: true, dimOn: true, dimOp: 0.42,
        chipOn: true, volumeOn: true, collectOn: true,
        /* 连接 */
        host: '127.0.0.1', port: '23330',
        /* 主题 */
        accent: '0.549 0.7843 1'
    };

    /* ========================================================================
     *  小工具
     * ====================================================================== */

    function setVar(name, value) {
        root.style.setProperty(name, value);
    }

    function num(v, dflt) {
        var n = parseFloat(v);
        return isFinite(n) ? n : dflt;
    }

    /* 壁纸引擎的 color 属性是 "r g b"，三个 0~1 的浮点 */
    function rgbOf(spec) {
        if (typeof spec !== 'string') return null;
        var p = spec.trim().split(/[\s,]+/).map(parseFloat);
        if (p.length < 3 || !p.slice(0, 3).every(isFinite)) return null;
        return p.slice(0, 3).map(function (x) {
            return Math.round(Math.max(0, Math.min(1, x)) * 255);
        });
    }

    function rgba(spec, alpha) {
        var c = rgbOf(spec);
        if (!c) return null;
        return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + alpha + ')';
    }

    /* 往白里调一点，用来做「外圈光晕」的亮色 */
    function lighter(spec, k) {
        var c = rgbOf(spec);
        if (!c) return null;
        return 'rgba(' + c.map(function (x) {
            return Math.round(x + (255 - x) * k);
        }).join(',') + ',';
    }

    /* 按通道各乘一个系数（截住 0~255），用来从一个基色派生出「更深 / 更沉」的同族色。
       返回的字符串以 ", " 结尾且不带 alpha，方便调用方自己接上。 */
    function tint(spec, factors) {
        var c = rgbOf(spec);
        if (!c) return null;
        return 'rgba(' + c.map(function (x, i) {
            return Math.round(Math.max(0, Math.min(255, x * factors[i])));
        }).join(',') + ',';
    }

    /* ========================================================================
     *  ① API 地址改写
     *  lyrics.html 把基址写死成 'http://127.0.0.1:23330'，所有接口 URL 都由它拼出。
     *  与其改源码，不如在 fetch / EventSource 入口把前缀换掉 —— 一处生效，处处生效。
     *  （壁纸引擎的网页壁纸宿主带 --disable-web-security，file:// 下也能直连 localhost）
     * ====================================================================== */

    var usedNativeES = window.EventSource;

    /* ------------------------------------------------------------------------
     *  地址改写的「先有鸡还是先有蛋」
     *  壁纸引擎是先让页面加载、后下发用户属性。如果用户把 API 地址改成别的，
     *  属性到达时页面的第一次 /lyric-all 已经发出去了 —— 那一次必然打在老地址上。
     *  更糟的是：重载后属性恢复成 project.json 里的默认值，引擎再下发一次自定义
     *  地址，又会触发一次重载 —— 无限刷。
     *
     *  办法：把「用户选定的地址」写进 URL 的 hash（重载后还在，且普通浏览器、
     *  file:// 下都可用）。本脚本在原始脚本之前执行，先从 hash 里读回来，
     *  于是第一帧就用对地址；再拿它当作「已经生效过」的凭据，值没变就不再重载。
     * ---------------------------------------------------------------------- */
    function apiToken() { return String(S.host) + '|' + String(S.port); }

    function readApiHash() {
        var m = /(?:^|[#&])weapi=([^&]*)/.exec(location.hash || '');
        if (!m) return null;
        var parts = decodeURIComponent(m[1]).split('|');
        return { host: parts[0] || '', port: parts.length > 1 ? parts[1] : '' };
    }

    /* 记下「本次加载生效的地址」，只有真正变了才重载 */
    var apiTokenAtLoad = null;
    (function seedFromHash() {
        var seed = readApiHash();
        if (!seed) return;
        S.host = seed.host;
        S.port = seed.port;
        apiTokenAtLoad = apiToken();
    })();

    function baseUrl() {
        var host = String(S.host || '127.0.0.1').trim() || '127.0.0.1';
        var port = String(S.port || '').trim();
        if (/^https?:\/\//i.test(host)) return host.replace(/\/+$/, '');   /* 允许直接填完整地址 */
        return 'http://' + host + (port ? ':' + port : '');
    }

    function rewrite(url) {
        var s = String(url);
        if (s.indexOf(API_DEFAULT) !== 0) return s;
        var base = baseUrl();
        return base === API_DEFAULT ? s : base + s.slice(API_DEFAULT.length);
    }

    var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
    if (nativeFetch) {
        window.fetch = function (input, init) {
            if (typeof input === 'string') return nativeFetch(rewrite(input), init);
            if (input && typeof input.url === 'string') {
                var u = rewrite(input.url);
                if (u !== input.url) return nativeFetch(new Request(u, input), init);
            }
            return nativeFetch(input, init);
        };
    }

    if (usedNativeES) {
        var PatchedES = function (url, config) { return new usedNativeES(rewrite(url), config); };
        PatchedES.prototype = usedNativeES.prototype;
        PatchedES.CONNECTING = 0;
        PatchedES.OPEN = 1;
        PatchedES.CLOSED = 2;
        window.EventSource = PatchedES;
    }

    /* ========================================================================
     *  ② 背景律动强度 / 动态背景可见度
     *  源页面已经不再有「同心圆呼吸层」，改成了一块 WebGL 的 fBm 云雾背景
     *  （.bg-shader）。它的律动幅度由源页面 JS 读 CSS 变量 --bg-beat-k 决定，
     *  可见度由 --bg-shader-op 决定 —— 两者都能直接被样式表覆盖，
     *  所以这里不再需要「包一层壳改 opacity」那套。
     * ====================================================================== */

    function syncPulse() {
        /* 律动强度（乘在音乐能量上：越大，云雾随歌起伏得越明显） */
        setVar('--we-pulse', S.pulse.toFixed(4));
        /* 有背景图时动态背景的可见度：默认 0 = 让位给照片；
           调上去就变成「照片 + 云雾叠加」。 */
        setVar('--we-shader-photo', S.pulsePhoto.toFixed(4));
    }

    /* ========================================================================
     *  ③ 音频律动（壁纸引擎的音频捕获）
     * ====================================================================== */

    var audioEl = null, audioRAF = 0, level = 0, spectrum = null;
    var bassPeak = 0.02;                 /* 自适应增益的"这首歌的响度"参考值 */
    var spectrumAt = 0;                  /* 最近一次收到频谱的时间戳（判"数据是否还新鲜"） */

    function audioEnergy(a) {
        if (!a || !a.length) return 0;
        var n = a.length >= 128 ? 32 : Math.min(16, a.length);   /* 低频段最像「鼓点」 */
        var s = 0;
        for (var i = 0; i < n; i++) s += a[i] || 0;
        return s / n;
    }

    function audioTick() {
        var raw = 0;
        /* 数据"新鲜"才认：壁纸引擎停掉音频后不会再回调，但 spectrum 变量还留着
           最后一次的数组 —— 不判新鲜度的话 level 会**冻在**最后一个值上，
           画面就一直停在"高潮"状态（暂停/切歌时能明显看出来）。 */
        var fresh = !!spectrum && (performance.now() - spectrumAt < 250);
        if (fresh) {
            raw = audioEnergy(spectrum);
            /* 自适应增益：背景跟的是低频的**起伏**，而壁纸引擎给的频谱量纲并不保证是
               0~1（不同版本/设备可能是 0~255，也可能整首歌都只有 0.0x）。
               固定乘一个系数的话，量纲大的会被钳在满值（看起来"压根没跟低频动"）、
               量纲小的几乎不动。这里用「近期峰值」归一化：
                 · 峰值上得稍快、落得**很慢**（τ ≈ 20 秒）—— 参考的是"这首歌整体有多响"，
                   而不是"上一帧/最近几秒有多响"。落得快会把安静段落也顶到满值，
                   结果就是安静的段落照样满屏在动（这不符合 Apple Music 那种克制）；
                 · raw / 峰值 → 无论量纲多大，鼓点一到都推到接近 1，安静段落自然回落。
               结果是一条与量纲无关的 0~1 曲线，跟的就是低频的强弱变化。 */
            if (raw > bassPeak) bassPeak += (raw - bassPeak) * 0.25;
            else bassPeak += (raw - bassPeak) * 0.0008;
            if (bassPeak < 0.008) bassPeak = 0.008;
            var norm = Math.min(1, raw / bassPeak);
            /* 弹道要「钝」。Apple Music 那块背景跟的是音乐的**能量包络**
               （时间尺度约 0.2~0.5 秒），不是逐帧瞬态。
               之前 0.55 / 0.10 的跟随几乎一帧就到，叠到画面上就是"闪眼睛"。
               现在 τ_attack ≈ 10 帧（≈0.17s）、τ_release ≈ 22 帧（≈0.37s）。 */
            level += (norm - level) * (norm > level ? 0.10 : 0.045);
        } else {
            /* 平滑落回 0（一阶指数，τ ≈ 0.27s），不要 *=0.9 那种陡降 */
            level += (0 - level) * 0.06;
        }
        /* 只做"看不见"的归零：这里的台阶在 0.4%~0 之间，不是突变 */
        if (level < 0.004) level = 0;

        /* 低频能量交给源页面的背景着色器：lyrics.html 每帧读 window.__weBass，
           用它决定背景流动的快慢与亮度起伏。这一条不受 S.audio 影响 ——
           背景跟低频是既定行为，「音频律动光晕」才是那个可选的光晕层。
           另外两个是排查用的观测值（源页面的"低频调试表"会显示）。 */
        window.__weBass = level;
        window.__weBassRaw = raw;
        window.__weBassPeak = bassPeak;

        /* --we-audio 与光晕的缩放只服务于可选的「音频律动光晕」 */
        if (S.audio > 0) {
            setVar('--we-audio', level.toFixed(4));
            if (audioEl) audioEl.style.transform = 'scale(' + (1 + level * 0.10).toFixed(4) + ')';
        }

        audioRAF = requestAnimationFrame(audioTick);
    }

    function startAudioLoop() {
        if (audioRAF) return;
        audioRAF = requestAnimationFrame(audioTick);
    }

    function makeAudioLayer() {
        var stage = document.getElementById('lyricStage');
        if (!stage || audioEl) return;
        audioEl = document.createElement('div');
        audioEl.className = 'we-audio-glow';
        audioEl.setAttribute('aria-hidden', 'true');
        /* 插在律动壳之后：同层里靠 DOM 顺序压在照片与律动之上、天际屏之下 */
        stage.insertBefore(audioEl, stage.children[2] || null);
    }

    /* ========================================================================
     *  背景图片
     *  工程自带 backpicture.jpg；用户可以：
     *    · 关掉（bg_enable = false）→ 回到默认深色渐变
     *    · 换成自己的图（bg_file 非空）→ 读不到就自动退回自带的
     * ====================================================================== */

    var photoRetry = 0;

    function photoUrl() {
        if (!S.bgFile) return 'backpicture.jpg';
        var f = String(S.bgFile).trim();
        if (/^(https?|file|data):/i.test(f)) return f;
        f = f.replace(/\\/g, '/');
        if (/^[a-zA-Z]:\//.test(f)) return 'file:///' + f;   /* C:/Users/... */
        if (f.indexOf('//') === 0) return 'file:' + f;        /* \\server\share → UNC */
        return f;                                             /* 工程内相对路径 */
    }

    function syncPhoto() {
        var el = document.getElementById('bgPhoto');
        var stage = document.getElementById('lyricStage');
        if (!el) return;

        if (!S.bgOn) {
            el.classList.remove('ready');
            el.style.opacity = '0';                 /* 行内样式，压得住 .ready */
            if (stage) stage.classList.remove('has-photo');
            syncPulse();
            return;
        }

        var url = photoUrl();
        el.style.opacity = '';
        if (el.getAttribute('data-we-url') === url) {
            /* 这张图之前已经加载成功过（onload 里盖的章），不用再探一次。
               但「显示」这件事必须补回来 —— 关掉背景图时摘了 .ready，
               再打开时如果在这里直接 return，图层就永远停在 opacity:0 了。 */
            el.classList.add('ready');
            if (stage) stage.classList.add('has-photo');
            return;
        }

        var probe = new Image();
        probe.onload = function () {
            el.setAttribute('data-we-url', url);
            el.style.backgroundImage = 'url("' + url + '")';
            requestAnimationFrame(function () {
                el.classList.add('ready');
                if (stage) stage.classList.add('has-photo');
            });
        };
        probe.onerror = function () {
            if (url !== 'backpicture.jpg') {
                console.info('[lyrics-we] 自定义背景图读取失败，退回工程自带的 backpicture.jpg');
                S.bgFile = '';
                syncPhoto();
                return;
            }
            el.classList.remove('ready');
            el.style.opacity = '0';
            if (stage) stage.classList.remove('has-photo');
            console.info('[lyrics-we] 读取不到 backpicture.jpg，保持默认背景');
        };
        probe.src = url;
    }

    /* ========================================================================
     *  字体
     *  「跟随原样式」= 一个变量都不写，CSS 里 var() 的兜底值 inherit 生效，
     *  于是与原版逐项一致。选定字体后，选中的族挂在最前，
     *  后面永远拖着原页面的 body 字体栈 —— 这样缺字（音符符号、emoji、
     *  生僻字）时的兜底行为不变，字形覆盖只增不减。
     * ====================================================================== */

    var FONT_TAIL = 'system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
    var GENERIC = { 'system-ui': 1, 'sans-serif': 1, 'serif': 1, 'monospace': 1, 'cursive': 1, 'fantasy': 1 };
    var FACE_FAMILY = 'WE 自定义字体';
    var faceOn = false;

    /* 用户可能填出任意字符串。引号 / 反斜杠 / 分号 / 花括号会把整条 CSS 声明
       弄坏，一律去掉；控制字符换成空格。keepComma 为真时保留逗号（用户自己写的整栈）。 */
    function cleanFont(s, keepComma) {
        s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ');
        s = s.replace(/[\\"'{}();]/g, '');
        if (!keepComma) s = s.replace(/,/g, ' ');
        return s.replace(/\s+/g, ' ').trim();
    }

    /* 单个族名 → CSS 片段。通用族（sans-serif 之类）不能加引号。 */
    function quoteFamily(name) {
        var n = cleanFont(name, false);
        if (!n) return '';
        return GENERIC[n.toLowerCase()] ? n.toLowerCase() : '"' + n + '"';
    }

    /* 自定义字体文件 → 可以在 CSS 里引用的 URL */
    function faceUrl(p) {
        p = String(p == null ? '' : p).trim();
        if (!p) return '';
        if (/^(data:|blob:|https?:|file:)/i.test(p)) return p;
        var s = p.replace(/\\/g, '/');
        if (/^[A-Za-z]:\//.test(s)) return 'file:///' + encodeURI(s);      /* 绝对路径 */
        if (s.charAt(0) === '/') return 'file://' + encodeURI(s);
        /* 相对路径按「工程根目录」解析（index.html 就在那儿） */
        return s.split('/').map(encodeURIComponent).join('/');
    }

    /* 把 @font-face 挂上 / 摘掉。只在路径变了才动 DOM。 */
    function syncFace() {
        var url = faceUrl(S.fontFile);
        var el = document.getElementById('we-font-face');
        if (!url) {
            if (el && el.parentNode) el.parentNode.removeChild(el);
            faceOn = false;
            return;
        }
        if (!el) {
            el = document.createElement('style');
            el.id = 'we-font-face';
            (document.head || root).appendChild(el);
        }
        /* font-display:swap —— 字体没加载完时先用兜底字体画，不要白屏等 */
        var css = '@font-face{font-family:"' + FACE_FAMILY + '";src:url("' + url + '");font-display:swap}';
        if (el.textContent !== css) el.textContent = css;
        faceOn = true;
    }

    /* 算出最终的 font-family 栈；返回空串 = 不改变字体 */
    function fontStack() {
        var head = '';
        var custom = cleanFont(S.fontCustom, true);
        if (custom) {
            /* 带逗号 = 用户自己写了一整套，逐段规整后保持他写的顺序 */
            head = custom.indexOf(',') >= 0
                ? custom.split(',').map(quoteFamily).filter(Boolean).join(', ')
                : quoteFamily(custom);
        } else if (S.fontFamily && S.fontFamily !== 'system') {
            head = quoteFamily(S.fontFamily);
        }
        var parts = [];
        if (faceOn) parts.push('"' + FACE_FAMILY + '"');
        if (head) parts.push(head);
        if (!parts.length) return '';
        parts.push(FONT_TAIL);
        return parts.join(', ');
    }

    function apply() {
        /* ---- 背景图 ---- */
        /* 整串 filter 一起拼：对比度为 1 时省掉那一项，默认外观就和原版一模一样。
           单独拆成 blur/bright/sat/contrast 四个变量的话，计算值里会永远挂着
           一个等价但多余的 contrast(1)。 */
        var bf = 'blur(' + S.bgBlur + 'px)' +
                 ' brightness(' + S.bgBright + ')' +
                 ' saturate(' + S.bgSat + ')';
        if (S.bgContrast !== 1) bf += ' contrast(' + S.bgContrast + ')';
        setVar('--we-bg-filter', bf);
        setVar('--we-bg-zoom', String(S.bgZoom));
        setVar('--we-bg-pos', S.bgPos);
        setVar('--we-vig', String(S.bgVig));

        /* ---- 氛围 ---- */
        syncPulse();
        /* 低频调试表（默认关）。用 HTML 属性而不是 CSS 变量 —— display 没法由变量驱动。 */
        var dbgStage = document.getElementById('lyricStage');
        if (dbgStage) dbgStage.setAttribute('data-bg-debug', S.bgDebug ? '1' : '0');
        setVar('--we-art-op', String(S.artOpacity));
        var artC = rgba(S.artColor, 0.5);
        if (artC) {
            setVar('--we-art-c', artC);
            setVar('--we-art-note-c', rgba(S.artColor, 0.66));
        }

        /* ---- 歌词 ---- */
        setVar('--we-lyric-scale', String(S.lyricScale));
        setVar('--we-active-scale', String(S.activeScale));
        setVar('--we-dim-k', String(S.dimK));
        var pos = S.align === 'left' ? ['flex-start', 'left']
                : S.align === 'right' ? ['flex-end', 'right']
                : ['center', 'center'];
        setVar('--we-lyric-align', pos[0]);
        setVar('--we-text-align', pos[1]);
        if (S.padX === null) root.style.removeProperty('--we-pad-x');
        else setVar('--we-pad-x', S.padX + '%');
        if (S.lineHeight === null) root.style.removeProperty('--we-lh');
        else setVar('--we-lh', String(S.lineHeight));
        /* ---- 字体（歌词 / 天际屏，作用范围由 fontTarget 决定） ---- */
        syncFace();
        var stack = fontStack();
        if (stack && S.fontTarget !== 'art') setVar('--we-font', stack);
        else root.style.removeProperty('--we-font');
        if (stack && S.fontTarget !== 'lyric') setVar('--we-font-art', stack);
        else root.style.removeProperty('--we-font-art');
        setVar('--we-char-dim', 'rgba(255,255,255,' + S.charDim.toFixed(3) + ')');

        /* 光晕：强度是倍数，0 时整组关掉。
         *
         * 原样式里「当前字」有三层蓝，各是各的颜色 + 透明度：
         *     基础  rgba(140, 200, 255, 0.5)    6px
         *     已唱  rgba(140, 200, 255, 0.55)   8px
         *     在唱  rgba(160, 210, 255, 0.85)  12px  +  rgba(100, 160, 255, 0.5) 24px
         * 要跟着「强调色」走，就得把这三层写成强调色的线性变形，
         * 而且默认强调色（140,200,255）下必须还原成一模一样的值 ——
         * 三个系数就是从这组原值反解出来的：
         *     往白提 17.4%   → 140→160、200→210（内层那层亮蓝）
         *     通道乘 0.714/0.8/1 → 140→100、200→160、255→255（外层那层沉蓝）
         * 换成别的强调色时，三层仍然保持「基础 / 更亮 / 更沉」的相对关系。 */
        var px = function (v) { return String(Math.round(v * 100) / 100) + 'px'; };
        var g1 = 6 * S.glow, g2 = 12 * S.glow;
        setVar('--we-glow1', px(g1));
        setVar('--we-glow2', px(g2));
        var cBase = rgba(S.accent, 0.5);
        if (cBase) setVar('--we-glow-c', cBase);
        var cSung = rgba(S.accent, 0.55);
        if (cSung) setVar('--we-glow-c-sung', cSung);
        var cSing = lighter(S.accent, 0.174);
        if (cSing) setVar('--we-glow-c2', cSing + '0.85)');
        var cHalo = tint(S.accent, [0.7143, 0.8, 1]);
        if (cHalo) setVar('--we-glow-c3', cHalo + '0.5)');
        var aGlow = rgba(S.accent, 0.9);
        if (aGlow) setVar('--we-audio-c', aGlow);

        /* ---- 翻译歌词 ---- */
        setVar('--we-trans-scale', S.transScale + 'em');
        var trC = rgba(S.transColor, S.transOpacity);
        if (trC) setVar('--we-trans-c', trC);

        /* ---- 播放控件 ---- */
        setVar('--we-ui-scale', String(S.uiScale));
        setVar('--we-lift', S.lift + 'px');
        setVar('--we-glass-blur', S.glassBlur + 'px');
        setVar('--we-glass-sat', String(S.glassSat));
        setVar('--we-glass-bright', String(S.glassBright));
        setVar('--we-r-glass', S.glassRadius + 'px');
        setVar('--we-dim-op', String(S.dimOp));
        /* 状态小胶囊跟着玻璃走，但轻一档：原值 16px / 1.6 相对 24px / 1.85 的比例。
           在 JS 里算好再写，默认得到的就是精确的 16 / 1.6，不会因为 calc 的
           浮点误差变成 16.008px。 */
        setVar('--we-glass-blur-chip', (S.glassBlur * (16 / 24)).toFixed(3) + 'px');
        setVar('--we-glass-sat-chip', (S.glassSat * (1.6 / 1.85)).toFixed(4));
        /* 胶囊的「离开就淡下去」同样比玻璃本体深一档（原值 0.5 相对 0.42）。 */
        setVar('--we-dim-op-chip', (S.dimOp * (0.5 / 0.42)).toFixed(4));

        /* ---- 开关类 ---- */
        var cl = root.classList;
        cl.toggle('we-no-sweep', !S.sweep);
        cl.toggle('we-no-gap', !S.gapOn);
        cl.toggle('we-no-trans', !S.transOn);
        cl.toggle('we-no-art', !S.artOn);
        cl.toggle('we-no-glow', S.glow <= 0);
        cl.toggle('we-no-sheen', !S.sheen);
        cl.toggle('we-no-chip', !S.chipOn);
        cl.toggle('we-no-collect', !S.collectOn);
        cl.toggle('we-no-volume', !S.volumeOn);
        cl.toggle('we-no-dim', !S.dimOn);

        /* ---- 需要动 DOM 的部分 ---- */
        syncPhoto();
        if (S.audio > 0) startAudioLoop();

        /* 改过字号 / 行高 / 左右留白之后，每一行的高度和间距都变了，
           原先正中的那一行会偏出去（画面上看就是「当前这句不在中间了」）。
           原页面自己在 window 的 resize 里重建内边距、并把当前行重新滚回正中，
           所以这里「借」它一次：派发一个 resize。
           用 lyricList 是否存在来判断页面是否已经把歌词渲染出来，
           免得在 <head> 阶段白派发一轮。（页面内部对 resize 有自己的防抖，
           拖动滑条连发也不会抖。）

           为什么不是立刻派发：上面刚写完 CSS 变量，浏览器还没重排，
           此刻页面 handler 读到的 clientHeight / offsetTop 全是旧值，
           照旧值算出来的滚动目标自然偏。等两帧（第一帧提交样式、第二帧布局已更新）
           再派发，量到的就是新布局。 */
        if (document.getElementById('lyricList')) {
            requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                    window.dispatchEvent(new Event('resize'));
                });
            });
        }
    }

    /* ========================================================================
     *  壁纸引擎属性入口
     *  applyUserProperties 只在「值有变化」的键上出现，所以逐项 if（官方要求这么写），
     *  最后统一 apply()。首次加载时壁纸引擎会把所有属性一次性发过来。
     * ====================================================================== */

    var pct = function (v, dflt) { return num(v, dflt) / 100; };

    window.wallpaperPropertyListener = {
        applyUserProperties: function (p) {
            var apiChanged = false;

            /* ---- 背景图片 ---- */
            if (p.bg_enable) S.bgOn = !!p.bg_enable.value;
            if (p.bg_file) S.bgFile = p.bg_file.value || '';
            if (p.bg_bright) S.bgBright = num(p.bg_bright.value, S.bgBright);
            if (p.bg_blur) S.bgBlur = num(p.bg_blur.value, S.bgBlur);
            if (p.bg_sat) S.bgSat = num(p.bg_sat.value, S.bgSat);
            if (p.bg_contrast) S.bgContrast = num(p.bg_contrast.value, S.bgContrast);
            if (p.bg_zoom) S.bgZoom = num(p.bg_zoom.value, S.bgZoom);
            if (p.bg_pos) S.bgPos = String(p.bg_pos.value || 'center');
            if (p.bg_vig) S.bgVig = num(p.bg_vig.value, S.bgVig);

            /* ---- 氛围 ---- */
            if (p.pulse) S.pulse = pct(p.pulse.value, 100);
            if (p.pulse_photo) S.pulsePhoto = pct(p.pulse_photo.value, 0);
            if (p.audio_reactive) S.audio = pct(p.audio_reactive.value, 0);
            if (p.bg_debug) S.bgDebug = !!p.bg_debug.value;
            if (p.art_enable) S.artOn = !!p.art_enable.value;
            if (p.art_opacity) S.artOpacity = pct(p.art_opacity.value, 100);
            if (p.art_color) S.artColor = p.art_color.value;

            /* ---- 歌词 ---- */
            if (p.lyric_scale) S.lyricScale = num(p.lyric_scale.value, S.lyricScale);
            if (p.lyric_active_scale) S.activeScale = num(p.lyric_active_scale.value, S.activeScale);
            if (p.lyric_dim) S.dimK = num(p.lyric_dim.value, S.dimK);
            if (p.lyric_align) S.align = String(p.lyric_align.value || 'center');
            if (p.lyric_pad) S.padX = num(p.lyric_pad.value, 6);
            if (p.lyric_line_height) S.lineHeight = num(p.lyric_line_height.value, 1.5);
            if (p.font_family) S.fontFamily = String(p.font_family.value || 'system');
            if (p.font_custom) S.fontCustom = String(p.font_custom.value || '');
            if (p.font_target) S.fontTarget = String(p.font_target.value || 'both');
            if (p.font_file) S.fontFile = String(p.font_file.value || '');
            if (p.lyric_sweep) S.sweep = !!p.lyric_sweep.value;
            if (p.lyric_char_dim) S.charDim = pct(p.lyric_char_dim.value, 28);
            if (p.lyric_glow) S.glow = pct(p.lyric_glow.value, 100);
            if (p.lyric_gap) S.gapOn = !!p.lyric_gap.value;

            /* ---- 翻译歌词 ---- */
            if (p.trans_enable) S.transOn = !!p.trans_enable.value;
            if (p.trans_scale) S.transScale = num(p.trans_scale.value, S.transScale);
            if (p.trans_opacity) S.transOpacity = num(p.trans_opacity.value, S.transOpacity);
            if (p.trans_color) S.transColor = p.trans_color.value;

            /* ---- 播放控件 ---- */
            if (p.ui_scale) S.uiScale = num(p.ui_scale.value, S.uiScale);
            if (p.ui_lift) S.lift = num(p.ui_lift.value, S.lift);
            if (p.glass_blur) S.glassBlur = num(p.glass_blur.value, S.glassBlur);
            if (p.glass_sat) S.glassSat = num(p.glass_sat.value, S.glassSat);
            if (p.glass_bright) S.glassBright = num(p.glass_bright.value, S.glassBright);
            if (p.glass_radius) S.glassRadius = num(p.glass_radius.value, S.glassRadius);
            if (p.glass_sheen) S.sheen = !!p.glass_sheen.value;
            if (p.dim_enable) S.dimOn = !!p.dim_enable.value;
            if (p.dim_opacity) S.dimOp = pct(p.dim_opacity.value, 42);
            if (p.show_chip) S.chipOn = !!p.show_chip.value;
            if (p.show_volume) S.volumeOn = !!p.show_volume.value;
            if (p.show_collect) S.collectOn = !!p.show_collect.value;

            /* ---- 连接：改地址要靠重载才会重新建立 SSE 长连接 ---- */
            if (p.api_host) {
                var h = String(p.api_host.value || '').trim() || '127.0.0.1';
                if (h !== S.host) { S.host = h; apiChanged = true; }
            }
            if (p.api_port) {
                var pt = String(p.api_port.value || '').trim() || '23330';
                if (pt !== S.port) { S.port = pt; apiChanged = true; }
            }

            /* ---- 主题 ---- */
            if (p.accent_color) S.accent = p.accent_color.value;

            apply();

            /* 地址确实变了才重载；把新地址写进 hash，重载后由 seedFromHash() 读回，
               这样第二帧起就用新地址，而且不会来回重载。 */
            if (apiChanged && apiToken() !== apiTokenAtLoad) {
                location.hash = 'weapi=' + encodeURIComponent(apiToken());
                location.reload();
            }
        },

        applyGeneralProperties: function () { /* 壁纸引擎的全局项（fps 等）暂不需要 */ }
    };

    /* 音频频谱：壁纸引擎独有的能力，普通浏览器里这个函数不存在，自动跳过。
       拿到就立刻开始采集 —— 背景要跟着低频走，不能等到用户把「音频律动光晕」
       那个可选项打开才开始采。 */
    if (typeof window.wallpaperRegisterAudioListener === 'function') {
        window.wallpaperRegisterAudioListener(function (a) {
            spectrum = a;
            spectrumAt = performance.now();      /* 打时间戳：audioTick 用它判数据是否还新鲜 */
        });
        startAudioLoop();
    }

    /* ========================================================================
     *  就绪
     *  脚本在 <head> 里执行，此时 body 还没有；变量可以立刻写，DOM 相关的等 DOMReady。
     * ====================================================================== */

    function domReady() {
        makeAudioLayer();
        apply();

        /* lyrics.html 自己的 initBackPicture() 也在这一轮跑，它会覆盖 backgroundImage。
         * 这里再补两次，保证「关掉背景图 / 换成自定义图」最终说了算。 */
        setTimeout(syncPhoto, 600);
        setTimeout(syncPhoto, 1600);

        if (typeof window.wallpaperPropertyListener === 'undefined') {
            console.info('[lyrics-we] 未检测到壁纸引擎属性接口，按默认外观运行' +
                         '（双击 index.html 预览时属于正常现象）');
        } else {
            console.info('[lyrics-we] 选项层已就绪');
        }
    }

    /* 先写一遍变量，避免首帧闪烁（此时还没有属性值，用的都是默认值） */
    apply();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', domReady);
    } else {
        domReady();
    }
})();
