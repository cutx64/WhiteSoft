// Command copyweb mirrors the web client (`public/`) into the Go package that
// embeds it.
//
// `go:embed` cannot reach outside its own package directory, and the web client
// has to stay at the repository root because it is also what `server.mjs` and
// the bash/batch launchers serve.  So the build copies it here once, and the
// desktop binary carries its own copy of the UI: no Node, no `public/` folder
// next to the executable, nothing to install.
//
// Files under vendor/mathjax are written gzipped, as `name.js.gz`.  That tree is
// 31 MB of font data, about 10 MB once compressed, and the browser unpacks it
// when the server marks the response `Content-Encoding: gzip`.  The web server
// reads the original tree, so the repository keeps the plain files and
// `server.mjs` serves them unchanged.
//
// Run it with `go generate ./...` (or `build.ps1`, which does it for you).
package main

import (
	"compress/gzip"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// compressPrefix names the directory whose files are stored gzipped.
const compressPrefix = "vendor/mathjax"

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

	plain, compressed, err := copyTree(*src, *dst, "")
	if err != nil {
		fail(err)
	}
	fmt.Printf("已同步 %d 个文件（其中 %d 个压缩存放）：%s → %s\n", plain+compressed, compressed, *src, *dst)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "同步网页资源失败："+err.Error())
	os.Exit(1)
}

func compressible(rel string) bool {
	rel = filepath.ToSlash(rel)
	return rel == compressPrefix || strings.HasPrefix(rel, compressPrefix+"/")
}

// copyTree copies a directory recursively and returns how many files it wrote
// plain and how many compressed.
func copyTree(src, dst, rel string) (int, int, error) {
	entries, err := os.ReadDir(src)
	if err != nil {
		return 0, 0, err
	}
	plain, compressed := 0, 0
	for _, e := range entries {
		s := filepath.Join(src, e.Name())
		d := filepath.Join(dst, e.Name())
		r := e.Name()
		if rel != "" {
			r = filepath.Join(rel, e.Name())
		}
		if e.IsDir() {
			if err := os.MkdirAll(d, 0o755); err != nil {
				return plain, compressed, err
			}
			p, c, err := copyTree(s, d, r)
			plain += p
			compressed += c
			if err != nil {
				return plain, compressed, err
			}
			continue
		}
		// Symbolic links are followed: the repository has none today, but a
		// silently missing file inside the binary would be hard to notice.
		info, err := os.Stat(s)
		if err != nil {
			return plain, compressed, err
		}
		data, err := os.ReadFile(s)
		if err != nil {
			return plain, compressed, err
		}
		if compressible(r) {
			if err := writeGzip(d+".gz", data); err != nil {
				return plain, compressed, err
			}
			compressed++
			continue
		}
		if err := os.WriteFile(d, data, info.Mode().Perm()|0o600); err != nil {
			return plain, compressed, err
		}
		plain++
	}
	return plain, compressed, nil
}

func writeGzip(name string, data []byte) error {
	f, err := os.Create(name)
	if err != nil {
		return err
	}
	zw := gzip.NewWriter(f)
	if _, err := zw.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := zw.Close(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
