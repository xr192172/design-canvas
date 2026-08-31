package probe

// Package probe — observe-dsl CLI：设计 DSL 仓库的管理入口（P1）。
//
// 子命令：
//
//	observe-dsl show              显示当前生效的设计 DSL（权威）
//	observe-dsl history           显示审计历史（版本/时间/来源/原因）
//	observe-dsl rollback <ver>    回滚到指定历史版本（作为新版本写入）
//	observe-dsl seed              播种 v1 种子（已存在则幂等跳过）
//
// dataDir 指向设计 DSL 仓库目录（{projectRoot}/.agent/observe）。LLM 无直接
// 写盘通道，本 CLI 是当前唯一的定稿/回滚入口（P3 验证门接入后由它代写）。

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"go-observe/internal/instrument"
)

// RunDSLCLI 处理 observe-dsl 子命令。args 为 observe-dsl 之后的参数（可能含
// 全局选项如 --project-root，先剥离）。返回 true 表示已消费该命令，调用方应
// 退出进程。
func RunDSLCLI(args []string, dataDir string) bool {
	// 剥离全局选项（--project-root 及其值、--project-root=…、其他 - 开头项），
	// 定位真正的子命令。
	for i := 0; i < len(args); i++ {
		if args[i] == "--project-root" && i+1 < len(args) {
			i++
			continue
		}
		if strings.HasPrefix(args[i], "--project-root=") || strings.HasPrefix(args[i], "-") {
			continue
		}
		args = args[i:]
		break
	}

	if len(args) == 0 {
		usageDSL()
		return true
	}
	store := NewDesignDSLStore(dataDir)
	switch args[0] {
	case "show":
		return dslShow(store)
	case "history":
		return dslHistory(store)
	case "rollback":
		return dslRollback(store, args[1:])
	case "seed":
		return dslSeed(store)
	case "actual":
		return dslActual(args[1:], dataDir)
	case "diff":
		return dslDiff(args[1:], dataDir)
	case "propose":
		return dslPropose(args[1:], dataDir)
	case "proposals":
		return dslProposals(dataDir)
	case "approve":
		return dslApprove(args[1:], dataDir)
	case "reject":
		return dslReject(args[1:], dataDir)
	case "loop":
		return dslLoop(args[1:], dataDir)
	case "log":
		return dslLog(args[1:])
	case "instrument":
		return dslInstrument(args[1:], dataDir)
	case "help", "-h", "--help":
		usageDSL()
		return true
	default:
		fmt.Fprintf(os.Stderr, "observe-dsl: unknown subcommand %q\n\n", args[0])
		usageDSL()
		return true
	}
}

func usageDSL() {
	fmt.Fprint(os.Stderr, `observe-dsl — Observe 设计 DSL 仓库（DSL 唯一真相源）

用法:
  observe-dsl show               显示当前生效的设计 DSL
  observe-dsl history            显示审计历史
  observe-dsl rollback <version> 回滚到指定历史版本（作为新版本写入）
  observe-dsl seed               播种 v1 种子（幂等）
  observe-dsl actual <events.jsonl> [--out <path>]  聚合观测画像 → actual.dsl.json
  observe-dsl diff [--actual <path>]                对比 actual vs design，出三类偏差报告
  observe-dsl propose <decls.json> [--reason <原因>] [--source <来源>]  提交修订提案（不落权威盘）
  observe-dsl proposals                               列出全部修订提案
  observe-dsl approve <id> [--reviewer <名字>]        验证门审批 → 定稿为设计 DSL 新版本
  observe-dsl reject <id> [--reviewer <名字>]         拒绝修订提案
  observe-dsl loop <events.jsonl>                    闭环：观测→偏差→未声明探针自动提案
                                                    [--ledger <ledger.json>] 接入影响台账：偏差回流设计（方向 D）
  observe-dsl log <events.jsonl> [--file <path>]... [--all]  日志：按文件路径过滤（可多次），默认只列异常，--all 显示全部
  observe-dsl instrument <dir> [--dry-run] [--enable-deep] [--explore] [--restore]  Go 源码自动插桩（契约模式默认，--explore 全量）

仓库位置: {projectRoot}/.agent/observe/
  dsl.json           当前生效版本（权威判定依据）
  dsl.history.jsonl  快照式审计历史
  actual.dsl.json    观测事实画像（可再生·非权威，由 observe-dsl actual 生成）
  proposals/         修订提案目录（写盘权分离，审批后才并入 dsl.json）
`)
}

