// v2 分级采集 runtime 验收测试（对应 camera_v2 决策卡）。
package probe

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func newTestTiered(t *testing.T, opts ...TieredOption) *Tiered {
	t.Helper()
	opts = append([]TieredOption{WithRingBudgetMB(1)}, opts...)
	return NewTiered(opts...)
}

func withTempIncidentDir(t *testing.T) (*Tiered, string) {
	t.Helper()
	dir := t.TempDir()
	inc := filepath.Join(dir, "incidents")
	return newTestTiered(t, WithIncidentDir(inc)), inc
}

// c3：计数器 hit/err 计数正确（含 .catch 后缀自动计 err）。
func TestTieredCounters(t *testing.T) {
	tier := newTestTiered(t)
	for i := 0; i < 100; i++ {
		tier.Emit(Event{Probe: "svc.a.enter", Source: "t"})
		tier.Emit(Event{Probe: "svc.a.exit", Source: "t"})
	}
	for i := 0; i < 7; i++ {
		tier.Emit(Event{Probe: "svc.a.catch", Source: "t"})
	}
	got := map[string]CountersSnapshot{}
	for _, c := range tier.Counters() {
		got[c.Probe] = c
	}
	if got["svc.a.enter"].Hit != 100 || got["svc.a.exit"].Hit != 100 {
		t.Fatalf("hit 计数错误: %+v", got)
	}
	if got["svc.a.catch"].Hit != 7 || got["svc.a.catch"].Err != 7 {
		t.Fatalf("catch 计数错误: %+v", got["svc.a.catch"])
	}
	if got["svc.a.enter"].Err != 0 {
		t.Fatalf("enter 不应有 err: %+v", got["svc.a.enter"])
	}
}

// c4：直方图记录耗时并给出合理分位值。
func TestHistogramPercentile(t *testing.T) {
	h := &histogram{}
	for i := 0; i < 100; i++ {
		h.Record(time.Duration(i+1) * time.Microsecond) // 1..100µs
	}
	snap := h.snapshot("p")
	if snap.Count != 100 {
		t.Fatalf("count=%d want 100", snap.Count)
	}
	if snap.P50us < 30 || snap.P50us > 90 {
		t.Fatalf("P50=%dµs 偏离中位", snap.P50us)
	}
	if snap.P99us < 90 || snap.P99us > 200 {
		t.Fatalf("P99=%dµs 偏离尾部", snap.P99us)
	}
	// 边界：超上界钳入末桶
	h2 := &histogram{}
	h2.Record(10 * time.Second)
	if s2 := h2.snapshot("q"); s2.Maxus < 500000 {
		t.Fatalf("超上界未入末桶: %+v", s2)
	}
}

// c5：环形缓冲占用恒等于预算（绕圈后统计自洽，snapshot 顺序完整可解析）。
func TestRingWrapAndSnapshot(t *testing.T) {
	tier := newTestTiered(t) // 1MB 环
	// 每事件约 100B，写 2 万条 ≈ 2MB > 1MB → 至少绕圈 1 次
	for i := 0; i < 20000; i++ {
		tier.Emit(Event{Probe: fmt.Sprintf("p.n%04d.enter", i%50), Source: "t"})
	}
	rs := tier.RingStats()
	if rs.BudgetBytes != 1<<20 {
		t.Fatalf("预算错误: %d", rs.BudgetBytes)
	}
	if rs.Laps < 1 {
		t.Fatalf("应至少绕圈 1 次: %+v", rs)
	}
	// snapshot 应为完整 JSONL 行（每行可解析）
	n := 0
	for _, line := range strings.Split(string(tier.ring.snapshot()), "\n") {
		if line == "" {
			continue
		}
		var ev Event
		if json.Unmarshal([]byte(line), &ev) != nil {
			t.Fatalf("环内出现残行: %.80s", line)
		}
		n++
	}
	if n < 5000 {
		t.Fatalf("绕圈后应仍有大量事件，实际 %d", n)
	}
}

// c1 铁律：留存层内存不变式——预热后与 100 倍压力后堆水位相同。
func TestC1MemoryInvariance(t *testing.T) {
	tier := newTestTiered(t)
	// 预热 2000 条（所有 map/环分配到位）
	for i := 0; i < 2000; i++ {
		tier.Emit(Event{Probe: "m.warm", Source: "t"})
	}
	heap1 := heapAfterGC()
	for i := 0; i < 200000; i++ {
		tier.Emit(Event{Probe: "m.load", Source: "t"})
	}
	heap2 := heapAfterGC()
	// 带符号比较：压测后堆允许持平或略降（GC 回收），只惩罚增长
	delta := int64(heap2) - int64(heap1)
	if delta > 4<<20 { // 允许 GC 噪声，超 4MB 视为留存泄漏
		t.Fatalf("c1 违反：堆增长 %.1fMB（预热后 %.1fMB → 压测后 %.1fMB）",
			float64(delta)/1048576, float64(heap1)/1048576, float64(heap2)/1048576)
	}
}

func heapAfterGC() uint64 {
	runtime.GC()
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return m.HeapAlloc
}

// c6：无错误 → 零磁盘（incident 目录不存在任何文件）。
func TestZeroDiskWithoutError(t *testing.T) {
	tier, inc := withTempIncidentDir(t)
	for i := 0; i < 5000; i++ {
		tier.Emit(Event{Probe: "ok.flow.enter", Source: "t"})
	}
	if _, err := os.Stat(inc); !os.IsNotExist(err) {
		entries, _ := os.ReadDir(inc)
		t.Fatalf("无错误却产生磁盘写入: %d 个文件", len(entries))
	}
}

