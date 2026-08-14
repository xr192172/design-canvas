package probe

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ── Loop（P4 闭环：观测→偏差→未声明探针自动提案）──

func TestRunLoop_GeneratesProposalsForUndesigned(t *testing.T) {
	dir := t.TempDir()
	dsl := NewDesignDSLStore(dir)
	dsl.SeedDefault() // v1 只含 silent-error-discard（全局，probe 空）

	// 观测两个新探针：一个已在设计声明覆盖范围（全局声明会覆盖所有探针？）
	// silent-error-discard 是全局声明（Probe=""），会覆盖所有探针 → 不会产生 undesigned。
	// 因此这里直接构造一个未覆盖探针场景：删掉设计声明或用特定探针对比。
	// 为确定性，改用不含全局声明的设计：直接写一个仅针对 save.writefile 的声明。
	dsl.Save([]DSLDecl{{Rule: "design:save", Probe: "save.writefile", Expect: "写文件必须处理错误"}}, "构造", "test")

	eventsPath := filepath.Join(dir, "events.jsonl")
	writeLines(t, eventsPath,
		`{"probe":"save.writefile","time":"2026-08-14T00:00:00Z","source":"s","fields":{"err":null}}`,
		`{"probe":"net.http","time":"2026-08-14T00:00:00Z","source":"s","fields":{"status":200}}`,
		`{"probe":"cache.get","time":"2026-08-14T00:00:00Z","source":"s","fields":{"hit":false}}`,
	)

	res, err := RunLoop(eventsPath, dir)
	if err != nil {
		t.Fatalf("RunLoop: %v", err)
	}
	// save.writefile 有设计声明 → 覆盖；net.http / cache.get 未声明 → 2 个提案
	if res.Report.Undesigned != 2 {
		t.Fatalf("undesigned=%d 期望 2", res.Report.Undesigned)
	}
	if len(res.Proposals) != 2 {
		t.Fatalf("提案=%d 期望 2", len(res.Proposals))
	}
	// 提案声明集应各自覆盖对应探针且 rule 带该探针后缀
	probeSet := map[string]bool{}
	for _, p := range res.Proposals {
		if p.Status != ProposalPending {
			t.Fatalf("新提案状态应为 pending，got %s", p.Status)
		}
		probeSet[p.Decls[0].Probe] = true
	}
	if !probeSet["net.http"] || !probeSet["cache.get"] {
		t.Fatalf("提案探针集错误: %v", probeSet)
	}
}

func TestRunLoop_DoesNotTouchDSL(t *testing.T) {
	dir := t.TempDir()
	dsl := NewDesignDSLStore(dir)
	dsl.SeedDefault()
	before := dslVersion(t, dsl)

	eventsPath := filepath.Join(dir, "events.jsonl")
	writeLines(t, eventsPath, `{"probe":"x.new","time":"2026-08-14T00:00:00Z","source":"s","fields":{"a":1}}`)

	if _, err := RunLoop(eventsPath, dir); err != nil {
		t.Fatalf("RunLoop: %v", err)
	}
	after := dslVersion(t, dsl)
	if after != before {
		t.Fatalf("loop 不应改动 dsl.json：before=%d after=%d", before, after)
	}
}

func TestRunLoop_NoUndesignedNoProposals(t *testing.T) {
	dir := t.TempDir()
	dsl := NewDesignDSLStore(dir)
	// 全局声明会覆盖所有探针 → 无 undesigned
	dsl.Save([]DSLDecl{{Rule: "design:global", Probe: "", Expect: "全局契约"}}, "构造", "test")

	eventsPath := filepath.Join(dir, "events.jsonl")
	writeLines(t, eventsPath, `{"probe":"anything","time":"2026-08-14T00:00:00Z","source":"s","fields":{"x":1}}`)

	res, err := RunLoop(eventsPath, dir)
	if err != nil {
		t.Fatalf("RunLoop: %v", err)
	}
	if len(res.Proposals) != 0 {
		t.Fatalf("全局声明覆盖下不应产提案，got %d", len(res.Proposals))
	}
}

