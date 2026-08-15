package probe

// Package probe — Loop（P4 循环+触发）：观测→聚合→偏差→自动提案的闭环编排。
//
// 闭环语义：探针落盘观测（events.jsonl）→ 聚合为事实画像（actual）→ 与权威
// 设计 DSL 对比出三类偏差 → 对「未声明」探针自动生成修订提案（把观测到的新
// 行为补成契约声明）。提案仍走写盘权分离（进 proposals/ 待审批），不直接改
// 权威 dsl.json——闭环只负责「发现并提议」，定稿权永远在验证门审批那边。
//
// 触发方式：camera-dsl loop <events.jsonl>。每次运行即一次闭环迭代，可被
// 外部定时/事件触发（watch/cron），实现持续校准。

import (
	"context"
	"fmt"
	"strings"
)

// LoopOptions 是闭环迭代的触发参数（低频演进护栏）：
// 偏差不显著（低于阈值）时本轮不演进，避免每次观测都走提案/LLM。
type LoopOptions struct {
	// MinDeviationRate 违反事件偏差率阈值：violated 事件数/总事件数 达到该比例
	// 才视为显著偏差（默认 0.1 = 10%）。
	MinDeviationRate float64
	// MinUndesigned 未声明探针数量阈值：观测到的新探针达到该数才生成补契约提案
	// （默认 1）。
	MinUndesigned int
	// UseLLM 对规则秒判为可疑/违反的事件做 LLM 行为级复核（走统一判定服务，
	// POST use_llm=1）。LLM 不可用/失败时降级为规则判定，不阻断闭环。
	UseLLM bool
}

// withDefaults 填充未设置项的默认值。
func (o LoopOptions) withDefaults() LoopOptions {
	if o.MinDeviationRate <= 0 {
		o.MinDeviationRate = 0.1
	}
	if o.MinUndesigned <= 0 {
		o.MinUndesigned = 1
	}
	return o
}

// LoopResult 是一次闭环迭代的产物。
type LoopResult struct {
	Report     DiffReport `json:"report"`
	Proposals  []Proposal `json:"proposals"`               // 本次为未声明探针生成的修订提案
	Triggered  bool       `json:"triggered"`               // 是否触发了演进（低于阈值则 false）
	SkipReason string     `json:"skip_reason,omitempty"`   // 未触发时的原因（低频护栏）

	// LLM 行为级复核（--use-llm）：
	LLMRun      bool         `json:"llm_run,omitempty"`       // 是否请求了 LLM 复核
	LLMDegraded bool         `json:"llm_degraded,omitempty"`  // LLM 不可用/失败，降级为规则判定
	LLMVerdicts []LLMVerdict `json:"llm_verdicts,omitempty"`  // 对可疑/违反事件的 LLM 复核结果
}

