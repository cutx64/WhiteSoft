// Package server hosts the embedded web client over loopback HTTP.
//
// It exists because the client needs an http:// origin: the File System Access
// API (open / save `.note` files in place), ES modules and the PDF.js worker all
// require a secure context, and Chromium treats a loopback http origin as
// secure.  A file:// URL would break those three.
//
// What it is *not* is a backend: it serves static bytes and answers
// `/api/health`, exactly like `server.mjs` did, and it never sees a board.  Every
// `.note` is opened, edited and written back by the web client against the
// user's own files.
package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path"
	"strings"
	"sync"
	"time"
)

// compressedPrefix names the part of the client that the build stores gzipped:
// the MathJax font data.  See tools/copyweb.
const compressedPrefix = "vendor/mathjax"

// Config describes how to host the client.
type Config struct {
	Assets fs.FS  // the web client, "index.html" at the root
	Host   string // listening address, default 127.0.0.1
	Port   int    // 0 = pick a free port starting at DefaultPort
	Logger *log.Logger
}

// DefaultPort is where the desktop app tries to listen first, so the URL is the
// familiar 8787; anything already there pushes it to the next free port.
const DefaultPort = 8787

// Server is a running listener.
type Server struct {
	url   string
	host  string
	port  int
	note  string
	http  *http.Server
	ln    net.Listener
	once  sync.Once
	done  chan struct{}
	err   error
	ready chan struct{}
}

// Start begins listening and returns as soon as the socket is open.
func Start(cfg Config) (*Server, error) {
	if cfg.Assets == nil {
		return nil, errors.New("没有可用的网页资源")
	}
	host := strings.TrimSpace(cfg.Host)
	if host == "" {
		host = "127.0.0.1"
	}
	logger := cfg.Logger
	if logger == nil {
		logger = log.New(os.Stderr, "", log.LstdFlags)
	}

	ln, port, note, err := listen(host, cfg.Port)
	if err != nil {
		return nil, err
	}

	srv := &Server{
		url:   fmt.Sprintf("http://%s/", net.JoinHostPort(host, fmt.Sprint(port))),
		host:  host,
		port:  port,
		note:  note,
		ln:    ln,
		done:  make(chan struct{}),
		ready: make(chan struct{}),
	}
	handler := &handler{assets: cfg.Assets, logger: logger}
	srv.http = &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}
	close(srv.ready)

	go func() {
		defer close(srv.done)
		err := srv.http.Serve(ln)
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			srv.err = err
		}
	}()
	return srv, nil
}

// listen binds host:port, or the first free port from DefaultPort upwards.
func listen(host string, want int) (net.Listener, int, string, error) {
	if want > 0 {
		if want < 1 || want > 65535 {
			return nil, 0, "", fmt.Errorf("端口非法：%d", want)
		}
		ln, err := net.Listen("tcp", net.JoinHostPort(host, fmt.Sprint(want)))
		if err != nil {
			return nil, 0, "", fmt.Errorf("端口 %d 已被占用：%w", want, err)
		}
		return ln, want, "", nil
	}
	// Prefer the documented default so the URL (and any bookmark) stays put;
	// only move aside when something else already listens there.
	for p := DefaultPort; p < DefaultPort+50; p++ {
		ln, err := net.Listen("tcp", net.JoinHostPort(host, fmt.Sprint(p)))
		if err == nil {
			note := ""
			if p != DefaultPort {
				note = fmt.Sprintf("端口 %d 已被占用，改用 %d", DefaultPort, p)
			}
			return ln, p, note, nil
		}
	}
	return nil, 0, "", fmt.Errorf("%d 到 %d 之间的端口都被占用", DefaultPort, DefaultPort+50)
}

// URL is the address the window should show.
func (s *Server) URL() string { return s.url }

// Host and Port expose the listener details.
func (s *Server) Host() string { return s.host }
func (s *Server) Port() int    { return s.port }

// Note explains a port that had to be moved aside ("" when the default was free).
func (s *Server) Note() string { return s.note }

// Done is closed when the listener has stopped.
func (s *Server) Done() <-chan struct{} { return s.done }

// Err reports why it stopped (nil for a clean shutdown).
func (s *Server) Err() error {
	select {
	case <-s.done:
		return s.err
	default:
		return nil
	}
}

// Ready is closed once the socket is listening.
func (s *Server) Ready() <-chan struct{} { return s.ready }

// Stop closes the listener and waits for in-flight requests to finish.
func (s *Server) Stop(ctx context.Context) error {
	var err error
	s.once.Do(func() {
		err = s.http.Shutdown(ctx)
	})
	select {
	case <-s.done:
	case <-ctx.Done():
	}
	return err
}

