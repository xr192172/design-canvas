// Package probe — LLMJudge: Camera 行为级偏差判定。
//
// 设计原则（2026-08-14，DSL 唯一真相源）：
//   - LLM 判定只看到「事件观测快照 + DSL 契约声明」两样东西，永不接触项目文档。
//   - DSL 声明是行为级判定的唯一真相源；判定不准时补 DSL，而不是靠文档兜底。
//   - 只对「可疑/待复核」事件调用（规则判定秒判不掉的），成本可控。
//   - 发送走统一 Router（router.ForTask(provider.TaskCamera)），每次调用自动
//     记入 UsageJournal 账本。probe 包只依赖 client 的发送接口，不 import
//     provider——依赖方向是装配层 → probe。
package probe

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// LLMMessage 是喂给 LLM 的一条消息。自包含最小形态（role/content），
// 由装配层把本模块的发送器适配到真实 LLM client（如 ai-base 的 Router）。
type LLMMessage struct {
	Role    string // system | user | assistant
	Content string
}

// LLMResponse 是 LLM 判定的返回（自包含，只取文本内容）。
type LLMResponse struct {
	Content string
}

// LLMSender 是 LLM 行为判定的发送器抽象。probe 包只依赖这个最小接口，
// 不 import 任何具体 client/provider——依赖方向是装配层 → probe。
type LLMSender interface {
	SendWithContext(ctx context.Context, messages []LLMMessage) (*LLMResponse, error)
}

// DSLDecl 是 Camera DSL 的一条声明——行为级判定的唯一真相源。
// LLM 判定输入 = 事件快照 + 匹配的 DSLDecl，不含任何项目文档背景。
type DSLDecl struct {
	Rule       string `json:"rule"`              // 规则 id，如 design:silent-error-discard
	Probe      string `json:"probe"`             // 探针点 id；空 = 匹配所有探针点
	Expect     string `json:"expect"`            // 期望行为（人类可读，喂给 LLM）
	Constraint string `json:"constraint,omitempty"` // 精确约束（可选，进一步限定 Expect）
}

// LLMVerdict 是 LLM 行为判定的结构化结果，与规则判定 Verdict 对齐。
type LLMVerdict struct {
	Result string `json:"result"` // ok | deviation
	Rule   string `json:"rule"`   // 命中的 DSL 规则 id
	Reason string `json:"reason"` // 判定理由（一句话）
}

// LLMJudge 用 LLM 对可疑事件做行为级判定。sender 为 nil 时 JudgeEvent 返回
// 错误（调用方降级处理，不阻断流程）。
type LLMJudge struct {
	sender  LLMSender
	decls   []DSLDecl
	timeout time.Duration
}

// NewLLMJudge 创建 LLM 行为判定器。
func NewLLMJudge(sender LLMSender) *LLMJudge {
	return &LLMJudge{sender: sender, timeout: 30 * time.Second}
}

// SetTimeout 覆盖单次判定的 LLM 调用超时（默认 30s）。
func (j *LLMJudge) SetTimeout(d time.Duration) *LLMJudge {
	j.timeout = d
	return j
}

// AddDSL 注册一条 DSL 声明（判定依据，唯一真相源）。
func (j *LLMJudge) AddDSL(d DSLDecl) *LLMJudge {
	j.decls = append(j.decls, d)
	return j
}

// LoadDSL 从 DesignDSLStore 加载当前设计 DSL 作为判定依据（替换硬编码装配）。
// dsl.json 不存在时自动播种 v1 种子，保证永远有可判定声明。加载即整体替换
// 既有 decls（以权威仓库为准）。
func (j *LLMJudge) LoadDSL(store *DesignDSLStore) error {
	if _, err := store.SeedDefault(); err != nil {
		return err
	}
	doc, err := store.Load()
	if err != nil {
		return err
	}
	j.decls = append([]DSLDecl(nil), doc.Decls...)
	return nil
}

// SilentErrorDiscardDSL 把静默错误丢弃契约表达成 DSL 声明，供 LLM 行为级判定
// 使用。与规则判定 SilentErrorDiscard 共用同一契约语义（单一事实来源：Go 谓词
// 判确定性，DSL 声明喂语义）。
func SilentErrorDiscardDSL() DSLDecl {
	return DSLDecl{
		Rule:  "design:silent-error-discard",
		Probe: "",
		Expect: "在本来会静默丢弃错误的位置，捕获到的 err 必须为 nil 或可证明是良性的（benign）",
		Constraint: "op=writefile/save/mkdirall 时任何错误都不可良性（父目录缺失的 ENOENT 也算非良性，因为数据未持久化）；op=remove/cleanup 仅 os.IsNotExist 良性",
	}
}

