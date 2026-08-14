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
	"fmt"
	"strings"
)

// LoopResult 是一次闭环迭代的产物。
type LoopResult struct {
	Report    DiffReport `json:"report"`
	Proposals []Proposal `json:"proposals"` // 本次为未声明探针生成的修订提案
}

// RunLoop 执行一次闭环迭代：读观测 → 聚合 → 对比 → 对未声明探针自动提案。
// dataDir 为 camera 数据目录（含设计 DSL 与 proposals/）。写盘权分离：只写
// proposals/，绝不触碰 dsl.json。
func RunLoop(eventsPath, dataDir string) (LoopResult, error) {
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
	// 5. 对未声明探针生成修订提案
	res.Report = NewComparator().RegisterDefaultPredicates().Compare(design, actual)
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