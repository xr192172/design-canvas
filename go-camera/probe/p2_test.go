package probe

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ── ActualDSLLoader ──

func TestActualDSLLoader_ParsesAndSkips(t *testing.T) {
	jsonl := "" +
		`{"probe":"a.x","time":"2026-08-14T00:00:00Z","source":"s","fields":{"err":null}}` + "\n" +
		`this is not json` + "\n" +
		`{"probe":"b.y","time":"2026-08-14T00:00:00Z","source":"s","fields":{"err":"boom"}}` + "\n" +
		"\n" +
		`{"probe":"c.z"}` + "\n"
	events, skipped, err := NewActualDSLLoader(strings.NewReader(jsonl)).Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(events) != 3 {
		t.Fatalf("期望 3 个事件，got %d", len(events))
	}
	if skipped != 1 {
		t.Fatalf("期望跳过 1 行坏数据，got %d", skipped)
	}
	if events[1].Probe != "b.y" || events[1].Fields["err"] != "boom" {
		t.Fatalf("第 2 个事件解析错误: %+v", events[1])
	}
}

func TestActualDSLLoader_AllBad(t *testing.T) {
	_, _, err := NewActualDSLLoader(strings.NewReader("nope\nbad\n")).Load()
	if err == nil {
		t.Fatal("全坏行应报错")
	}
}

// ── Aggregator ──

func TestAggregator_GroupsByProbe(t *testing.T) {
	events := []Event{
		{Probe: "b.y", Fields: map[string]any{"op": "remove", "err": os.ErrNotExist.Error(), "benign": true}},
		{Probe: "a.x", Fields: map[string]any{"op": "writefile", "err": nil, "benign": false}},
		{Probe: "a.x", Fields: map[string]any{"op": "writefile", "err": "permission denied", "benign": false}},
		{Probe: "a.x", Fields: map[string]any{"op": "mkdirall", "err": nil, "benign": false}},
	}
	doc := NewAggregator().Aggregate(events)
	if doc.EventCount != 4 {
		t.Fatalf("event_count=%d", doc.EventCount)
	}
	if len(doc.Probes) != 2 {
		t.Fatalf("期望 2 个探针，got %d", len(doc.Probes))
	}
	// 探针按名排序：a.x 在前
	ax := doc.Probes[0]
	if ax.Probe != "a.x" || ax.Count != 3 || ax.Errs != 1 || ax.Benigns != 0 {
		t.Fatalf("a.x 画像错误: %+v", ax)
	}
	if len(ax.Ops) != 2 || ax.Ops[0] != "writefile" || ax.Ops[1] != "mkdirall" {
		t.Fatalf("a.x ops 错误: %v", ax.Ops)
	}
	if !strings.Contains(ax.Facts[0], "1/3") {
		t.Fatalf("a.x facts 错误: %v", ax.Facts)
	}
	by := doc.Probes[1]
	if by.Probe != "b.y" || by.Benigns != 1 {
		t.Fatalf("b.y 画像错误: %+v", by)
	}
}

// ── Comparator ──

func TestComparator_ThreeKinds(t *testing.T) {
	design := DesignDSLDoc{Decls: []DSLDecl{
		{Rule: "design:silent-error-discard", Probe: "save.writefile", Expect: "err 必须 nil 或良性"},
		{Rule: "design:never-run", Probe: "never.touched", Expect: "从未观测"},
	}}
	actual := ActualDSLDoc{Probes: []ProbeObs{
		{
			Probe: "save.writefile",
			Events: []Event{
				{Probe: "save.writefile", Fields: map[string]any{"op": "writefile", "err": nil, "benign": false}},
				{Probe: "save.writefile", Fields: map[string]any{"op": "writefile", "err": "ENOENT", "benign": false}},
			},
		},
		{Probe: "new.probe", Events: []Event{{Probe: "new.probe", Fields: map[string]any{"x": 1}}}},
	}}

	c := NewComparator().RegisterDefaultPredicates()
	rep := c.Compare(design, actual)

	// save.writefile 有事件但其中一条违反 → violated
	// never.touched 无事件 → unobserved
	// new.probe 无设计声明覆盖 → undesigned
	if rep.Violated != 1 {
		t.Fatalf("violated=%d 期望 1", rep.Violated)
	}
	if rep.Unobserved != 1 {
		t.Fatalf("unobserved=%d 期望 1", rep.Unobserved)
	}
	if rep.Undesigned != 1 {
		t.Fatalf("undesigned=%d 期望 1", rep.Undesigned)
	}
	if len(rep.Deviations) != 3 {
		t.Fatalf("deviations=%d 期望 3", len(rep.Deviations))
	}
	if rep.Deviations[0].Kind != DevUnobserved {
		t.Fatalf("排序应未观测在前，got %s", rep.Deviations[0].Kind)
	}
}

