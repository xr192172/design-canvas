package probe

// P2 链路偏差分析测试：链路重建（trace 三元组 → 调用序列）+ 链路契约
// （子序列语义）+ chain-broken/unobserved 判定 + CLI 端到端。
// 决策卡 c9 验收：嵌套三层 events → diff 正确指出中间帧缺失；
// 含未声明中间帧的正常链路零误报。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func scopeEv(probe, tid string, fid, pid uint64, at time.Time, fields map[string]any) Event {
	return Event{
		Probe: probe, Time: at, Source: "v2-scope",
		Fields: fields, TraceID: tid, FrameID: fid, ParentID: pid,
	}
}

func TestRebuildChains_NestedSequence(t *testing.T) {
	base := time.Now()
	// 链 t1：order.Place → pay.Charge → inv.Reserve（三层嵌套）
	evs := []Event{
		scopeEv("order.Place.enter", "t1", 1, 0, base, nil),
		scopeEv("pay.Charge.enter", "t1", 2, 1, base.Add(1*time.Millisecond), nil),
		scopeEv("inv.Reserve.enter", "t1", 3, 2, base.Add(2*time.Millisecond), nil),
		scopeEv("inv.Reserve.catch", "t1", 3, 2, base.Add(3*time.Millisecond), map[string]any{"err": "库存不足"}),
		scopeEv("inv.Reserve.exit", "t1", 3, 2, base.Add(4*time.Millisecond), nil),
		scopeEv("pay.Charge.exit", "t1", 2, 1, base.Add(5*time.Millisecond), nil),
		scopeEv("order.Place.exit", "t1", 1, 0, base.Add(6*time.Millisecond), nil),
	}
	chains, dropped := RebuildChains(evs)
	if dropped != 0 {
		t.Fatalf("不应丢弃链: %d", dropped)
	}
	if len(chains) != 1 {
		t.Fatalf("期望 1 条链，got %d", len(chains))
	}
	ch := chains[0]
	want := []string{"order.Place", "pay.Charge", "inv.Reserve"}
	if strings.Join(ch.Sequence, ",") != strings.Join(want, ",") {
		t.Fatalf("序列错误: %v", ch.Sequence)
	}
	if ch.Errs != 1 {
		t.Fatalf("errs=%d 期望 1", ch.Errs)
	}
	if ch.Events != 7 {
		t.Fatalf("events=%d 期望 7", ch.Events)
	}
}

func TestRebuildChains_MultiTraceAndAnon(t *testing.T) {
	base := time.Now()
	evs := []Event{
		scopeEv("a.enter", "t1", 1, 0, base, nil),
		scopeEv("b.enter", "t2", 2, 0, base.Add(1*time.Millisecond), nil),
		// t3：无 frame id 的 v1 式事件（手动传 trace）
		{Probe: "legacy.op", TraceID: "t3", Time: base.Add(2 * time.Millisecond), Fields: map[string]any{"err": "boom"}},
	}
	chains, _ := RebuildChains(evs)
	if len(chains) != 3 {
		t.Fatalf("期望 3 条链，got %d", len(chains))
	}
	if chains[0].TraceID != "t1" || chains[1].TraceID != "t2" || chains[2].TraceID != "t3" {
		t.Fatalf("链序错误: %v", chains)
	}
	if chains[2].Sequence[0] != "legacy.op" || chains[2].Errs != 1 {
		t.Fatalf("匿名事件链错误: %+v", chains[2])
	}
}

func TestRebuildChains_BudgetDrop(t *testing.T) {
	base := time.Now()
	var evs []Event
	for i := 0; i < maxChains+1; i++ {
		evs = append(evs, scopeEv("f.enter", "t"+strings.Repeat("a", i%4)+time.Duration(i).String(), uint64(i+1), 0, base.Add(time.Duration(i)*time.Millisecond), nil))
	}
	chains, dropped := RebuildChains(evs)
	if len(chains) != maxChains || dropped != 1 {
		t.Fatalf("chains=%d dropped=%d 期望 %d/1", len(chains), dropped, maxChains)
	}
}

