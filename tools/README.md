# tools —— 开发期脚本

工程**根目录只放运行时文件**：`index.html` / `we-glue.js` / `we-glue.css` / `project.json` /
`CustomFont*.ttf` / `preview.jpg`。这里的脚本都不参与壁纸运行，删掉也不影响播放。

> 这些脚本会在**工程根目录**写临时文件（`_render.html`、`_shot.png` 等），用完随手删。
> 需要 Node 18+；渲染类脚本需要本机有 Edge / Chrome。
> ⚠ 渲染类脚本要用 Chromium 的命名管道，必须在**非沙箱**（完全权限）下运行。

## 目录

| 目录 | 用途 | 脚本 |
|---|---|---|
| `build/` | 生成工程产物 | `build.js` —— 由 `../lyrics.html` 生成 `index.html`（源文件已不存在，保留备用） |
| `render/` | 把页面渲染成图 | `make-preview.js` —— 无头 Edge + CDP 生成 `preview.jpg`；`render-shot.js` —— 一次性截图，不依赖 CDP（本机 CDP WebSocket 收不到回帧时用这个） |
| `setup/` | 环境类（都已停用，保留备用） | `install-to-we.js` —— 整包复制到 WE 目录；`scan-fonts.js` —— 扫系统字体写进 `project.json` |
| `probes/` | 自测 / 诊断（只读工程，自己起临时服务器） | 见下表 |

## 自测脚本（probes/）

每个脚本都是"起一个临时服务器 → 用无头浏览器打开工程（用桩数据顶掉 LX 接口）→ 量指标 → 打印结论"，可以随时回归。

| 脚本 | 检查什么 |
|---|---|
| `probe.js` | 布局量测：左右分栏尺寸、封面大小、各段间距、元素位置/字号/层级 |
| `probe-flip.js` | 封面翻页：转完以后卡片是否回到正位（`transform: none`）、封面是否还在 |
| `probe-strike.js` | 唱完那行的"划掉"线：是否从 0 划到 1、线宽是否等于文字宽、拖进度条时不划线 |
| `probe-lyrics.js` | 歌词：焦点行左缘对齐、空歌词清空、快速切歌时的视觉跳变 |
| `probe-scroll.js` | 换句居中：快速换句时焦点行能否收敛到居中；最后一句是否保持高亮 |
| `probe-empty.js` | 空/单句歌词：单句「纯音乐，请欣赏」是否被误判、"没有歌词"是否闪烁 |
| `probe-bars.js` | 滑条：进度条能否拖动、音量条拖动时是否实时下发 `/volume` |

## 常用命令

```bash
# 量一遍布局
node tools/probes/probe.js 1920 1080

# 回归歌词相关
node tools/probes/probe-lyrics.js
node tools/probes/probe-scroll.js
node tools/probes/probe-empty.js

# 回归控件与封面
node tools/probes/probe-bars.js
node tools/probes/probe-flip.js
node tools/probes/probe-strike.js

# 截一张图（不覆盖 preview.jpg）
node tools/render/render-shot.js 1920 1080
```

## 注意

- `make-preview.js` 会**覆盖** `preview.jpg`（作者的缩略图），不要随手跑。
- `build.js` 依赖 `../lyrics.html`（工程外），该文件已不存在：运行会直接报"找不到源文件"后退出，不会破坏 `index.html`。
- `install-to-we.js` / `scan-fonts.js` 默认拒绝执行（防止误操作克隆出第二个工程 / 重写字体下拉），确实要用请加 `--i-am-sure`。
