//go:build windows

package desktop

import (
	"fmt"
	"runtime"
	"strings"

	webview "github.com/webview/webview_go"
	"golang.org/x/sys/windows/registry"
)

// webView2Client is the Edge WebView2 runtime's installer key.  Both the
// machine-wide and the 32-bit view of it are checked, because the runtime is
// registered per architecture and per install scope.
const webView2Client = `SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`

// ErrNoRuntime is returned when the WebView2 runtime is not installed.
var ErrNoRuntime = fmt.Errorf("系统缺少 Microsoft Edge WebView2 运行时不" +
	"（Windows 10/11 一般自带；可安装微软官方的 WebView2 Runtime 后重试）")

// Open shows the client in a native window and blocks until the user closes it.
//
// It locks the OS thread for its whole life: WebView2 requires its window and
// message loop to live on the process main thread.
func Open(opts Options) Result {
	opts = opts.withDefaults()
	if !WebView2Available() {
		return Result{Err: ErrNoRuntime}
	}

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	w := webview.New(opts.Debug)
	defer w.Destroy()

	w.SetTitle(opts.Title)
	w.SetSize(opts.Width, opts.Height, webview.HintNone)
	w.Navigate(opts.URL)
	w.Run()
	return Result{}
}

// WebView2Available reports whether the runtime is installed.
func WebView2Available() bool {
	return webView2Version() != ""
}

func webView2Version() string {
	for _, access := range []uint32{registry.WOW64_64KEY, registry.WOW64_32KEY} {
		k, err := registry.OpenKey(registry.LOCAL_MACHINE, webView2Client, registry.QUERY_VALUE|access)
		if err != nil {
			continue
		}
		v, _, err := k.GetStringValue("pv")
		k.Close()
		if err == nil && strings.TrimSpace(v) != "" && strings.TrimSpace(v) != "0.0.0.0" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// WebView2Version exposes the installed runtime version for the startup banner.
func WebView2Version() string { return webView2Version() }
