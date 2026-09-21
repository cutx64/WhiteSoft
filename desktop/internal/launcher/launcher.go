// Package launcher runs the project's Node server as a child process.
//
// The desktop app deliberately does not reimplement the server: `server.mjs`
// is the single source of truth for the `.note` API (including the
// non-destructive save semantics), so the Go binary locates it, picks a free
// port, starts it, waits until `/api/health` answers and opens a window on it.
package launcher

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// MinNodeMajor is the oldest Node.js the server supports (it uses
// `fs.readSync`, `for await (const chunk of req)` and ES modules).
const MinNodeMajor = 18

// DefaultPort is the port every entry point of this project uses unless it is
// told otherwise: `./whitesoft.sh`, `node server.mjs` and the desktop app all
// start on 8787, so the URL (and any bookmark) stays the same.  Pass a port
// explicitly to override it.
const DefaultPort = 8787

// Config describes how the server should be started.
type Config struct {
	Root     string    // workspace directory (where the .note files live)
	ServerJS string    // path to server.mjs; empty = auto-detect
	NodeBin  string    // node executable; empty = auto-detect
	Port     int       // 0 = DefaultPort (falling back to a free one), else exact
	Host     string    // default 127.0.0.1
	Log      io.Writer // child stdout/stderr; nil = discard
	Ready    time.Duration
}

// Server is a running `node server.mjs` process.
type Server struct {
	url    string
	host   string
	port   int
	root   string
	note   string
	cmd    *exec.Cmd
	cancel context.CancelFunc

	mu   sync.Mutex
	logs []string
	done chan struct{}
	err  error
}

// URL is the address the UI is served on.
func (s *Server) URL() string { return s.url }

// Port is the TCP port the server listens on.
func (s *Server) Port() int { return s.port }

// Root is the workspace the server was given.
func (s *Server) Root() string { return s.root }

// Note explains a port that had to be moved aside ("" when the default was free).
func (s *Server) Note() string { return s.note }

// Logs returns the last lines the server printed.
func (s *Server) Logs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.logs))
	copy(out, s.logs)
	return out
}

// Done is closed once the child process exits.
func (s *Server) Done() <-chan struct{} { return s.done }

// Err reports why the process exited (nil while it is still running).
func (s *Server) Err() error {
	select {
	case <-s.done:
		return s.err
	default:
		return nil
	}
}

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

