// Package probe — c6 错误开箱导出 + c8 导出限流。
//
// c6 错误开箱（嵌入式黑匣子语义）：环形缓冲一直在录、平时永不落盘；
// catch 探针触发才"打开黑匣子"——捞同 trace id 的整条链路窗口 + 现场
// 计数器/直方图快照，写成一个自包含 incident 文件。
//
// c8 限流（防导出风暴）：每探针每分钟最多 N 次（默认 10）。超限不导出、
// 只计数（skipped 统计暴露风暴规模）——错误洪峰时宁丢现场不写爆磁盘。
package probe

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

const (
	DefaultExportPerMin = 10 // c8: 每探针每分钟导出限额
	DefaultMaxIncidents = 64 // incident 目录保留条数封顶（最旧先删）
	ambientWindow       = 50 // 开箱附带的环境窗口：catch 前最近 N 条任意事件
)

// exportGate 每探针滑动窗口限流（c8）。内存 O(探针数 × quota)。
type exportGate struct {
	mu    sync.Mutex
	quota int
	seen  map[string][]time.Time
	// 风暴统计：被限流跳过的导出次数（按探针）
	skipped sync.Map // probe -> *int64
}

func newExportGate(quota int) *exportGate {
	return &exportGate{quota: quota, seen: make(map[string][]time.Time)}
}

// allow 判定本探针本轮分钟窗口内是否还有导出名额。
func (g *exportGate) allow(probe string, now time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.quota <= 0 {
		return false
	}
	times := g.seen[probe]
	keep := times[:0]
	for _, t := range times {
		if now.Sub(t) < time.Minute {
			keep = append(keep, t)
		}
	}
	if len(keep) >= g.quota {
		g.seen[probe] = keep
		if v, _ := g.skipped.LoadOrStore(probe, new(atomic.Int64)); v != nil {
			v.(*atomic.Int64).Add(1)
		}
		return false
	}
	g.seen[probe] = append(keep, now)
	return true
}

// Skipped 返回被限流跳过的导出次数（按探针）。
func (g *exportGate) Skipped() map[string]int64 {
	out := make(map[string]int64)
	g.skipped.Range(func(k, v any) bool {
		out[k.(string)] = v.(*atomic.Int64).Load()
		return true
	})
	return out
}

// ExportSkipped 暴露 c8 限流统计（被跳过的导出次数，按探针）。
func (t *Tiered) ExportSkipped() map[string]int64 {
	if t.gate == nil {
		return nil
	}
	return t.gate.Skipped()
}

// incidentHeader 是开箱文件首行：自描述现场快照。
type incidentHeader struct {
	Type     string                       `json:"type"` // "incident"
	TraceID  string                       `json:"trace_id"`
	Probe    string                       `json:"probe"`
	Err      string                       `json:"err"`
	At       time.Time                    `json:"at"`
	Counters []CountersSnapshot           `json:"counters"`  // 触发时全量计数器
	Histos   []HistogramSnapshot          `json:"histograms"` // 触发探针的耗时形态
	Ambient  int                          `json:"ambient"`    // 环境窗口条数
	Chain    int                          `json:"chain"`      // 同 trace_id 链路事件条数
}

// exportIncident 打开黑匣子：扫环形缓冲一整圈，抽出
//   1. 同 trace_id 的链路事件（c7 验收：各层窗口 trace id 一致）
//   2. catch 前最近 ambientWindow 条任意事件（现场环境）
// 加 incidentHeader 头行，写成单个 JSONL 文件；目录超出保留数删最旧。
func (t *Tiered) exportIncident(sp *Scope, err error) {
	dir := t.incidentDir
	if dir == "" || t.gate == nil {
		return
	}
	now := time.Now()
	if !t.gate.allow(sp.probe, now) {
		return // c8 限流：本轮无名额，只计数不写盘
	}

	raw := t.ring.snapshot()
	// 残包/覆盖边界行 JSON 解析失败自动丢弃（splitEvents 内处理）
	all := splitEvents(raw)
	var chain, ambient []Event
	for _, ev := range all {
		if ev.TraceID == sp.traceID {
			chain = append(chain, ev)
		}
	}
	// 环境窗口：末尾 N 条（含其他 trace 的近邻事件，呈现"事故现场周边"）
	if len(all) > ambientWindow {
		ambient = all[len(all)-ambientWindow:]
	} else {
		ambient = all
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	name := fmt.Sprintf("incident-%s-%s.jsonl", now.Format("20060102-150405.000000"), sp.traceID)
	path := filepath.Join(dir, name)
	fh, ferr := os.Create(path)
	if ferr != nil {
		return
	}
	defer fh.Close()

	w := json.NewEncoder(fh)
	hdr := incidentHeader{
		Type: "incident", TraceID: sp.traceID, Probe: sp.probe,
		Err: err.Error(), At: now,
		Counters: t.Counters(),
		Histos:   filterHistos(t.Histograms(), sp.probe),
		Ambient:  len(ambient), Chain: len(chain),
	}
	_ = w.Encode(hdr)
	for _, ev := range chain {
		_ = w.Encode(ev)
	}
	if len(chain) == 0 {
		// 链路窗口已被环覆盖（罕见：链路跨度大于环容量）——环境窗口兜底
		for _, ev := range ambient {
			_ = w.Encode(ev)
		}
	}
	_ = fh.Sync()
	t.pruneIncidents(dir)
}

// splitEvents 解析环形快照为事件序列（残行自动丢弃）。
func splitEvents(raw []byte) []Event {
	var out []Event
	for _, line := range bytes.Split(raw, []byte{'\n'}) {
		if len(line) == 0 {
			continue
		}
		var ev Event
		if json.Unmarshal(line, &ev) == nil {
			out = append(out, ev)
		}
	}
	return out
}

func filterHistos(all []HistogramSnapshot, probe string) []HistogramSnapshot {
	var out []HistogramSnapshot
	for _, h := range all {
		if h.Probe == probe {
			out = append(out, h)
		}
	}
	return out
}

// pruneIncidents 保持 incident 目录 ≤ max 条（c1 铁律同样适用于磁盘）。
func (t *Tiered) pruneIncidents(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var files []string
	for _, e := range entries {
		if !e.IsDir() && bytes.HasPrefix([]byte(e.Name()), []byte("incident-")) {
			files = append(files, filepath.Join(dir, e.Name()))
		}
	}
	if len(files) <= DefaultMaxIncidents {
		return
	}
	sort.Slice(files, func(i, j int) bool { return files[i] < files[j] }) // 名含时间戳，字典序=时间序
	for _, f := range files[:len(files)-DefaultMaxIncidents] {
		_ = os.Remove(f)
	}
}