func TestIsSubsequence(t *testing.T) {
	cases := []struct {
		want, seq []string
		ok        bool
	}{
		{[]string{"A", "B", "C"}, []string{"A", "X", "B", "C"}, true}, // 中间插帧 OK
		{[]string{"A", "B"}, []string{"B", "A"}, false},               // 顺序颠倒
		{[]string{"A", "C"}, []string{"A", "B"}, false},               // 缺尾
		{[]string{"A"}, []string{"A", "A"}, true},                     // 重复
		{[]string{"A", "B", "C"}, []string{"A", "B"}, false},          // 缺中间
	}
	for i, c := range cases {
		if got := isSubsequence(c.want, c.seq); got != c.ok {
			t.Errorf("case %d: isSubsequence(%v,%v)=%v 期望 %v", i, c.want, c.seq, got, c.ok)
		}
	}
}

// c9 验收核心：未声明中间帧的正常链路 → 零误报。
func TestComparator_ChainSatisfiedWithExtraFrames(t *testing.T) {
	design := DesignDSLDoc{Decls: []DSLDecl{
		{Rule: "design:call-chain", Chain: []string{"svc.Handle", "db.Exec"}},
	}}
	base := time.Now()
	evs := []Event{
		scopeEv("svc.Handle.enter", "t1", 1, 0, base, nil),
		scopeEv("cache.Warm.enter", "t1", 2, 1, base.Add(1*time.Millisecond), nil), // 未声明中间帧
		scopeEv("db.Exec.enter", "t1", 3, 1, base.Add(2*time.Millisecond), nil),
		scopeEv("db.Exec.exit", "t1", 3, 1, base.Add(3*time.Millisecond), nil),
		scopeEv("svc.Handle.exit", "t1", 1, 0, base.Add(4*time.Millisecond), nil),
	}
	doc := NewAggregator().Aggregate(evs)
	rep := NewComparator().Compare(design, doc)
	if rep.ChainBroken != 0 || rep.Unobserved != 0 || rep.Violated != 0 {
		t.Fatalf("正常链路应零偏差: %+v", rep)
	}
}

// c9 验收核心：中间帧缺失 → chain-broken，带 trace id + 实测窗口 + 缺失定位。
func TestComparator_ChainBrokenMiddleMissing(t *testing.T) {
	design := DesignDSLDoc{Decls: []DSLDecl{
		{Rule: "design:call-chain", Chain: []string{"svc.Handle", "db.Exec", "tx.Commit"}},
	}}
	base := time.Now()
	evs := []Event{ // db.Exec 缺失：Handle → Commit 直连
		scopeEv("svc.Handle.enter", "t9", 1, 0, base, nil),
		scopeEv("tx.Commit.enter", "t9", 2, 1, base.Add(1*time.Millisecond), nil),
		scopeEv("svc.Handle.exit", "t9", 1, 0, base.Add(2*time.Millisecond), nil),
	}
	doc := NewAggregator().Aggregate(evs)
	rep := NewComparator().Compare(design, doc)
	if rep.ChainBroken != 1 {
		t.Fatalf("chain_broken=%d 期望 1", rep.ChainBroken)
	}
	d := rep.Deviations[0]
	if d.Kind != DevChainBroken || d.TraceID != "t9" {
		t.Fatalf("偏差类别/trace 错误: %+v", d)
	}
	if strings.Join(d.Window, ",") != "svc.Handle,tx.Commit" {
		t.Fatalf("窗口错误: %v", d.Window)
	}
	if !strings.Contains(d.Detail, `"db.Exec"`) || !strings.Contains(d.Detail, "1/3") {
		t.Fatalf("缺失定位错误: %s", d.Detail)
	}
}

