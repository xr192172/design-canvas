package probe

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSinkEmitAndJudge(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "probe_events.jsonl")

	sink, err := NewSink(logPath)
	if err != nil {
		t.Fatal(err)
	}

	// 模拟三个打点事件
	_ = sink.Emit("save.writefile", "llm-design", map[string]any{
		"op": "writefile", "err": nil, "path": "/tmp/notes.json", "benign": false,
	})
	_ = sink.Emit("session.remove", "llm-design", map[string]any{
		"op": "remove", "err": os.ErrNotExist.Error(), "path": "/tmp/state.json.tmp", "benign": true,
	})
	_ = sink.Emit("session.removeall", "llm-design", map[string]any{
		"op": "remove", "err": "permission denied", "path": "/tmp/sessions/abc/", "benign": false,
	})
	_ = sink.Emit("session.removeall", "llm-design", map[string]any{
		"op": "remove", "err": nil, "path": "/tmp/sessions/abc/", "benign": false,
	})
	sink.Close()

	// Judge 评判
	judge := new(Judge).AddRule("design:silent-error-discard", SilentErrorDiscard)
	verdicts, err := judge.JudgeLogFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(verdicts) != 4 {
		t.Fatalf("expected 4 verdicts, got %d", len(verdicts))
	}

	// 验证
	// 1. nil err → ok
	// 2. benign err → ok
	// 3. non-benign err → deviation
	// 4. nil err → ok
	expectedResults := []string{"ok", "ok", "deviation", "ok"}
	for i, v := range verdicts {
		if v.Result != expectedResults[i] {
			t.Errorf("verdict %d: expected %s, got %s (reason: %s)", i, expectedResults[i], v.Result, v.Reason)
		}
	}

	// RenderReport
	report := RenderReport(verdicts)
	if !strings.Contains(report, "4 个事件") {
		t.Errorf("report missing count: %s", report)
	}
	if !strings.Contains(report, "1 偏差") {
		t.Errorf("report missing deviation count: %s", report)
	}
	if !strings.Contains(report, "permission denied") {
		t.Errorf("report missing deviation detail: %s", report)
	}
	t.Logf("Report:\n%s", report)
}

// ── 以下 4 条回迁自历史分叉期（2026-08-16 防写爆重构）测试 ──

// TestSinkRotationExtractsDeviations 验证降级保全：环形缓冲轮转覆盖旧槽位前，
// 快车道规则判定的 deviation 事件被抽到独立 deviations.jsonl 保留，其余噪音清空。
func TestSinkRotationExtractsDeviations(t *testing.T) {
	dir := t.TempDir()
	evFile := filepath.Join(dir, "events.jsonl")
	devFile := filepath.Join(dir, "deviations.jsonl")

	sink, err := NewSink(evFile)
	if err != nil {
		t.Fatal(err)
	}
	defer sink.Close()
	sink.
		SetRotationMB(1). // 1MB/槽，让轮转快速触发
		SetRateLimit(0).  // 禁用限速，测试要灌满环形缓冲
		SetJudge(new(Judge).AddRule("design:silent-error-discard", SilentErrorDiscard))

	// 先写一个 deviation（writefile 非良性错误）
	if err := sink.Emit("save.writefile", "llm-design", map[string]any{
		"op": "writefile", "err": "permission denied", "path": "/tmp/x.json", "benign": false,
	}); err != nil {
		t.Fatal(err)
	}

	// 灌入足够多的正常事件（≈14MB > 6 槽 × 1MB），强制环形缓冲完整轮转，
	// 轮转回到 slot0 时必须先抽离其 deviation 再清空。
	for i := 0; i < 150_000; i++ {
		if err := sink.Emit("hot.path", "llm-design", map[string]any{"n": i}); err != nil {
			t.Fatal(err)
		}
	}

	// deviation 应已被抽到独立文件保留
	data, err := os.ReadFile(devFile)
	if err != nil {
		t.Fatalf("read deviations: %v", err)
	}
	content := string(data)
	if !strings.Contains(content, "save.writefile") || !strings.Contains(content, "permission denied") {
		t.Errorf("deviations.jsonl 缺少 deviation 事件。实际:\n%s", content)
	}

	// 事件环应被容量约束（6 槽 × 1MB ≈ ≤7MB）
	matches, _ := filepath.Glob(filepath.Join(dir, "events.jsonl*"))
	var total int64
	for _, m := range matches {
		if fi, err := os.Stat(m); err == nil {
			total += fi.Size()
		}
	}
	if total > 8*1024*1024 {
		t.Errorf("事件环形缓冲超出容量约束: %d bytes", total)
	}
	t.Logf("ring total=%d bytes, deviations=%d bytes", total, len(data))
}

