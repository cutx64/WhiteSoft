// Command copyweb mirrors the web client (`public/`) into the Go package that
// embeds it.
//
// `go:embed` cannot reach outside its own package directory, and the web client
// has to stay at the repository root because it is also what `server.mjs` and
// the bash/batch launchers serve.  So the build copies it here once, and the
// desktop binary carries its own copy of the UI: no Node, no `public/` folder
// next to the executable, nothing to install.
//
// Run it with `go generate ./...` (or `build.ps1`, which does it for you).
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
)

func main() {
	src := flag.String("src", "", "source directory (the repository's public/)")
	dst := flag.String("dst", "", "destination directory (the embed package's web/)")
	flag.Parse()
	if *src == "" || *dst == "" {
		fmt.Fprintln(os.Stderr, "用法：copyweb -src <public> -dst <web>")
		os.Exit(2)
	}

	// Replace the destination wholesale: files deleted from the web client must
	// disappear from the binary too, otherwise a stale bundle would still load.
	if err := os.RemoveAll(*dst); err != nil {
		fail(err)
	}
	if err := os.MkdirAll(*dst, 0o755); err != nil {
		fail(err)
	}

	n, err := copyTree(*src, *dst)
	if err != nil {
		fail(err)
	}
	fmt.Printf("已同步 %d 个文件：%s → %s\n", n, *src, *dst)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "同步网页资源失败："+err.Error())
	os.Exit(1)
}

// copyTree copies a directory recursively and returns how many files it wrote.
func copyTree(src, dst string) (int, error) {
	entries, err := os.ReadDir(src)
	if err != nil {
		return 0, err
	}
	written := 0
	for _, e := range entries {
		s := filepath.Join(src, e.Name())
		d := filepath.Join(dst, e.Name())
		if e.IsDir() {
			if err := os.MkdirAll(d, 0o755); err != nil {
				return written, err
			}
			n, err := copyTree(s, d)
			written += n
			if err != nil {
				return written, err
			}
			continue
		}
		// Symbolic links are followed: the repository has none today, but a
		// silently missing file inside the binary would be hard to notice.
		info, err := os.Stat(s)
		if err != nil {
			return written, err
		}
		data, err := os.ReadFile(s)
		if err != nil {
			return written, err
		}
		if err := os.WriteFile(d, data, info.Mode().Perm()|0o600); err != nil {
			return written, err
		}
		written++
	}
	return written, nil
}