func TestComparator_ChainOrderViolation(t *testing.T) {
	design := DesignDSLDoc{Decls: []DSLDecl{
		{Rule: "design:call-chain", Chain: []string{"A", "B", "C"}},
	}}
	base := time.Now()
	evs := []Event{ // 顺序颠倒：A → C → B
		scopeEv("A.enter", "t1", 1, 0, base, nil),
		scopeEv("C.enter", "t1", 2, 1, base.Add(1*time.Millisecond), nil),
		scopeEv("B.enter", "t1", 3, 1, base.Add(2*time.Millisecond), nil),
	}
	doc := NewAggregator().Aggregate(evs)
	rep := NewComparator().Compare(design, doc)
	if rep.ChainBroken != 1 {
		t.Fatalf("顺序颠倒应报断裂: %+v", rep)
	}
	if !strings.Contains(rep.Deviations[0].Detail, `"C"`) {
		t.Fatalf("应定位缺失 C: %s", rep.Deviations[0].Detail)
	}
}

func TestComparator_ChainRootUnobserved(t *testing.T) {
	design := DesignDSLDoc{Decls: []DSLDecl{
		{Rule: "design:call-chain", Chain: []string{"never.Root", "never.Child"}},
	}}
	base := time.Now()
	evs := []Event{ // 无关链路
		scopeEv("other.enter", "t1", 1, 0, base, nil),
	}
	doc := NewAggregator().Aggregate(evs)
	rep := NewComparator().Compare(design, doc)
	if rep.ChainBroken != 0 || rep.Unobserved != 1 {
		t.Fatalf("根未观测应报 unobserved: %+v", rep)
	}
	if rep.Deviations[0].Kind != DevUnobserved || rep.Deviations[0].Probe != "never.Root" {
		t.Fatalf("偏差错误: %+v", rep.Deviations[0])
	}
}

// CLI 端到端：events.jsonl（带 trace 三元组）→ actual（含 chains）→ diff 报链路断裂。
func TestCLI_ChainDiff(t *testing.T) {
	dir := t.TempDir()
	eventsPath := filepath.Join(dir, "events.jsonl")
	dataDir := filepath.Join(dir, "observe")

	jsonl := "" +
		`{"probe":"svc.Handle.enter","time":"2026-08-18T10:00:00Z","source":"v2-scope","trace_id":"tabc","frame_id":1,"parent_id":0}` + "\n" +
		`{"probe":"cache.Warm.enter","time":"2026-08-18T10:00:01Z","source":"v2-scope","trace_id":"tabc","frame_id":2,"parent_id":1}` + "\n" +
		`{"probe":"svc.Handle.exit","time":"2026-08-18T10:00:02Z","source":"v2-scope","trace_id":"tabc","frame_id":1,"parent_id":0,"fields":{"dur_ms":2.0}}` + "\n"
	if err := os.WriteFile(eventsPath, []byte(jsonl), 0644); err != nil {
		t.Fatal(err)
	}

	store := NewDesignDSLStore(dataDir)
	if _, err := store.Save([]DSLDecl{
		{Rule: "design:call-chain", Chain: []string{"svc.Handle", "db.Exec"}},
	}, "test", "manual"); err != nil {
		t.Fatal(err)
	}

	if !dslActual([]string{eventsPath}, dataDir) {
		t.Fatal("dslActual 返回 false")
	}
	raw, err := os.ReadFile(filepath.Join(dataDir, "actual.dsl.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"chains"`) || !strings.Contains(string(raw), `"svc.Handle"`) {
		t.Fatalf("actual.dsl.json 应含链路画像:\n%s", raw)
	}

	capture := captureStdout(func() {
		if !dslDiff(nil, dataDir) {
			t.Fatal("dslDiff 返回 false")
		}
	})
	for _, want := range []string{"链路断裂 1", "[链断裂]", "trace=tabc", "cache.Warm"} {
		if !strings.Contains(capture, want) {
			t.Errorf("diff 报告缺少 %q:\n%s", want, capture)
		}
	}
}
