package probe

// 方向 D（deviation 回流 DSL evolution loop）测试：
//   - LoadImpactLedger：缺失/合法/损坏
//   - AnalyzeLedger：偏差率口径（violated+resolved / consumed）、累犯归因与并集、minRepeat 门槛
//   - RunLoop + ledger：台账触发（事件侧干净）、known-spread 提案内容、
//     去重（设计已承认同波及面 / pending 不堆叠 / 波及面增长提更新）

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeLedger(t *testing.T, path string, entries ...map[string]any) {
	t.Helper()
	esc := make([]any, len(entries))
	for i, e := range entries {
		esc[i] = e
	}
	data, err := json.Marshal(map[string]any{"version": 1, "entries": esc})
	if err != nil {
		t.Fatalf("marshal ledger: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatalf("写台账 %s: %v", path, err)
	}
}

func ledgerEntry(id, status string, consumed bool, declared, unexpected []string) map[string]any {
	e := map[string]any{
		"id":             id,
		"created_at":     "2026-08-17T00:00:00Z",
		"declared_files": declared,
		"expected_files": []string{},
		"status":         status,
	}
	if consumed {
		e["consumed_at"] = "2026-08-17T01:00:00Z"
	}
	if unexpected != nil {
		e["unexpected_files"] = unexpected
	}
	return e
}

func TestLoadImpactLedger_MissingFileIsEmpty(t *testing.T) {
	entries, err := LoadImpactLedger(filepath.Join(t.TempDir(), "nope", "ledger.json"))
	if err != nil {
		t.Fatalf("缺失文件应返回空+nil，got err=%v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("缺失文件应无条目，got %d", len(entries))
	}
}

func TestAnalyzeLedger_RateSemantics(t *testing.T) {
	entries := []LedgerEntry{
		{Status: "ok", ConsumedAt: "t"},               // 消费未违反
		{Status: "violated", ConsumedAt: "t"},         // 违反未处理
		{Status: "resolved", ConsumedAt: "t"},         // 违反已过门（历史仍算）
		{Status: "pending"},                           // 未消费 → 不计
		{Status: "expired"},                           // 过期未消费 → 不计
	}
	st := AnalyzeLedger("p", entries, 2)
	if st.Consumed != 3 {
		t.Fatalf("consumed=%d 期望 3", st.Consumed)
	}
	if st.Violated != 2 {
		t.Fatalf("violated=%d 期望 2（violated+resolved）", st.Violated)
	}
	if st.DeviationRate < 0.666 || st.DeviationRate > 0.667 {
		t.Fatalf("rate=%.4f 期望 ≈2/3", st.DeviationRate)
	}
}

func TestAnalyzeLedger_RepeatSpreadUnion(t *testing.T) {
	entries := []LedgerEntry{
		{Status: "violated", ConsumedAt: "t", DeclaredFiles: []string{"src/a.ts"}, UnexpectedFiles: []string{"src/b.ts"}},
		{Status: "resolved", ConsumedAt: "t", DeclaredFiles: []string{"src/a.ts"}, UnexpectedFiles: []string{"src/c.ts", "src/b.ts"}},
		{Status: "violated", ConsumedAt: "t", DeclaredFiles: []string{"src/x.ts"}, UnexpectedFiles: []string{"src/y.ts"}}, // 单次不成模式
	}
	st := AnalyzeLedger("p", entries, 2)
	if len(st.RepeatSpreads) != 1 {
		t.Fatalf("RepeatSpreads=%d 期望 1（a.ts 累犯，x.ts 单次不算）", len(st.RepeatSpreads))
	}
	p := st.RepeatSpreads[0]
	if p.Source != "src/a.ts" || p.Violations != 2 {
		t.Fatalf("pattern=%+v 期望 src/a.ts ×2", p)
	}
	if strings.Join(p.Files, ",") != "src/b.ts,src/c.ts" {
		t.Fatalf("并集应有序 [b c]，got %v", p.Files)
	}
}

// 台账触发（事件侧完全干净）：累犯模式 → 触发演进 + known-spread 提案。
func TestRunLoop_LedgerRepeatSpreadProposes(t *testing.T) {
	dir := t.TempDir()
	dsl := NewDesignDSLStore(dir)
	dsl.Save([]DSLDecl{{Rule: "design:global", Probe: "", Expect: "全局契约"}}, "构造", "test")

	eventsPath := filepath.Join(dir, "events.jsonl")
	writeLines(t, eventsPath, `{"probe":"p1","time":"2026-08-17T00:00:00Z","source":"s","fields":{"x":1}}`)

	ledgerPath := filepath.Join(dir, "ledger.json")
	writeLedger(t, ledgerPath,
		ledgerEntry("d1", "violated", true, []string{"src/a.ts"}, []string{"src/b.ts", "src/c.ts"}),
		ledgerEntry("d2", "violated", true, []string{"src/a.ts"}, []string{"src/c.ts"}),
		ledgerEntry("d3", "ok", true, nil, nil),
	)

	res, err := RunLoop(eventsPath, dir, LoopOptions{LedgerPath: ledgerPath})
	if err != nil {
		t.Fatalf("RunLoop: %v", err)
	}
	if !res.Triggered {
		t.Fatalf("台账累犯应触发演进，skip=%s", res.SkipReason)
	}
	if res.Ledger == nil || res.Ledger.Consumed != 3 || res.Ledger.Violated != 2 {
		t.Fatalf("台账统计异常: %+v", res.Ledger)
	}
	if len(res.Proposals) != 1 {
		t.Fatalf("提案=%d 期望 1（known-spread）", len(res.Proposals))
	}
	d := res.Proposals[0].Decls[0]
	if d.Rule != KnownSpreadRule || d.Probe != "impact.spread" {
		t.Fatalf("声明规则/探针错误: %+v", d)
	}
	if d.Origin != "runtime-observe" || d.Status != "proposed" {
		t.Fatalf("审计字段错误: %+v", d)
	}
	var c knownSpreadConstraint
	if err := json.Unmarshal([]byte(d.Constraint), &c); err != nil {
		t.Fatalf("constraint 应为合法 JSON: %v", err)
	}
	if c.Source != "src/a.ts" || c.Violations != 2 || strings.Join(c.Spread, ",") != "src/b.ts,src/c.ts" {
		t.Fatalf("constraint 内容错误: %+v", c)
	}
}

// 台账干净（全 ok）：事件侧也干净 → 不触发（低频护栏对台账同样生效）。
func TestRunLoop_LedgerCleanDoesNotTrigger(t *testing.T) {
	dir := t.TempDir()
	dsl := NewDesignDSLStore(dir)
	dsl.Save([]DSLDecl{{Rule: "design:global", Probe: "", Expect: "全局契约"}}, "构造", "test")

	eventsPath := filepath.Join(dir, "events.jsonl")
	writeLines(t, eventsPath, `{"probe":"p1","time":"2026-08-17T00:00:00Z","source":"s","fields":{"x":1}}`)

	ledgerPath := filepath.Join(dir, "ledger.json")
	writeLedger(t, ledgerPath,
		ledgerEntry("d1", "ok", true, []string{"src/a.ts"}, nil),
		ledgerEntry("d2", "ok", true, []string{"src/b.ts"}, nil),
	)

	res, err := RunLoop(eventsPath, dir, LoopOptions{LedgerPath: ledgerPath})
	if err != nil {
		t.Fatalf("RunLoop: %v", err)
	}
	if res.Triggered {
		t.Fatal("台账全 ok + 事件干净不应触发")
	}
	if !strings.Contains(res.SkipReason, "台账偏差率 0.0%") {
		t.Fatalf("SkipReason 应含台账统计: %s", res.SkipReason)
	}
	if len(res.Proposals) != 0 {
		t.Fatalf("不应产提案，got %d", len(res.Proposals))
	}
}

// 单次违反（不成累犯模式）但偏差率高 → 触发但无台账提案（可能是失误，不回流）。
func TestRunLoop_LedgerHighRateSingleViolationNoProposal(t *testing.T) {
	dir := t.TempDir()
	dsl := NewDesignDSLStore(dir)
	dsl.Save([]DSLDecl{{Rule: "design:global", Probe: "", Expect: "全局契约"}}, "构造", "test")

	eventsPath := filepath.Join(dir, "events.jsonl")
	writeLines(t, eventsPath, `{"probe":"p1","time":"2026-08-17T00:00:00Z","source":"s","fields":{"x":1}}`)

	ledgerPath := filepath.Join(dir, "ledger.json")
	writeLedger(t, ledgerPath,
		ledgerEntry("d1", "violated", true, []string{"src/a.ts"}, []string{"src/b.ts"}),
	)

	res, err := RunLoop(eventsPath, dir, LoopOptions{LedgerPath: ledgerPath})
	if err != nil {
		t.Fatalf("RunLoop: %v", err)
	}
	if !res.Triggered {
		t.Fatal("偏差率 100% 应触发")
	}
	if len(res.Proposals) != 0 {
		t.Fatalf("单次违反不成模式，不应产提案，got %d", len(res.Proposals))
	}
}

// 去重三态：设计已承认同波及面 → 不提；pending 同源 → 不堆叠；波及面增长 → 提更新。
func TestRunLoop_KnownSpreadDedup(t *testing.T) {
	dir := t.TempDir()
	dsl := NewDesignDSLStore(dir)
	dsl.Save([]DSLDecl{{Rule: "design:global", Probe: "", Expect: "全局契约"}}, "构造", "test")

	eventsPath := filepath.Join(dir, "events.jsonl")
	writeLines(t, eventsPath, `{"probe":"p1","time":"2026-08-17T00:00:00Z","source":"s","fields":{"x":1}}`)

	ledgerPath := filepath.Join(dir, "ledger.json")
	writeLedger(t, ledgerPath,
		ledgerEntry("d1", "violated", true, []string{"src/a.ts"}, []string{"src/b.ts"}),
		ledgerEntry("d2", "violated", true, []string{"src/a.ts"}, []string{"src/b.ts"}),
	)

	// 第一轮：生成 pending 提案
	res1, err := RunLoop(eventsPath, dir, LoopOptions{LedgerPath: ledgerPath})
	if err != nil {
		t.Fatalf("RunLoop 1: %v", err)
	}
	if len(res1.Proposals) != 1 {
		t.Fatalf("第一轮应产 1 提案，got %d", len(res1.Proposals))
	}

	// 第二轮（同数据）：pending 同源 → 不堆叠
	res2, err := RunLoop(eventsPath, dir, LoopOptions{LedgerPath: ledgerPath})
	if err != nil {
		t.Fatalf("RunLoop 2: %v", err)
	}
	if len(res2.Proposals) != 0 {
		t.Fatalf("pending 去重后第二轮不应堆叠，got %d", len(res2.Proposals))
	}

	// 审批第一份提案：known-spread 无确定性谓词 → 需 LLM 复核过门（stub 放行，
	// 真实链路走统一判定服务——数据回流设计必须过门把关，这是设计意图）
	propID := res1.Proposals[0].ID
	ps := NewProposalStore(dir)
	gate := VerifyGate{LLMReview: func(ctx context.Context, decls []DSLDecl) ([]LLMVerdict, error) {
		vs := make([]LLMVerdict, len(decls))
		for i, d := range decls {
			vs[i] = LLMVerdict{Result: "ok", Rule: d.Rule, Reason: "stub: 耦合属实"}
		}
		return vs, nil
	}}
	if _, err := ps.ApproveGated(context.Background(), propID, "test", NewDesignDSLStore(dir), gate); err != nil {
		t.Fatalf("approveGated: %v", err)
	}

	// 第三轮（同数据）：设计已承认同波及面 → 不再提
	res3, err := RunLoop(eventsPath, dir, LoopOptions{LedgerPath: ledgerPath})
	if err != nil {
		t.Fatalf("RunLoop 3: %v", err)
	}
	if len(res3.Proposals) != 0 {
		t.Fatalf("设计已承认同波及面，不应再提，got %d", len(res3.Proposals))
	}

	// 第四轮：波及面增长（新增 src/c.ts）→ 提更新提案
	writeLedger(t, ledgerPath,
		ledgerEntry("d1", "violated", true, []string{"src/a.ts"}, []string{"src/b.ts"}),
		ledgerEntry("d2", "violated", true, []string{"src/a.ts"}, []string{"src/b.ts"}),
		ledgerEntry("d3", "violated", true, []string{"src/a.ts"}, []string{"src/c.ts"}),
	)
	res4, err := RunLoop(eventsPath, dir, LoopOptions{LedgerPath: ledgerPath})
	if err != nil {
		t.Fatalf("RunLoop 4: %v", err)
	}
	if len(res4.Proposals) != 1 {
		t.Fatalf("波及面增长应提更新提案，got %d", len(res4.Proposals))
	}
	var c knownSpreadConstraint
	if err := json.Unmarshal([]byte(res4.Proposals[0].Decls[0].Constraint), &c); err != nil {
		t.Fatalf("constraint: %v", err)
	}
	if strings.Join(c.Spread, ",") != "src/b.ts,src/c.ts" {
		t.Fatalf("更新提案应含增长后的并集，got %v", c.Spread)
	}
}

// sameSpreadSet 单元：集合相同（乱序）→ true；大小不同 → false。
func TestSameSpreadSet(t *testing.T) {
	a := knownSpreadConstraint{Source: "a", Spread: []string{"x", "y"}}
	if !sameSpreadSet(a, SpreadPattern{Source: "a", Files: []string{"y", "x"}}) {
		t.Fatal("乱序同集应相等")
	}
	if sameSpreadSet(a, SpreadPattern{Source: "a", Files: []string{"x"}}) {
		t.Fatal("大小不同不应相等")
	}
	if sameSpreadSet(a, SpreadPattern{Source: "a", Files: []string{"x", "z"}}) {
		t.Fatal("元素不同不应相等")
	}
}
