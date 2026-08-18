// Package probe — v2 分级采集 runtime（camera_v2 决策卡 c1/c3/c4/c5 落地）。
//
// c1 内存不变式（铁律）：任何事件留存层，跑 1 秒与跑 1 年占用必须相同（常数）。
//   - 计数器：O(探针数)（3603 探针 ≈ 60KB）
//   - 直方图：O(探针数)（3603 探针 ≈ 600KB）
//   - 环形缓冲：O(固定预算)（默认 64MB，溢出=旧事件被覆盖，构造性有界）
//   - 导出：错误触发才落盘，每探针限额（见 export.go），目录保留条数封顶
//
// c3 计数器常开：每探针 hit/err 两个 int64，承载趋势/频率信息。
// c4 直方图常开：每探针 20 个固定桶（1µs 起 2 的幂次），回答 P50/P99 形态。
// c5 环形缓冲常录：预分配分段字节环，平时永不落盘（嵌入式黑匣子语义：
//   一直在录，坠毁才打开）。
package probe

import (
	"encoding/json"
	"math/bits"
	"sync"
	"sync/atomic"
	"time"
)

// ─────────────────────────────────────────────────────────────
// c3 计数器：每探针 hit/err
// ─────────────────────────────────────────────────────────────

type probeCounters struct {
	hit atomic.Int64
	err atomic.Int64
}

// CountersSnapshot 是一次只读快照（demo/报告用）。
type CountersSnapshot struct {
	Probe string `json:"probe"`
	Hit   int64  `json:"hit"`
	Err   int64  `json:"err"`
}

// ─────────────────────────────────────────────────────────────
// c4 直方图：每探针 20 个固定桶（对数刻度）
// ─────────────────────────────────────────────────────────────

const histBuckets = 20

// histogram 桶边界：bucket i 覆盖 [2^i, 2^(i+1)) 微秒，i=0..18；
// bucket 19 兜底 ≥ 2^19µs（≥524ms）。
type histogram struct {
	buckets [histBuckets]atomic.Int64
}

func (h *histogram) Record(d time.Duration) {
	us := d.Microseconds()
	if us < 1 {
		us = 1
	}
	idx := 63 - bits.LeadingZeros64(uint64(us)) // floor(log2(us))
	if idx >= histBuckets {
		idx = histBuckets - 1
	}
	h.buckets[idx].Add(1)
}

// Percentile 返回近似分位值（桶内线性内插），count=0 返回 0。
func (h *histogram) Percentile(p float64) time.Duration {
	var total int64
	var arr [histBuckets]int64
	for i := range h.buckets {
		arr[i] = h.buckets[i].Load()
		total += arr[i]
	}
	if total == 0 {
		return 0
	}
	target := int64(float64(total)*p + 0.5)
	if target < 1 {
		target = 1
	}
	var cum int64
	for i, c := range arr {
		cum += c
		if cum >= target {
			lo := int64(1) << i // 桶下界 µs
			hi := int64(2) << i
			frac := float64(target-(cum-c)) / float64(max(c, 1))
			return time.Duration(float64(lo)+frac*float64(hi-lo)) * time.Microsecond
		}
	}
	return 0
}

// HistogramSnapshot 是一次只读快照。
type HistogramSnapshot struct {
	Probe string `json:"probe"`
	Count int64  `json:"count"`
	P50us int64  `json:"p50_us"`
	P99us int64  `json:"p99_us"`
	Maxus int64  `json:"max_us"` // 非零的最高桶上界
}

func (h *histogram) snapshot(probe string) HistogramSnapshot {
	var count int64
	maxUs := int64(0)
	for i := range h.buckets {
		c := h.buckets[i].Load()
		count += c
		if c > 0 {
			maxUs = int64(2) << i // 最高非零桶的上界
		}
	}
	return HistogramSnapshot{
		Probe: probe,
		Count: count,
		P50us: int64(h.Percentile(0.50) / time.Microsecond),
		P99us: int64(h.Percentile(0.99) / time.Microsecond),
		Maxus: maxUs,
	}
}

