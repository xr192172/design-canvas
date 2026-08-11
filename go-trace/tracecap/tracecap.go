// Package tracecap is a compile-time instrumentation capture library.
//
// 设计目标：给 AI base 项目做「函数级仿真」的原材料采集。
// trace-implant 工具在编译期用 go/ast 重写源码，为每个函数注入
//   frameID := ttc.TraceEntry(fn, file, line, name0, val0, name1, val1, ...)
//   defer ttc.TraceExit(frameID, resultName, resultValue)
// 编译出的二进制在运行时自动记录每个函数的调用、入参、出参和 token 成本，
// 落盘为 trace JSON，作为后续接入 design-canvas 仿真（Reasoning DSL）的原材料。
//
// 并发模型：主 agent loop 串行调用上下文引擎，本包用全局调用栈记录
// 嵌套/parent 关系。对串行驱动正确；并发场景 parent 可能不精确，但调用
// 记录本身线程安全。
package tracecap

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"unicode"
)

// Record 是一次函数调用。
type Record struct {
	ID     int            `json:"id"`
	Parent int            `json:"parent"`         // 父调用 frame id，0=根
	Fn     string         `json:"fn"`             // 限定名 pkg.Type.Method 或 pkg.Func
	File   string         `json:"file"`           // 仅文件名
	Line   int            `json:"line"`           // 函数第一行
	Args   string         `json:"args"`           // 入参 recap
	Result string         `json:"result"`         // 出参 recap，void 为 ""
	Tokens int            `json:"tokens"`         // 本次调用估算 token 成本
	Depth  int            `json:"depth"`          // 调用深度
	Order  int64          `json:"order"`          // 全局单调调用序号
	Meta   map[string]any `json:"meta,omitempty"` // 额外信息（如 round）
}

// Trace 是整次运行的全部原始数据。
type Trace struct {
	Version int              `json:"version"`
	Rounds  int              `json:"rounds"`
	Root    string           `json:"root"` // 驱动入口函数，如 v2.NewV2Manager
	Records []Record         `json:"records"`
	Meta    TraceMeta        `json:"meta"`
}

// TraceMeta 记录运行级元信息。
type TraceMeta struct {
	SessionID string `json:"session_id,omitempty"`
	StartedAt string `json:"started_at,omitempty"`
	Finished  bool   `json:"finished"`
}

var (
	mu       sync.Mutex
	records  []Record
	stack    []int // frame id 栈顶 = 当前父调用
	nextID   int   // 帧 id 从 1 开始
	orderSeq int64 // 全局调用序号
)

// ── 运行时探针 ──

// TraceEntry 记录函数入口，返回 frameID 供 TraceExit 配对。
// pairs 为 [name0, val0, name1, val1, ...] 交替的入参名/值。
func TraceEntry(fn, file string, line int, pairs ...interface{}) int {
	recap := buildRecap(pairs)
	tokens := countTokens(recap) + countTokens(fn)

	mu.Lock()
	parent := 0
	if len(stack) > 0 {
		parent = stack[len(stack)-1]
	}
	id := nextID
	nextID++
	rec := Record{
		ID:     id,
		Parent: parent,
		Fn:     fn,
		File:   filepath.Base(file),
		Line:   line,
		Args:   recap,
		Tokens: tokens,
		Depth:  len(stack),
		Order:  atomic.AddInt64(&orderSeq, 1),
	}
	records = append(records, rec)
	stack = append(stack, id)
	mu.Unlock()
	return id
}

// TraceExit 记录函数出口。resultName 为空表示 void 函数。
func TraceExit(frameID int, resultName string, result interface{}) {
	resultRecap := ""
	if resultName != "" {
		resultRecap = fmt.Sprintf("%s=%s", resultName, fmt.Sprintf("%v", result))
	}
	mu.Lock()
	defer mu.Unlock()
	// 弹出栈：保证栈一致
	for i := len(stack) - 1; i >= 0; i-- {
		if stack[i] == frameID {
			stack = stack[:i]
			break
		}
	}
	for i := range records {
		if records[i].ID == frameID {
			r := &records[i]
			r.Result = resultRecap
			if add := countTokens(resultRecap); add > 0 {
				r.Tokens += add
			}
			return
		}
	}
}