// RunLoop 执行一次闭环迭代：读观测 → 聚合 → 对比 → 按触发条件对未声明探针
// 自动提案。dataDir 为 camera 数据目录（含设计 DSL 与 proposals/）。写盘权
// 分离：只写 proposals/，绝不触碰 dsl.json。
//
// 触发条件（低频演进护栏）：偏差率（violated 事件占比）≥ MinDeviationRate
// 或未声明探针数 ≥ MinUndesigned，才生成修订提案；否则跳过演进并在报告标注。
func RunLoop(eventsPath, dataDir string, opts ...LoopOptions) (LoopResult, error) {
	var res LoopResult

	// 1. 读取观测事件
	events, _, err := (&ActualDSLLoader{}).LoadFile(eventsPath)
	if err != nil {
		return res, fmt.Errorf("loop: 读取观测 %s: %v", eventsPath, err)
	}

	// 2. 聚合为事实画像
	actual := NewAggregator().Aggregate(events)
	actual.Source = eventsPath

	// 3. 加载权威设计 DSL（不存在则播种 v1）
	store := NewDesignDSLStore(dataDir)
	if _, err := store.SeedDefault(); err != nil {
		return res, fmt.Errorf("loop: 播种设计 DSL: %v", err)
	}
	design, err := store.Load()
	if err != nil {
		return res, fmt.Errorf("loop: 读设计 DSL: %v", err)
	}

	// 4. 对比出三类偏差
	res.Report = NewComparator().RegisterDefaultPredicates().Compare(design, actual)

	// 4.5 可选 LLM 行为级复核（--use-llm）：对规则秒判为可疑/违反的事件，交付
	// 统一判定服务做 LLM 复核（POST use_llm=1，由服务侧调 LLM 记账）。LLM 只喂
	// 「事件快照 + DSL 声明」，不接触项目文档。失败降级：保留规则判定，不阻断。
	opt := LoopOptions{}
	if len(opts) > 0 {
		opt = opts[0]
	}
	opt = opt.withDefaults()
	if opt.UseLLM {
		res.LLMRun = true
		judge := NewJudgeClient("")
		if !judge.IsRemote() {
			// 未配置判定服务 → LLM 复核不可用，诚实标注降级
			res.LLMDegraded = true
		} else {
			verdicts, err := judge.JudgeEventsLLM(context.Background(), events)
			if err != nil {
				res.LLMDegraded = true
			} else {
				for _, v := range verdicts {
					if v.LLM != nil {
						res.LLMVerdicts = append(res.LLMVerdicts, *v.LLM)
					}
				}
			}
		}
	}

	// 5. 触发条件判定（低频演进护栏）
	rate := 0.0
	if res.Report.EventCount > 0 {
		rate = float64(res.Report.Violated) / float64(res.Report.EventCount)
	}
	if res.Report.Undesigned < opt.MinUndesigned && rate < opt.MinDeviationRate {
		res.Triggered = false
		res.SkipReason = fmt.Sprintf(
			"偏差低于触发阈值（violated 事件占比 %.1f%% < %.0f%% · 未声明探针 %d < %d），本轮不演进",
			rate*100, opt.MinDeviationRate*100, res.Report.Undesigned, opt.MinUndesigned)
		return res, nil
	}
	res.Triggered = true

	// 6. 对未声明探针生成修订提案
	ps := NewProposalStore(dataDir)
	obs := probeObsByProbe(actual)
	for _, dev := range res.Report.Deviations {
		if dev.Kind != DevUndesigned {
			continue // 只对未声明探针补契约；违反/未观测交人工复核
		}
		decl := DSLDecl{
			Rule:   "design:observe-" + sanitizeRuleSuffix(dev.Probe),
			Probe:  dev.Probe,
			Expect: expectFromObs(obs[dev.Probe]),
			Origin: "runtime-observe",
			Status: "proposed",
		}
		p, err := ps.Create([]DSLDecl{decl}, fmt.Sprintf("loop: 补全未声明探针 %s", dev.Probe), "loop")
		if err != nil {
			return res, fmt.Errorf("loop: 为 %s 生成提案: %v", dev.Probe, err)
		}
		res.Proposals = append(res.Proposals, p)
	}
	return res, nil
}

// probeObsByProbe 把画像按探针名建索引，便于生成契约描述。
func probeObsByProbe(doc ActualDSLDoc) map[string]ProbeObs {
	m := make(map[string]ProbeObs, len(doc.Probes))
	for _, p := range doc.Probes {
		m[p.Probe] = p
	}
	return m
}

// expectFromObs 从观测画像生成契约的期望描述（人类可读，喂给后续审批/判定）。
func expectFromObs(obs ProbeObs) string {
	if obs.Count == 0 {
		return "该探针被观测到，需申明其行为契约"
	}
	facts := strings.Join(obs.Facts, "；")
	return fmt.Sprintf("被观测到 %d 次（%s），需以契约锁定其行为", obs.Count, facts)
}

// sanitizeRuleSuffix 把探针名转成可作 rule 后缀的合法串（点/斜杠 → 连字符）。
func sanitizeRuleSuffix(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '.' || r == '/' || r == '\\' || r == ' ':
			b.WriteByte('-')
		case r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	return b.String()
}