func dslShow(store *DesignDSLStore) bool {
	doc, err := store.Load()
	if err != nil {
		if os.IsNotExist(err) {
			fmt.Fprintln(os.Stderr, "observe-dsl: 设计 DSL 尚未初始化，运行 `observe-dsl seed` 播种")
			return true
		}
		fmt.Fprintf(os.Stderr, "observe-dsl: %v\n", err)
		return true
	}
	fmt.Printf("设计 DSL v%d（%s）\n", doc.Version, doc.UpdatedAt.Format(time.RFC3339))
	fmt.Printf("声明 %d 条：\n\n", len(doc.Decls))
	for i, d := range doc.Decls {
		fmt.Printf("%d) Rule=%s Probe=%q\n   期望: %s\n", i+1, d.Rule, d.Probe, d.Expect)
		if d.Constraint != "" {
			fmt.Printf("   约束: %s\n", d.Constraint)
		}
		fmt.Println()
	}
	return true
}

func dslHistory(store *DesignDSLStore) bool {
	hist, err := store.History()
	if err != nil {
		fmt.Fprintf(os.Stderr, "observe-dsl: %v\n", err)
		return true
	}
	if len(hist) == 0 {
		fmt.Println("无审计历史（尚未播种）")
		return true
	}
	fmt.Println("设计 DSL 审计历史：")
	for _, h := range hist {
		fmt.Printf("  v%-3d %s  [%s]  %s  (%d 条声明)\n",
			h.Version, h.At.Format("2006-01-02 15:04:05"), h.Source, h.Reason, len(h.Decls))
	}
	return true
}

func dslRollback(store *DesignDSLStore, args []string) bool {
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "用法: observe-dsl rollback <version>")
		return true
	}
	ver, err := strconv.Atoi(args[0])
	if err != nil || ver < 1 {
		fmt.Fprintf(os.Stderr, "observe-dsl: 非法版本号 %q\n", args[0])
		return true
	}
	newVer, err := store.Rollback(ver)
	if err != nil {
		fmt.Fprintf(os.Stderr, "observe-dsl: %v\n", err)
		return true
	}
	fmt.Printf("已回滚到 v%d（作为 v%d 写入，审计链保留）\n", ver, newVer)
	return true
}

func dslSeed(store *DesignDSLStore) bool {
	seeded, err := store.SeedDefault()
	if err != nil {
		fmt.Fprintf(os.Stderr, "observe-dsl: %v\n", err)
		return true
	}
	if seeded {
		fmt.Println("已播种 v1 种子：silent-error-discard 契约")
	} else {
		fmt.Println("设计 DSL 已存在，跳过播种（幂等）")
	}
	return true
}

// dslActual 读取 events.jsonl，聚合生成观测画像 actual.dsl.json（可再生·非权威）。
func dslActual(args []string, dataDir string) bool {
	var eventsPath string
	outPath := filepath.Join(dataDir, "actual.dsl.json")
	for i := 0; i < len(args); i++ {
		if args[i] == "--out" && i+1 < len(args) {
			outPath = args[i+1]
			i++
			continue
		}
		if strings.HasPrefix(args[i], "-") {
			continue
		}
		if eventsPath == "" {
			eventsPath = args[i]
		}
	}
	if eventsPath == "" {
		fmt.Fprintln(os.Stderr, "用法: observe-dsl actual <events.jsonl> [--out <path>]")
		return true
	}

	events, skipped, err := (&ActualDSLLoader{}).LoadFile(eventsPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "observe-dsl actual: %v\n", err)
		return true
	}
	doc := NewAggregator().Aggregate(events)
	doc.Source = eventsPath
	doc.BadLines = skipped
	if err := writeJSON(outPath, doc); err != nil {
		fmt.Fprintf(os.Stderr, "observe-dsl actual: 写 %s: %v\n", outPath, err)
		return true
	}
	fmt.Printf("已生成观测画像 %s（%d 事件 · %d 探针 · %d 坏行跳过）\n",
		outPath, doc.EventCount, len(doc.Probes), skipped)
	return true
}

