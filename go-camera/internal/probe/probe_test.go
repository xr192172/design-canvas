package probe

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
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