//go:build windows

package server

import (
	"errors"
	"syscall"
)

// The two Windows socket errors a bind can fail with that are worth telling
// apart: an address someone else holds, and an address the system refuses to
// hand out because a reserved block covers it.
const (
	wsaEADDRINUSE = syscall.Errno(10048)
	wsaEACCES     = syscall.Errno(10013)
)

// portBusy reports whether err means another socket already listens there.
func portBusy(err error) bool { return errors.Is(err, wsaEADDRINUSE) }

// portDenied reports whether the system refused the port itself, which on
// Windows means a reservation such as the ones Hyper-V, WSL and Docker make.
func portDenied(err error) bool { return errors.Is(err, wsaEACCES) }