// dslDiff 对比设计 DSL（权威）与观测画像（事实），输出三类偏差报告。
func dslDiff(args []string, dataDir string) bool {
	store := NewDesignDSLStore(dataDir)
	actualPath := filepath.Join(dataDir, "actual.dsl.json")
	for i := 0; i < len(args); i++ {
		if args[i] == "--actual" && i+1 < len(args) {
			actualPath = args[i+1]
			i++
		}
	}

	design, err := store.Load()
	if err != nil {
		if os.IsNotExist(err) {
			fmt.Fprintln(os.Stderr, "observe-dsl diff: 设计 DSL 未初始化，先运行 `observe-dsl seed`")
			return true
		}
		fmt.Fprintf(os.Stderr, "observe-dsl diff: 读设计 DSL: %v\n", err)
		return true
	}
	var actual ActualDSLDoc
	raw, err := os.ReadFile(actualPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "observe-dsl diff: 读 %s: %v（先运行 `observe-dsl actual <events.jsonl>`）\n", actualPath, err)
		return true
	}
	if err := json.Unmarshal(raw, &actual); err != nil {
		fmt.Fprintf(os.Stderr, "observe-dsl diff: 解析 %s: %v\n", actualPath, err)
		return true
	}

	report := NewComparator().RegisterDefaultPredicates().Compare(design, actual)
	report.Design = "dsl.json"
	report.Actual = actualPath
	fmt.Print(RenderDiffReport(report))
	return true
}

// dslPropose 从 decls JSON 文件创建一份修订提案（写盘权分离，不触碰 dsl.json）。
func dslPropose(args []string, dataDir string) bool {
	var declsPath, reason, source = "", "", "manual"
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "--reason" && i+1 < len(args):
			reason = args[i+1]
			i++
		case args[i] == "--source" && i+1 < len(args):
			source = args[i+1]
			i++
		case strings.HasPrefix(args[i], "-"):
			continue
		default:
			if declsPath == "" {
				declsPath = args[i]
			}
		}
	}
	if declsPath == "" {
		fmt.Fprintln(os.Stderr, "用法: observe-dsl propose <decls.json> [--reason <原因>] [--source <来源>]")
		return true
	}
	decls, err := loadDeclsFile(declsPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "observe-dsl propose: %v\n", err)
		return true
	}
	p, err := NewProposalStore(dataDir).Create(decls, reason, source)
	if err != nil {
		fmt.Fprintf(os.Stderr, "observe-dsl propose: %v\n", err)
		return true
	}
	fmt.Printf("已创建修订提案 %s（%d 条声明，状态 pending）\n  运行 `observe-dsl approve %s` 定稿为设计 DSL 新版本\n",
		p.ID, len(p.Decls), p.ID)
	return true
}

// loadDeclsFile 解析声明文件：接受 DSLDecl 数组，或 {"decls":[...]} 包装对象。
func loadDeclsFile(path string) ([]DSLDecl, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var arr []DSLDecl
	if err := json.Unmarshal(data, &arr); err == nil {
		return arr, nil
	}
	var wrap struct {
		Decls []DSLDecl `json:"decls"`
	}
	if err := json.Unmarshal(data, &wrap); err != nil {
		return nil, fmt.Errorf("解析 %s 失败（需 DSLDecl 数组或 {\"decls\":[...]}）: %w", path, err)
	}
	return wrap.Decls, nil
}

// dslProposals 列出全部修订提案。
func dslProposals(dataDir string) bool {
	list, err := NewProposalStore(dataDir).List()
	if err != nil {
		fmt.Fprintf(os.Stderr, "observe-dsl proposals: %v\n", err)
		return true
	}
	if len(list) == 0 {
		fmt.Println("无修订提案")
		return true
	}
	fmt.Println("修订提案：")
	for _, p := range list {
		reason := p.Reason
		if len(reason) > 40 {
			reason = reason[:40] + "…"
		}
		verified := ""
		if p.VerifiedBy != "" {
			verified = "  已验证: " + p.VerifiedBy
		}
		fmt.Printf("  %-24s %-9s %d 条声明  src=%s  %s%s\n", p.ID, p.Status, len(p.Decls), p.Source, reason, verified)
	}
	return true
}

