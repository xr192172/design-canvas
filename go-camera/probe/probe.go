// Package probe implements the "camera" layer of dynamic instrumentation.
//
// Coverage counters (go tool cover) are the "stopwatch" — they say how often a
// path runs. Probes are the "camera": they capture the actual data values
// flowing through a point (args, return values, error values) and emit them as
// structured JSONL. A contract judge then compares each snapshot against a
// declared expectation and flags deviations.
//
// 2026-08-16 防写爆重构（磁盘满事故复盘：热路径探针曾写出 161GB 事件文件；
// 修复落于历史本地分叉，2026-08-18 回迁归位到 go-camera）：
//   - 容量轮转：事件文件按环形缓冲（默认 6 × 64MB ≈ 384MB 封顶）轮转，
//     热路径无论多频繁都不会写爆磁盘。
//   - 每探针限速：默认 200 事件/秒/探针（token bucket），超速丢弃。
//   - 异味抽离（降级保全）：轮转覆盖某个槽位前，用快车道规则把判定为
//     deviation 的事件抽到独立的 deviations.jsonl（附规则与理由），
//     该槽位随后清空（O_TRUNC）。环形缓冲覆盖丢失的只是正常噪音，
//     有价值的行为偏差永不丢。
//
// v2 分级采集 runtime（Tiered，见 tiered.go）：本文件的全量 JSONL Sink 作为
// 可选的"全量镜像"模式保留（conformance/调试）；生产默认走 Tiered
//（计数器+直方图+环形缓冲，平时零磁盘）。
package probe

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Event is one data snapshot captured at a probe point.
type Event struct {
	Probe    string         `json:"probe"`              // probe point id, e.g. "save.writefile"
	Time     time.Time      `json:"time"`               // capture timestamp
	Source   string         `json:"source"`             // where the expectation comes from: static-rule / llm-design / runtime-invariant
	Fields   map[string]any `json:"fields"`             // captured values (err, path, bytes, benign...)
	TraceID  string         `json:"trace_id,omitempty"` // c7: 整条调用链共享的 trace id
	FrameID  uint64         `json:"frame_id,omitempty"` // c7: 本帧唯一 id（每次调用一个）
	ParentID uint64         `json:"parent_id,omitempty"` // c7: 父调用帧 id（0=根）
}

// DeviationEntry records one preserved deviation: the raw event plus why it
// deviates (rule + reason). deviations.jsonl is a self-contained audit trail
// the camera-dsl loop can read directly.
type DeviationEntry struct {
	Event  Event     `json:"event"`
	Rule   string    `json:"rule"`   // rule id that fired
	Reason string    `json:"reason"` // why it deviates
	At     time.Time `json:"at"`     // when it was extracted
}

// Sink defaults for the event ring buffer.
const (
	DefaultRotationMB = 64    // per-file cap (MB)
	DefaultMaxFiles   = 6     // ring size → ~384MB ceiling
	DefaultRateLimit  = 200.0 // events/second per probe
	DefaultDevMB      = 256   // deviation file cap (MB), rotates to deviations.jsonl.1
)

// Sink appends probe events to a JSONL ring. The append path is hot; rotation,
// rate limiting and deviation extraction are cheap so Emit stays fast. Rotation
// is bounded by DefaultMaxFiles × DefaultRotationMB.
type Sink struct {
	mu         sync.Mutex
	path       string // base events file path
	dir        string
	rotationMB int64
	maxFiles   int
	activeIdx  int
	fh         *os.File
	size       int64 // current file bytes

	devPath string
	devMB   int64

	judge    *Judge     // fast-path rule judge; nil disables deviation extraction
	llmJudge *LLMJudge // slow-path LLM re-check on rule-flagged deviations; nil = rule-only
	llmu     sync.RWMutex // guards llmJudge (SetLLMJudge may run outside the sink's mu)

	rl *rateLimiter
}

// NewSink opens (or creates) path for appending and returns a Sink with the
// default ring configuration. An existing file is appended to (its deviations
// survive until the ring recycles it), so a crashed run's data is not lost.
func NewSink(path string) (*Sink, error) {
	s := &Sink{
		path:       path,
		dir:        filepath.Dir(path),
		rotationMB: DefaultRotationMB,
		maxFiles:   DefaultMaxFiles,
		devMB:      DefaultDevMB,
		rl:         newRateLimiter(DefaultRateLimit, DefaultRateLimit),
	}
	s.devPath = filepath.Join(s.dir, "deviations.jsonl")
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return nil, err
	}
	fh, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	s.fh = fh
	if fi, err := fh.Stat(); err == nil {
		s.size = fi.Size()
	}
	return s, nil
}

