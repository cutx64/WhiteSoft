//go:build !windows

package desktop

import (
	"fmt"
	"os/exec"
	"runtime"
)

// OpenBrowser opens a URL in the user's default browser.
func OpenBrowser(url string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", url).Start()
	default:
		if err := exec.Command("xdg-open", url).Start(); err != nil {
			return fmt.Errorf("无法打开浏览器：%w", err)
		}
		return nil
	}
}