// dslApprove 验证门审批：通过后借 DesignDSLStore 定稿为新版本。
func dslApprove(args []string, dataDir string) bool {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "用法: observe-dsl approve <id> [--reviewer <名字>]")
		return true
	}
	id := args[0]
	reviewer := "cli"
	for i := 1; i < len(args); i++ {
		if args[i] == "--reviewer" && i+1 < len(args) {
			reviewer = args[i+1]
			i++
		}
	}
	ver, err := NewProposalStore(dataDir).Approve(id, reviewer, NewDesignDSLStore(dataDir))
	if err != nil {
		fmt.Fprintf(os.Stderr, "observe-dsl approve: %v\n", err)
		return true
	}
	fmt.Printf("已审批通过提案 %s → 设计 DSL v%d（审计链保留）\n", id, ver)
	if p, perr := NewProposalStore(dataDir).Get(id); perr == nil && p.VerifiedBy != "" {
		fmt.Printf("  验证门证据: %s\n", p.VerifiedBy)
		if p.Verification != "" {
			fmt.Printf("  验证详情: %s\n", p.Verification)
		}
	}
	return true
}

// dslReject 拒绝修订提案。
func dslReject(args []string, dataDir string) bool {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "用法: observe-dsl reject <id> [--reviewer <名字>]")
		return true
	}
	id := args[0]
	reviewer := "cli"
	for i := 1; i < len(args); i++ {
		if args[i] == "--reviewer" && i+1 < len(args) {
			reviewer = args[i+1]
			i++
		}
	}
	if err := NewProposalStore(dataDir).Reject(id, reviewer); err != nil {
		fmt.Fprintf(os.Stderr, "observe-dsl reject: %v\n", err)
		return true
	}
	fmt.Printf("已拒绝修订提案 %s\n", id)
	return true
}

