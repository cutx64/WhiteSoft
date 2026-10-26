//go:build windows

package desktop

import (
	"fmt"
	"os"
	"path/filepath"
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
var ErrNoRuntime = fmt.Errorf("系统缺少 Microsoft Edge WebView2 运行时" +
	"，Windows 10 和 11 一般自带，也可以安装微软官方的 WebView2 Runtime 后重试")

// Open shows the client in a native window and blocks until the user closes it.
//
// It locks the OS thread for its whole life: WebView2 requires its window and
// message loop to live on the process main thread.
func Open(opts Options) Result {
	opts = opts.withDefaults()
	if !WebView2Available() {
		return Result{Err: ErrNoRuntime}
	}
	// The engine keeps a profile: cache, cookies, GPU shaders. Left alone it
	// puts that folder next to the executable, so a freshly copied binary writes
	// a directory beside itself on first run, which is the shape security
	// software watches for. It belongs in the user's local application data.
	if err := prepareUserDataFolder(userDataFolderName); err != nil {
		return Result{Err: err}
	}
	tuneEngine()

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	w := webview.New(opts.Debug)
	// A failed engine creation yields a null handle, not an error, and the
	// window is created even when the engine behind it is not. Both look the
	// same from here: the profile could not be used.
	//
	// A profile written by a run started at another privilege level cannot be
	// reused, and neither can one another instance still holds; both are common
	// on a machine where some shortcuts run elevated. The second attempt
	// therefore discards the old folder and takes a fresh one, which turns a
	// launch that could only show an error into a working window.
	if w.Window() == nil || !w.EngineReady() {
		w.Destroy()
		shared, _ := userDataFolder()
		if shared != "" {
			_ = os.RemoveAll(shared)
		}
		fresh := fmt.Sprintf("WebView2-%d", os.Getpid())
		if err := prepareUserDataFolder(fresh); err != nil {
			return Result{Err: err}
		}
		w = webview.New(opts.Debug)
		if w.Window() == nil || !w.EngineReady() {
			w.Destroy()
			return Result{Err: errEngine()}
		}
	}
	defer w.Destroy()

	applyWindowIcon(w.Window())
	w.SetTitle(opts.Title)
	w.SetSize(opts.Width, opts.Height, webview.HintNone)
	// The page needs to know it is running inside the shell, and the shell needs
	// its close hook in place before the page boots and closes the window itself.
	w.Init("window.whitesoftDesktop = true;")
	installCloseGuard(w, uintptr(w.Window()))
	w.Navigate(opts.URL)
	w.Run()
	return Result{}
}

// WebView2Available reports whether the runtime is installed.
func WebView2Available() bool {
	return webView2Version() != ""
}

// UserDataFolder is where the WebView2 profile is kept.
func UserDataFolder() string {
	dir, err := userDataFolder()
	if err != nil {
		return ""
	}
	return dir
}

// userDataFolderName is the profile folder used first. A retry after a failed
// start appends a suffix so it cannot collide with whatever held the first one.
const userDataFolderName = "WebView2"

func userDataFolder() (string, error) {
	return userDataFolderFor(userDataFolderName)
}

func userDataFolderFor(name string) (string, error) {
	base, err := os.UserCacheDir()
	if err != nil {
		return "", fmt.Errorf("拿不到本地应用数据目录：%w", err)
	}
	return filepath.Join(base, "WhiteSoft", name), nil
}

// profileRoots lists the places the profile may live, most preferred first.
//
// One location is not enough: a process started from Explorer gets a different
// token context than the same program started from a terminal, and on at least
// one machine that context was refused write access to
// %LOCALAPPDATA%\WhiteSoft while the temp folder under the same profile stayed
// writable. Trying each in turn turns that into a working window.
func profileRoots() []string {
	// An explicit choice wins over every guess.
	if dir := strings.TrimSpace(os.Getenv("WHITESOFT_DATA_DIR")); dir != "" {
		return []string{dir}
	}
	seen := map[string]bool{}
	var roots []string
	add := func(dir string) {
		if dir == "" || seen[dir] {
			return
		}
		seen[dir] = true
		roots = append(roots, dir)
	}
	if dir, err := os.UserCacheDir(); err == nil {
		add(filepath.Join(dir, "WhiteSoft"))
	}
	if dir := os.Getenv("TEMP"); dir != "" {
		add(filepath.Join(dir, "WhiteSoft"))
	}
	if dir := os.Getenv("APPDATA"); dir != "" {
		add(filepath.Join(dir, "WhiteSoft"))
	}
	// Beside the program. A confined context can write where the program itself
	// lives even when the whole user profile is read-only, so this is the
	// fallback that keeps the window working there.
	if exe, err := os.Executable(); err == nil {
		add(filepath.Join(filepath.Dir(exe), "WhiteSoftData"))
	}
	return roots
}

// prepareUserDataFolder creates the profile directory and points the engine at
// it before the environment is created. Every candidate is tried, and the first
// one that can actually be written becomes the profile.
func prepareUserDataFolder(name string) error {
	var tried []string
	for _, root := range profileRoots() {
		dir := filepath.Join(root, name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			tried = append(tried, fmt.Sprintf("%s —— %v", dir, err))
			continue
		}
		// A directory can exist and still refuse a write, which is the shape
		// this failure takes on the affected machine.
		probe := filepath.Join(dir, ".write-test")
		if err := os.WriteFile(probe, []byte("ok"), 0o644); err != nil {
			tried = append(tried, fmt.Sprintf("%s —— %v", dir, err))
			continue
		}
		os.Remove(probe)
		return os.Setenv("WEBVIEW2_USER_DATA_FOLDER", dir)
	}
	return fmt.Errorf("没有任何位置可以用来放 WebView2 数据目录，试过：\n%s\n\n"+
		"可以用 --data-dir 指定一个可写的目录，或者设环境变量 WHITESOFT_DATA_DIR。",
		strings.Join(tried, "\n"))
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

// errEngine explains a window that could not get an engine behind it.
//
// The profile directory is the usual reason: a run that did not exit cleanly
// still holds it, or it was written by a run started with other privileges, so
// the engine cannot start and the window stays empty.
func errEngine() error {
	dir, _ := userDataFolder()
	return fmt.Errorf("WebView2 引擎没能启动。\n\n数据目录：%s\n\n"+
		"删掉这个目录再启动一次通常就好了。它只放缓存，"+
		"白板本身存在你自己的 .note 文件里，删掉不会丢内容。\n\n"+
		"如果一直不行，说明当前权限级别用不了这份数据：用管理员身份运行，"+
		"或反过来用普通权限运行，保持和创建它的那次一致。", dir)
}
// tuneEngine trims what the engine keeps and does in the background. The app is
// a single local page, so the defaults meant for browsing the web are wasted:
// a disk cache measured in hundreds of megabytes, background network calls and
// component updates, and a renderer process per site.
//
// Only applied when the user has not set the variable, so an explicit choice
// always wins.
func tuneEngine() {
	if os.Getenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") != "" {
		return
	}
	os.Setenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", strings.Join([]string{
		"--disk-cache-size=33554432",       // 32 MB of HTTP cache instead of the default
		"--disable-background-networking",  // no phone-home while idle
		"--disable-component-update",       // the engine is updated by Windows, not per app
		"--disable-sync",
		"--process-per-site",               // one renderer for the one page we show
	}, " "))
}