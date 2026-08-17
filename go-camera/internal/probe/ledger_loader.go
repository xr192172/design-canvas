package probe

// Package probe — Ledger 装载与分析（方向 D：偏差回流 DSL evolution loop）。
//
// 数据源：TS 侧 impact_ledger_store.ts 落盘的
// {projectRoot}/.design-canvas/impact/ledger.json（declare 预告-消费定损台账）。
// 本模块只读不写：把台账折叠成「影响偏差率 + 累犯波及模式」，供 RunLoop
// 触发演进并生成 design:impact-known-spread 提案（把实际耦合回流进设计 DSL）。
//
// 语义对齐（与 TS 侧状态机一致）：
//   - consumed  = consumed_at 非空的条目（status ∈ ok|violated|resolved）
//   - violated  = 消费时定损为 violated 的条目（status ∈ violated|resolved，
//     resolved 是已过门处理的 violated，历史事实仍算违反）
//   - rate      = violated / consumed（0 个消费时无意义，不参与触发）
//
// 累犯归因（保守超集）：一条 violated 条目的 declared_files 可能多个，
// 无法精确归因到单个源文件——每个 declared file 都计入完整 unexpected_files。

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
)

// LedgerEntry 是 TS 侧 LedgerEntry 的只读镜像（字段名与 JSON 完全一致）。
type LedgerEntry struct {
	ID              string   `json:"id"`
	CreatedAt       string   `json:"created_at"`
	DeclaredFiles   []string `json:"declared_files"`
	ExpectedFiles   []string `json:"expected_files"`
	Status          string   `json:"status"` // pending|ok|violated|resolved|expired
	ConsumedAt      string   `json:"consumed_at,omitempty"`
	MatchedSeq      int      `json:"matched_seq,omitempty"`
	UnexpectedFiles []string `json:"unexpected_files,omitempty"`
	ActualFiles     []string `json:"actual_files,omitempty"`
}

// SpreadPattern 是一个源文件的累犯波及模式：改动它 historically 多次波及
// 预告面之外的这些文件——这是「设计未承认的真实耦合」。
type SpreadPattern struct {
	Source     string   `json:"source"`               // 声明改动的源文件
	Files      []string `json:"files"`                // 累计计划外波及文件（并集，有序）
	Violations int      `json:"violations"`           // 累犯次数（含该源的 violated 条目数）
}

// LedgerStats 是台账的折叠统计（方向 D 的触发与提案依据）。
type LedgerStats struct {
	Path         string          `json:"path"`          // 台账来源（审计）
	Total        int             `json:"total"`         // 全部条目（含 pending/expired）
	Consumed     int             `json:"consumed"`      // 已消费（ok+violated+resolved）
	Violated     int             `json:"violated"`      // 消费时违反（violated+resolved）
	DeviationRate float64        `json:"deviation_rate"` // violated/consumed（consumed=0 时 0）
	RepeatSpreads []SpreadPattern `json:"repeat_spreads"` // 累犯波及模式（violations ≥ minRepeat）
}

// LoadImpactLedger 读取 ledger.json。文件缺失/损坏 → 空列表 + nil 错误
// （台账是可选输入，缺失只意味着「无影响偏差数据」，不阻断闭环）。
func LoadImpactLedger(path string) ([]LedgerEntry, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("读台账 %s: %w", path, err)
	}
	var f struct {
		Version int           `json:"version"`
		Entries []LedgerEntry `json:"entries"`
	}
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("解析台账 %s: %w", path, err)
	}
	return f.Entries, nil
}

