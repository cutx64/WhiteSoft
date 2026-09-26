# WhiteSoft 桌面端（Go）

这是 WhiteSoft 的桌面外壳：一个 Go 程序，负责把项目自带的网页端跑起来，并额外提供一个
go-tui 终端管理器。白板本身仍然是 `public/` + `server.mjs`，这里**不重写**任何白板逻辑。

```bash
go build -o whitesoft .      # 需要 Go 1.24+ 与 Node.js 18+
./whitesoft                  # 启动服务 + 打开浏览器（不需要任何目录）
./whitesoft tui --root ~/boards   # 终端管理器：浏览哪个目录（默认仓库上一级）
```

完整说明（选项、按键、架构、测试）见仓库根目录的 [README](../README.md#桌面端go)。

## 结构

```
main.go                 命令行入口：默认桌面模式，tui 子命令进终端管理器
internal/notes/         只读解析 .note（ZIP + manifest + Pages/*.json）
internal/launcher/      找 node / 找 server.mjs / 挑空闲端口 / 起子进程 / 等健康检查 / 开浏览器
internal/tui/           go-tui 终端管理器（manager.gsx 模板 + 生成的 manager_gsx.go）
```

`manager_gsx.go` 由 go-tui 的 CLI 生成并已提交，普通构建不需要它。改过 `.gsx` 之后：

```bash
go run github.com/grindlemire/go-tui/cmd/tui@v0.22.1 generate ./...
go test ./...
```

## 为什么不重写服务端

`server.mjs` 只做两件事：托管 `public/` 与回答 `/api/health`。所有 `.note` 的读写都在
浏览器里对着用户自己的文件完成（File System Access，必要时下载副本），所以桌面端只做
「找到它 → 启动它 → 给它一个窗口 → 退出时收走它」。`.note` 的解析则由 Go 侧独立实现，
供终端管理器浏览与统计使用（只读）。
