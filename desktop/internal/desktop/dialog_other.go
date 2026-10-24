//go:build !windows

package desktop

import (
	"fmt"
	"os"
)

// ShowError reports a startup failure. Other platforms always have a terminal,
// so the message goes to standard error.
func ShowError(title, message string) {
	fmt.Fprintf(os.Stderr, "%s: %s\n", title, message)
}

// ShowInfo reports a diagnostic result.
func ShowInfo(title, message string) {
	fmt.Fprintf(os.Stderr, "%s: %s\n", title, message)
}

// ConsoleAttached is always true away from Windows.
func ConsoleAttached() bool { return true }
