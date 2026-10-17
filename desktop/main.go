// Command whitesoft is the WhiteSoft desktop app.
//
// It is the whole whiteboard in one binary: the web client that the repository
// hosts in `public/` is embedded, served from an in-process loopback HTTP
// server, and shown in a native WebView2 window.  There is no Node.js and no
// `server.mjs` — the Go program replaces both.
//
// Boards stay where they were: opened and written in place by the client
// through the File System Access API, never copied and never uploaded.
//
// Usage:
//
//	whitesoft                     # 打开桌面窗口
//	whitesoft --port 9000         # 指定端口（默认 8787，被占用时自动顺延）
//	whitesoft --no-window         # 只起本地服务，用浏览器访问打印出的地址
//	whitesoft serve               # 同上，语义更清楚的写法
//	whitesoft --version
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/cutx64/WhiteSoft/desktop/internal/desktop"
	"github.com/cutx64/WhiteSoft/desktop/internal/server"
	"github.com/cutx64/WhiteSoft/desktop/internal/webapp"
)

const version = "2.0.0"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "错误："+err.Error())
		if errors.Is(err, desktop.ErrNoRuntime) {
			os.Exit(2)
		}
		os.Exit(1)
	}
}

type options struct {
	port     int
	host     string
	width    int
	height   int
	noWindow bool
	debug    bool
	version  bool
}

func run(args []string) error {
	// `whitesoft serve` is a sub-command; everything else is desktop mode.
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		switch args[0] {
		case "serve":
			args = append([]string{"--no-window"}, args[1:]...)
		case "desktop":
			args = args[1:]
		default:
			return fmt.Errorf("未知子命令 %q，可用的是 serve", args[0])
		}
	}

	opts, err := parseFlags(args)
	if err != nil {
		return err
	}
	if opts.version {
		fmt.Printf("WhiteSoft 桌面端 %s\n", version)
		if v := desktop.WebView2Version(); v != "" {
			fmt.Printf("WebView2  : %s\n", v)
		}
		return nil
	}
	return runApp(opts)
}

func parseFlags(args []string) (options, error) {
	var opts options
	fs := flag.NewFlagSet("whitesoft", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	fs.Usage = func() {
		fmt.Fprintf(os.Stderr, "WhiteSoft %s — 本地白板桌面端（内嵌网页界面，不需要 Node.js）\n\n", version)
		fmt.Fprint(os.Stderr, "用法：\n  whitesoft                打开桌面窗口\n  whitesoft serve          只起本地服务，用浏览器访问\n\n选项：\n")
		fs.PrintDefaults()
	}
	fs.IntVar(&opts.port, "port", 0, "监听端口，默认 8787，被占用时自动顺延；指定后严格使用")
	fs.StringVar(&opts.host, "host", "127.0.0.1", "监听地址；改成 0.0.0.0 会暴露到局域网")
	fs.IntVar(&opts.width, "width", 1440, "窗口宽度（像素）")
	fs.IntVar(&opts.height, "height", 900, "窗口高度（像素）")
	fs.BoolVar(&opts.noWindow, "no-window", false, "不开窗口，只启动本地服务并打印地址")
	fs.BoolVar(&opts.debug, "debug", false, "打开开发者工具与右键菜单，便于排查界面问题")
	fs.BoolVar(&opts.version, "version", false, "显示版本")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return opts, nil
		}
		return opts, err
	}
	if opts.port < 0 || opts.port > 65535 {
		return opts, fmt.Errorf("端口非法：%d", opts.port)
	}
	return opts, nil
}

func runApp(opts options) error {
	logger := log.New(os.Stdout, "", log.LstdFlags)

	assets, err := webapp.FS()
	if err != nil {
		return err
	}

	srv, err := server.Start(server.Config{
		Assets: assets,
		Host:   opts.host,
		Port:   opts.port,
		Logger: logger,
	})
	if err != nil {
		return err
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Stop(ctx)
	}()

	banner(os.Stdout, srv, opts)
	if srv.Note() != "" {
		fmt.Println(srv.Note())
	}

	if opts.noWindow {
		return runHeadless(srv)
	}

	// The window blocks the calling goroutine (and owns the process main
	// thread), so the shutdown plumbing lives in its own goroutine.
	shutdown := make(chan struct{})
	go func() {
		select {
		case <-srv.Done():
			if err := srv.Err(); err != nil {
				fmt.Fprintln(os.Stderr, "本地服务意外退出："+err.Error())
			}
		case <-shutdown:
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sig
		// Closing the window ends `Open`; the deferred Stop closes the socket.
		os.Exit(0)
	}()

	res := desktop.Open(desktop.Options{
		Title:  "WhiteSoft — 本地白板",
		URL:    srv.URL(),
		Width:  opts.width,
		Height: opts.height,
		Debug:  opts.debug,
	})
	close(shutdown)
	fmt.Println("窗口已关闭")
	return res.Err
}

// runHeadless keeps serving until Ctrl+C, printing the address to open.
func runHeadless(srv *server.Server) error {
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	select {
	case <-sig:
		fmt.Println("\n正在退出 …")
		return nil
	case <-srv.Done():
		if err := srv.Err(); err != nil {
			return fmt.Errorf("本地服务意外退出：%w", err)
		}
		return nil
	}
}

func banner(w *os.File, srv *server.Server, opts options) {
	fmt.Fprintf(w, "\nWhiteSoft %s — 本地白板（桌面端）\n", version)
	fmt.Fprintln(w, "──────────────────────────────────────────────")
	fmt.Fprintf(w, "界面地址 : %s\n", srv.URL())
	fmt.Fprintf(w, "服务     : Go 内置（已内嵌网页界面，不需要 Node.js）\n")
	if v := desktop.WebView2Version(); v != "" {
		fmt.Fprintf(w, "渲染引擎 : WebView2 %s\n", v)
	}
	fmt.Fprintln(w, "打开白板 : 界面里用「打开」选择本机的 .note / .pdf（文件不会被复制或上传）")
	if opts.noWindow {
		fmt.Fprintln(w, "停止服务 : Ctrl+C")
	} else {
		fmt.Fprintln(w, "关闭窗口 : 退出程序并停止本地服务")
	}
	fmt.Fprintln(w, "──────────────────────────────────────────────")
}