// dslLoop 执行一次闭环迭代：观测→偏差→（触发条件满足时）对未声明探针自动提案。
// 支持 --min-deviation-rate <比例> / --min-undesigned <数量> 调节触发阈值，
// --use-llm 对可疑/违反事件做 LLM 行为级复核。
// --ledger <path> 接入影响台账（方向 D：偏差回流设计）——缺省自动探测
// {projectRoot}/.design-canvas/impact/ledger.json（dataDir 上溯两级）。
func dslLoop(args []string, dataDir string) bool {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "用法: observe-dsl loop <events.jsonl> [--min-deviation-rate 0.1] [--min-undesigned 1] [--use-llm] [--ledger <ledger.json>]")
		return true
	}
	var eventsPath string
	opt := LoopOptions{}
	ledgerSet := false
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "--use-llm":
			opt.UseLLM = true
		case args[i] == "--ledger" && i+1 < len(args):
			opt.LedgerPath = args[i+1]
			ledgerSet = true
			i++
		case strings.HasPrefix(args[i], "--ledger="):
			opt.LedgerPath = strings.TrimPrefix(args[i], "--ledger=")
			ledgerSet = true
		case args[i] == "--min-deviation-rate" && i+1 < len(args):
			v, err := strconv.ParseFloat(args[i+1], 64)
			if err != nil {
				fmt.Fprintf(os.Stderr, "observe-dsl loop: 非法偏差率阈值 %q\n", args[i+1])
				return true
			}
			opt.MinDeviationRate = v
			i++
		case args[i] == "--min-undesigned" && i+1 < len(args):
			v, err := strconv.Atoi(args[i+1])
			if err != nil {
				fmt.Fprintf(os.Stderr, "observe-dsl loop: 非法未声明阈值 %q\n", args[i+1])
				return true
			}
			opt.MinUndesigned = v
			i++
		case strings.HasPrefix(args[i], "-"):
			continue
		default:
			if eventsPath == "" {
				eventsPath = args[i]
			}
		}
	}
	// 未显式指定 --ledger：自动探测默认位置。dataDir = {projectRoot}/.agent/observe
	// → projectRoot = dataDir 上溯两级；台账在 {projectRoot}/.design-canvas/impact/。
	if !ledgerSet {
		candidate := filepath.Join(dataDir, "..", "..", ".design-canvas", "impact", "ledger.json")
		if abs, err := filepath.Abs(candidate); err == nil {
			candidate = abs
		}
		if _, err := os.Stat(candidate); err == nil {
			opt.LedgerPath = candidate
		}
	}
	res, err := RunLoop(eventsPath, dataDir, opt)
	if err != nil {
		fmt.Fprintf(os.Stderr, "observe-dsl loop: %v\n", err)
		return true
	}
	fmt.Print(RenderDiffReport(res.Report))
	if res.Ledger != nil {
		fmt.Printf("影响台账：%d 条目 · 已消费 %d · 违反 %d（偏差率 %.1f%%）· 累犯模式 %d\n",
			res.Ledger.Total, res.Ledger.Consumed, res.Ledger.Violated,
			res.Ledger.DeviationRate*100, len(res.Ledger.RepeatSpreads))
		for _, p := range res.Ledger.RepeatSpreads {
			fmt.Printf("  ▸ %s：%d 次计划外波及 %v\n", p.Source, p.Violations, p.Files)
		}
	}
	if res.LLMRun {
		if res.LLMDegraded {
			fmt.Println("LLM 复核：判定服务不可用/调用失败，已降级为规则判定（不阻断）")
		} else if len(res.LLMVerdicts) > 0 {
			fmt.Printf("LLM 复核：%d 个可疑事件经行为级复核\n", len(res.LLMVerdicts))
			for _, lv := range res.LLMVerdicts {
				fmt.Printf("  • [%s] %s\n", lv.Result, lv.Reason)
			}
		} else {
			fmt.Println("LLM 复核：无可疑事件，全部规则秒判通过")
		}
	}
	if !res.Triggered {
		fmt.Printf("闭环：未触发演进（%s）\n", res.SkipReason)
		return true
	}
	if len(res.Proposals) == 0 {
		fmt.Println("闭环：偏差已触发但无可补契约项（未声明探针/累犯模式均无），无需提案")
		return true
	}
	fmt.Printf("闭环：生成 %d 份修订提案（写盘权分离，待验证门审批）\n", len(res.Proposals))
	for _, p := range res.Proposals {
		fmt.Printf("  %s rule=%s probe=%s\n", p.ID, p.Decls[0].Rule, p.Decls[0].Probe)
	}
	return true
}

