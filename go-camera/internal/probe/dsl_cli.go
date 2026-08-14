package probe

// Package probe — camera-dsl CLI：设计 DSL 仓库的管理入口（P1）。
//
// 子命令：
//
//	camera-dsl show              显示当前生效的设计 DSL（权威）
//	camera-dsl history           显示审计历史（版本/时间/来源/原因）
//	camera-dsl rollback <ver>    回滚到指定历史版本（作为新版本写入）
//	camera-dsl seed              播种 v1 种子（已存在则幂等跳过）
//
// dataDir 指向设计 DSL 仓库目录（{projectRoot}/.agent/camera）。LLM 无直接
// 写盘通道，本 CLI 是当前唯一的定稿/回滚入口（P3 验证门接入后由它代写）。

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// RunDSLCLI 处理 camera-dsl 子命令。args 为 camera-dsl 之后的参数（可能含
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
	case "help", "-h", "--help":
		usageDSL()
		return true
	default:
		fmt.Fprintf(os.Stderr, "camera-dsl: unknown subcommand %q\n\n", args[0])
		usageDSL()
		return true
	}
}

func usageDSL() {
	fmt.Fprint(os.Stderr, `camera-dsl — Camera 设计 DSL 仓库（DSL 唯一真相源）

用法:
  camera-dsl show               显示当前生效的设计 DSL
  camera-dsl history            显示审计历史
  camera-dsl rollback <version> 回滚到指定历史版本（作为新版本写入）
  camera-dsl seed               播种 v1 种子（幂等）
  camera-dsl actual <events.jsonl> [--out <path>]  聚合观测画像 → actual.dsl.json
  camera-dsl diff [--actual <path>]                对比 actual vs design，出三类偏差报告
  camera-dsl propose <decls.json> [--reason <原因>] [--source <来源>]  提交修订提案（不落权威盘）
  camera-dsl proposals                               列出全部修订提案
  camera-dsl approve <id> [--reviewer <名字>]        验证门审批 → 定稿为设计 DSL 新版本
  camera-dsl reject <id> [--reviewer <名字>]         拒绝修订提案

仓库位置: {projectRoot}/.agent/camera/
  dsl.json           当前生效版本（权威判定依据）
  dsl.history.jsonl  快照式审计历史
  actual.dsl.json    观测事实画像（可再生·非权威，由 camera-dsl actual 生成）
  proposals/         修订提案目录（写盘权分离，审批后才并入 dsl.json）
`)
}

func dslShow(store *DesignDSLStore) bool {
	doc, err := store.Load()
	if err != nil {
		if os.IsNotExist(err) {
			fmt.Fprintln(os.Stderr, "camera-dsl: 设计 DSL 尚未初始化，运行 `camera-dsl seed` 播种")
			return true
		}
		fmt.Fprintf(os.Stderr, "camera-dsl: %v\n", err)
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
		fmt.Fprintf(os.Stderr, "camera-dsl: %v\n", err)
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
		fmt.Fprintln(os.Stderr, "用法: camera-dsl rollback <version>")
		return true
	}
	ver, err := strconv.Atoi(args[0])
	if err != nil || ver < 1 {
		fmt.Fprintf(os.Stderr, "camera-dsl: 非法版本号 %q\n", args[0])
		return true
	}
	newVer, err := store.Rollback(ver)
	if err != nil {
		fmt.Fprintf(os.Stderr, "camera-dsl: %v\n", err)
		return true
	}
	fmt.Printf("已回滚到 v%d（作为 v%d 写入，审计链保留）\n", ver, newVer)
	return true
}

func dslSeed(store *DesignDSLStore) bool {
	seeded, err := store.SeedDefault()
	if err != nil {
		fmt.Fprintf(os.Stderr, "camera-dsl: %v\n", err)
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
		fmt.Fprintln(os.Stderr, "用法: camera-dsl actual <events.jsonl> [--out <path>]")
		return true
	}

	events, skipped, err := (&ActualDSLLoader{}).LoadFile(eventsPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "camera-dsl actual: %v\n", err)
		return true
	}
	doc := NewAggregator().Aggregate(events)
	doc.Source = eventsPath
	doc.BadLines = skipped
	if err := writeJSON(outPath, doc); err != nil {
		fmt.Fprintf(os.Stderr, "camera-dsl actual: 写 %s: %v\n", outPath, err)
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
			fmt.Fprintln(os.Stderr, "camera-dsl diff: 设计 DSL 未初始化，先运行 `camera-dsl seed`")
			return true
		}
		fmt.Fprintf(os.Stderr, "camera-dsl diff: 读设计 DSL: %v\n", err)
		return true
	}
	var actual ActualDSLDoc
	raw, err := os.ReadFile(actualPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "camera-dsl diff: 读 %s: %v（先运行 `camera-dsl actual <events.jsonl>`）\n", actualPath, err)
		return true
	}
	if err := json.Unmarshal(raw, &actual); err != nil {
		fmt.Fprintf(os.Stderr, "camera-dsl diff: 解析 %s: %v\n", actualPath, err)
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
		fmt.Fprintln(os.Stderr, "用法: camera-dsl propose <decls.json> [--reason <原因>] [--source <来源>]")
		return true
	}
	decls, err := loadDeclsFile(declsPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "camera-dsl propose: %v\n", err)
		return true
	}
	p, err := NewProposalStore(dataDir).Create(decls, reason, source)
	if err != nil {
		fmt.Fprintf(os.Stderr, "camera-dsl propose: %v\n", err)
		return true
	}
	fmt.Printf("已创建修订提案 %s（%d 条声明，状态 pending）\n  运行 `camera-dsl approve %s` 定稿为设计 DSL 新版本\n",
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
		fmt.Fprintf(os.Stderr, "camera-dsl proposals: %v\n", err)
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
		fmt.Printf("  %-24s %-9s %d 条声明  src=%s  %s\n", p.ID, p.Status, len(p.Decls), p.Source, reason)
	}
	return true
}

// dslApprove 验证门审批：通过后借 DesignDSLStore 定稿为新版本。
func dslApprove(args []string, dataDir string) bool {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "用法: camera-dsl approve <id> [--reviewer <名字>]")
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
		fmt.Fprintf(os.Stderr, "camera-dsl approve: %v\n", err)
		return true
	}
	fmt.Printf("已审批通过提案 %s → 设计 DSL v%d（审计链保留）\n", id, ver)
	return true
}

// dslReject 拒绝修订提案。
func dslReject(args []string, dataDir string) bool {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "用法: camera-dsl reject <id> [--reviewer <名字>]")
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
		fmt.Fprintf(os.Stderr, "camera-dsl reject: %v\n", err)
		return true
	}
	fmt.Printf("已拒绝修订提案 %s\n", id)
	return true
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