// c6/c7：Catch 触发开箱，开箱文件含整条链路且 3 层 trace_id 一致。
func TestIncidentChainSameTraceID(t *testing.T) {
	tier, inc := withTempIncidentDir(t)
	SetGlobalTiered(tier)
	t.Cleanup(func() { SetGlobalTiered(nil) })

	ctx := context.Background()
	var firstErr error
	// 层 1
	ctx1, sp1 := Enter(ctx, "order.Place", nil)
	_ = ctx1
	// 层 2（继承 ctx1）
	ctx2, sp2 := Enter(ctx1, "pay.Charge", nil)
	_ = ctx2
	// 层 3：注入错误
	_, sp3 := Enter(ctx2, "inv.Reserve", nil)
	firstErr = fmt.Errorf("库存不足")
	sp3.Catch(firstErr, nil)
	sp2.Catch(fmt.Errorf("wrap: %w", firstErr), nil)
	sp1.Catch(fmt.Errorf("wrap: %w", firstErr), nil)

	entries, err := os.ReadDir(inc)
	if err != nil || len(entries) == 0 {
		t.Fatalf("应产生开箱文件: %v", err)
	}
	f, _ := os.Open(filepath.Join(inc, entries[0].Name()))
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	traceIDs := map[string]bool{}
	layers := map[string]bool{}
	sawHeader := false
	for sc.Scan() {
		var raw map[string]any
		if json.Unmarshal(sc.Bytes(), &raw) != nil {
			t.Fatalf("开箱文件残行: %.80s", sc.Text())
		}
		if ty, _ := raw["type"].(string); ty == "incident" {
			sawHeader = true
			continue
		}
		if id, _ := raw["trace_id"].(string); id != "" {
			traceIDs[id] = true
		}
		if p, _ := raw["probe"].(string); p != "" {
			for _, l := range []string{"order.", "pay.", "inv."} {
				if strings.HasPrefix(p, l) {
					layers[l] = true
				}
			}
		}
	}
	if !sawHeader {
		t.Fatal("开箱文件缺 incident 头行")
	}
	if len(traceIDs) != 1 {
		t.Fatalf("链路出现多个 trace_id: %v", traceIDs)
	}
	if len(layers) != 3 {
		t.Fatalf("开箱应含 3 层窗口，实际: %v", layers)
	}
}

// c8：滑动窗口限流——quota 内放行，超出拒绝并计数。
func TestExportGateQuota(t *testing.T) {
	g := newExportGate(3)
	base := time.Now()
	allow := []bool{}
	for i := range 5 {
		allow = append(allow, g.allow("p", base.Add(time.Duration(i)*time.Second)))
	}
	want := []bool{true, true, true, false, false}
	for i := range want {
		if allow[i] != want[i] {
			t.Fatalf("第 %d 次判定=%v want %v", i+1, allow[i], want[i])
		}
	}
	// 窗口滑动：2 分钟后旧记录过期，恢复放行
	if !g.allow("p", base.Add(2*time.Minute)) {
		t.Fatal("窗口过期后应恢复放行")
	}
	if g.Skipped()["p"] != 2 {
		t.Fatalf("跳过计数错误: %v", g.Skipped())
	}
}

// c8 端到端：错误洪峰下开箱文件数 ≤ quota。
func TestExportFloodBounded(t *testing.T) {
	tier, inc := withTempIncidentDir(t)
	SetGlobalTiered(tier)
	t.Cleanup(func() { SetGlobalTiered(nil) })

	for i := 0; i < 50; i++ {
		_, sp := Enter(context.Background(), "hot.fn", nil)
		sp.Catch(fmt.Errorf("err-%d", i), nil)
	}
	entries, _ := os.ReadDir(inc)
	if len(entries) > 10 {
		t.Fatalf("洪峰下开箱文件 %d 个，超过默认限额 10", len(entries))
	}
	if s := tier.ExportSkipped()["hot.fn"]; s < 30 {
		t.Fatalf("跳过统计应显著: %d", s)
	}
}

// 兼容：旧 Capture API 自动路由进 v2 runtime。
func TestLegacyCaptureRoutesToTiered(t *testing.T) {
	tier := newTestTiered(t)
	prev := globalTier
	SetGlobalTiered(tier)
	t.Cleanup(func() { SetGlobalTiered(prev) })

	Capture("legacy.point", "static-rule", map[string]any{"k": 1})
	CaptureErr("legacy.point.catch", "static-rule", fmt.Errorf("x"), nil)
	found := map[string]CountersSnapshot{}
	for _, c := range tier.Counters() {
		found[c.Probe] = c
	}
	if found["legacy.point"].Hit != 1 {
		t.Fatalf("旧 API 未路由: %+v", found)
	}
	if found["legacy.point.catch"].Err != 1 {
		t.Fatalf("旧 catch 未计 err: %+v", found)
	}
}

// 并发安全：多 goroutine 并发 Emit/Snapshot。
func TestTieredConcurrent(t *testing.T) {
	tier := newTestTiered(t)
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 1000; i++ {
				tier.Emit(Event{Probe: fmt.Sprintf("c.g%d.n%d", g, i%10), Source: "t"})
			}
		}(g)
	}
	wg.Wait()
	total := int64(0)
	for _, c := range tier.Counters() {
		total += c.Hit
	}
	if total != 8000 {
		t.Fatalf("并发丢事件: %d", total)
	}
}
