//go:build windows

package desktop

import (
	"sync/atomic"
	"syscall"
	"time"

	webview "github.com/webview/webview_go"
)

// Closing the window, whether from the close box or from Alt+F4, arrives as one
// WM_CLOSE.  The guard here holds that message back and asks the page instead,
// so a board with unsaved changes can still be saved before the window goes.
// The page answers through the bound functions: close now, or stay open.
const (
	wmClose     = 0x0010
	gwlpWndProc = ^uintptr(3) // -4 as an unsigned word
	// How long the page has to take the question up before the window closes
	// anyway.  Without it a page that never booted would make the window
	// impossible to close.
	closeGrace = 4 * time.Second
)

var (
	procCallWindowProcW   = user32.NewProc("CallWindowProcW")
	procSetWindowLongPtrW = user32.NewProc("SetWindowLongPtrW")
	procPostMessageW      = user32.NewProc("PostMessageW")
)

// closeGuard owns the window procedure subclass of the one window this program
// has.
type closeGuard struct {
	view     webview.WebView
	hwnd     uintptr
	prevProc uintptr
	approved atomic.Bool // the page let the window go
	asking   atomic.Bool // a question is on its way to the page
}

// activeGuard is read by the window procedure, which is a C callback and cannot
// carry a receiver.
var activeGuard *closeGuard

// windowProc runs before the webview's own procedure.  Every message is passed
// on unchanged except WM_CLOSE, which is swallowed until the page has answered.
var windowProc = syscall.NewCallback(func(hwnd, msg, wp, lp uintptr) uintptr {
	g := activeGuard
	if g == nil {
		return 0
	}
	if msg == wmClose && !g.approved.Load() {
		if g.asking.CompareAndSwap(false, true) {
			g.ask()
		}
		return 0
	}
	r, _, _ := procCallWindowProcW.Call(g.prevProc, hwnd, msg, wp, lp)
	return r
})

// installCloseGuard wraps the window procedure of the window `hwnd` and binds
// the two answers the page can give.  It returns nil when the window cannot be
// wrapped, and closing then behaves as it always did.
func installCloseGuard(w webview.WebView, hwnd uintptr) *closeGuard {
	if hwnd == 0 {
		return nil
	}
	g := &closeGuard{view: w, hwnd: hwnd}
	prev, _, callErr := procSetWindowLongPtrW.Call(hwnd, gwlpWndProc, windowProc)
	if prev == 0 && callErr != nil && callErr != syscall.Errno(0) {
		return nil
	}
	g.prevProc = prev
	activeGuard = g
	if err := w.Bind("whitesoftClose", func() {
		g.approved.Store(true)
		g.asking.Store(false)
		g.postClose()
	}); err != nil {
		return nil
	}
	// The page calls this as soon as it has the question in hand, which stops
	// the grace timer: the user may take as long as they like over the answer.
	_ = w.Bind("whitesoftHold", func() { g.asking.Store(false) })
	return g
}

// ask hands the question to the page.  A page without the handler closes, which
// is what a window that never loaded should do.
func (g *closeGuard) ask() {
	w := g.view
	w.Dispatch(func() {
		w.Eval(`(function () {
			var shell = window.whitesoft;
			if (shell && typeof shell.requestClose === 'function') { shell.requestClose(); return; }
			if (typeof window.whitesoftClose === 'function') window.whitesoftClose();
		})()`)
	})
	time.AfterFunc(closeGrace, func() {
		if g.asking.CompareAndSwap(true, false) {
			g.close()
		}
	})
}

// close lets the window go.
func (g *closeGuard) close() {
	g.approved.Store(true)
	g.postClose()
}

// postClose sends the close message again, now that it will pass the guard.  It
// is the only way to close from another goroutine: the window has to be
// destroyed on the thread that owns it.
func (g *closeGuard) postClose() {
	procPostMessageW.Call(g.hwnd, wmClose, 0, 0)
}