// TestSinkRateLimitDrops 验证每探针限速：瞬时灌入大量同探针事件时，
// token bucket 只放行 burst 个，其余丢弃（热路径写不爆）。
func TestSinkRateLimitDrops(t *testing.T) {
	dir := t.TempDir()
	evFile := filepath.Join(dir, "events.jsonl")
	sink, err := NewSink(evFile)
	if err != nil {
		t.Fatal(err)
	}
	sink.SetRateLimit(10) // 10 事件/秒/探针
	for i := 0; i < 1000; i++ {
		if err := sink.Emit("hot.path", "llm-design", map[string]any{"n": i}); err != nil {
			t.Fatal(err)
		}
	}
	sink.Close()

	data, err := os.ReadFile(evFile)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Count(string(data), "\n")
	if lines > 10 {
		t.Errorf("rate limit 未生效: %d 行 > burst 10", lines)
	}
	t.Logf("rate-limited to %d lines", lines)
}

// TestExtractLockedSurvivesOversizeLine 回归：轮转抽离槽位时，槽位里混有
// 超过 1MB（旧 bufio.Scanner 行上限）的超长噪音行，抽离仍须继续处理其后事件。
func TestExtractLockedSurvivesOversizeLine(t *testing.T) {
	dir := t.TempDir()
	slotPath := filepath.Join(dir, "slot.jsonl")
	devFile := filepath.Join(dir, "deviations.jsonl")

	var sb strings.Builder
	sb.WriteString(`{"probe":"save.writefile","time":"2026-08-16T00:00:00Z","source":"llm-design","fields":{"op":"writefile","err":"denied a","path":"/tmp/a.json","benign":false}}` + "\n")
	sb.WriteString(`{"probe":"noisy.big","time":"2026-08-16T00:00:00Z","source":"llm-design","fields":{"blob":"` + strings.Repeat("x", 2*1024*1024) + `"}}` + "\n")
	sb.WriteString(`{"probe":"save.writefile","time":"2026-08-16T00:00:00Z","source":"llm-design","fields":{"op":"writefile","err":"denied b","path":"/tmp/b.json","benign":false}}` + "\n")
	if err := os.WriteFile(slotPath, []byte(sb.String()), 0o644); err != nil {
		t.Fatal(err)
	}

	sink, err := NewSink(filepath.Join(dir, "events.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer sink.Close()
	sink.
		SetJudge(new(Judge).AddRule("design:silent-error-discard", SilentErrorDiscard)).
		SetDeviationPath(devFile)

	if err := sink.extractLocked(slotPath, time.Now()); err != nil {
		t.Fatalf("extractLocked 被超长行中断: %v", err)
	}
	data, err := os.ReadFile(devFile)
	if err != nil {
		t.Fatalf("read deviations: %v", err)
	}
	content := string(data)
	for _, want := range []string{"/tmp/a.json", "/tmp/b.json"} {
		if !strings.Contains(content, want) {
			t.Errorf("deviations 丢失 %s（超长行打断了抽离）。实际:\n%s", want, content)
		}
	}
	t.Logf("超长行之后的偏差仍被保留: %d bytes", len(data))
}

// TestJudgeLogSurvivesOversizeLine 回归：离线判定同样不能因超长行中止。
func TestJudgeLogSurvivesOversizeLine(t *testing.T) {
	var sb strings.Builder
	sb.WriteString(`{"probe":"save.writefile","time":"2026-08-16T00:00:00Z","source":"llm-design","fields":{"op":"writefile","err":"denied a","path":"/tmp/a.json","benign":false}}` + "\n")
	sb.WriteString(`{"probe":"noisy.big","time":"2026-08-16T00:00:00Z","source":"llm-design","fields":{"blob":"` + strings.Repeat("x", 2*1024*1024) + `"}}` + "\n")
	sb.WriteString(`{"probe":"save.writefile","time":"2026-08-16T00:00:00Z","source":"llm-design","fields":{"op":"writefile","err":"denied b","path":"/tmp/b.json","benign":false}}` + "\n")

	verdicts, err := new(Judge).AddRule("design:silent-error-discard", SilentErrorDiscard).
		JudgeLog(strings.NewReader(sb.String()))
	if err != nil {
		t.Fatalf("JudgeLog 被超长行中断: %v", err)
	}
	if len(verdicts) != 3 {
		t.Fatalf("期望 3 条判定（超长行后的偏差不能被吞掉），实际 %d", len(verdicts))
	}
	if verdicts[2].Result != "deviation" {
		t.Errorf("超长行后的偏差事件未被判定: %+v", verdicts[2])
	}
}