/* ------------------------------------------------------------------ *
 * Request handling
 * ------------------------------------------------------------------ */

type handler struct {
	assets fs.FS
	logger *log.Logger
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	urlPath := r.URL.Path
	if urlPath == "" {
		urlPath = "/"
	}

	// The desktop window polls this to know the UI is reachable, and it is a
	// handy smoke test from the command line.
	if urlPath == "/api/health" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte(`{"ok":true,"version":1,"userAgent":"go-desktop"}`))
		return
	}
	if strings.HasPrefix(urlPath, "/api/") {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"这个服务只托管界面：文件都在你自己的机器上由浏览器读写。"}`))
		return
	}

	name := strings.TrimPrefix(path.Clean("/"+urlPath), "/")
	if name == "" {
		name = "index.html"
	}
	f, err := h.assets.Open(name)
	if err != nil {
		// The MathJax font data is embedded compressed; see serveGzip.
		if strings.HasPrefix(name, compressedPrefix+"/") {
			if gz, gerr := h.assets.Open(name + ".gz"); gerr == nil {
				h.serveGzip(w, r, name, gz)
				return
			}
		}
		h.notFound(w, r, name)
		return
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil || st.IsDir() {
		h.notFound(w, r, name)
		return
	}
	setHeaders(w, name)
	// ServeContent adds Content-Length, ranges and HEAD support — the PDF
	// worker and MathJax both rely on ranges.  Embedded files are seekable, so
	// the bytes go out without being copied into memory first.
	if rs, ok := f.(io.ReadSeeker); ok {
		http.ServeContent(w, r, name, st.ModTime(), rs)
		return
	}
	http.ServeContent(w, r, name, st.ModTime(), bytes.NewReader(mustReadAll(f)))
}

func mustReadAll(f fs.File) []byte {
	data, err := io.ReadAll(f)
	if err != nil {
		return nil
	}
	return data
}

// serveGzip sends one of the vendored MathJax files, which the build embedded
// compressed.
//
// Browsers hand us `Accept-Encoding: gzip` and unpack the stream themselves,
// which is why the bytes go out untouched and the 31 MB of font data cost about
// 10 MB of executable.  A client that does not accept gzip gets the file
// inflated, so nothing depends on that header being present.
func (h *handler) serveGzip(w http.ResponseWriter, r *http.Request, name string, gz fs.File) {
	defer gz.Close()
	st, err := gz.Stat()
	if err != nil {
		h.notFound(w, r, name)
		return
	}
	setHeaders(w, name)
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Add("Vary", "Accept-Encoding")
		if rs, ok := gz.(io.ReadSeeker); ok {
			http.ServeContent(w, r, name, st.ModTime(), rs)
			return
		}
		http.ServeContent(w, r, name, st.ModTime(), bytes.NewReader(mustReadAll(gz)))
		return
	}
	zr, err := gzip.NewReader(gz)
	if err != nil {
		h.notFound(w, r, name)
		return
	}
	defer zr.Close()
	data, err := io.ReadAll(zr)
	if err != nil {
		h.notFound(w, r, name)
		return
	}
	http.ServeContent(w, r, name, st.ModTime(), bytes.NewReader(data))
}

func (h *handler) notFound(w http.ResponseWriter, r *http.Request, name string) {
	if !strings.HasPrefix(name, "favicon") {
		h.logger.Printf("404 %s", r.URL.Path)
	}
	http.Error(w, "not found: "+r.URL.Path, http.StatusNotFound)
}

var mimeByExt = map[string]string{
	".html":  "text/html; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json; charset=utf-8",
	".png":   "image/png",
	".jpg":   "image/jpeg",
	".jpeg":  "image/jpeg",
	".gif":   "image/gif",
	".webp":  "image/webp",
	".svg":   "image/svg+xml",
	".pdf":   "application/pdf",
	".woff2": "font/woff2",
	".woff":  "font/woff",
	".ttf":   "font/ttf",
	".ico":   "image/x-icon",
	".map":   "application/json",
	".wasm":  "application/wasm",
	".bcmap": "application/octet-stream",
	".pfb":   "application/octet-stream",
}

func setHeaders(w http.ResponseWriter, name string) {
	ext := strings.ToLower(path.Ext(name))
	if ct, ok := mimeByExt[ext]; ok {
		w.Header().Set("Content-Type", ct)
	} else {
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")
	// Code must never be cached: a rebuilt binary has to show the new client,
	// and the window is reopened rather than reloaded against a stale cache.
	switch ext {
	case ".html", ".js", ".mjs", ".css", ".json":
		w.Header().Set("Cache-Control", "no-store, must-revalidate")
	default:
		w.Header().Set("Cache-Control", "public, max-age=3600")
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
}