// matchingDecls 返回与事件匹配的 DSL 声明（probe 精确或空匹配）。
func (j *LLMJudge) matchingDecls(ev Event) []DSLDecl {
	var out []DSLDecl
	for _, d := range j.decls {
		if d.Probe == "" || d.Probe == ev.Probe {
			out = append(out, d)
		}
	}
	return out
}

// JudgeEvent 用 LLM 判定一个可疑事件。只把「事件快照 + 匹配的 DSL 声明」喂给
// LLM（DSL 唯一真相源）。LLM 调用失败返回 err（调用方降级处理）。
func (j *LLMJudge) JudgeEvent(ctx context.Context, ev Event) (LLMVerdict, error) {
	if j.sender == nil {
		return LLMVerdict{}, fmt.Errorf("llm_judge: no sender injected (router.ForTask(TaskCamera))")
	}
	decls := j.matchingDecls(ev)
	if len(decls) == 0 {
		return LLMVerdict{Result: "ok", Reason: "no DSL declaration matched — nothing to adjudicate"}, nil
	}

	llmCtx, cancel := context.WithTimeout(ctx, j.timeout)
	defer cancel()
	resp, err := j.sender.SendWithContext(llmCtx, []LLMMessage{
		{Role: "system", Content: "你是代码行为判定器。只依据给出的 DSL 契约声明与事件观测快照判定，不得臆测项目文档之外的背景。输出纯 JSON，不要 markdown。"},
		{Role: "user", Content: buildLLMPrompt(ev, decls)},
	})
	if err != nil {
		return LLMVerdict{}, fmt.Errorf("llm_judge: send: %w", err)
	}
	if resp.Content == "" {
		return LLMVerdict{}, fmt.Errorf("llm_judge: empty response")
	}

	jsonStr := extractFirstJSON(resp.Content)
	if jsonStr == "" {
		return LLMVerdict{}, fmt.Errorf("llm_judge: no JSON in response: %.200s", resp.Content)
	}
	var v LLMVerdict
	if err := json.Unmarshal([]byte(jsonStr), &v); err != nil {
		return LLMVerdict{}, fmt.Errorf("llm_judge: parse verdict: %w (raw=%.300s)", err, resp.Content)
	}
	if v.Result != "ok" && v.Result != "deviation" {
		return LLMVerdict{}, fmt.Errorf("llm_judge: invalid result %q (raw=%.200s)", v.Result, resp.Content)
	}
	return v, nil
}

// buildLLMPrompt 组装判定 prompt：只含事件快照 + DSL 声明（唯一真相源，无文档）。
func buildLLMPrompt(ev Event, decls []DSLDecl) string {
	var b strings.Builder
	b.WriteString("【事件观测快照】\n")
	fmt.Fprintf(&b, "probe: %s\n", ev.Probe)
	fmt.Fprintf(&b, "source: %s\n", ev.Source)
	b.WriteString("fields:\n")
	for k, val := range ev.Fields {
		fmt.Fprintf(&b, "  %s: %v\n", k, val)
	}
	b.WriteString("\n【DSL 契约声明】（判定唯一依据）\n")
	for i, d := range decls {
		fmt.Fprintf(&b, "%d) Rule=%s\n   期望: %s\n", i+1, d.Rule, d.Expect)
		if d.Constraint != "" {
			fmt.Fprintf(&b, "   约束: %s\n", d.Constraint)
		}
	}
	b.WriteString("\n【输出】纯 JSON：{\"result\":\"ok\"|\"deviation\",\"rule\":\"<命中的规则id>\",\"reason\":\"一句话说明\"}")
	return b.String()
}

// extractFirstJSON 从文本中提取第一个 {...} JSON 对象。与 memory 包同名单函数
// 逻辑一致，保持 LLM JSON 输出的解析惯例。
func extractFirstJSON(s string) string {
	start := strings.Index(s, "{")
	if start < 0 {
		return ""
	}
	depth := 0
	for i := start; i < len(s); i++ {
		switch s[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return s[start : i+1]
			}
		}
	}
	return ""
}
