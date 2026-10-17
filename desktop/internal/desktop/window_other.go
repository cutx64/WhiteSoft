//go:build !windows

package desktop

import "errors"

// Open is only implemented for Windows; the other platforms keep using the web
// client through `server.mjs` / `whitesoft.sh`.
func Open(opts Options) Result {
	return Result{Err: errors.New("桌面端目前只支持 Windows；其它系统请使用 whitesoft.sh 或 server.mjs")}
}
