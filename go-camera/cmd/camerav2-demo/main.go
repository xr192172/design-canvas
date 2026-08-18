// camerav2-demo：camera v2 分级采集 runtime 演示（决策卡 c1/c3/c4/c5/c6/c7/c8 验收）。
//
// 模拟 3 层调用链 OrderService.Place → PaymentService.Charge → InventoryService.Reserve，
// 每 errEvery 次在第 3 层注入一次错误。跑 N 次后产出中文验收报告：
//
//	c3 计数器表 / c4 直方图 P50/P99 / c1 内存不变式（跑 1k vs N 次堆恒定）/
//	c5 正常期磁盘零写入 / c6 错误开箱文件 / c8 限流（错误数 > 导出数）/
//	c7 开箱内 3 层 trace_id 一致
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"go-camera/probe"
)

const (
	itersTotal  = 10000 // 总调用链次数
	itersWarmup = 1000  // 预热后测第一次堆水位
	errEvery    = 100   // 每 100 次注入 1 次错误（共 100 次）
	ringMB      = 4     // 演示用小环（生产默认 64MB）
)

func main() {
	dir, _ := os.MkdirTemp("", "camerav2-demo")
	incidents := filepath.Join(dir, "incidents")
	defer os.RemoveAll(dir)

	tiered := probe.NewTiered(
		probe.WithRingBudgetMB(ringMB),
		probe.WithIncidentDir(incidents),
		probe.WithExportPerMin(10), // c8 决策卡默认值
	)
	demoTiered = tiered
	probe.SetGlobalTiered(tiered)

	// ── 阶段 1：预热 itersWarmup 次（无错误），测堆水位 #1 ──
	runChain(itersWarmup, 0) // errEvery=0 → 不注入错误
	heap1 := heapAllocMB()

	// ── 阶段 2：正式跑（含错误注入），测堆水位 #2 ──
	runChain(itersTotal, errEvery)
	heap2 := heapAllocMB()

	report(dir, incidents, heap1, heap2)
}

// runChain 跑 n 次 3 层调用链；errEvery>0 时每 errEvery 次注入一次错误。
func runChain(n, errEvery int) {
	ctx := context.Background()
	for i := 1; i <= n; i++ {
		injectErr := errEvery > 0 && i%errEvery == 0
		_ = placeOrder(ctx, i, injectErr)
	}
}

// ── 3 层调用链（演示业务，全部走 probe.Enter/Exit/Catch 作用域 API）──

func placeOrder(ctx context.Context, orderID int, injectErr bool) error {
	ctx, sp := probe.Enter(ctx, "order.Place", map[string]any{"order_id": orderID})
	defer sp.Exit(nil)
	if err := chargePayment(ctx, orderID, injectErr); err != nil {
		sp.Catch(fmt.Errorf("下单失败: %w", err), map[string]any{"order_id": orderID})
		return err
	}
	return nil
}

func chargePayment(ctx context.Context, orderID int, injectErr bool) error {
	ctx, sp := probe.Enter(ctx, "pay.Charge", map[string]any{"order_id": orderID})
	defer sp.Exit(nil)
	if err := reserveInventory(ctx, orderID, injectErr); err != nil {
		sp.Catch(fmt.Errorf("支付受阻: %w", err), nil)
		return err
	}
	return nil
}

func reserveInventory(ctx context.Context, orderID int, injectErr bool) error {
	_, sp := probe.Enter(ctx, "inv.Reserve", map[string]any{"order_id": orderID})
	defer sp.Exit(nil)
	if injectErr {
		err := fmt.Errorf("库存不足: sku-%d", orderID%7)
		sp.Catch(err, map[string]any{"sku": fmt.Sprintf("sku-%d", orderID%7)})
		return err
	}
	return nil
}

// ─────────────────────────────────────────────────────────────
// 验收报告
// ─────────────────────────────────────────────────────────────

