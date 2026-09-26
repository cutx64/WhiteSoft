// Command whitesoft is the desktop front end for WhiteSoft.
//
// It does not reimplement the whiteboard: the browser UI and the `.note` API
// stay in `public/` and `server.mjs`, and this binary starts that server,
// opens a window on it.  A terminal manager
// (`whitesoft tui`) browses the same library from the command line.
//
// Usage:
//
//	whitesoft                     # 启动桌面端（文件都在浏览器里打开，不需要目录）
//	whitesoft tui --root ~/boards # 终端管理器浏览哪个目录
//	whitesoft --port 9000         # 指定端口（默认自动挑一个空闲端口）
//	whitesoft --no-open           # 只启动服务，不打开浏览器
//	whitesoft tui                 # 终端管理器（go-tui）
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/cutx64/WhiteSoft/desktop/internal/launcher"
	"github.com/cutx64/WhiteSoft/desktop/internal/tui"
)

const version = "1.0.0"

type options struct {
	root    string
	port    int
	host    string
	server  string
	node    string
	noOpen  bool
	showVer bool
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "错误："+err.Error())
		os.Exit(1)
	}
}

func run(args []string) error {
	// `whitesoft tui [...]` is a sub-command; everything else is desktop mode.
	mode := "desktop"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		mode = args[0]
		args = args[1:]
	}

	opts, err := parseFlags(mode, args)
	if err != nil {
		return err
	}
	if opts.showVer {
		fmt.Printf("WhiteSoft 桌面端 %s\n", version)
		return nil
	}
	// The desktop app needs no directory at all — boards are opened from the
	// browser.  Only the terminal manager browses a folder of `.note` files.
	if mode == "tui" {
		if opts.root == "" {
			opts.root, err = defaultRoot(opts.server)
			if err != nil {
				return err
			}
		}
		if st, err := os.Stat(opts.root); err != nil || !st.IsDir() {
			return fmt.Errorf("目录不存在：%s", opts.root)
		}
	}

	switch mode {
	case "desktop":
		return runDesktop(opts)
	case "tui":
		return tui.Run(tui.Options{
			Root: opts.root, Server: opts.server, Node: opts.node, Port: opts.port, Open: false,
		})
	default:
		return fmt.Errorf("未知子命令 %q（可用：tui）", mode)
	}
}

func parseFlags(mode string, args []string) (options, error) {
	var opts options
	fs := flag.NewFlagSet("whitesoft "+mode, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	usage := "启动桌面端（内嵌网页界面）"
	if mode == "tui" {
		usage = "打开终端管理器"
	}
	fs.Usage = func() {
		fmt.Fprintf(os.Stderr, "WhiteSoft %s — %s\n\n", version, usage)
		if mode == "tui" {
			fmt.Fprintf(os.Stderr, "用法：\n  whitesoft tui\n  whitesoft tui --root ~/my-boards\n\n")
		} else {
			fmt.Fprintf(os.Stderr, "用法：\n  whitesoft\n  whitesoft --port 8788\n\n")
		}
		fmt.Fprintln(os.Stderr, "选项：")
		fs.PrintDefaults()
	}
	fs.StringVar(&opts.root, "root", "", "终端管理器浏览的目录（仅 tui 子命令使用；桌面端不需要）")
	fs.IntVar(&opts.port, "port", 0, "监听端口（默认 8787，被占用时自动顺延；指定后严格使用该端口）")
	fs.StringVar(&opts.host, "host", "127.0.0.1", "监听地址")
	fs.StringVar(&opts.server, "server", "", "server.mjs 的路径（默认自动查找）")
	fs.StringVar(&opts.node, "node", "", "node 可执行文件（默认用 PATH 里的 node）")
	fs.BoolVar(&opts.noOpen, "no-open", false, "只启动服务，不打开浏览器")
	fs.BoolVar(&opts.showVer, "version", false, "显示版本")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return opts, nil
		}
		return opts, err
	}
	return opts, nil
}

// defaultRoot is only used by the terminal manager: the folder it browses
// defaults to the parent of the repository.
func defaultRoot(serverJS string) (string, error) {
	path, err := launcher.FindServerJS(serverJS)
	if err != nil {
		return "", err
	}
	return filepath.Dir(filepath.Dir(path)), nil
}

func runDesktop(opts options) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	fmt.Println("WhiteSoft — 桌面端")
	fmt.Println("──────────────────────────────────────────────")

	nodeBin, nodeVersion, err := launcher.FindNode(opts.node)
	if err != nil {
		return err
	}
	serverJS, err := launcher.FindServerJS(opts.server)
	if err != nil {
		return err
	}
	fmt.Printf("Node      : %s (%s)\n", nodeVersion, nodeBin)
	fmt.Printf("服务端    : %s\n", serverJS)

	srv, err := launcher.Start(ctx, launcher.Config{
		ServerJS: serverJS,
		NodeBin:  nodeBin,
		Port:     opts.port,
		Host:     opts.host,
		Log:      os.Stdout,
	})
	if err != nil {
		return err
	}
	defer func() {
		if err := srv.Stop(); err != nil {
			fmt.Fprintln(os.Stderr, "停止服务失败："+err.Error())
		}
	}()

	if note := srv.Note(); note != "" {
		fmt.Println(note)
	}
	fmt.Printf("界面地址  : %s\n", srv.URL())
	if opts.noOpen {
		fmt.Println("已跳过打开浏览器（--no-open）")
	} else if err := launcher.OpenBrowser(srv.URL()); err != nil {
		fmt.Fprintf(os.Stderr, "打不开浏览器（%v），请手动访问上面的地址\n", err)
	} else {
		fmt.Println("已在浏览器中打开界面")
	}
	fmt.Println("停止服务  : Ctrl+C")
	fmt.Println("──────────────────────────────────────────────")

	select {
	case <-ctx.Done():
		fmt.Println("\n正在退出 …")
	case <-srv.Done():
		if err := srv.Err(); err != nil {
			return fmt.Errorf("server.mjs 意外退出：%w", err)
		}
	}
	return nil
}
