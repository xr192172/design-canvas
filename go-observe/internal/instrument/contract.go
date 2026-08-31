// Package instrument — 契约驱动插桩 + 探索模式。
//
// 工程化目标（2026-08-16，狗食插桩纠偏·契约驱动）：
//   用户原话：「还是把注入器改成契约吧。我原先是想说全量插桩才能挖掘出隐藏的问题。」
//
// 设计要点：
//   - 契约模式（默认）：根据 DSL 契约声明精确插桩，只注入 DSLDecl.Probe 非空的探针点，
//     大幅减少噪音事件（实测 3603 探针 → 98% 噪音）。
//   - 探索模式（--explore）：保留全量无脑插桩能力，用于挖掘隐藏问题——发现真问题后
//     把对应探针点提升进 DSL，之后契约模式持续盯守。
//   - 探针点匹配：生成的探针名（pkg.FuncName.suffix）必须精确匹配 DSLDecl.Probe。
//     空 Probe（如 design:silent-error-discard 全局规则）不驱动插桩，只作用于判定阶段。
//   - 包级过滤优化：提取所有 DSLDecl.Probe 的包名前缀，跳过不匹配的整个文件。
package instrument

import "strings"

// ContractProbe 是 DSL 契约声明的一条探针点——契约模式下只注入这里声明的探针。
type ContractProbe struct {
	// Probe 是探针点 id，如 "v2.sessionsDir.mkdirall"。
	// 格式：pkg.FuncName.suffix，与 instrument 生成的探针名一致。
	Probe string
}

// packageFromProbe 从探针名提取包名前缀（第一个点号之前的部分）。
// 如 "v2.sessionsDir.mkdirall" → "v2"。
func packageFromProbe(probe string) string {
	if idx := strings.IndexByte(probe, '.'); idx > 0 {
		return probe[:idx]
	}
	return ""
}

// PackageFilter 从契约探针列表中提取唯一的包名集合（用于文件级过滤）。
// 无具体包声明的探针（空串）不入集合。
func PackageFilter(probes []ContractProbe) map[string]bool {
	out := map[string]bool{}
	for _, p := range probes {
		if pkg := packageFromProbe(p.Probe); pkg != "" {
			out[pkg] = true
		}
	}
	return out
}

// MatchProbe 检查生成的探针名是否精确匹配任一契约探针。
// probes 为 nil（探索模式）时恒真——全量无脑插桩。
func MatchProbe(probeName string, probes []ContractProbe) bool {
	if probes == nil {
		return true
	}
	for _, p := range probes {
		if p.Probe == probeName {
			return true
		}
	}
	return false
}

// ProbeName 构造探针名：pkg.FuncName.suffix。
func ProbeName(pkg, fn, suffix string) string {
	return pkg + "." + fn + "." + suffix
}
