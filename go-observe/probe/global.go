package probe

import (
	"sync"
	"time"
)

// Package-level globals for zero-dependency instrumentation.
// Probes check these before emitting; if nil, the call is a no-op.
// This avoids importing probe into every package for compile-time coupling.
//
// v2 路由优先级：Tiered（分级采集）→ legacy Sink（JSONL 全量）→ no-op。
// 旧插桩代码（Capture/CaptureErr）零改动自动进入 v2 runtime。
var (
	globalMu   sync.RWMutex
	globalSink *Sink
	globalTier *Tiered

	globalLLMMu    sync.RWMutex
	globalLLMJudge *LLMJudge
)

// SetGlobalSink configures the legacy JSONL sink. Pass nil to disable.
// （兼容保留：v1 全量落盘模式，conformance/调试用。）
func SetGlobalSink(s *Sink) {
	globalMu.Lock()
	globalSink = s
	globalMu.Unlock()
}

// SetGlobalTiered 配置 v2 分级采集 runtime。设置后 Capture 全部路由到它。
func SetGlobalTiered(t *Tiered) {
	globalMu.Lock()
	globalTier = t
	globalMu.Unlock()
}

// globalTieredFor 返回全局 Tiered（trace.go 的 Enter 使用）。
func globalTieredFor() *Tiered {
	globalMu.RLock()
	defer globalMu.RUnlock()
	return globalTier
}

// SetGlobalLLMJudge installs the global slow-path LLM judge. Bootstrap wires
// it after the Router is created (main.go creates the Sink earlier, before the
// Router exists); Sink.llmJudgeFor falls back to this when no judge was
// explicitly attached. Pass nil to disable.
func SetGlobalLLMJudge(j *LLMJudge) {
	globalLLMMu.Lock()
	globalLLMJudge = j
	globalLLMMu.Unlock()
}

// GetGlobalLLMJudge returns the currently installed global LLM judge (nil if
// none). Reads are lock-guarded; the returned pointer is never mutated after
// installation.
func GetGlobalLLMJudge() *LLMJudge {
	globalLLMMu.RLock()
	defer globalLLMMu.RUnlock()
	return globalLLMJudge
}

// Capture emits an event to the global runtime (if set).
// A no-op when no sink is configured — safe to call unconditionally.
// v2：优先走 Tiered（计数器+环形缓冲+可选开箱导出）。
func Capture(probeName, source string, fields map[string]any) {
	globalMu.RLock()
	t := globalTier
	s := globalSink
	globalMu.RUnlock()
	if t != nil {
		t.Emit(Event{Probe: probeName, Time: time.Now(), Source: source, Fields: fields})
		return
	}
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
