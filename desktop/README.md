# WhiteSoft 桌面端，Go 实现

一个 Go 程序就是整个白板：仓库里的网页界面 `public/` 在编译时**嵌进二进制**，
由 Go 内置的 HTTP 服务在 `127.0.0.1` 上托管，再用 WebView2 开一个原生窗口。
**不需要 Node.js，也不需要 `server.mjs`**，编译产物是一个可直接双击的 `.exe`。

界面本身是同一个网页界面，所以桌面端具备网页端的全部能力：编辑器式的顶部菜单栏、
多白板标签、文件打开与保存、设置，以及底部的绘图工具栏。

## 编译与运行

```powershell
cd desktop
powershell -ExecutionPolicy Bypass -File .\build.ps1   # 同步网页资源并编译 whitesoft.exe
.\whitesoft                       # 打开窗口
.\whitesoft --port 9000           # 指定端口，默认 8787，被占用时自动顺延
.\whitesoft serve                 # 只起本地服务，用浏览器打开打印出的地址
.\whitesoft --debug               # 打开开发者工具
.\whitesoft --version             # 版本与 WebView2 版本
```

编译需要 Go 1.25+ 与 CGO，Windows 上要装 MinGW-w64 的 gcc，嵌入图标与资源还需要同套的 windres。

`build.ps1 -Console` 产出带控制台的版本，方便直接看输出。

## 资源占用

实测值，机器不同会有浮动：

| 项目 | 占用 |
|---|---|
| 可执行文件 | 12.4 MB，其中内嵌网页界面 6 MB，PDF.js 3.5 MB、MathJax 2 MB |
| 主进程内存 | 约 74 MB |
| WebView2 引擎 | 约 560 MB，六个子进程 |
| 磁盘缓存 | 上限 32 MB，可在任何时候删除 |

占用的大头是 WebView2 自带的 Chromium 内核，这是用原生窗口换来的成本。已经做的收敛：

- 编译去掉调试符号，12.4 MB 而非 20 MB；
- 磁盘缓存限制在 32 MB，默认可能是数百 MB；
- 关掉后台网络请求、组件更新与账户同步，空闲时不做无谓的磁盘和网络动作；
- 引擎按站点复用渲染进程，只有一个页面时不再多开；
- 不再周期性写日志，空闲时磁盘零写入。

**如果只想要最小的开销，用网页端** `whitesoft.bat`：界面代码完全相同，
浏览器你已经开着，不会多出一个 Chromium 实例。

## 数据目录

程序自己的数据只有一个 WebView2 配置目录，按顺序试几个位置，第一个能真正写入的才用：

1. `%LOCALAPPDATA%\WhiteSoft\WebView2`
2. `%TEMP%\WhiteSoft\WebView2`
3. `%APPDATA%\WhiteSoft\WebView2`
4. 程序旁边的 `WhiteSoftData`

每一处都会实写一个探针文件再删掉，因为「目录存在」不等于「能写进去」。
想自己指定就加 `--data-dir`，或者设环境变量 `WHITESOFT_DATA_DIR`：

```powershell
.\whitesoft --data-dir D:\WhiteSoftData
```

这个目录只放缓存、Cookie 与着色器缓存，**白板本身存在你自己的 `.note` 文件里，删掉不会丢内容**。
换过权限级别之后如果窗口打不开，删掉它重来一次即可。

## 权限级别

WebView2 的配置目录与创建它的进程绑定在同一个权限级别上。用管理员权限跑过一次之后，
再用普通权限启动就会用不了那份数据，表现为窗口打不开或一片空白。两种情况选一种，别混着用：

- 一直用普通权限；
- 一直用管理员权限，右键程序选「以管理员身份运行」。

程序发现引擎起不来时会自动删掉旧目录、换新目录重试一次；仍不行就改用浏览器打开同一个界面。

## 结构

```
main.go                       命令行入口：默认开窗口，serve 子命令只起服务
internal/webapp/              内嵌网页界面，web/ 由 tools/copyweb 从 public/ 同步而来
internal/server/              本地 HTTP 服务：托管界面与 /api/health，不做任何后端逻辑
internal/desktop/             窗口与系统交互：WebView2 绑定、错误对话框、控制台挂接
tools/copyweb/                把 public/ 镜像进 internal/webapp/web，go:embed 不能跨包目录
tools/patch-webview/          给本地副本补上空指针保护与就绪查询
winres/                       图标、版本信息与应用清单，由 windres 编译进 exe
third_party/webview_go/       窗口绑定库的本地副本，见下
```

`internal/webapp/web/` 与 `app_windows_amd64.syso` 是生成物，不进版本库。

## 关于 third_party/webview_go

`third_party/webview_go` 是窗口绑定库的本地副本，`go.mod` 用 `replace` 指向它。
直接引用上游会在引擎启动失败时崩溃：上游的 `navigate` 直接解引用 `m_webview` 而不判空，
Windows 上表现为 `Exception 0xc0000005`，进程在一秒内消失。

本地副本补了两件事：

- `navigate`、`init`、`eval`、`set_html` 调用前判空，失败时变成空操作而不是崩溃；
- 新增 `webview_engine_ready` 与 `EngineReady()`，让程序能区分引擎是否真的起来了。

补丁由 `tools/patch-webview` 施加，`build.ps1` 每次构建都会跑一遍，重复执行没有副作用。

## 双击没反应时

1. 右键程序选「以管理员身份运行」，看看是否只是权限级别不一致。
2. 删掉 `%LOCALAPPDATA%\WhiteSoft` 再启动。
3. 用 `.\whitesoft serve` 起服务，浏览器打开打印出的地址，功能完全一样。

## 被杀毒软件拦截时

Windows Defender 等产品可能把刚编译出来的 `whitesoft.exe` 判成威胁并删除或阻止运行。
这是误报：这是一个没有代码签名、没有下载量的新二进制，会拉起 `msedgewebview2.exe` 子进程
并监听本地端口，容易被启发式规则命中。

1. 在「保护历史记录」里恢复文件，并给所在目录加排除：

   ```powershell
   Add-MpPreference -ExclusionPath "D:\Workspace\WhiteSoft\desktop"
   ```

2. 到 <https://www.microsoft.com/en-us/wdsi/filesubmission> 提交误报。
3. 用 `build.ps1 -NoStrip` 换一个不剥符号的形态试试，文件会大 7 MB 左右。
4. 用 `build.ps1 -Sign <证书指纹>` 做代码签名，这是根治「未知发布者」提示的办法。

## 测试

```powershell
go test ./...                     # 服务、健康检查、模块与 vendor、Range、越权路径、端口顺延
node test/godesk-test.mjs http://127.0.0.1:8787/   # 界面冒烟
node test/shell-test.mjs http://127.0.0.1:8787/    # 编辑器外壳：菜单栏、标签栏、多白板
node test/opentab-test.mjs http://127.0.0.1:8787/  # 打开 .note 落在新标签
node test/patch-test.mjs http://127.0.0.1:8787/    # 局部重绘与整页重绘像素一致
node test/perf-real.mjs http://127.0.0.1:8787/     # 落笔开销
node test/window-test.mjs 8830 .\whitesoft.exe 9333  # 真窗口，需要可交互的桌面会话
```

除 `go test` 之外都需要 Chrome，通过 CDP 驱动。
