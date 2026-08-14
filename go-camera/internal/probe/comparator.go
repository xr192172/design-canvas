package probe

// Package probe — Comparator: actual（观测画像）vs design（设计 DSL）偏差对比
// （P2）。
//
// 三类偏差：
//   - unobserved（未观测）：设计声明对应的探针从未被观测到（未覆盖/未触发）。
//   - violated（违反）：观测事件违反了设计声明（需确定性谓词判定）。
//   - undesigned（未声明）：观测到行为但没有任何设计声明覆盖（设计不完整）。
//
// 违反判定依赖按 rule id 注册的确定性谓词（如 SilentErrorDiscard）；未注册
// 谓词的声明只做"是否被观测"的覆盖检查，不臆造违反（交给 LLM/P3 层复核）。

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// DeviationKind 是偏差类别。
type DeviationKind string

const (
	DevUnobserved DeviationKind = "unobserved" // 设计声明从未被观测到
	DevViolated   DeviationKind = "violated"   // 观测事件违反了设计声明
	DevUndesigned DeviationKind = "undesigned" // 观测到事实没有对应设计声明
)

// Deviation 一条偏差。
type Deviation struct {
	Kind   DeviationKind `json:"kind"`
	Rule   string        `json:"rule,omitempty"`
	Probe  string        `json:"probe,omitempty"`
	Detail string        `json:"detail"`
}

// DiffReport 是 actual vs design 的对比结果。
type DiffReport struct {
	GeneratedAt time.Time   `json:"generated_at"`
	Design      string      `json:"design,omitempty"` // 设计 DSL 来源
	Actual      string      `json:"actual,omitempty"` // 观测画像来源
	EventCount  int         `json:"event_count"`
	Deviations  []Deviation `json:"deviations"`
	Unobserved  int         `json:"unobserved"`
	Violated    int         `json:"violated"`
	Undesigned  int         `json:"undesigned"`
}

// Comparator 对比设计 DSL（权威）与观测画像（事实），产出三类偏差。
type Comparator struct {
	preds map[string]func(Event) (string, string) // rule id → 确定性违反谓词
}

// NewComparator 创建对比器。
func NewComparator() *Comparator {
	return &Comparator{preds: map[string]func(Event) (string, string){}}
}

// RegisterPredicate 为某个 rule 注册确定性违反判定谓词。
func (c *Comparator) RegisterPredicate(rule string, pred func(Event) (string, string)) *Comparator {
	c.preds[rule] = pred
	return c
}

// RegisterDefaultPredicates 注册内置契约的谓词（当前：静默错误丢弃）。
func (c *Comparator) RegisterDefaultPredicates() *Comparator {
	return c.RegisterPredicate("design:silent-error-discard", SilentErrorDiscard)
}

// Compare 执行对比。design 为权威设计 DSL，actual 为观测画像。
func (c *Comparator) Compare(design DesignDSLDoc, actual ActualDSLDoc) DiffReport {
	r := DiffReport{
		GeneratedAt: time.Now().UTC(),
		EventCount:  actual.EventCount,
		Deviations:  []Deviation{},
	}

	// 观测到的探针 → 事件集合
	obsEvents := map[string][]Event{}
	for _, p := range actual.Probes {
		obsEvents[p.Probe] = p.Events
	}

	// 1. 设计声明的覆盖 + 违反检查
	for _, d := range design.Decls {
		var matched []Event
		if d.Probe == "" { // 全局声明：匹配所有探针
			for _, evs := range obsEvents {
				matched = append(matched, evs...)
			}
		} else {
			matched = append(matched, obsEvents[d.Probe]...)
		}

		if len(matched) == 0 {
			r.Unobserved++
			r.Deviations = append(r.Deviations, Deviation{
				Kind: DevUnobserved, Rule: d.Rule, Probe: d.Probe,
				Detail: "设计声明从未被观测到（该探针未触发/未覆盖）",
			})
			continue
		}

		pred, hasPred := c.preds[d.Rule]
		if !hasPred {
			continue // 无确定性谓词 → 不臆造违反（交 LLM/P3 复核）
		}
		for _, ev := range matched {
			result, reason := pred(ev)
			if result == "deviation" {
				r.Violated++
				r.Deviations = append(r.Deviations, Deviation{
					Kind: DevViolated, Rule: d.Rule, Probe: ev.Probe, Detail: reason,
				})
			}
		}
	}

	// 2. 未声明：观测探针无任何设计声明覆盖
	for _, p := range actual.Probes {
		covered := false
		for _, d := range design.Decls {
			if d.Probe == "" || d.Probe == p.Probe {
				covered = true
				break
			}
		}
		if !covered {
			r.Undesigned++
			r.Deviations = append(r.Deviations, Deviation{
				Kind: DevUndesigned, Probe: p.Probe,
				Detail: "观测到行为但没有对应设计声明（设计不完整/新探针）",
			})
		}
	}

	// 稳定排序：未观测 → 违反 → 未声明
	sort.SliceStable(r.Deviations, func(i, j int) bool {
		return deviationRank(r.Deviations[i].Kind) < deviationRank(r.Deviations[j].Kind)
	})
	return r
}

// deviationRank 偏差类别排序权重。
func deviationRank(k DeviationKind) int {
	switch k {
	case DevUnobserved:
		return 0
	case DevViolated:
		return 1
	default:
		return 2
	}
}

// RenderDiffReport 生成可读的偏差报告。
func RenderDiffReport(r DiffReport) string {
	var b strings.Builder
	b.WriteString(fmt.Sprintf("Camera 偏差报告（actual vs design）：%d 事件\n", r.EventCount))
	b.WriteString(fmt.Sprintf("  未观测 %d · 违反 %d · 未声明 %d\n", r.Unobserved, r.Violated, r.Undesigned))
	if len(r.Deviations) == 0 {
		b.WriteString("  ✓ 设计声明与观测画像一致\n")
		return b.String()
	}
	b.WriteString("\n▎偏差明细\n")
	for _, d := range r.Deviations {
		switch d.Kind {
		case DevUnobserved:
			fmt.Fprintf(&b, "  [未观测] rule=%s probe=%s\n      %s\n", d.Rule, d.Probe, d.Detail)
		case DevViolated:
			fmt.Fprintf(&b, "  [违反]   rule=%s probe=%s\n      %s\n", d.Rule, d.Probe, d.Detail)
		default:
			fmt.Fprintf(&b, "  [未声明] probe=%s\n      %s\n", d.Probe, d.Detail)
		}
	}
	return b.String()
}