// TraceExitR 记录函数出口，支持多返回值：pairs 为
// [name0, val0, name1, val1, ...] 交替的返回值名/值。
func TraceExitR(frameID int, pairs ...interface{}) {
	resultRecap := buildRecap(pairs)
	mu.Lock()
	defer mu.Unlock()
	for i := len(stack) - 1; i >= 0; i-- {
		if stack[i] == frameID {
			stack = stack[:i]
			break
		}
	}
	for i := range records {
		if records[i].ID == frameID {
			r := &records[i]
			r.Result = resultRecap
			if add := countTokens(resultRecap); add > 0 {
				r.Tokens += add
			}
			return
		}
	}
}

// AddMeta 给指定 frame 附加一条元信息（如 round 序号）。
func AddMeta(frameID int, key string, val interface{}) {
	mu.Lock()
	defer mu.Unlock()
	for i := range records {
		if records[i].ID == frameID {
			if records[i].Meta == nil {
				records[i].Meta = map[string]interface{}{}
			}
			records[i].Meta[key] = val
			return
		}
	}
}

// ── recap 与 token 计算 ──

// maxRecapLen 控制单个入参/出参 recap 的最大长度，避免 trace 膨胀。
const maxRecapLen = 160

// buildRecap 把 [name0,val0,...] 格式化为 "name0=val0, name1=val1"。
func buildRecap(pairs []interface{}) string {
	if len(pairs) == 0 {
		return ""
	}
	var sb strings.Builder
	for i := 0; i+1 < len(pairs); i += 2 {
		if sb.Len() > 0 {
			sb.WriteString(", ")
		}
		name, _ := pairs[i].(string)
		val := fmt.Sprintf("%v", pairs[i+1])
		sb.WriteString(name)
		sb.WriteString("=")
		sb.WriteString(truncateStr(val, maxRecapLen))
	}
	return sb.String()
}

// countTokens 复用 AI base TokenCounter 的字符类型估算：
// CJK 0.6, ASCII 0.25, 其他 0.3 tokens/char。
func countTokens(text string) int {
	if text == "" {
		return 0
	}
	var cjk, ascii, other int
	for _, r := range text {
		if unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hiragana, r) ||
			unicode.Is(unicode.Katakana, r) || unicode.Is(unicode.Hangul, r) {
			cjk++
		} else if r < 128 {
			ascii++
		} else {
			other++
		}
	}
	raw := int(float64(cjk)*0.6 + float64(ascii)*0.25 + float64(other)*0.3)
	if raw < 1 {
		raw = 1
	}
	return raw
}

func truncateStr(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) > max {
		return s[:max-3] + "..."
	}
	return s
}

// ── 落盘 ──

// Flush 把采集到的 trace 写入 path（覆盖）。
func Flush(path, root string, rounds int) error {
	mu.Lock()
	copyRecords := make([]Record, len(records))
	copy(copyRecords, records)
	stackNow := len(stack)
	mu.Unlock()

	t := Trace{
		Version: 1,
		Rounds:  rounds,
		Root:    root,
		Records: copyRecords,
		Meta: TraceMeta{
			Finished: stackNow == 0,
		},
	}
	data, err := json.MarshalIndent(t, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return err
	}
	return nil
}

// Reset 清空采集状态（多次运行复用用）。
func Reset() {
	mu.Lock()
	records = records[:0]
	stack = stack[:0]
	nextID = 1
	atomic.StoreInt64(&orderSeq, 0)
	mu.Unlock()
}

// Stats 返回当前采集统计（诊断用）。
func Stats() (frames int, depth int) {
	mu.Lock()
	defer mu.Unlock()
	return len(records), len(stack)
}

// SortedFns 返回去重排序后的函数限定名列表（诊断/概览用）。
func SortedFns() []string {
	mu.Lock()
	set := map[string]bool{}
	for _, r := range records {
		set[r.Fn] = true
	}
	mu.Unlock()
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// ── 辅助：把指针/切片等复杂对象转成可读摘要（供驱动手动埋点用） ──

// Recap 把任意值格式化为紧凑摘要，供 TraceEntry 手动调用时复用。
func Recap(v interface{}) string {
	return truncateStr(fmt.Sprintf("%v", v), maxRecapLen)
}