// FindServerJS locates `server.mjs`, searching the usual places: an explicit
// path, the directory the binary lives in, its parent, and the current
// directory upwards (so it works both from `desktop/` and from a build output
// dropped next to the web app).
func FindServerJS(explicit string) (string, error) {
	if explicit != "" {
		abs, err := filepath.Abs(explicit)
		if err != nil {
			return "", err
		}
		if st, err := os.Stat(abs); err == nil && !st.IsDir() {
			return abs, nil
		}
		return "", fmt.Errorf("找不到 server.mjs：%s", explicit)
	}

	var starts []string
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		starts = append(starts, dir, filepath.Dir(dir))
	}
	if wd, err := os.Getwd(); err == nil {
		starts = append(starts, wd)
	}
	for _, start := range starts {
		dir := start
		for i := 0; i < 4; i++ {
			cand := filepath.Join(dir, "server.mjs")
			if st, err := os.Stat(cand); err == nil && !st.IsDir() {
				return cand, nil
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return "", errors.New("找不到 server.mjs，请用 --server 指定路径")
}

// FindNode returns the node executable and its version.
func FindNode(explicit string) (string, string, error) {
	bin := explicit
	if bin == "" {
		found, err := exec.LookPath("node")
		if err != nil {
			return "", "", errors.New("找不到 node，请先安装 Node.js 18 或更高版本（或用 --node 指定）")
		}
		bin = found
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "-v").Output()
	if err != nil {
		return "", "", fmt.Errorf("无法运行 %s：%w", bin, err)
	}
	version := strings.TrimSpace(string(out))
	if major := nodeMajor(version); major > 0 && major < MinNodeMajor {
		return "", version, fmt.Errorf("Node.js 版本过低（%s），需要 %d 或更高", version, MinNodeMajor)
	}
	return bin, version, nil
}

var nodeVersionRE = regexp.MustCompile(`v?(\d+)\.`)

func nodeMajor(version string) int {
	m := nodeVersionRE.FindStringSubmatch(version)
	if m == nil {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

// portAvailable reports whether nothing is listening on host:port.
func portAvailable(host string, port int) bool {
	l, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return false
	}
	l.Close()
	return true
}

// FreePort asks the kernel for an unused TCP port on host.
func FreePort(host string) (int, error) {
	l, err := net.Listen("tcp", net.JoinHostPort(host, "0"))
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

/* ------------------------------------------------------------------ *
 * Running
 * ------------------------------------------------------------------ */

// Start launches the server and waits until it answers /api/health.
func Start(ctx context.Context, cfg Config) (*Server, error) {
	if cfg.Host == "" {
		cfg.Host = "127.0.0.1"
	}
	if cfg.Ready <= 0 {
		cfg.Ready = 20 * time.Second
	}
	serverJS, err := FindServerJS(cfg.ServerJS)
	if err != nil {
		return nil, err
	}
	nodeBin, nodeVersion, err := FindNode(cfg.NodeBin)
	if err != nil {
		return nil, err
	}
	root := cfg.Root
	if root == "" {
		root = filepath.Dir(filepath.Dir(serverJS)) // repo root by default
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if st, err := os.Stat(root); err != nil || !st.IsDir() {
		return nil, fmt.Errorf("工作区目录不存在：%s", root)
	}
	port := cfg.Port
	var portNote string
	if port == 0 {
		// Prefer the documented default so the address is predictable; only
		// move aside when something already listens there.
		if portAvailable(cfg.Host, DefaultPort) {
			port = DefaultPort
		} else {
			port, err = FreePort(cfg.Host)
			if err != nil {
				return nil, fmt.Errorf("端口 %d 已被占用，也找不到其它空闲端口：%w", DefaultPort, err)
			}
			portNote = fmt.Sprintf("端口 %d 已被占用，改用 %d（用 --port 指定固定端口）", DefaultPort, port)
		}
	} else if port < 1 || port > 65535 {
		return nil, fmt.Errorf("端口非法：%d", port)
	}

	runCtx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(runCtx, nodeBin, serverJS,
		"--port", strconv.Itoa(port), "--host", cfg.Host, "--root", root)
	cmd.Dir = filepath.Dir(serverJS)

	s := &Server{
		url:    fmt.Sprintf("http://%s:%d/", cfg.Host, port),
		host:   cfg.Host,
		port:   port,
		root:   root,
		note:   portNote,
		cmd:    cmd,
		cancel: cancel,
		done:   make(chan struct{}),
	}
	logWriter := cfg.Log
	if logWriter == nil {
		logWriter = io.Discard
	}
	pipe := &logPipe{w: logWriter, sink: s}
	cmd.Stdout = pipe
	cmd.Stderr = pipe

	if err := cmd.Start(); err != nil {
		cancel()
		return nil, fmt.Errorf("启动 node 失败：%w", err)
	}
	go func() {
		err := cmd.Wait()
		pipe.flush()
		s.mu.Lock()
		s.err = err
		s.mu.Unlock()
		close(s.done)
	}()

	if err := s.waitReady(ctx, cfg.Ready, nodeVersion); err != nil {
		_ = s.Stop()
		return nil, err
	}
	return s, nil
}

func (s *Server) waitReady(ctx context.Context, timeout time.Duration, nodeVersion string) error {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: 2 * time.Second}
	health := s.url + "api/health"
	for time.Now().Before(deadline) {
		select {
		case <-s.done:
			logs := strings.Join(s.Logs(), "\n")
			if strings.Contains(logs, "EADDRINUSE") || strings.Contains(logs, "已被占用") {
				return fmt.Errorf("端口 %d 已被占用", s.port)
			}
			return fmt.Errorf("server.mjs 启动失败（%s）：\n%s", nodeVersion, logs)
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, health, nil)
		resp, err := client.Do(req)
		if err == nil {
			ok := resp.StatusCode == http.StatusOK
			resp.Body.Close()
			if ok {
				return nil
			}
		}
		time.Sleep(80 * time.Millisecond)
	}
	return fmt.Errorf("等待 %s 就绪超时（%s）", health, timeout)
}

// Stop terminates the server, giving it a moment to shut down cleanly.
func (s *Server) Stop() error {
	if s == nil || s.cmd == nil || s.cmd.Process == nil {
		return nil
	}
	select {
	case <-s.done:
		return nil
	default:
	}
	// SIGTERM first: server.mjs closes the listener and exits.
	_ = s.cmd.Process.Signal(os.Interrupt)
	select {
	case <-s.done:
		s.cancel()
		return nil
	case <-time.After(3 * time.Second):
	}
	_ = s.cmd.Process.Kill()
	<-s.done
	s.cancel()
	return nil
}

// logPipe keeps the last lines of child output and mirrors them to Log.
type logPipe struct {
	w    io.Writer
	sink *Server
	mu   sync.Mutex
	buf  string
}

func (p *logPipe) Write(b []byte) (int, error) {
	p.mu.Lock()
	p.buf += string(b)
	for {
		i := strings.IndexByte(p.buf, '\n')
		if i < 0 {
			break
		}
		line := strings.TrimRight(p.buf[:i], "\r")
		p.buf = p.buf[i+1:]
		p.append(line)
	}
	p.mu.Unlock()
	// Complete lines are mirrored by append(); only a trailing partial line
	// waits for flush(), so nothing is printed twice.
	return len(b), nil
}

func (p *logPipe) flush() {
	p.mu.Lock()
	rest := strings.TrimSpace(p.buf)
	p.buf = ""
	p.mu.Unlock()
	if rest != "" {
		p.append(rest)
	}
}

func (p *logPipe) append(line string) {
	if line == "" {
		return
	}
	s := p.sink
	s.mu.Lock()
	s.logs = append(s.logs, line)
	if len(s.logs) > 200 {
		s.logs = s.logs[len(s.logs)-200:]
	}
	s.mu.Unlock()
	if p.w != nil {
		fmt.Fprintln(p.w, line)
	}
}

/* ------------------------------------------------------------------ *
 * Opening a window
 * ------------------------------------------------------------------ */

// OpenBrowser opens url in the user's default browser.  (A native webview
// window would need CGO plus libwebkit2gtk; the browser is the one dependency
// free way to show the UI, and the server keeps running either way.)
func OpenBrowser(url string) error {
	var candidates [][]string
	switch runtime.GOOS {
	case "darwin":
		candidates = [][]string{{"open", url}}
	case "windows":
		candidates = [][]string{{"rundll32", "url.dll,FileProtocolHandler", url}}
	default:
		candidates = [][]string{
			{"xdg-open", url},
			{"gio", "open", url},
			{"sensible-browser", url},
			{"x-www-browser", url},
		}
	}
	var lastErr error
	for _, c := range candidates {
		bin, err := exec.LookPath(c[0])
		if err != nil {
			lastErr = err
			continue
		}
		if err := exec.Command(bin, c[1:]...).Start(); err != nil {
			lastErr = err
			continue
		}
		return nil
	}
	if lastErr == nil {
		lastErr = errors.New("没有找到可用的浏览器打开命令")
	}
	return lastErr
}
