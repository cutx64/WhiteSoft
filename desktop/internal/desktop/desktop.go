// Package desktop puts the running server into a native window.
//
// On Windows that window is a WebView2 control (part of Windows 10/11), so the
// client runs in the same Chromium engine the browser version targets: Canvas
// 2D, ES modules, the File System Access API for opening and writing `.note`
// files in place, PDF.js and MathJax all behave exactly as they do in a tab.
package desktop

// Options describes the window.
type Options struct {
	Title  string // window title
	URL    string // address to show (the in-process server)
	Width  int    // initial width in logical pixels
	Height int    // initial height in logical pixels
	Debug  bool   // enable the engine's developer tools / context menu
}

// Result says why the window closed.
type Result struct {
	// Err is non-nil when the window could not be opened at all (for example a
	// machine without the WebView2 runtime).
	Err error
}

func (o Options) withDefaults() Options {
	if o.Title == "" {
		o.Title = "WhiteSoft"
	}
	if o.Width <= 0 {
		o.Width = 1440
	}
	if o.Height <= 0 {
		o.Height = 900
	}
	return o
}