func TestComparator_GlobalDeclCoversAll(t *testing.T) {
	design := DesignDSLDoc{Decls: []DSLDecl{{Rule: "design:silent-error-discard", Probe: "", Expect: "全局"}}}
	actual := ActualDSLDoc{Probes: []ProbeObs{
		{Probe: "a.x", Events: []Event{{Probe: "a.x", Fields: map[string]any{"op": "writefile", "err": nil}}}},
		{Probe: "b.y", Events: []Event{{Probe: "b.y", Fields: map[string]any{"op": "remove", "err": os.ErrNotExist.Error(), "benign": true}}}},
	}}
	rep := NewComparator().RegisterDefaultPredicates().Compare(design, actual)
	if rep.Undesigned != 0 {
		t.Fatalf("全局声明应覆盖所有探针，undesigned=%d", rep.Undesigned)
	}
	if rep.Unobserved != 0 {
		t.Fatalf("有事件应非未观测，unobserved=%d", rep.Unobserved)
	}
	if rep.Violated != 0 {
		t.Fatalf("两事件均良性/无错，violated=%d", rep.Violated)
	}
}

func TestComparator_NoPredicateNoFabricatedViolation(t *testing.T) {
	design := DesignDSLDoc{Decls: []DSLDecl{{Rule: "design:unknown", Probe: "a.x", Expect: "无谓词"}}}
	actual := ActualDSLDoc{Probes: []ProbeObs{
		{Probe: "a.x", Events: []Event{{Probe: "a.x", Fields: map[string]any{"err": "something wrong"}}}},
	}}
	rep := NewComparator().Compare(design, actual)
	if rep.Violated != 0 {
		t.Fatalf("无谓词不应臆造违反，violated=%d", rep.Violated)
	}
	if rep.Unobserved != 0 {
		t.Fatalf("有事件应非未观测，unobserved=%d", rep.Unobserved)
	}
}

// ── CLI 端到端：actual → diff ──

func TestCLI_ActualThenDiff(t *testing.T) {
	dir := t.TempDir()
	eventsPath := filepath.Join(dir, "events.jsonl")
	dataDir := filepath.Join(dir, "camera")

	// 造一份带违反/良性/未观测的事件
	jsonl := "" +
		`{"probe":"save.writefile","source":"static-rule","fields":{"op":"writefile","err":null,"benign":false}}` + "\n" +
		`{"probe":"save.writefile","source":"static-rule","fields":{"op":"writefile","err":"ENOENT","benign":false}}` + "\n" +
		`{"probe":"session.remove-tmp","source":"static-rule","fields":{"op":"remove","err":"not exist","benign":true}}` + "\n"
	if err := os.WriteFile(eventsPath, []byte(jsonl), 0644); err != nil {
		t.Fatal(err)
	}

	// 播种设计 DSL + 写一条与该探针无关的声明（制造 undesigned）+ 一条未观测声明
	store := NewDesignDSLStore(dataDir)
	if _, err := store.SeedDefault(); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Save([]DSLDecl{
		{Rule: "design:silent-error-discard", Probe: "", Expect: "全局"},
		{Rule: "design:never-run", Probe: "never.touched", Expect: "未观测"},
	}, "test", "manual"); err != nil {
		t.Fatal(err)
	}

	// camera-dsl actual
	if !dslActual([]string{eventsPath}, dataDir) {
		t.Fatal("dslActual 返回 false")
	}
	actualPath := filepath.Join(dataDir, "actual.dsl.json")
	if _, err := os.Stat(actualPath); err != nil {
		t.Fatalf("actual.dsl.json 未生成: %v", err)
	}

	// camera-dsl diff，捕获 stdout
	capture := captureStdout(func() {
		if !dslDiff(nil, dataDir) {
			t.Fatal("dslDiff 返回 false")
		}
	})
	// 全局声明覆盖所有 → 无 undesigned；never.touched 未观测；save.writefile 违反 1 条
	for _, want := range []string{"未观测 1", "违反 1", "未声明 0", "save.writefile"} {
		if !strings.Contains(capture, want) {
			t.Errorf("diff 报告缺少 %q\n%s", want, capture)
		}
	}
}

// captureStdout 捕获函数执行期间的 os.Stdout。
func captureStdout(fn func()) string {
	old := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w
	fn()
	_ = w.Close()
	os.Stdout = old
	buf := make([]byte, 4096)
	n, _ := r.Read(buf)
	return string(buf[:n])
}