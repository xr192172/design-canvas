package probe

import "sync"

// Package-level global sink for zero-dependency instrumentation.
// Probes check this before emitting; if nil, the call is a no-op.
// This avoids importing probe into every package for compile-time coupling.
var (
	globalMu   sync.RWMutex
	globalSink *Sink
)

// SetGlobalSink configures the global sink. Pass nil to disable.
func SetGlobalSink(s *Sink) {
	globalMu.Lock()
	globalSink = s
	globalMu.Unlock()
}

// Capture emits an event to the global sink (if set).
// A no-op when no sink is configured — safe to call unconditionally.
func Capture(probeName, source string, fields map[string]any) {
	globalMu.RLock()
	s := globalSink
	globalMu.RUnlock()
	if s == nil {
		return
	}
	_ = s.Emit(probeName, source, fields)
}

// CaptureErr is a convenience: captures err as a string, nil error becomes "".
func CaptureErr(probeName, source string, err error, extra map[string]any) {
	m := make(map[string]any, len(extra)+2)
	for k, v := range extra {
		m[k] = v
	}
	if err != nil {
		m["err"] = err.Error()
	} else {
		m["err"] = nil
	}
	Capture(probeName, source, m)
}