// SetMaxFiles configures the ring size (≥1). Total ceiling = MaxFiles × RotationMB.
func (s *Sink) SetMaxFiles(n int) *Sink {
	s.maxFiles = max(1, n)
	return s
}

// SetRotationMB configures the per-file cap in MB (≥1).
func (s *Sink) SetRotationMB(n int64) *Sink {
	s.rotationMB = max(1, n)
	return s
}

// SetRateLimit configures the per-probe token refill rate in events/second.
// perSec ≤ 0 disables rate limiting entirely.
func (s *Sink) SetRateLimit(perSec float64) *Sink {
	if perSec <= 0 {
		s.rl = nil
	} else {
		s.rl = newRateLimiter(perSec, perSec)
	}
	return s
}

// SetDeviationPath overrides the deviation preservation file (default
// deviations.jsonl next to the event file).
func (s *Sink) SetDeviationPath(p string) *Sink {
	s.devPath = p
	return s
}

// SetDeviationMB configures the deviation file cap in MB (≥1). When exceeded
// the current file is rotated to deviations.jsonl.1, bounding preserved
// deviations to ~2×DevMB worst case.
func (s *Sink) SetDeviationMB(n int64) *Sink {
	s.devMB = max(1, n)
	return s
}

// SetJudge attaches the fast-path rule judge used to pick deviations out of a
// rotating slot before it is cleared. nil disables extraction.
func (s *Sink) SetJudge(j *Judge) *Sink {
	s.judge = j
	return s
}

// SetLLMJudge attaches the slow-path LLM re-check. When non-nil, rule-flagged
// deviations are sent to the LLM for behavior-level confirmation before being
// preserved; the LLM verdict (ok/deviation) overrides the rule verdict. nil
// keeps rule-only extraction. Takes precedence over the global judge installed
// via SetGlobalLLMJudge.
func (s *Sink) SetLLMJudge(j *LLMJudge) *Sink {
	s.llmu.Lock()
	s.llmJudge = j
	s.llmu.Unlock()
	return s
}

// llmJudgeFor returns the active LLM judge: the one explicitly attached via
// SetLLMJudge wins; otherwise falls back to the globally installed judge.
// This decouples the assembly order — main.go creates the Sink before the
// Router exists, bootstrap wires the judge later.
func (s *Sink) llmJudgeFor() *LLMJudge {
	s.llmu.RLock()
	j := s.llmJudge
	s.llmu.RUnlock()
	if j != nil {
		return j
	}
	return GetGlobalLLMJudge()
}

// Emit serializes and appends one event. Rate-limited per probe; over-rate
// events are dropped so the ring stays bounded. Rotation happens in-place when
// the current file exceeds its cap.
func (s *Sink) Emit(probeName, source string, fields map[string]any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	if s.rl != nil && !s.rl.allow(probeName, now) {
		return nil // rate-limited drop — probe too chatty; keep the ring bounded
	}
	ev := Event{Probe: probeName, Time: now, Source: source, Fields: fields}
	data, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	n, err := s.fh.Write(append(data, '\n'))
	if err != nil {
		return err
	}
	s.size += int64(n)
	if s.size >= s.rotationMB*1024*1024 {
		return s.rotateLocked(now)
	}
	return nil
}

// Close flushes and closes the active file. The ring is left intact (its
// deviations are extracted when the ring recycles each slot), so this is a
// safe point for a clean shutdown.
func (s *Sink) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fh == nil {
		return nil
	}
	err := s.fh.Close()
	s.fh = nil
	return err
}