// dslLog 输出异常日志：逐条判定事件。支持按文件路径过滤（--file，可多次），
// 让 LLM 只取某个文件/链路相关的日志，避免一次性全量丢出。
//
// 过滤语义：
//   - 默认：只列偏差（设计不符 / 静默吞错）
//   - --file <path>：只列与这些路径相关的事件（按事件 Fields["file"] 精确或
//     后缀匹配，支持传相对路径/绝对路径/文件名片段），并连正常流动一并列出
//     （供 LLM 查看该文件数据流具体怎么实现），异常打标记
//   - --all：全部事件，异常打标记（不做文件过滤时慎用，会全量输出）
func dslLog(args []string) bool {
	eventsPath := ""
	all := false
	var fileFilter []string
	for i := 0; i < len(args); i++ {
		if args[i] == "--all" {
			all = true
			continue
		}
		if args[i] == "--file" && i+1 < len(args) {
			fileFilter = append(fileFilter, args[i+1])
			i++
			continue
		}
		if strings.HasPrefix(args[i], "--file=") {
			fileFilter = append(fileFilter, strings.TrimPrefix(args[i], "--file="))
			continue
		}
		if strings.HasPrefix(args[i], "-") {
			continue
		}
		if eventsPath == "" {
			eventsPath = args[i]
		}
	}
	if eventsPath == "" {
		fmt.Fprintln(os.Stderr, "用法: observe-dsl log <events.jsonl> [--file <path>]... [--all]")
		return true
	}
	f, err := os.Open(eventsPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "observe-dsl log: %v\n", err)
		return true
	}
	defer f.Close()

	judge := NewJudgeClient("")
	parsed, perr := loadEvents(f)
	if perr != nil {
		fmt.Fprintf(os.Stderr, "observe-dsl log: %v\n", perr)
		return true
	}
	verdicts, err := judge.JudgeEvents(context.Background(), parsed)
	if err != nil {
		fmt.Fprintf(os.Stderr, "observe-dsl log: %v\n", err)
		return true
	}

	// 按文件路径过滤：命中任一 --file 的事件保留
	norm := func(s string) string { return strings.ReplaceAll(s, "\\", "/") }
	var filtered []Verdict
	if len(fileFilter) > 0 {
		for _, v := range verdicts {
			evFile, _ := v.Event.Fields["file"].(string)
			evFile = norm(evFile)
			for _, ff := range fileFilter {
				ff = norm(ff)
				if evFile == ff || strings.HasSuffix(evFile, ff) || strings.Contains(evFile, ff) {
					filtered = append(filtered, v)
					break
				}
			}
		}
		verdicts = filtered
	}

	var anomalies []Verdict
	for _, v := range verdicts {
		if v.Result == "deviation" {
			anomalies = append(anomalies, v)
		}
	}

	scope := ""
	if len(fileFilter) > 0 {
		scope = fmt.Sprintf(" · 按文件过滤 %d 条", len(fileFilter))
	}
	fmt.Printf("Observe 运行日志：%d 事件 · %d 异常%s\n", len(verdicts), len(anomalies), scope)

	// 指定了文件：把该文件相关的正常流动也列出来（供 LLM 看数据流），异常打标记。
	if len(fileFilter) > 0 {
		fmt.Println()
		for _, v := range verdicts {
			renderLogLine(v, v.Result == "deviation")
		}
		return true
	}

	if !all {
		// 默认只列异常，正常流动数据不显示（除非 LLM 想看实现细节）
		if len(anomalies) == 0 {
			fmt.Println("  ✓ 无异常（无静默吞错 / 设计不符）")
			return true
		}
		fmt.Println()
		for _, v := range anomalies {
			renderLogLine(v, true)
		}
		return true
	}
	// --all：全部事件，异常打标记，正常事件仅一行概要
	fmt.Println()
	for _, v := range verdicts {
		renderLogLine(v, v.Result == "deviation")
	}
	return true
}

// renderLogLine 格式化单条日志行。emphasize 为 true 时（异常）打满详情，否则仅概要。
func renderLogLine(v Verdict, emphasize bool) {
	ev := v.Event
	ts := ev.Time.Format("15:04:05.000")
	rule := v.Rule
	if rule == "" {
		rule = "-"
	}
	if emphasize {
		fmt.Printf("  ✗ %s  [%s]  %s\n", ts, rule, ev.Probe)
		fmt.Printf("      %s\n", v.Reason)
		if len(ev.Fields) > 0 {
			data, _ := json.Marshal(ev.Fields)
			fmt.Printf("      fields: %s\n", data)
		}
		return
	}
	// 概要行也带上文件路径，便于按文件快速筛读
	if evFile, ok := ev.Fields["file"].(string); ok && evFile != "" {
		fmt.Printf("  · %s  [%s]  %s  <%s>\n", ts, rule, ev.Probe, evFile)
		return
	}
	fmt.Printf("  · %s  [%s]  %s\n", ts, rule, ev.Probe)
}