func TestRunLoop_LowDriftSkipsEvolution(t *testing.T) {
	dir := t.TempDir()
	dsl := NewDesignDSLStore(dir)
	// 全局声明覆盖所有探针 → 无 undesigned；无违反事件 → 偏差率 0
	dsl.Save([]DSLDecl{{Rule: "design:global", Probe: "", Expect: "全局契约"}}, "构造", "test")

	eventsPath := filepath.Join(dir, "events.jsonl")
	writeLines(t, eventsPath, `{"probe":"p1","time":"2026-08-14T00:00:00Z","source":"s","fields":{"x":1}}`)

	res, err := RunLoop(eventsPath, dir)
	if err != nil {
		t.Fatalf("RunLoop: %v", err)
	}
	if res.Triggered {
		t.Error("无偏差的观测不应触发演进")
	}
	if res.SkipReason == "" {
		t.Error("未触发时应有 SkipReason 说明")
	}
	if len(res.Proposals) != 0 {
		t.Fatalf("未触发时不应产提案，got %d", len(res.Proposals))
	}
}

func TestRunLoop_MinUndesignedThresholdHonored(t *testing.T) {
	dir := t.TempDir()
	dsl := NewDesignDSLStore(dir)
	// 只声明 save.writefile，观测出现 net.http / cache.get 两个未声明探针
	dsl.Save([]DSLDecl{{Rule: "design:save", Probe: "save.writefile", Expect: "写文件必须处理错误"}}, "构造", "test")

	eventsPath := filepath.Join(dir, "events.jsonl")
	writeLines(t, eventsPath,
		`{"probe":"net.http","time":"2026-08-14T00:00:00Z","source":"s","fields":{"status":200}}`,
		`{"probe":"cache.get","time":"2026-08-14T00:00:00Z","source":"s","fields":{"hit":false}}`,
	)

	// MinUndesigned=3 > 实际 2 → 不触发
	res, err := RunLoop(eventsPath, dir, LoopOptions{MinUndesigned: 3})
	if err != nil {
		t.Fatalf("RunLoop: %v", err)
	}
	if res.Triggered {
		t.Error("未声明探针数低于 MinUndesigned 不应触发")
	}
	if len(res.Proposals) != 0 {
		t.Fatalf("未触发时不应产提案，got %d", len(res.Proposals))
	}

	// MinUndesigned=2（等于实际）→ 触发
	res2, err := RunLoop(eventsPath, dir, LoopOptions{MinUndesigned: 2})
	if err != nil {
		t.Fatalf("RunLoop: %v", err)
	}
	if !res2.Triggered {
		t.Error("未声明探针数达到 MinUndesigned 应触发")
	}
	if len(res2.Proposals) != 2 {
		t.Fatalf("触发后应产 2 提案，got %d", len(res2.Proposals))
	}
	// 提案声明带审计来源标记
	if res2.Proposals[0].Decls[0].Origin != "runtime-observe" {
		t.Errorf("loop 提案声明 origin 应为 runtime-observe，got %q", res2.Proposals[0].Decls[0].Origin)
	}
}

func TestSanitizeRuleSuffix(t *testing.T) {
	cases := map[string]string{
		"net.http":     "net-http",
		"cache/get":    "cache-get",
		"a.b/c d":      "a-b-c-d",
		"plain":        "plain",
		"x.y.z":        "x-y-z",
	}
	for in, want := range cases {
		if got := sanitizeRuleSuffix(in); got != want {
			t.Fatalf("sanitize(%q)=%q 期望 %q", in, got, want)
		}
	}
}

func writeLines(t *testing.T, path string, lines ...string) {
	t.Helper()
	var b strings.Builder
	for _, l := range lines {
		b.WriteString(l)
		b.WriteString("\n")
	}
	if err := os.WriteFile(path, []byte(b.String()), 0644); err != nil {
		t.Fatalf("写 %s: %v", path, err)
	}
}