// rotateLocked advances to the next ring slot. Before truncating the slot we
// are about to enter, its historical deviations are preserved to devPath.
func (s *Sink) rotateLocked(now time.Time) error {
	if err := s.fh.Close(); err != nil {
		return err
	}
	s.fh = nil
	nextIdx := (s.activeIdx + 1) % s.maxFiles
	nextPath := s.filePath(nextIdx)

	var extractErr error
	if s.judge != nil {
		extractErr = s.extractLocked(nextPath, now)
	}
	fh, err := os.OpenFile(nextPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	s.fh = fh
	s.size = 0
	s.activeIdx = nextIdx
	return extractErr
}

// extractLocked reads a ring slot line by line, judges each event with the
// fast-path rules, and appends deviations to devPath. Best-effort: corrupt
// lines are skipped; the slot is still cleared by the caller afterwards.
//
// 2026-08-16 超长行修复：改用 bufio.Reader.ReadBytes 逐行读取而非
// bufio.Scanner——Scanner 有 1MB 行上限，遇到超长事件行（实测探针捕获整段
// LLM 流式消息可达 10MB+）会 ErrTooLong 直接中止抽离，导致该槽位剩余偏差
// 全部静默丢失。ReadBytes 无固定行上限，长行最多多占一点内存，不打断抽离。
func (s *Sink) extractLocked(path string, now time.Time) error {
	fh, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	defer fh.Close()

	br := bufio.NewReaderSize(fh, 64*1024)
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			line = bytes.TrimSpace(line)
			if len(line) > 0 {
				var ev Event
				if json.Unmarshal(line, &ev) != nil {
					continue // corrupt line — not extractable
				}
				v := s.judge.JudgeEvent(ev)
				if v.Result != "deviation" {
					continue
				}
				// 慢车道：LLM 行为级复核（同步，最坏 j.timeout 阻塞轮转）。
				// LLM 判 ok → 规则误报被纠正，不保留；判 deviation → 保留并用
				// LLM 的 rule/reason 覆盖；调用失败 → 降级保留（安全侧，宁多留不漏报）。
				if j := s.llmJudgeFor(); j != nil {
					lv, lerr := j.JudgeEvent(context.Background(), ev)
					if lerr == nil && lv.Result == "ok" {
						continue // LLM 纠正了规则误报
					}
					if lerr == nil && lv.Result == "deviation" {
						v.Rule = lv.Rule
						v.Reason = lv.Reason
					}
					// lerr != nil → 保留规则版判定（降级）
				}
				if err := s.appendDeviationLocked(DeviationEntry{
					Event:  ev,
					Rule:   v.Rule,
					Reason: v.Reason,
					At:     now,
				}); err != nil {
					return err
				}
			}
		}
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}

// appendDeviationLocked appends one deviation to devPath, rotating the
// deviation file to deviations.jsonl.1 when it exceeds devMB.
func (s *Sink) appendDeviationLocked(entry DeviationEntry) error {
	if s.devPath == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(s.devPath), 0o755); err != nil {
		return err
	}
	if fi, err := os.Stat(s.devPath); err == nil && fi.Size() >= s.devMB*1024*1024 {
		_ = os.Rename(s.devPath, s.devPath+".1") // bounded: keep only latest + previous
	}
	fh, err := os.OpenFile(s.devPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer fh.Close()
	data, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	_, err = fh.Write(append(data, '\n'))
	return err
}

// filePath returns the ring slot path. Slot 0 is the base path; slots 1..N-1
// append ".1"..".N-1" to it.
func (s *Sink) filePath(idx int) string {
	if idx == 0 {
		return s.path
	}
	return fmt.Sprintf("%s.%d", s.path, idx)
}

// rateLimiter is a per-probe token bucket. Memory is bounded: buckets not seen
// for 5 minutes are purged during a periodic sweep.
type rateLimiter struct {
	mu        sync.Mutex
	rate      float64 // tokens refilled per second
	burst     float64 // max tokens a bucket can hold
	buckets   map[string]*tokenBucket
	lastPurge time.Time
}

type tokenBucket struct {
	tokens float64
	last   time.Time
}

func newRateLimiter(rate, burst float64) *rateLimiter {
	return &rateLimiter{
		rate:      rate,
		burst:     burst,
		buckets:   make(map[string]*tokenBucket),
		lastPurge: time.Now(),
	}
}

// allow reports whether an emit for probe should proceed (consumes a token).
func (rl *rateLimiter) allow(probe string, now time.Time) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	if now.Sub(rl.lastPurge) > time.Minute {
		for k, b := range rl.buckets {
			if now.Sub(b.last) > 5*time.Minute {
				delete(rl.buckets, k)
			}
		}
		rl.lastPurge = now
	}

	b := rl.buckets[probe]
	if b == nil {
		b = &tokenBucket{tokens: rl.burst, last: now}
		rl.buckets[probe] = b
	}
	elapsed := now.Sub(b.last).Seconds()
	b.tokens = min(rl.burst, b.tokens+elapsed*rl.rate)
	b.last = now
	if b.tokens >= 1 {
		b.tokens--
		return true
	}
	return false
}
