# WhiteSoft 桌面端（Go）

一个 Go 程序就是整个白板：仓库里的网页界面（`public/`）在编译时**嵌进二进制**，
由 Go 内置的 HTTP 服务在 `127.0.0.1` 上托管，再用 WebView2 开一个原生窗口。
**不需要 Node.js，也不需要 `server.mjs`**，编译产物是一个可直接双击的 `.exe`。

```powershell
cd desktop
powershell -ExecutionPolicy Bypass -File .\build.ps1   # 同步网页资源 + 编译 whitesoft.exe
.\whitesoft                       # 打开窗口
.\whitesoft --port 9000           # 指定端口（默认 8787，被占用时自动顺延）
.\whitesoft serve                 # 只起本地服务，用浏览器打开打印出的地址
.\whitesoft --debug               # 打开开发者工具，排查界面问题
```

`build.ps1` 只是 `go generate` + `go build` 的包装（外加把资源同步进来）；
已经放宽过执行策略的机器可以直接 `.\build.ps1`。也可以手动来：

```powershell
go generate ./...                 # 把 public/ 镜像进 internal/webapp/web
go build -trimpath -o whitesoft.exe .
```

需要 Go 1.25+、CGO（Windows 上装 MinGW-w64 的 gcc）。运行需要 Microsoft Edge WebView2
运行时——Windows 10/11 一般自带；没有的话程序会明确告诉你，不会只留一个空白窗口。

## 结构

```
main.go                       命令行入口：默认开窗口，serve 子命令只起服务
internal/webapp/              内嵌网页界面（web/ 由 tools/copyweb 从 public/ 同步而来）
internal/server/              本地 HTTP 服务：托管界面 + /api/health，不做任何后端逻辑
internal/desktop/             窗口：WebView2 绑定，缺运行时给出明确错误
internal/notes/               只读解析 .note（ZIP + manifest + Pages/*.json）
tools/copyweb/                把 public/ 镜像进 internal/webapp/web（go:embed 不能跨包目录）
```

`internal/webapp/web/` 是生成物，不进版本库；第一次编译前要跑一次
`go generate ./...`（`build.ps1` 已经代劳）。

## 为什么还有一个本地 HTTP 服务

界面需要 `http://` 源：打开 / 原地写回 `.note` 用的是 File System Access API，
ES 模块和 PDF.js 的 worker 也都要安全上下文。Chromium 把 loopback 的 `http://` 视作安全上下文，
所以这里用 `127.0.0.1` 而不是 `file://`。它与 `server.mjs` 的区别在于：

- 进程内，不是子进程，`node` 完全不需要；
- 只托管内嵌的静态字节，不认识任何白板数据——`.note` 的读写仍然全部由界面
  对着用户自己的文件完成，服务端从不接触白板内容；
- 端口默认 8787，被占用时自动顺延，避免和同时开着的网页端撞车。

## 与旧版桌面端的区别

旧版只做「找到 node / 起 server.mjs / 开浏览器」，本版把服务和窗口都收进同一个二进制。
旧的终端管理器（go-tui，依赖 `server.mjs`）已移到仓库根目录的 `legacy-tui/`，
不再参与这里的构建。

## 测试

```powershell
go test ./...                     # 服务、健康检查、模块与 vendor、Range、越权路径、端口顺延
node test/godesk-test.mjs http://127.0.0.1:8787/   # 真机界面冒烟：启动、画笔+Tab 换色、
                                                   # 空闲自动保存、.note 往返、PDF.js/MathJax/fflate
node test/window-test.mjs 8830 .\whitesoft.exe     # 真窗口：WebView2 里确实渲染了界面并能落笔
```

后两个需要 Chrome（走 CDP 驱动）。
