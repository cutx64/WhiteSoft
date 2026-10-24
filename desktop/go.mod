module github.com/cutx64/WhiteSoft/desktop

go 1.25.1

require (
	github.com/webview/webview_go v0.0.0-20240831120633-6173450d4dd6
	golang.org/x/sys v0.40.0
)

// 本地副本：上游 webview.h 在没有 WebView2 时会解引用空指针并崩溃，
// 这里补上了空指针保护，见 tools/patch-webview。
replace github.com/webview/webview_go => ./third_party/webview_go
