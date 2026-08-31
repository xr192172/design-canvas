package probe

// Package probe — Aggregator: 把事件流聚合为观测事实画像（P2）。
//
// actual DSL 是「可再生·非权威」的：它只描述观测到的真实行为分布，不做期望
// 声明。每个探针点一个 ProbeObs，含统计（count/errs/benigns）、去重 op、
// 人类可读事实摘要，以及全量证据事件——Comparator 据此做精确违反判定，
// 也使 actual.dsl.json 自给自足（无需再读 events.jsonl）。

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// ActualDSLDoc 是观测事实画像（可再生·非权威）。区别于设计 DSL（权威），
// 它只描述"观测到的真实行为分布"，不声明期望。
type ActualDSLDoc struct {
	GeneratedAt   time.Time  `json:"generated_at"`
	Source        string     `json:"source,omitempty"` // 事件来源路径
	EventCount    int        `json:"event_count"`
	BadLines      int        `json:"bad_lines,omitempty"` // 读取时跳过的坏行数
	Probes        []ProbeObs `json:"probes"`
	Chains        []ChainObs `json:"chains,omitempty"`         // 链路画像（v2：trace 三元组重建，可再生自 events）
	ChainsDropped int        `json:"chains_dropped,omitempty"` // 超预算被丢弃的链数
}

// ProbeObs 是单个探针点的观测画像。
type ProbeObs struct {
	Probe   string   `json:"probe"`
	Count   int      `json:"count"`
	Errs    int      `json:"errs"`             // 捕获到非空 err 的事件数
	Benigns int      `json:"benigns"`          // 标记良性的事件数
	Ops     []string `json:"ops,omitempty"`    // 去重的 op 取值（保持出现顺序）
	Facts   []string `json:"facts,omitempty"`  // 人类可读的事实摘要
	Events  []Event  `json:"events,omitempty"` // 全量证据（可再生自 events.jsonl）
}

// Aggregator 把事件流按 probe 聚合成观测画像。
type Aggregator struct{}

// NewAggregator 创建聚合器。
func NewAggregator() *Aggregator { return &Aggregator{} }

// Aggregate 按 probe 分组统计，返回观测画像（探针按名字排序）。
func (a *Aggregator) Aggregate(events []Event) ActualDSLDoc {
	byProbe := map[string][]Event{}
	for _, ev := range events {
		byProbe[ev.Probe] = append(byProbe[ev.Probe], ev)
	}
	names := make([]string, 0, len(byProbe))
	for name := range byProbe {
		names = append(names, name)
	}
	sort.Strings(names)

	probes := make([]ProbeObs, 0, len(names))
	for _, name := range names {
		evs := byProbe[name]
		obs := ProbeObs{Probe: name, Count: len(evs), Events: evs}
		seenOps := map[string]bool{}
		for _, ev := range evs {
			if s, _ := ev.Fields["err"].(string); s != "" {
				obs.Errs++
			}
			if b, _ := ev.Fields["benign"].(bool); b {
				obs.Benigns++
			}
			if op, _ := ev.Fields["op"].(string); op != "" && !seenOps[op] {
				seenOps[op] = true
				obs.Ops = append(obs.Ops, op)
			}
		}
		obs.Facts = buildProbeFacts(obs)
		probes = append(probes, obs)
	}

	chains, dropped := RebuildChains(events)

	return ActualDSLDoc{
		GeneratedAt:   time.Now().UTC(),
		EventCount:    len(events),
		Probes:        probes,
		Chains:        chains,
		ChainsDropped: dropped,
	}
}

// buildProbeFacts 生成人类可读的事实摘要（供画像快速阅读）。
func buildProbeFacts(obs ProbeObs) []string {
	var f []string
	if obs.Errs == 0 {
		f = append(f, "所有事件 err 均为 nil")
	} else {
		f = append(f, fmt.Sprintf("%d/%d 事件捕获到非空 err", obs.Errs, obs.Count))
	}
	if obs.Benigns > 0 {
		f = append(f, fmt.Sprintf("%d 个错误标记为良性", obs.Benigns))
	}
	if len(obs.Ops) > 0 {
		f = append(f, fmt.Sprintf("覆盖 op: %s", strings.Join(obs.Ops, ", ")))
	}
	return f
}
