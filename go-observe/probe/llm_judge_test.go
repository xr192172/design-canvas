package probe

import (
	"context"
	"strings"
	"testing"
	"time"
)

// mockSender 捕获发给 LLM 的 messages 并按预设内容回包。
type mockSender struct {
	got      []LLMMessage // 捕获的原始消息（用于断言输入范围）
	reply    string
	replyErr error
	callCount int
}

func (m *mockSender) SendWithContext(_ context.Context, messages []LLMMessage) (*LLMResponse, error) {
	m.callCount++
	m.got = messages
	if m.replyErr != nil {
		return nil, m.replyErr
	}
	return &LLMResponse{Content: m.reply}, nil
}

// 构造一个带事件的 LLM 判定场景（writefile 非良性错误）。
func sampleEvent() Event {
	return Event{
		Probe:  "save.writefile",
		Source: "llm-design",
		Fields: map[string]any{
			"op":     "writefile",
			"path":   "/tmp/x/notes.json",
			"bytes":  int64(42),
			"benign": false,
			"err":    "open /tmp/x/notes.json: no such file or directory",
		},
	}
}

// 断言 LLM 判定输入只含「事件快照 + DSL 声明」，不含任何项目文档内容。
func TestLLMJudge_PromptOnlyDSLAndEvent(t *testing.T) {
	ms := &mockSender{reply: `{"result":"deviation","rule":"design:silent-error-discard","reason":"writefile 失败说明数据未持久化"}`}
	j := NewLLMJudge(ms).AddDSL(SilentErrorDiscardDSL())

	v, err := j.JudgeEvent(context.Background(), sampleEvent())
	if err != nil {
		t.Fatalf("JudgeEvent: %v", err)
	}
	if v.Result != "deviation" {
		t.Fatalf("result = %q, want deviation", v.Result)
	}
	if v.Rule != "design:silent-error-discard" {
		t.Fatalf("rule = %q", v.Rule)
	}
	if v.Reason == "" {
		t.Fatal("reason empty")
	}

	// 断言输入范围：prompt 必须含 DSL 声明与事件字段，
	// 且不能出现任何项目文档特征（架构、历史、注释等关键词）。
	prompt := ms.got[1].Content
	for _, want := range []string{"【DSL 契约声明】", "design:silent-error-discard", "save.writefile", "期望", "约束"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt 缺少 %q", want)
		}
	}
	for _, banned := range []string{"架构", "历史", "ch17", "AGENTS", "文档"} {
		if strings.Contains(prompt, banned) {
			t.Errorf("prompt 混入了非 DSL 内容 %q（违反唯一真相源）", banned)
		}
	}
}

// DSL 按 probe 精确匹配：不匹配该探针点的声明不参与判定。
func TestLLMJudge_DSLProbeMatch(t *testing.T) {
	ms := &mockSender{reply: `{"result":"ok","rule":"","reason":"ok"}`}
	j := NewLLMJudge(ms).
		AddDSL(DSLDecl{Rule: "other:rule", Probe: "unrelated.probe", Expect: "只适用其他探针"})

	// 事件探针 save.writefile 不匹配 unrelated.probe → 无声明可判 → 直接 ok，不调 LLM
	v, err := j.JudgeEvent(context.Background(), sampleEvent())
	if err != nil {
		t.Fatalf("JudgeEvent: %v", err)
	}
	if v.Result != "ok" || ms.callCount != 0 {
		t.Fatalf("期望不调 LLM 直接 ok；got result=%q calls=%d", v.Result, ms.callCount)
	}
}

// 空 Probe 声明匹配所有探针点（全局契约）。
func TestLLMJudge_DSLGlobalMatches(t *testing.T) {
	ms := &mockSender{reply: `{"result":"deviation","rule":"design:silent-error-discard","reason":"x"}`}
	j := NewLLMJudge(ms).AddDSL(SilentErrorDiscardDSL()) // Probe == ""
	_, err := j.JudgeEvent(context.Background(), sampleEvent())
	if err != nil {
		t.Fatalf("JudgeEvent: %v", err)
	}
	if ms.callCount != 1 {
		t.Fatalf("全局声明应触发 LLM 调用，got calls=%d", ms.callCount)
	}
}

// sender 未注入 → 报错（装配层没接 Router 时降级）。
func TestLLMJudge_NoSender(t *testing.T) {
	j := NewLLMJudge(nil).AddDSL(SilentErrorDiscardDSL())
	if _, err := j.JudgeEvent(context.Background(), sampleEvent()); err == nil {
		t.Fatal("期望无 sender 报错")
	}
}

// 响应不是合法 JSON → 报错。
func TestLLMJudge_BadJSON(t *testing.T) {
	ms := &mockSender{reply: "抱歉我无法判定"}
	j := NewLLMJudge(ms).AddDSL(SilentErrorDiscardDSL())
	if _, err := j.JudgeEvent(context.Background(), sampleEvent()); err == nil {
		t.Fatal("期望非 JSON 响应报错")
	}
}

// result 非法值 → 报错。
func TestLLMJudge_InvalidResult(t *testing.T) {
	ms := &mockSender{reply: `{"result":"maybe","rule":"r","reason":"x"}`}
	j := NewLLMJudge(ms).AddDSL(SilentErrorDiscardDSL())
	if _, err := j.JudgeEvent(context.Background(), sampleEvent()); err == nil {
		t.Fatal("期望非法 result 报错")
	}
}

// LLM 调用错误 → 透传错误（调用方降级，不 panic）。
func TestLLMJudge_SendError(t *testing.T) {
	ms := &mockSender{replyErr: context.DeadlineExceeded}
	j := NewLLMJudge(ms).AddDSL(SilentErrorDiscardDSL())
	if _, err := j.JudgeEvent(context.Background(), sampleEvent()); err == nil {
		t.Fatal("期望 send 错误透传")
	}
}

func TestExtractFirstJSON(t *testing.T) {
	got := extractFirstJSON("```json\n{\"a\":1,\"b\":{\"c\":2}}\n```")
	if got != `{"a":1,"b":{"c":2}}` {
		t.Fatalf("extractFirstJSON = %q", got)
	}
	if extractFirstJSON("no json here") != "" {
		t.Fatal("无 JSON 应返回空串")
	}
}

func TestLLMJudge_TimeoutConfig(t *testing.T) {
	ms := &mockSender{reply: `{"result":"ok","rule":"","reason":"ok"}`}
	j := NewLLMJudge(ms).SetTimeout(2 * time.Second)
	if j.timeout != 2*time.Second {
		t.Fatalf("timeout 未生效: %v", j.timeout)
	}
}
