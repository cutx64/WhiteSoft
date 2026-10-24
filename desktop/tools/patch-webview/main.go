// Command patchwebview applies the fixes the vendored webview library needs.
//
// Two problems, both fatal when the WebView2 environment cannot be created,
// which happens when another process still holds the profile directory:
//
//  1. `m_webview` is dereferenced without a null check, so the first call
//     raises an access violation that kills the process before it can report
//     anything. Those call sites get a guard.
//  2. Nothing exposes whether the engine actually came up, so the program
//     cannot tell a working window from an empty one. `webview_engine_ready`
//     is added for that.
//
// Running it twice is harmless: an already patched tree is left alone.
//
//	go run ./tools/patch-webview
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// edit is one replacement. want must occur exactly once in an unpatched file;
// when it occurs zero times and with is already present, the file is patched.
type edit struct {
	want string
	with string
}

var edits = []edit{
	// The query itself, declared next to the other C entry points.
	{
		want: "WEBVIEW_API void webview_navigate(webview_t w, const char *url);",
		with: "WEBVIEW_API void webview_navigate(webview_t w, const char *url);\n\n" +
			"// Returns 1 once the engine is up and can accept a page, 0 otherwise.\n" +
			"WEBVIEW_API int webview_engine_ready(webview_t w);",
	},
	{
		want: "WEBVIEW_API void webview_navigate(webview_t w, const char *url) {",
		with: "WEBVIEW_API int webview_engine_ready(webview_t w) {\n" +
			"  if (!w) {\n" +
			"    return 0;\n" +
			"  }\n" +
			"  return static_cast<webview::webview *>(w)->engine_ready() ? 1 : 0;\n" +
			"}\n\n" +
			"WEBVIEW_API void webview_navigate(webview_t w, const char *url) {",
	},
	// Base class: everything but the Windows engine is always ready.
	{
		want: "protected:\n  virtual void navigate_impl(const std::string &url) = 0;",
		with: "protected:\n  virtual bool engine_ready_impl() const { return true; }\n" +
			"  virtual void navigate_impl(const std::string &url) = 0;",
	},
	{
		want: "  void set_html(const std::string &html) { set_html_impl(html); }",
		with: "  bool engine_ready() const { return engine_ready_impl(); }\n" +
			"  void set_html(const std::string &html) { set_html_impl(html); }",
	},
	// The four unguarded call sites.
	{
		want: "  void navigate_impl(const std::string &url) override {\n" +
			"    auto wurl = widen_string(url);\n" +
			"    m_webview->Navigate(wurl.c_str());\n" +
			"  }",
		with: "  bool engine_ready_impl() const override { return m_webview != nullptr; }\n\n" +
			"  void navigate_impl(const std::string &url) override {\n" +
			"    if (!m_webview) {\n" +
			"      return;\n" +
			"    }\n" +
			"    auto wurl = widen_string(url);\n" +
			"    m_webview->Navigate(wurl.c_str());\n" +
			"  }",
	},
	{
		want: "  void init_impl(const std::string &js) override {\n" +
			"    auto wjs = widen_string(js);\n" +
			"    m_webview->AddScriptToExecuteOnDocumentCreated(wjs.c_str(), nullptr);\n" +
			"  }",
		with: "  void init_impl(const std::string &js) override {\n" +
			"    if (!m_webview) {\n" +
			"      return;\n" +
			"    }\n" +
			"    auto wjs = widen_string(js);\n" +
			"    m_webview->AddScriptToExecuteOnDocumentCreated(wjs.c_str(), nullptr);\n" +
			"  }",
	},
	{
		want: "  void eval_impl(const std::string &js) override {\n" +
			"    auto wjs = widen_string(js);\n" +
			"    m_webview->ExecuteScript(wjs.c_str(), nullptr);\n" +
			"  }",
		with: "  void eval_impl(const std::string &js) override {\n" +
			"    if (!m_webview) {\n" +
			"      return;\n" +
			"    }\n" +
			"    auto wjs = widen_string(js);\n" +
			"    m_webview->ExecuteScript(wjs.c_str(), nullptr);\n" +
			"  }",
	},
	{
		want: "  void set_html_impl(const std::string &html) override {\n" +
			"    m_webview->NavigateToString(widen_string(html).c_str());\n" +
			"  }",
		with: "  void set_html_impl(const std::string &html) override {\n" +
			"    if (!m_webview) {\n" +
			"      return;\n" +
			"    }\n" +
			"    m_webview->NavigateToString(widen_string(html).c_str());\n" +
			"  }",
	},
}

func main() {
	root := flag.String("root", filepath.Join("third_party", "webview_go"), "vendored webview package")
	flag.Parse()

	header := filepath.Join(*root, "libs", "webview", "include", "webview.h")
	binding := filepath.Join(*root, "webview.go")

	if err := patchFile(header, edits, true); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	// The Go binding needs to expose the new query too.
	bindingEdits := []edit{
		{
			want: "\t// Run runs the main loop until it's terminated. After this function exits -",
			with: "\t// EngineReady reports whether the engine came up and can accept a page.\n" +
				"\tEngineReady() bool\n\n" +
				"\t// Run runs the main loop until it's terminated. After this function exits -",
		},
		{
			want: "func (w *webview) Run() {",
			with: "func (w *webview) EngineReady() bool { return C.webview_engine_ready(w.w) != 0 }\n\n" +
				"func (w *webview) Run() {",
		},
	}
	if err := patchFile(binding, bindingEdits, false); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// patchFile applies every edit once. It reports whether anything changed and
// restores the original line endings, because the header is compiled by a
// Windows toolchain while the patterns above are written with plain newlines.
func patchFile(path string, list []edit, crlf bool) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("读取 %s 失败：%w", path, err)
	}
	hasCRLF := strings.Contains(string(raw), "\r\n")
	text := strings.ReplaceAll(string(raw), "\r\n", "\n")

	applied, skipped := 0, 0
	for _, e := range list {
		// Ask about the patched form first: most anchors stay in the file after
		// patching, so counting them first would apply the same edit twice.
		if strings.Contains(text, e.with) {
			skipped++
			continue
		}
		switch strings.Count(text, e.want) {
		case 1:
			text = strings.Replace(text, e.want, e.with, 1)
			applied++
		case 0:
			return fmt.Errorf("补丁锚点找不到：%s", strings.SplitN(e.want, "\n", 2)[0])
		default:
			return fmt.Errorf("补丁锚点出现多次：%s", strings.SplitN(e.want, "\n", 2)[0])
		}
	}

	if applied == 0 {
		fmt.Printf("已打过补丁，无需修改：%s\n", path)
		return nil
	}
	out := text
	if hasCRLF && crlf {
		out = strings.ReplaceAll(out, "\n", "\r\n")
	}
	if err := os.WriteFile(path, []byte(out), 0o644); err != nil {
		return fmt.Errorf("写回 %s 失败：%w", path, err)
	}
	fmt.Printf("已修补 %s：新增 %d 处，跳过 %d 处\n", path, applied, skipped)
	return nil
}
