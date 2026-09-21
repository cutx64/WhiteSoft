package tui

import (
	"fmt"
	"os"

	tui "github.com/grindlemire/go-tui"
)

// Run starts the terminal manager and blocks until the user quits.
func Run(opts Options) error {
	m := Manager(opts)
	app, err := tui.NewApp(tui.WithRootComponent(m))
	if err != nil {
		return fmt.Errorf("启动终端界面：%w", err)
	}
	defer app.Close()

	// Any server the manager started belongs to this session.
	defer func() {
		if m.srv != nil {
			_ = m.srv.Stop()
			fmt.Fprintln(os.Stderr, "已停止 server.mjs")
		}
	}()

	if err := app.Run(); err != nil {
		return fmt.Errorf("终端界面异常退出：%w", err)
	}
	return nil
}