// dslInstrument 对 Go 项目目录做源码级自动插桩（PR 偏差2）。
//   - --dry-run      只报告探针点，不写盘
//   - --enable-deep  额外捕获函数内部变量赋值（deep 级）
//   - --explore      探索模式：全量无脑插桩（挖掘隐藏问题），默认契约模式只注入 DSL 声明的探针
//   - --restore      还原上次插桩前的原始文件（从备份目录拷回）
func dslInstrument(args []string, dataDir string) bool {
	dir := ""
	dryRun := false
	enableDeep := false
	restore := false
	explore := false
	probeImport := ""
	var excludeDirs []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--dry-run":
			dryRun = true
		case a == "--enable-deep":
			enableDeep = true
		case a == "--restore":
			restore = true
		case a == "--explore":
			explore = true
		case a == "--probe-import" && i+1 < len(args):
			i++
			probeImport = args[i]
		case a == "--exclude-dir" && i+1 < len(args):
			i++
			excludeDirs = append(excludeDirs, args[i])
		case strings.HasPrefix(a, "-"):
			fmt.Fprintln(os.Stderr, "未知参数: "+a)
		default:
			if dir == "" {
				dir = a
			}
		}
	}
	if dir == "" {
		fmt.Fprintln(os.Stderr, "用法: observe-dsl instrument <dir> [--dry-run] [--enable-deep] [--explore] [--restore] [--probe-import <path>]")
		return true
	}

	if restore {
		restored := instrument.RestoreInstrumented(dir)
		if len(restored) == 0 {
			fmt.Println("instrument: 无备份可还原（或目录已清洁）")
		} else {
			fmt.Printf("已将 %d 个文件还原为插桩前原版：\n", len(restored))
			for _, f := range restored {
				fmt.Printf("  · %s\n", f)
			}
		}
		return true
	}

	if probeImport == "" {
		probeImport = "go-observe/probe"
	}

	// 模式：默认契约模式（读 DSL 声明探针），--explore 全量无脑插桩。
	var contractProbes []instrument.ContractProbe
	modeNote := "契约模式"
	if explore {
		contractProbes = nil
		modeNote = "探索模式（全量插桩，挖掘隐藏问题）"
	} else {
		store := NewDesignDSLStore(dataDir)
		doc, err := store.Load()
		if err != nil {
			if os.IsNotExist(err) {
				fmt.Fprintln(os.Stderr, "observe-dsl instrument: 设计 DSL 尚未初始化（契约模式需要 DSL），先 `observe-dsl seed` 或用 `--explore` 全量插桩")
				return true
			}
			fmt.Fprintf(os.Stderr, "observe-dsl instrument: 加载 DSL: %v\n", err)
			return true
		}
		for _, d := range doc.Decls {
			// 只取有具体探针点的声明驱动插桩；空 Probe（全局规则）只作用于判定阶段
			if d.Probe != "" {
				contractProbes = append(contractProbes, instrument.ContractProbe{Probe: d.Probe})
			}
		}
		if len(contractProbes) == 0 {
			fmt.Fprintln(os.Stderr, "observe-dsl instrument: DSL 尚无具体探针点声明（只有全局规则），契约模式将不注入任何探针；可用 `--explore` 全量插桩发现可提升的探针点")
			return true
		}
	}

	opts := instrument.Options{
		ProbeImport:    probeImport,
		Write:          !dryRun,
		EnableDeep:     enableDeep,
		BackupRoot:     dir,
		ExcludeDirs:    excludeDirs,
		ContractProbes: contractProbes,
	}
	results := instrument.InstrumentDir(dir, opts)
	var total int
	hits := 0
	for _, r := range results {
		if len(r.Sites) == 0 {
			continue
		}
		hits++
		total += len(r.Sites)
		modes := map[string]int{}
		for _, s := range r.Sites {
			modes[s.Level]++
		}
		summary := ""
		for _, lvl := range []string{"core", "event", "deep"} {
			if n := modes[lvl]; n > 0 {
				summary += fmt.Sprintf("  %s×%d", lvl, n)
			}
		}
		fmt.Printf("  · %s  +%d 探针%s\n", r.File, len(r.Sites), summary)
	}
	verb := "注入"
	if dryRun {
		verb = "将注入（dry-run）"
	}
	fmt.Printf("instrument: [%s] %d/%d 文件%s %d 个探针点\n", modeNote, hits, len(results), verb, total)
	if contractProbes != nil {
		fmt.Printf("  契约探针 %d 个: %v\n", len(contractProbes), contractProbeNames(contractProbes))
	}
	if !dryRun && hits > 0 {
		fmt.Println("提示: 用 `observe-dsl instrument <dir> --restore` 可还原为插桩前原版")
	}
	return true
}

// contractProbeNames 提取契约探针 id 列表（用于输出）。
func contractProbeNames(probes []instrument.ContractProbe) []string {
	out := make([]string, 0, len(probes))
	for _, p := range probes {
		out = append(out, p.Probe)
	}
	return out
}

// writeJSON 原子写 JSON 文件（临时文件 + rename）。
func writeJSON(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