// ─────────────────────────────────────────────────────────────
// c5 环形缓冲：预分配分段字节环，滚动覆盖
// ─────────────────────────────────────────────────────────────

// ringBuf 预分配 n 段 × segSize 字节。事件序列化后拷入，放不下当前段
// 剩余空间就整段推进到下一段（段尾浪费 ≤ 单事件大小，不做跨段拼接）。
// 占用恒等于预算值；溢出 = 最旧事件被覆盖，数学上不可能爆。
type ringBuf struct {
	mu       sync.Mutex
	segs     [][]byte
	segSize  int
	writeSeg int
	off      int
	wrapped  bool
	written  int64 // 累计写入字节数（统计用）
	dropped  int64 // 被覆盖圈数（统计用）
}

func newRingBuf(budgetBytes, segSize int) *ringBuf {
	if segSize <= 0 {
		segSize = 1 << 20 // 1MB
	}
	n := budgetBytes / segSize
	if n < 1 {
		n = 1
	}
	segs := make([][]byte, n)
	for i := range segs {
		segs[i] = make([]byte, segSize)
	}
	return &ringBuf{segs: segs, segSize: segSize}
}

// write 拷贝一行 JSONL（含结尾换行）入环。调用方保证 data 含结尾 '\n'。
func (r *ringBuf) write(data []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(data) > r.segSize {
		return // 单事件超段大小：丢弃（防异常巨事件破坏环）
	}
	if r.off+len(data) > r.segSize {
		// 当前段放不下：整段推进。若回到 seg 0 则完成一圈（旧数据开始被覆盖）
		r.writeSeg = (r.writeSeg + 1) % len(r.segs)
		if r.writeSeg == 0 {
			r.wrapped = true
			r.dropped++
		}
		r.off = 0
	}
	copy(r.segs[r.writeSeg][r.off:], data)
	r.off += len(data)
	r.written += int64(len(data))
}

// snapshot 按时间顺序（旧→新）取出一整圈有效字节。
// 环形缓冲的语义：当前写指针处就是最旧数据（下一个被覆盖的位置）。
// 首块可能从旧数据的半行开始（上一圈段尾残留），调用方需跳过首个换行符前
// 的残包字节。
func (r *ringBuf) snapshot() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := len(r.segs)
	var out []byte
	if !r.wrapped {
		// 未满一圈：段 0..writeSeg，各段取 [0, used)
		for i := 0; i <= r.writeSeg; i++ {
			end := r.segSize
			if i == r.writeSeg {
				end = r.off
			}
			out = append(out, r.segs[i][:end]...)
		}
		return out
	}
	// 已绕圈：从当前写指针（最旧）读到最新（写指针前一字节）
	for k := 0; k < n; k++ {
		i := (r.writeSeg + k) % n
		end := r.segSize
		if k == n-1 {
			end = r.off // 最后一段只写到 off
		}
		out = append(out, r.segs[i][:end]...)
	}
	return out
}

// stats 返回环形缓冲统计（预算/写入/绕圈数）。
type RingStats struct {
	BudgetBytes int64 `json:"budget_bytes"`
	Written     int64 `json:"written_bytes"`
	Laps        int64 `json:"laps_overwritten"`
}

func (r *ringBuf) stats() RingStats {
	r.mu.Lock()
	defer r.mu.Unlock()
	return RingStats{
		BudgetBytes: int64(len(r.segs) * r.segSize),
		Written:     r.written,
		Laps:        r.dropped,
	}
}

// ─────────────────────────────────────────────────────────────
// Tiered：v2 分级采集 sink（组合 c3/c4/c5，c6/c8 见 export.go）
// ─────────────────────────────────────────────────────────────

// Tiered 默认预算（决策卡 c5：64MB 固定预算）。
const (
	DefaultRingBudgetMB = 64
	DefaultRingSegSize  = 1 << 20
)

// TieredOption 配置 Tiered。
type TieredOption func(*Tiered)

// WithRingBudgetMB 设置环形缓冲预算（MB，≥1）。
func WithRingBudgetMB(mb int) TieredOption {
	return func(t *Tiered) {
		if mb >= 1 {
			t.ring = newRingBuf(mb*1024*1024, DefaultRingSegSize)
		}
	}
}

