//go:build windows

package desktop

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	procSendMessage     = user32.NewProc("SendMessageW")
	procLoadImage       = user32.NewProc("LoadImageW")
	kernel32            = windows.NewLazySystemDLL("kernel32.dll")
	procGetModuleHandle = kernel32.NewProc("GetModuleHandleW")
)

const (
	wmSetIcon   = 0x0080
	iconSmall   = 0
	iconBig     = 1
	imageIcon   = 1
	lrShared    = 0x8000
	iconIDInRC  = 1 // the icon compiled from winres/app.rc
)

// applyWindowIcon puts the program's own icon on the title bar, the taskbar and
// the Alt+Tab switcher.
//
// The window library creates its window with the stock application icon, which
// is why the title bar showed the generic Windows glyph even though the
// executable already carried the right icon. Setting it here fixes the window
// without patching the library again.
func applyWindowIcon(hwnd unsafe.Pointer) {
	if hwnd == nil {
		return
	}
	module, _, _ := procGetModuleHandle.Call(0)
	for _, c := range []struct {
		kind  uintptr
		width int32
	}{
		{iconSmall, 16},
		{iconBig, 32},
	} {
		h, _, _ := procLoadImage.Call(
			module,
			iconIDInRC,
			imageIcon,
			uintptr(c.width), uintptr(c.width),
			lrShared,
		)
		if h == 0 {
			continue
		}
		procSendMessage.Call(uintptr(hwnd), wmSetIcon, c.kind, h)
	}
}
