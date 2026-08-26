package probe

// llm_sink_test.go — Sink 轮转抽离的 LLM 慢车道复核测试。
// 回迁自历史分叉期（2026-08-16 防写爆重构）；mockSender/sampleEvent
// 复用 llm_judge_test.go 的定义（同包）。

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

var errTestLLM = errors.New("llm judge test failure")

// 构造一个带规则 Judge + LLM Judge 的 Sink（仅用于直接测 extractLocked）。
func llmSinkForTest(t *testing.T, devPath string, llm *LLMJudge) *Sink {
	t.Helper()
	s := &Sink{
		judge:    new(Judge).AddRule("design:silent-error-discard", SilentErrorDiscard),
		devPath:  devPath,
		devMB:    256,
		llmJudge: llm,
	}
	return s
}

// 把一个含事件的槽位文件写到临时目录，返回文件路径。
func writeEventSlot(t *testing.T, dir string, evs ...Event) string {
	t.Helper()
	var b bytes.Buffer
	for _, ev := range evs {
		data, err := json.Marshal(ev)
		if err != nil {
			t.Fatalf("marshal event: %v", err)
		}
		b.Write(data)
		b.WriteByte('\n')
	}
	path := filepath.Join(dir, "slot.jsonl")
	if err := os.WriteFile(path, b.Bytes(), 0o644); err != nil {
		t.Fatalf("write slot: %v", err)
	}
	return path
}

// 读取 deviations 文件并解析为 DeviationEntry 列表。
func readDevEntries(t *testing.T, devPath string) []DeviationEntry {
	t.Helper()
	data, err := os.ReadFile(devPath)
	if err != nil {
		return nil
	}
	var out []DeviationEntry
	for _, line := range bytes.Split(bytes.TrimSpace(data), []byte{'\n'}) {
		if len(line) == 0 {
			continue
		}
		var e DeviationEntry
		if err := json.Unmarshal(line, &e); err != nil {
			t.Fatalf("parse deviation line %q: %v", string(line), err)
		}
		out = append(out, e)
	}
	return out
}

// LLM 判 deviation → 保留，rule/reason 用 LLM 版本覆盖。
func TestExtract_LLMConfirmsDeviation(t *testing.T) {
	dir := t.TempDir()
	devPath := filepath.Join(dir, "deviations.jsonl")
	ms := &mockSender{reply: `{"result":"deviation","rule":"design:silent-error-discard","reason":"LLM 确认 writefile 失败说明数据未持久化"}`}
	llm := NewLLMJudge(ms).AddDSL(SilentErrorDiscardDSL())

	s := llmSinkForTest(t, devPath, llm)
	slot := writeEventSlot(t, dir, sampleEvent())

	if err := s.extractLocked(slot, time.Now()); err != nil {
		t.Fatalf("extractLocked: %v", err)
	}
	entries := readDevEntries(t, devPath)
	if len(entries) != 1 {
		t.Fatalf("deviation entries = %d, want 1 (LLM 确认保留)", len(entries))
	}
	if entries[0].Rule != "design:silent-error-discard" {
		t.Fatalf("rule = %q", entries[0].Rule)
	}
	if !bytes.Contains([]byte(entries[0].Reason), []byte("LLM 确认")) {
		t.Fatalf("reason 未被 LLM 版本覆盖: %q", entries[0].Reason)
	}
	if ms.callCount != 1 {
		t.Fatalf("LLM 调用次数 = %d, want 1", ms.callCount)
	}
}

// LLM 判 ok → 规则误报被纠正，deviation 不保留。
func TestExtract_LLMOverridesToOK(t *testing.T) {
	dir := t.TempDir()
	devPath := filepath.Join(dir, "deviations.jsonl")
	ms := &mockSender{reply: `{"result":"ok","rule":"","reason":"该目录删除行为属良性清理"}`}
	llm := NewLLMJudge(ms).AddDSL(SilentErrorDiscardDSL())

	s := llmSinkForTest(t, devPath, llm)
	slot := writeEventSlot(t, dir, sampleEvent())

	if err := s.extractLocked(slot, time.Now()); err != nil {
		t.Fatalf("extractLocked: %v", err)
	}
	if entries := readDevEntries(t, devPath); len(entries) != 0 {
		t.Fatalf("LLM 判 ok 后仍保留了 %d 条 deviation，want 0", len(entries))
	}
}

// LLM 调用失败 → 降级保留规则版判定（安全侧，宁多留不漏报）。
func TestExtract_LLMErrorFallsBack(t *testing.T) {
	dir := t.TempDir()
	devPath := filepath.Join(dir, "deviations.jsonl")
	ms := &mockSender{replyErr: errTestLLM}
	llm := NewLLMJudge(ms).AddDSL(SilentErrorDiscardDSL())

	s := llmSinkForTest(t, devPath, llm)
	slot := writeEventSlot(t, dir, sampleEvent())

	if err := s.extractLocked(slot, time.Now()); err != nil {
		t.Fatalf("extractLocked: %v", err)
	}
	entries := readDevEntries(t, devPath)
	if len(entries) != 1 {
		t.Fatalf("LLM 失败应降级保留规则版，got %d entries", len(entries))
	}
	// 规则版 reason（未含 LLM 特征标记）。
	if bytes.Contains([]byte(entries[0].Reason), []byte("LLM")) {
		t.Fatalf("降级后 reason 不应来自 LLM: %q", entries[0].Reason)
	}
}

// 无 LLM Judge → 纯规则抽离（回归：不装配 LLM 时行为不变）。
func TestExtract_NoLLMJudgeRuleOnly(t *testing.T) {
	dir := t.TempDir()
	devPath := filepath.Join(dir, "deviations.jsonl")
	s := llmSinkForTest(t, devPath, nil)
	slot := writeEventSlot(t, dir, sampleEvent())

	if err := s.extractLocked(slot, time.Now()); err != nil {
		t.Fatalf("extractLocked: %v", err)
	}
	if entries := readDevEntries(t, devPath); len(entries) != 1 {
		t.Fatalf("纯规则抽离应保留 1 条，got %d", len(entries))
	}
}

// 全局注入兜底：Sink 未显式 SetLLMJudge 时从 global 拾取（解耦装配顺序）。
func TestExtract_GlobalLLMJudgeFallback(t *testing.T) {
	dir := t.TempDir()
	devPath := filepath.Join(dir, "deviations.jsonl")
	ms := &mockSender{reply: `{"result":"ok","rule":"","reason":"规则误报，LLM 纠正"}`}
	llm := NewLLMJudge(ms).AddDSL(SilentErrorDiscardDSL())
	SetGlobalLLMJudge(llm)
	defer SetGlobalLLMJudge(nil)

	// Sink 不显式 SetLLMJudge → llmJudgeFor 走 global。
	s := llmSinkForTest(t, devPath, nil)
	slot := writeEventSlot(t, dir, sampleEvent())

	if err := s.extractLocked(slot, time.Now()); err != nil {
		t.Fatalf("extractLocked: %v", err)
	}
	if entries := readDevEntries(t, devPath); len(entries) != 0 {
		t.Fatalf("global LLM 判 ok 后仍保留 %d 条，want 0", len(entries))
	}
}
