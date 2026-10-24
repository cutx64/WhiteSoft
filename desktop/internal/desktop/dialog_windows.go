//go:build windows

package desktop

import (
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32         = windows.NewLazySystemDLL("user32.dll")
	procMessageBox = user32.NewProc("MessageBoxW")
)

const (
	mbOK              = 0x00000000
	mbIconError       = 0x00000010
	mbIconWarning     = 0x00000030
	mbIconInformation = 0x00000040
	mbSetForeground   = 0x00010000
)

// ShowError reports a startup failure to the user in a native dialog.
//
// A `-H windowsgui` build has no console, so writing to stderr is writing to
// nowhere: the window simply never appears and the program looks broken. A
// message box is the only way such a failure can explain itself.
func ShowError(title, message string) {
	showDialog(title, message, mbIconError)
}

// ShowInfo reports a successful diagnostic result the same way.
func ShowInfo(title, message string) {
	showDialog(title, message, mbIconInformation)
}

func showDialog(title, message string, flags uintptr) {
	t, err := windows.UTF16PtrFromString(title)
	if err != nil {
		return
	}
	m, err := windows.UTF16PtrFromString(message)
	if err != nil {
		return
	}
	procMessageBox.Call(
		0,
		uintptr(unsafe.Pointer(m)),
		uintptr(unsafe.Pointer(t)),
		flags|mbOK|mbSetForeground,
	)
}

// ConsoleAttached reports whether the process owns a console window, which
// tells a `-H windowsgui` build apart from a console build.
func ConsoleAttached() bool {
	procGetConsoleWindow := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetConsoleWindow")
	h, _, _ := procGetConsoleWindow.Call()
	return h != 0
}

// consoleReady records whether output can reach a terminal, either because the
// process owns a console or because it borrowed the parent's.
var consoleReady = ConsoleAttached()

// ConsoleReady reports whether printed output reaches a terminal.
func ConsoleReady() bool { return consoleReady }

const (
	fileTypeDisk = 1
	fileTypeChar = 2
	fileTypePipe = 3
)

// StdoutUsable reports whether anything written to standard output can be read.
//
// Inheriting a handle is not the same as someone seeing it: a program started
// from Explorer gets no standard handles at all, so an error written there
// disappears. What matters is what the handle is attached to. A console, a pipe
// and a file all lead somewhere a person or a script can look; an unknown
// handle leads nowhere, and then a dialog is the only way to say anything.
func StdoutUsable() bool {
	if consoleReady {
		return true
	}
	procGetFileType := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetFileType")
	t, _, _ := procGetFileType.Call(os.Stdout.Fd())
	switch t {
	case fileTypeDisk, fileTypeChar, fileTypePipe:
		return true
	}
	return false
}

// StreamKind names what a standard stream is attached to, for the startup log.
func StreamKind(f *os.File) string {
	if f == nil {
		return "none"
	}
	procGetFileType := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetFileType")
	t, _, _ := procGetFileType.Call(f.Fd())
	switch t {
	case fileTypeDisk:
		return "file"
	case fileTypeChar:
		return "char"
	case fileTypePipe:
		return "pipe"
	}
	return "unknown"
}

// PrepareConsole makes output visible in both launch styles.
//
// A window build has no console of its own, which is what stops a black window
// flashing on a double click. Started from a shell it can borrow that shell's
// console instead, so `--version`, `serve` and error messages still print where
// the user expects them. When there is no parent console nothing happens and
// failures are reported with a dialog instead.
func PrepareConsole() {
	if consoleReady {
		return
	}
	procAttach := windows.NewLazySystemDLL("kernel32.dll").NewProc("AttachConsole")
	const attachParentProcess = ^uintptr(0)
	if r, _, _ := procAttach.Call(attachParentProcess); r == 0 {
		return
	}
	if f, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0); err == nil {
		os.Stdout = f
		os.Stderr = f
	}
	if f, err := os.OpenFile("CONIN$", os.O_RDONLY, 0); err == nil {
		os.Stdin = f
	}
	consoleReady = true
}
