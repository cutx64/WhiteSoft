//go:build !windows

package server

import (
	"errors"
	"syscall"
)

// portBusy reports whether err means another socket already listens there.
func portBusy(err error) bool { return errors.Is(err, syscall.EADDRINUSE) }

// portDenied reports whether the system refused the port itself, as it does for
// a port below 1024 when the process is not privileged.
func portDenied(err error) bool { return errors.Is(err, syscall.EACCES) }