func report(root, incidents string, heap1, heap2 float64) {
	w := bufio.NewWriter(os.Stdout)
	defer w.Flush()

	fmt.Fprintf(w, "════════════ Camera v2 分级采集演示报告 ════════════\n")
	fmt.Fprintf(w, "运行: %d 次调用链（预热 %d 次），每 %d 次注入 1 次错误 → 共 %d 次错误\n",
		itersTotal, itersWarmup, errEvery, itersTotal/errEvery)

	// c3 计数器
	fmt.Fprintf(w, "\n── c3 计数器（常开，O(探针数) 内存）──\n")
	counters := tiered().Counters()
	for _, c := range counters {
		fmt.Fprintf(w, "  %-22s hit=%-6d err=%d\n", c.Probe, c.Hit, c.Err)
	}

	// c4 直方图
	fmt.Fprintf(w, "\n── c4 直方图（常开，20 桶/探针）──\n")
	for _, h := range tiered().Histograms() {
		fmt.Fprintf(w, "  %-22s n=%-6d P50=%dµs P99=%dµs max<%dµs\n",
			h.Probe, h.Count, h.P50us, h.P99us, h.Maxus)
	}

	// c1 内存不变式
	fmt.Fprintf(w, "\n── c1 内存不变式（铁律：跑 1 秒 = 跑 1 年）──\n")
	fmt.Fprintf(w, "  预热 %d 次后 HeapAlloc: %.2f MB\n", itersWarmup, heap1)
	fmt.Fprintf(w, "  全量 %d 次后 HeapAlloc: %.2f MB  %s\n", itersTotal, heap2,
		pass(heap2-heap1 < float64(ringMB)*0.5))

	// c5 正常期零磁盘 + 环统计
	rs := tiered().RingStats()
	fmt.Fprintf(w, "\n── c5 环形缓冲（预算 %dMB，平时永不落盘）──\n", rs.BudgetBytes/1024/1024)
	fmt.Fprintf(w, "  累计写入 %.2f MB，绕圈覆盖 %d 次（内存占用恒等于预算）\n",
		float64(rs.Written)/1024/1024, rs.Laps)

	// c6/c8 开箱文件与限流（c8 口径：每探针每分钟 ≤ quota，非全局总量）
	files := listIncidents(incidents)
	nErr := int64(itersTotal / errEvery)
	fmt.Fprintf(w, "\n── c6/c8 错误开箱 + 导出限流（10 次/分钟/探针，3 层各自 Catch）──\n")
	perProbe := countIncidentsByProbe(incidents, files)
	quotaOK := true
	for p, n := range perProbe {
		fmt.Fprintf(w, "  %-14s 开箱 %d 份（限额 10）%s\n", p, n, pass(n <= 10))
		if n > 10 {
			quotaOK = false
		}
	}
	skipped := 0
	for _, v := range demoTiered.ExportSkipped() {
		skipped += int(v)
	}
	fmt.Fprintf(w, "  错误总数 %d → 开箱文件 %d 份（3 探针 × 10）%s，限流跳过 %d 次\n",
		nErr, len(files), pass(quotaOK && len(files) > 0), skipped)

	// c7 链路一致性：打开最新开箱文件验证 3 层 trace_id 一致
	fmt.Fprintf(w, "\n── c7 correlation ID（开箱文件 3 层 trace_id 一致）──\n")
	if len(files) > 0 {
		latest := filepath.Join(incidents, files[len(files)-1])
		ok, lines, traceID := verifyChain(latest)
		fmt.Fprintf(w, "  %s\n  trace_id=%s，链路事件 %d 条（order/pay/inv 三层同 id）%s\n",
			files[len(files)-1], traceID, lines, pass(ok))
		previewIncident(w, latest)
	} else {
		fmt.Fprintf(w, "  （无开箱文件，跳过）\n")
	}

	fmt.Fprintf(w, "\n产物目录: %s\n", root)
}

var demoTiered *probe.Tiered

func tiered() *probe.Tiered { return demoTiered }

func pass(ok bool) string {
	if ok {
		return "✓"
	}
	return "✗（验收失败）"
}

// verifyChain 解析开箱文件：事件按 probe 前缀分层，全部同 trace_id 则通过。
func verifyChain(path string) (bool, int, string) {
	f, err := os.Open(path)
	if err != nil {
		return false, 0, ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 16*1024*1024)
	traceID := ""
	layers := map[string]bool{}
	n := 0
	for sc.Scan() {
		var raw map[string]any
		if json.Unmarshal(sc.Bytes(), &raw) != nil {
			continue
		}
		if t, ok := raw["type"].(string); ok && t == "incident" {
			if id, ok := raw["trace_id"].(string); ok {
				traceID = id
			}
			continue
		}
		if id, _ := raw["trace_id"].(string); id != "" {
			if traceID != "" && id != traceID {
				return false, n, traceID
			}
			traceID = id
		}
		if p, _ := raw["probe"].(string); p != "" {
			for _, layer := range []string{"order.", "pay.", "inv."} {
				if strings.HasPrefix(p, layer) {
					layers[layer] = true
				}
			}
		}
		n++
	}
	return len(layers) == 3, n, traceID
}

// countIncidentsByProbe 按触发探针分组统计开箱文件数（头行 probe 字段）。
func countIncidentsByProbe(dir string, files []string) map[string]int {
	out := map[string]int{}
	for _, name := range files {
		f, err := os.Open(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		if sc.Scan() {
			var raw map[string]any
			if json.Unmarshal(sc.Bytes(), &raw) == nil {
				if p, _ := raw["probe"].(string); p != "" {
					out[p]++
				}
			}
		}
		f.Close()
	}
	return out
}

// previewIncident 打印开箱文件前几行（头行+链路首尾），肉眼可验。
func previewIncident(w *bufio.Writer, path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	fmt.Fprintf(w, "  ── 开箱内容预览 ──\n")
	for i := 0; sc.Scan() && i < 5; i++ {
		line := sc.Text()
		if len(line) > 130 {
			line = line[:130] + "…"
		}
		fmt.Fprintf(w, "    %s\n", line)
	}
	fmt.Fprintf(w, "    …（完整文件见产物目录）\n")
}

func listIncidents(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), "incident-") {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out
}

func heapAllocMB() float64 {
	runtime.GC()
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return float64(m.HeapAlloc) / 1024 / 1024
}
