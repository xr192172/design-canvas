// Package probe — c7 correlation ID（关键设计）。
//
// 链路串联靠 trace id：调用进入时生成、层层显式传递。
// 否决方案：全局变量隐式传递——Go goroutine / TS async 下不成立。
// 落地方式：trace id 经 context.Context 显式流动（Go 惯用法），
// 嵌套调用自动继承父 frame id，错误触发时才能捞整条链路上下文。
//
// 用法（插桩器注入或手写）：
//
//	func (s *Svc) Handle(ctx context.Context, req *Req) (*Resp, error) {
//	    ctx, sp := probe.Enter(ctx, "svc.Handle", nil)
//	    defer sp.Exit()
//	    ...
//	    if err != nil {
//	        sp.Catch(err) // 触发错误开箱导出（同 trace id 整条链路窗口）
//	        return nil, err
//	    }
//	}
package probe

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync/atomic"
	"time"
)

// trace 字段（c7）定义在 probe.go 的 Event 上（omitempty，v1 读者兼容）。

var frameSeq atomic.Uint64

// Scope 承载一次函数调用的采集作用域：enter/exit 配对（耗时→直方图）、
// catch 触发错误开箱导出。
type Scope struct {
	t         *Tiered
	probe     string // 基础探针名，如 "svc.Handle"（enter/exit/catch 加后缀）
	traceID   string
	frameID   uint64
	parentID  uint64
	start     time.Time
	exported  atomic.Bool // Catch 已触发导出（一帧只导一次）
}

type scopeCtxKey struct{}

// Enter 进入一个调用作用域：
//   - ctx 里已有父 Scope → 继承 trace id，记 parent frame
//   - 无父 → 生成新 trace id（根）
//   - 发出 "<probe>.enter" 事件（计数器+环形缓冲）
func Enter(ctx context.Context, probe string, fields map[string]any) (context.Context, *Scope) {
	t := globalTieredFor()
	sp := &Scope{
		t:       t,
		probe:   probe,
		frameID: frameSeq.Add(1),
		start:   time.Now(),
	}
	if parent := ScopeFromContext(ctx); parent != nil {
		sp.traceID = parent.traceID
		sp.parentID = parent.frameID
	} else {
		sp.traceID = newTraceID()
	}
	if t != nil {
		t.Emit(Event{
			Probe: probe + ".enter", Time: sp.start, Source: "v2-scope",
			Fields: fields, TraceID: sp.traceID, FrameID: sp.frameID, ParentID: sp.parentID,
		})
	}
	return context.WithValue(ctx, scopeCtxKey{}, sp), sp
}

// Exit 退出作用域：发出 "<probe>.exit"（带耗时），耗时记入直方图（c4）。
// 幂等：多次调用只记一次。
func (s *Scope) Exit(fields map[string]any) {
	if s == nil || s.t == nil {
		return
	}
	d := time.Since(s.start)
	if fields == nil {
		fields = map[string]any{}
	}
	fields["dur_ms"] = float64(d.Microseconds()) / 1000.0
	s.t.Emit(Event{
		Probe: s.probe + ".exit", Time: time.Now(), Source: "v2-scope",
		Fields: fields, TraceID: s.traceID, FrameID: s.frameID, ParentID: s.parentID,
	})
	s.t.recordDuration(s.probe, d)
}

// Catch 记录一次错误：err 计数器 +1，并触发错误开箱导出（c6，经 c8 限流门）。
// 一帧只导出一次（重复 Catch 只计数）。
func (s *Scope) Catch(err error, fields map[string]any) {
	if s == nil || s.t == nil {
		return
	}
	f := map[string]any{}
	for k, v := range fields {
		f[k] = v
	}
	if err != nil {
		f["err"] = err.Error()
	} else {
		f["err"] = nil
	}
	s.t.Emit(Event{
		Probe: s.probe + ".catch", Time: time.Now(), Source: "v2-scope",
		Fields: f, TraceID: s.traceID, FrameID: s.frameID, ParentID: s.parentID,
	})
	// 首次 Catch 且确有错误才导出（一帧最多一次）
	if err != nil && s.exported.CompareAndSwap(false, true) {
		s.t.exportIncident(s, err)
	}
}

// ScopeFromContext 取当前 ctx 里的 Scope（无则 nil）。
func ScopeFromContext(ctx context.Context) *Scope {
	if ctx == nil {
		return nil
	}
	sp, _ := ctx.Value(scopeCtxKey{}).(*Scope)
	return sp
}

// TraceIDFromContext 取当前 trace id（无作用域返回空串）。
func TraceIDFromContext(ctx context.Context) string {
	if sp := ScopeFromContext(ctx); sp != nil {
		return sp.traceID
	}
	return ""
}

// newTraceID 生成 16 字符十六进制随机 id（crypto/rand，128bit 碰撞可忽略）。
func newTraceID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand 失败极罕见（系统熵池枯竭）；退化为时间戳仍然唯一可用
		return time.Now().UTC().Format("20060102150405.000000000")
	}
	return hex.EncodeToString(b[:])
}
