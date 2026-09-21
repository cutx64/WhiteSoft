package launcher

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// writeFixtureServer drops a minimal Node server that speaks just enough of
// the API for the launcher to consider it ready.
func writeFixtureServer(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, "server.mjs")
	body := `import http from 'node:http';
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; };
const port = Number(arg('port', 8787));
const host = arg('host', '127.0.0.1');
const root = arg('root', '.');
http.createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, workspace: root }));
  }
  res.writeHead(404); res.end('nope');
}).listen(port, host, () => console.log('fixture listening on ' + port + ' root=' + root));
`
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	return path
}

func requireNode(t *testing.T) {
	t.Helper()
	if _, _, err := FindNode(""); err != nil {
		t.Skipf("node unavailable: %v", err)
	}
}

func TestStartStopFixtureServer(t *testing.T) {
	requireNode(t)
	dir := t.TempDir()
	serverJS := writeFixtureServer(t, dir)
	root := t.TempDir()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	srv, err := Start(ctx, Config{ServerJS: serverJS, Root: root, Log: os.Stderr, Ready: 15 * time.Second})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if srv.Port() == 0 || !strings.HasPrefix(srv.URL(), "http://127.0.0.1:") {
		t.Fatalf("url = %q port=%d", srv.URL(), srv.Port())
	}
	resp, err := http.Get(srv.URL() + "api/health")
	if err != nil {
		t.Fatalf("health: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("health status = %d", resp.StatusCode)
	}
	if len(srv.Logs()) == 0 {
		t.Error("expected the child's log lines to be captured")
	}
	if srv.Err() != nil {
		t.Errorf("unexpected exit: %v", srv.Err())
	}

	if err := srv.Stop(); err != nil {
		t.Fatalf("stop: %v", err)
	}
	select {
	case <-srv.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("child did not exit after Stop")
	}
	if _, err := http.Get(srv.URL() + "api/health"); err == nil {
		t.Error("server still answering after Stop")
	}
}

func TestDefaultPortIsPreferred(t *testing.T) {
	requireNode(t)
	dir := t.TempDir()
	serverJS := writeFixtureServer(t, dir)
	root := t.TempDir()

	free := portAvailable("127.0.0.1", DefaultPort)
	srv, err := Start(context.Background(), Config{ServerJS: serverJS, Root: root, Ready: 15 * time.Second})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	defer srv.Stop()

	if free {
		if srv.Port() != DefaultPort {
			t.Errorf("port = %d, want the default %d", srv.Port(), DefaultPort)
		}
		if srv.Note() != "" {
			t.Errorf("note = %q, want empty when the default port is free", srv.Note())
		}
	} else {
		// Something already listens on 8787: the app must move aside and say so.
		if srv.Port() == DefaultPort {
			t.Errorf("port = %d although %d was busy", srv.Port(), DefaultPort)
		}
		if !strings.Contains(srv.Note(), "已被占用") {
			t.Errorf("note = %q, want an explanation", srv.Note())
		}
	}
}

func TestExplicitPortIsRespected(t *testing.T) {
	requireNode(t)
	dir := t.TempDir()
	serverJS := writeFixtureServer(t, dir)
	want, err := FreePort("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	srv, err := Start(context.Background(), Config{ServerJS: serverJS, Root: t.TempDir(), Port: want, Ready: 15 * time.Second})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	defer srv.Stop()
	if srv.Port() != want {
		t.Errorf("port = %d, want %d", srv.Port(), want)
	}
	if srv.Note() != "" {
		t.Errorf("note = %q, want empty for an explicit port", srv.Note())
	}
	if !strings.Contains(srv.URL(), fmt.Sprintf(":%d/", want)) {
		t.Errorf("url = %q", srv.URL())
	}
}

func TestExplicitBusyPortFails(t *testing.T) {
	requireNode(t)
	dir := t.TempDir()
	serverJS := writeFixtureServer(t, dir)

	// Occupy a port, then insist on it.
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	busy := l.Addr().(*net.TCPAddr).Port

	_, err = Start(context.Background(), Config{
		ServerJS: serverJS, Root: t.TempDir(), Port: busy, Ready: 10 * time.Second,
	})
	if err == nil {
		t.Fatal("want an error when an explicit port is already in use")
	}
}

func TestInvalidPortRejected(t *testing.T) {
	if _, err := Start(context.Background(), Config{ServerJS: "x", Port: 70000}); err == nil {
		t.Fatal("want an error for an out-of-range port")
	}
}

func TestPortAvailable(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	port := l.Addr().(*net.TCPAddr).Port
	if portAvailable("127.0.0.1", port) {
		t.Errorf("port %d should read as busy", port)
	}
}

func TestStartFailsWithBadRoot(t *testing.T) {
	requireNode(t)
	dir := t.TempDir()
	serverJS := writeFixtureServer(t, dir)
	_, err := Start(context.Background(), Config{
		ServerJS: serverJS,
		Root:     filepath.Join(dir, "does-not-exist"),
		Ready:    5 * time.Second,
	})
	if err == nil {
		t.Fatal("want an error for a missing workspace directory")
	}
}

func TestNodeVersionGuard(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, "old-node")
	script := "#!/bin/sh\necho v16.20.0\n"
	if err := os.WriteFile(old, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	_, version, err := FindNode(old)
	if err == nil {
		t.Fatal("want a version error for node 16")
	}
	if !strings.Contains(err.Error(), "版本过低") || version != "v16.20.0" {
		t.Fatalf("err = %v (version %q)", err, version)
	}
}

func TestNodeMajor(t *testing.T) {
	for in, want := range map[string]int{"v22.23.2": 22, "v18.0.0": 18, "20.11.1": 20, "weird": 0} {
		if got := nodeMajor(in); got != want {
			t.Errorf("nodeMajor(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestFreePortIsUsable(t *testing.T) {
	port, err := FreePort("127.0.0.1")
	if err != nil {
		t.Fatalf("free port: %v", err)
	}
	if port <= 0 || port > 65535 {
		t.Fatalf("port = %d", port)
	}
}

func TestFindServerJS(t *testing.T) {
	// The package lives inside the repository, so the default search (walking
	// up from the working directory) must find the real server.mjs.
	found, err := FindServerJS("")
	if err != nil {
		t.Skipf("server.mjs not reachable from %s: %v", mustGetwd(t), err)
	}
	if filepath.Base(found) != "server.mjs" {
		t.Fatalf("found %q", found)
	}
	if _, err := os.Stat(found); err != nil {
		t.Fatalf("stat %q: %v", found, err)
	}
	if _, err := FindServerJS(filepath.Join(t.TempDir(), "nope.mjs")); err == nil {
		t.Fatal("want an error for an explicit missing path")
	}
}

func mustGetwd(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		return "?"
	}
	return wd
}