// WithFullSink 挂全量镜像 sink（JSONL 轮转，conformance/调试用）。
// 生产默认不挂：平时零磁盘（c5）。
func WithFullSink(s *Sink) TieredOption {
	return func(t *Tiered) { t.full = s }
}

// WithIncidentDir 设置错误开箱导出目录（空=不导出，c6 关闭）。
func WithIncidentDir(dir string) TieredOption {
	return func(t *Tiered) { t.incidentDir = dir }
}

// WithExportPerMin 设置每探针每分钟导出限额（c8，默认 10；≤0 关闭导出）。
func WithExportPerMin(n int) TieredOption {
	return func(t *Tiered) { t.gate.quota = n }
}

// Tiered 是 v2 分级采集 runtime。所有留存层 O(探针数) 或 O(固定预算)，
// 满足 c1 铁律：任意压力下内存占用恒等于预算值。
type Tiered struct {
	counters sync.Map // probeName -> *probeCounters（O(探针数)）
	histos   sync.Map // probeBase -> *histogram（O(探针数)，仅配对作用域记录）
	ring     *ringBuf // O(固定预算)

	full        *Sink // 可选全量镜像（conformance 模式）
	incidentDir string
	gate        *exportGate

	// 事件序号（导出头/统计用）
	seq atomic.Int64
}

// NewTiered 创建 v2 分级采集 sink。
func NewTiered(opts ...TieredOption) *Tiered {
	t := &Tiered{
		ring: newRingBuf(DefaultRingBudgetMB*1024*1024, DefaultRingSegSize),
		gate: newExportGate(DefaultExportPerMin),
	}
	for _, opt := range opts {
		opt(t)
	}
	return t
}

// Emit 是所有采集路径的汇合点：计数器 + 环形缓冲（+ 可选全量镜像）。
// 热路径：两次原子加 + 一次环拷贝，无系统调用、无磁盘。
func (t *Tiered) Emit(ev Event) {
	t.seq.Add(1)
	// c3 计数器
	v, _ := t.counters.LoadOrStore(ev.Probe, &probeCounters{})
	c := v.(*probeCounters)
	c.hit.Add(1)
	if isCatchProbe(ev.Probe) {
		c.err.Add(1)
	}
	// c5 环形缓冲
	data, err := json.Marshal(ev)
	if err == nil {
		t.ring.write(append(data, '\n'))
	}
	// 可选全量镜像（自带限速+轮转）
	if t.full != nil {
		_ = t.full.Emit(ev.Probe, ev.Source, ev.Fields)
	}
}

// Counters 返回全部计数器快照（按探针名排序）。
func (t *Tiered) Counters() []CountersSnapshot {
	var out []CountersSnapshot
	t.counters.Range(func(k, v any) bool {
		c := v.(*probeCounters)
		out = append(out, CountersSnapshot{
			Probe: k.(string),
			Hit:   c.hit.Load(),
			Err:   c.err.Load(),
		})
		return true
	})
	sortSnapshots(out)
	return out
}

// Histograms 返回全部直方图快照（按探针名排序）。
func (t *Tiered) Histograms() []HistogramSnapshot {
	var out []HistogramSnapshot
	t.histos.Range(func(k, v any) bool {
		out = append(out, v.(*histogram).snapshot(k.(string)))
		return true
	})
	return out
}

// RingStats 返回环形缓冲统计。
func (t *Tiered) RingStats() RingStats { return t.ring.stats() }

// recordDuration 记一次配对耗时（c4，由 Scope.Exit 调用）。
func (t *Tiered) recordDuration(base string, d time.Duration) {
	v, _ := t.histos.LoadOrStore(base, &histogram{})
	v.(*histogram).Record(d)
}

// isCatchProbe 判定探针是否为 catch 点（错误计数器递增依据）。
func isCatchProbe(name string) bool {
	n := len(name)
	return n >= 6 && name[n-6:] == ".catch"
}

func sortSnapshots(s []CountersSnapshot) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j].Probe < s[j-1].Probe; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}
