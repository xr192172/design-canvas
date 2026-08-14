package probe

// Package probe — JudgeClient: Go 侧统一判定入口（PR 偏差3）。
//
// 目的：把「偏差判定」收敛到 TS 判定服务（judge_service.ts，挂 /api/camera/judge），
// 避免 Go 侧复刻判定规则造成语义漂移。Go 侧只负责把采集到的 Event 批量 POST 过去，
// 复用同一份判定实现。未配置服务地址时降级为本地规则判定（SilentErrorDiscard），
// 保证离线/单测环境仍可用——判定语义与 TS 逐条对齐。
//
// 判定入口（与 TS JudgeResult 对齐）：
//   POST {judge_endpoint}   body: { events: TSEvent[] } → { total, ok, deviation, entries:[{verdict,event}] }
//
// 地址来源：环境变量 CAMERA_JUDGE_URL（如 http://localhost:8080/api/camera/judge）。
// 未设置 → IsRemote() 返回 false，走本地判定。

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"
)

// EnvJudgeURL 是 TS 判定服务地址的环境变量名。
const EnvJudgeURL = "CAMERA_JUDGE_URL"

// JudgeURL 返回当前配置的判定服务地址；未配置返回 ""。
func JudgeURL() string { return os.Getenv(EnvJudgeURL) }

// JudgeClient 是 Go 侧统一判定入口。Endpoint 为空时走本地判定。
type JudgeClient struct {
	Endpoint string
	Timeout  time.Duration
	Client   *http.Client

	// 本地判定（Endpoint 为空时使用）。外部可替换为装配好的 Judge。
	Local func(ev Event) Verdict
}

// NewJudgeClient 创建判定客户端。Endpoint 取 JudgeURL()（可覆盖）。
func NewJudgeClient(endpoint string) *JudgeClient {
	c := &JudgeClient{
		Endpoint: endpoint,
		Timeout:  10 * time.Second,
	}
	if c.Endpoint == "" {
		c.Endpoint = JudgeURL()
	}
	local := new(Judge).AddRule("design:silent-error-discard", SilentErrorDiscard)
	c.Local = local.JudgeEvent
	return c
}

// IsRemote 报告是否走远程 TS 判定服务。
func (c *JudgeClient) IsRemote() bool { return c.Endpoint != "" }

// JudgeEvents 判定一批事件。远程可用则 POST 到 TS 判定服务（复用同一判定实现），
// 否则降级本地判定。远程调用失败时返回错误（调用方决定是否降级）。
func (c *JudgeClient) JudgeEvents(ctx context.Context, events []Event) ([]Verdict, error) {
	if !c.IsRemote() {
		return judgeLocal(c, events), nil
	}
	return c.judgeRemote(ctx, events)
}

// judgeLocal 本地判定：逐事件跑注册的本地谓词。
func judgeLocal(c *JudgeClient, events []Event) []Verdict {
	out := make([]Verdict, 0, len(events))
	for _, ev := range events {
		out = append(out, c.Local(ev))
	}
	return out
}

// tsEvent 是 TS 侧 TSEvent 的 JSON 形状（time 为字符串）。
type tsEvent struct {
	Probe  string         `json:"probe"`
	Time   string         `json:"time"`
	Source string         `json:"source"`
	Fields map[string]any `json:"fields"`
}

// tsEntry 是 TS JudgeResult.entries 的一项。
type tsEntry struct {
	Verdict struct {
		Result string `json:"result"`
		Rule   string `json:"rule"`
		Reason string `json:"reason"`
	} `json:"verdict"`
	Event tsEvent `json:"event"`
}

// tsResult 是 TS JudgeResult 的 JSON 形状。
type tsResult struct {
	Total      int       `json:"total"`
	Ok         int       `json:"ok"`
	Deviation  int       `json:"deviation"`
	Entries    []tsEntry `json:"entries"`
}

// judgeRemote 把事件 POST 到 TS 判定服务，解析回 Verdict。
func (c *JudgeClient) judgeRemote(ctx context.Context, events []Event) ([]Verdict, error) {
	payload := map[string]any{"events": toTSEvents(events)}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("judge_client: marshal events: %w", err)
	}

	ctx, cancel := context.WithTimeout(ctx, c.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("judge_client: new request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	client := c.Client
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("judge_client: post %s: %w", c.Endpoint, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("judge_client: %s returned %d", c.Endpoint, resp.StatusCode)
	}

	var res tsResult
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, fmt.Errorf("judge_client: decode response: %w", err)
	}

	out := make([]Verdict, 0, len(res.Entries))
	for _, e := range res.Entries {
		out = append(out, Verdict{
			Event: Event{
				Probe:  e.Event.Probe,
				Source: e.Event.Source,
				Fields: e.Event.Fields,
			},
			Rule:   e.Verdict.Rule,
			Result: e.Verdict.Result,
			Reason: e.Verdict.Reason,
		})
	}
	return out, nil
}

// toTSEvents 把 Go Event 转成 TS TSEvent 形状（time 渲染为 RFC3339 字符串）。
func toTSEvents(events []Event) []tsEvent {
	out := make([]tsEvent, 0, len(events))
	for _, ev := range events {
		out = append(out, tsEvent{
			Probe:  ev.Probe,
			Time:   ev.Time.Format(time.RFC3339Nano),
			Source: ev.Source,
			Fields: ev.Fields,
		})
	}
	return out
}