// AnalyzeLedger 把台账折叠为统计。minRepeat 是累犯门槛（同一源文件出现 ≥
// minRepeat 次 violated 才成模式；默认 2——单次可能是失误，两次以上是结构）。
func AnalyzeLedger(path string, entries []LedgerEntry, minRepeat int) LedgerStats {
	if minRepeat < 1 {
		minRepeat = 2
	}
	st := LedgerStats{Path: path, Total: len(entries)}

	// 源文件 → 计划外文件并集 + 累犯次数
	type acc struct {
		files map[string]bool
		n     int
	}
	accBySrc := map[string]*acc{}

	for _, e := range entries {
		consumed := e.ConsumedAt != ""
		violated := e.Status == "violated" || e.Status == "resolved"
		if consumed {
			st.Consumed++
		}
		if !violated {
			continue
		}
		st.Violated++
		if len(e.UnexpectedFiles) == 0 || len(e.DeclaredFiles) == 0 {
			continue
		}
		for _, src := range e.DeclaredFiles {
			a := accBySrc[src]
			if a == nil {
				a = &acc{files: map[string]bool{}}
				accBySrc[src] = a
			}
			a.n++
			for _, f := range e.UnexpectedFiles {
				a.files[f] = true
			}
		}
	}
	if st.Consumed > 0 {
		st.DeviationRate = float64(st.Violated) / float64(st.Consumed)
	}

	for src, a := range accBySrc {
		if a.n < minRepeat {
			continue // 单次违反不成模式（可能是失误而非结构耦合）
		}
		files := make([]string, 0, len(a.files))
		for f := range a.files {
			files = append(files, f)
		}
		sort.Strings(files)
		st.RepeatSpreads = append(st.RepeatSpreads, SpreadPattern{Source: src, Files: files, Violations: a.n})
	}
	// 确定性排序：累犯次数降序 → 源文件字典序
	sort.Slice(st.RepeatSpreads, func(i, j int) bool {
		if st.RepeatSpreads[i].Violations != st.RepeatSpreads[j].Violations {
			return st.RepeatSpreads[i].Violations > st.RepeatSpreads[j].Violations
		}
		return st.RepeatSpreads[i].Source < st.RepeatSpreads[j].Source
	})
	return st
}

// knownSpreadConstraint 是 design:impact-known-spread 声明的机器可读约束
// （DSLDecl.Constraint 字段的 JSON 形态）。消费方（判定/审批）据此精确匹配。
type knownSpreadConstraint struct {
	Source     string   `json:"source"`
	Spread     []string `json:"spread"`
	Violations int      `json:"violations"`
}

// parseKnownSpread 解析声明/提案的 constraint；失败返回零值（视为无约束）。
func parseKnownSpread(d DSLDecl) (knownSpreadConstraint, bool) {
	if d.Rule != KnownSpreadRule || d.Constraint == "" {
		return knownSpreadConstraint{}, false
	}
	var c knownSpreadConstraint
	if err := json.Unmarshal([]byte(d.Constraint), &c); err != nil {
		return knownSpreadConstraint{}, false
	}
	return c, c.Source != ""
}

// KnownSpreadRule 是「已知波及耦合」声明的 rule id：改动 Source 会波及
// Spread 清单中的文件——设计已承认的耦合，impact.spread 判定时不再算计划外。
const KnownSpreadRule = "design:impact-known-spread"

// knownSpreadDecl 把累犯模式转成 DSL 声明（提案的最小单元）。
func knownSpreadDecl(p SpreadPattern) (DSLDecl, error) {
	c := knownSpreadConstraint{Source: p.Source, Spread: p.Files, Violations: p.Violations}
	cj, err := json.Marshal(c)
	if err != nil {
		return DSLDecl{}, err
	}
	files := joinQuoted(p.Files, 8)
	return DSLDecl{
		Rule:       KnownSpreadRule,
		Probe:      "impact.spread",
		Expect:     fmt.Sprintf("改动 %s 的已知波及面（历史 %d 次计划外扩散）：%s——这些文件属设计已承认的耦合", p.Source, p.Violations, files),
		Constraint: string(cj),
		Origin:     "runtime-observe",
		Status:     "proposed",
	}, nil
}

// joinQuoted 把文件清单拼成 "a"、"b" 形式，超过 max 截断（人类可读用）。
func joinQuoted(files []string, max int) string {
	n := len(files)
	if n > max {
		quoted := make([]string, 0, max)
		for _, f := range files[:max] {
			quoted = append(quoted, fmt.Sprintf("%q", f))
		}
		return fmt.Sprintf("%s …等 %d 个", joinComma(quoted), n)
	}
	quoted := make([]string, 0, n)
	for _, f := range files {
		quoted = append(quoted, fmt.Sprintf("%q", f))
	}
	return joinComma(quoted)
}

func joinComma(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += "、"
		}
		out += p
	}
	return out
}

// sameSpreadSet 判断已批准声明与新模式是否覆盖同一波及面
// （proposal 去重：集合相同 → 无需再提；集合增长 → 提更新）。
func sameSpreadSet(a knownSpreadConstraint, p SpreadPattern) bool {
	if len(a.Spread) != len(p.Files) {
		return false
	}
	set := make(map[string]bool, len(a.Spread))
	for _, f := range a.Spread {
		set[f] = true
	}
	for _, f := range p.Files {
		if !set[f] {
			return false
		}
	}
	return true
}
