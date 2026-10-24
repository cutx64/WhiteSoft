//go:build windows

package desktop

import (
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var procShellExecute = windows.NewLazySystemDLL("shell32.dll").NewProc("ShellExecuteW")

// OpenBrowser opens a URL in the user's default browser.
//
// This is the fallback when the engine cannot start: the window needs WebView2's
// own browser process, which a confined launch context may refuse to create,
// while opening a URL only asks the shell to hand it to a program that is
// already installed and trusted.
func OpenBrowser(url string) error {
	verb, err := windows.UTF16PtrFromString("open")
	if err != nil {
		return err
	}
	target, err := windows.UTF16PtrFromString(url)
	if err != nil {
		return err
	}
	const swShowNormal = 1
	ret, _, _ := procShellExecute.Call(
		0,
		uintptr(unsafe.Pointer(verb)),
		uintptr(unsafe.Pointer(target)),
		0, 0,
		swShowNormal,
	)
	// ShellExecuteW reports values above 32 on success.
	if ret <= 32 {
		return syscall.Errno(ret)
	}
	return nil
}
