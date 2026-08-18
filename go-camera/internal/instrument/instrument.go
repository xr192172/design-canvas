// Package instrument — Go 源码级自动插桩（PR 偏差2）。
//
// 用 go/ast 解析被测 Go 文件，在函数出入口 / return / IO 写盘 / (可选的 deep)
// 变量赋值处注入 camprobe.Capture 探针，直接改写源文件（git 兜底 + 备份还原）。
// 与 TS 侧 instrument.ts 的策略一致：全量无脑插桩、幂等标记、从后往前注入避免
// 偏移漂移、写盘前备份可一键还原。
//
// 事件分级（与 TS 对齐）：
//   - core  ：函数入口(enter)/出口(exit) 参数与返回值
//   - event ：IO 写盘（op）
//   - deep  ：函数内部变量赋值（默认关闭，enableDeep 放大）
//
// 依赖：被测项目须能 import 本探针包（默认 go-camera/probe）。
package instrument

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
)

// ProbeKind 是探针点类型。
type ProbeKind string

// 探针点类型枚举。
const (
	ProbeEnter ProbeKind = "enter"
	ProbeExit  ProbeKind = "exit"
	ProbeIO    ProbeKind = "io"
	ProbeDeep  ProbeKind = "deep"
)

// Site 是单个插桩点。
type Site struct {
	Kind   ProbeKind
	Level  string // core | event | deep
	Line   int    // 1-based
	Offset int    // 注入字节偏移
	Code   string // 注入的探针源码
}

// Result 是单文件插桩结果。
type Result struct {
	File  string
	Sites []Site
	Error string
}

// Options 是插桩配置。
type Options struct {
	// ProbeImport 是被插桩代码 import 的探针包路径（默认 go-camera/probe）。
	ProbeImport string
	// Write 是否实际写盘；false 只做 dry-run 报告（默认 true）。
	Write bool
	// EnableDeep 是否启用 deep 级插桩（变量赋值捕获，默认 false）。
	EnableDeep bool
	// BackupRoot 备份根：写盘前把原文件备份到 <backupRoot>/.design-canvas/camera-backup/<rel>。
	BackupRoot string
	// ExcludeDirs 相对目录名列表（如 internal/probe），这些目录下的文件跳过插桩。
	// 用于避免把探针打进探针包自身/其依赖链造成 import cycle。
	ExcludeDirs []string
	// ContractProbes 契约模式探针列表：非 nil 时只注入其中声明的探针点（精确匹配
	// pkg.FuncName.suffix），并做文件级包过滤；nil 时全量无脑插桩（探索模式）。
	ContractProbes []ContractProbe
}

// 探针 import 别名（保持在此处，注入统一使用）。
const probeAlias = "camprobe"

// 幂等标记：已插桩文件含此标记则跳过。
const probeMarker = "camera:instrumented"

// deep 级插桩独立标记。
const deepMarker = "camera:deep"

// 备份目录名（相对被插桩项目根）。
const backupDir = ".design-canvas/camera-backup"

// IO 写盘调用 → 探针 op 名（selector 选择器名）。
var ioOps = map[string]string{
	"WriteFile": "writefile", "WriteString": "writefile", "Write": "writefile",
	"MkdirAll": "mkdirall", "Mkdir": "mkdirall",
	"Remove": "remove", "RemoveAll": "remove", "Rename": "remove",
	"Create": "writefile", "OpenFile": "writefile",
	"AppendFile": "writefile", "Copy": "writefile",
}

// collectGoFiles 递归收集目录下所有 .go 源文件（跳过 node_modules/dist/.git/.design-canvas 等）。
func collectGoFiles(root string, excludes []string) []string {
	var out []string
	// excludes 是相对根目录的路径（如 internal/probe），命中则跳过整目录
	excludeSet := map[string]bool{}
	for _, e := range excludes {
		excludeSet[filepath.ToSlash(strings.TrimPrefix(filepath.ToSlash(e), "./"))] = true
	}
	filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if d.Name() == "node_modules" || d.Name() == ".git" ||
				d.Name() == ".design-canvas" || d.Name() == "coverage" {
				return filepath.SkipDir
			}
			// 相对 root 的目录路径（slash），命中 exclude 则跳过
			rel, rerr := filepath.Rel(root, path)
			if rerr == nil {
				relSlash := filepath.ToSlash(rel)
				if excludeSet[relSlash] {
					return filepath.SkipDir
				}
			}
			return nil
		}
		if strings.HasSuffix(d.Name(), ".go") && !strings.HasSuffix(d.Name(), "_test.go") {
			out = append(out, path)
		}
		return nil
	})
	return out
}

// backupPathFor 把文件相对 backupRoot 的路径映射为备份目录下的镜像路径。
func backupPathFor(backupRoot, file string) string {
	rel := filepath.ToSlash(relPath(backupRoot, file))
	return filepath.Join(backupRoot, backupDir, rel)
}

// relPath 计算 from 到 to 的相对路径。
func relPath(from, to string) string {
	r, err := filepath.Rel(from, to)
	if err != nil {
		return filepath.Base(to)
	}
	return r
}

// backupOriginal 写盘前备份原文件（幂等：已备份则保留最早原版）。
func backupOriginal(backupRoot, file, content string) {
	dest := backupPathFor(backupRoot, file)
	if _, err := os.Stat(dest); err == nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(dest), 0o755)
	_ = os.WriteFile(dest, []byte(content), 0o644)
}

// RestoreInstrumented 还原被插桩项目的所有文件（拷回备份并删除备份目录）。
func RestoreInstrumented(root string) []string {
	dir := filepath.Join(root, backupDir)
	var restored []string
	filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		// p 是备份文件，目标 = 相对 backupDir 的路径映射回 root
		rel := relPath(dir, p)
		if rel == "" || strings.HasPrefix(rel, "..") {
			return nil
		}
		target := filepath.Join(root, rel)
		if data, err := os.ReadFile(p); err == nil {
			if err := os.WriteFile(target, data, 0o644); err == nil {
				restored = append(restored, target)
			}
		}
		return nil
	})
	_ = os.RemoveAll(dir)
	return restored
}

// InstrumentFile 对单个 Go 文件插桩。返回注入的探针点（dry-run 不写盘）。
func InstrumentFile(file string, opts Options) (Result, error) {
	res := Result{File: file}
	applyWrite := opts.Write
	enableDeep := opts.EnableDeep

	content, err := os.ReadFile(file)
	if err != nil {
		res.Error = err.Error()
		return res, err
	}
	src := string(content)

	// 幂等：核心探针已注入且未请求 deep → 跳过；核心与 deep 都已注入 → 跳过
	hasCore := strings.Contains(src, probeMarker)
	hasDeep := strings.Contains(src, deepMarker)
	if (hasCore && !enableDeep) || (hasCore && hasDeep) {
		return res, nil
	}

	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, file, src, parser.ParseComments)
	if err != nil {
		res.Error = err.Error()
		return res, err
	}

	backupRoot := opts.BackupRoot
	if backupRoot == "" {
		// findProjectRoot 已返回含 go.mod 的项目根，不要再包 filepath.Dir（否则备份写到父目录，还原时找不到）
		backupRoot = findProjectRoot(file, f.Name.Name)
	}

	probeImport := opts.ProbeImport
	if probeImport == "" {
		probeImport = "go-camera/probe"
	}

	fileRel := filepath.ToSlash(relPath(backupRoot, file))
	pkg := f.Name.Name

	// 契约模式文件级包过滤：契约探针声明的包不包含当前文件包名则整文件跳过。
	// 探索模式（probes==nil）不做此过滤，全量扫描。
	if probes := opts.ContractProbes; probes != nil {
		if pkgs := PackageFilter(probes); len(pkgs) > 0 {
			if !pkgs[pkg] {
				return res, nil
			}
		}
	}

	var sites []Site
	collectFuncSites(fset, f, pkg, fileRel, enableDeep, opts.ContractProbes, &sites)

	if len(sites) == 0 {
		return res, nil
	}

	// 按 Offset 从大到小排序，从后往前注入避免偏移漂移
	sortSites(sites)

	// 探针 import 注入：在 package 声明行后补一行
	importLine := "\nimport " + probeAlias + " \"" + probeImport + "\"\n"
	insertOffset := packageLineEnd(src, fset, f)

	out := src
	// 按 Offset 降序遍历（sites[0]=文件末尾），从后往前注入避免偏移漂移。
	// 注：sortSites 已按 Offset 降序排列，此处正向遍历 = 从最大Offset（文件末尾）开始。
	for i := 0; i < len(sites); i++ {
		s := sites[i]
		out = out[:s.Offset] + s.Code + out[s.Offset:]
	}
	// 头部标记 + import（避免重复补 import）
	if !hasCore {
		out = out[:insertOffset] + importLine + out[insertOffset:]
	}
	if enableDeep && !hasDeep {
		out = "// " + deepMarker + "\n" + out
	}
	if !hasCore {
		out = "// " + probeMarker + "\n" + out
	}

	res.Sites = sites
	// 防御性清理：块末探针破坏终止性（missing return）时删除多余探针。
	// 触发场景：switch case / comm 分支 / 函数体等块，原最后一条是终止语句
	// （return/for/switch...），但探针被插到它之后使块不再终止。
	if cleaned := cleanupTrailingProbes(file, []byte(out)); cleaned != nil {
		out = string(cleaned)
	}
	if applyWrite {
		backupOriginal(backupRoot, file, src)
		if err := os.WriteFile(file, []byte(out), 0o644); err != nil {
			res.Error = err.Error()
			return res, err
		}
	}
	return res, nil
}

// findProjectRoot 向上找含 go.mod 的目录作为项目根（用于备份根/相对路径）。
func findProjectRoot(file, _ string) string {
	dir := filepath.Dir(file)
	for depth := 0; depth < 12; depth++ {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return filepath.Dir(file)
}

// packageLineEnd 返回 package 声明行结束（换行）的字节偏移，用于插入 import。
// 用 AST 的 f.Package（package 关键字）与 f.Name.End()（包名结尾）定位真实声明行，
// 避免文件头注释里出现 "// Package xxx" 时字符串匹配误判（如 ws_brain.go）。
func packageLineEnd(src string, fset *token.FileSet, f *ast.File) int {
	if f == nil || f.Package == token.NoPos {
		return 0
	}
	tf := fset.File(f.Package)
	if tf == nil {
		return 0
	}
	// 包名结尾的字节偏移
	endOff := tf.Offset(f.Name.End())
	if endOff < 0 || endOff >= len(src) {
		return len(src)
	}
	// 从包名结尾跳到该行行尾
	rest := src[endOff:]
	if nl := strings.IndexByte(rest, '\n'); nl >= 0 {
		return endOff + nl + 1
	}
	return len(src)
}


// terminatesFunction 判断语句是否可能使函数不落出（return / 无限循环 / 全分支返回）。
// 用于决定是否在函数体末尾补出口探针——在这些语句之后插任何语句都是不可达代码，
// Go 编译器会报 "missing return"。
func terminatesFunction(stmt ast.Stmt) bool {
	switch t := stmt.(type) {
	case *ast.ReturnStmt, *ast.ForStmt, *ast.RangeStmt, *ast.SelectStmt:
		return true
	case *ast.SwitchStmt, *ast.TypeSwitchStmt:
		return true
	case *ast.IfStmt:
		if t.Else == nil {
			return false // 无 else，可能不返回
		}
		// else 分支：仅当是 BlockStmt 且末尾是 return 才算终止
		eb, ok := t.Else.(*ast.BlockStmt)
		if !ok || len(eb.List) == 0 {
			return false
		}
		_, ebRet := eb.List[len(eb.List)-1].(*ast.ReturnStmt)
		_, ifRet := false, false
		if t.Body != nil && len(t.Body.List) > 0 {
			_, ifRet = t.Body.List[len(t.Body.List)-1].(*ast.ReturnStmt)
		}
		return ebRet && ifRet
	default:
		return false
	}
}

// sortSites 按 Offset 降序排列（注入时从文件末尾往前）。
func sortSites(sites []Site) {
	for i := 1; i < len(sites); i++ {
		for j := i; j > 0 && sites[j].Offset > sites[j-1].Offset; j-- {
			sites[j], sites[j-1] = sites[j-1], sites[j]
		}
	}
}

// collectFuncSites 遍历文件 AST，收集所有插桩点。probes 非 nil 时按契约过滤。
func collectFuncSites(fset *token.FileSet, f *ast.File, pkg, fileRel string, enableDeep bool, probes []ContractProbe, sites *[]Site) {
	ast.Inspect(f, func(n ast.Node) bool {
		switch t := n.(type) {
		case *ast.FuncDecl:
			if t.Body != nil {
				processFunction(fset, t.Name.Name, t.Type.Params, t.Body, pkg, fileRel, enableDeep, probes, sites)
			}
		case *ast.FuncLit:
			if t.Body != nil {
				processFunction(fset, "", t.Type.Params, t.Body, pkg, fileRel, enableDeep, probes, sites)
			}
		}
		return true
	})
}

// processFunction 处理一个函数体（FuncDecl 或 FuncLit）：入口/出口/return/IO/deep。
// probes 非 nil（契约模式）时，每条探针注入前用 MatchProbe 精确门控——只注入
// DSL 声明的 pkg.FuncName.suffix。
func processFunction(fset *token.FileSet, fn string, params *ast.FieldList, body *ast.BlockStmt, pkg, fileRel string, enableDeep bool, probes []ContractProbe, sites *[]Site) {
	if fn == "" {
		fn = "closure"
	}
	offsetOf := func(pos token.Pos) int {
		return fset.Position(pos).Offset
	}
	lineOf := func(pos token.Pos) int {
		return fset.Position(pos).Line
	}
	probeName := func(suffix string) string {
		return fmt.Sprintf("%s.%s.%s", pkg, fn, suffix)
	}

	// ── 入口（core）：在函数体 '{' 后注入参数捕获 ──
	if MatchProbe(probeName("enter"), probes) {
		openOffset := offsetOf(body.Lbrace)
		insertAt := openOffset + 1
		argsMap := paramCapture(params)
		code := fmt.Sprintf(`camprobe.Capture(%q, "llm-design", map[string]any{"file": %q, "level": "core", "args": map[string]any{%s}});`,
			probeName("enter"), fileRel, argsMap)
		*sites = append(*sites, Site{Kind: ProbeEnter, Level: "core", Line: lineOf(body.Lbrace), Offset: insertAt, Code: "\n" + code})
	}

	// 遍历函数体语句：return / IO / deep 由语句级处理
	walkStmts(fset, body.List, probeName, fileRel, enableDeep, offsetOf, lineOf, probes, sites)

	// 函数体末尾出口探针：仅当最后一条语句不是 return 时注入（named-return 尾部自然落出等）。
	// 若最后一条是 return，return 前已有 exit 探针捕获出口；在 return 后插任何语句
	// （探针/调用）都会成为不可达代码，Go 编译器报 "missing return"（已实验证实）。
	// 注入位置用最后一条语句的 End()，避免与 Rbrace 前位置冲突。
	if MatchProbe(probeName("exit"), probes) && len(body.List) > 0 {
		last := body.List[len(body.List)-1]
		// 末尾是「可能不落出函数」的控制流时不插末尾探针：
		// return（已有 return 前探针）、for/select/switch（可能无限或全分支返回）、
		// if-else（两分支均以 return 收尾）。在这些语句后插任何语句都有
		// "missing return" 风险（Go 对不可达代码的规则）。
		if !terminatesFunction(last) {
			lastEnd := offsetOf(last.End())
			code := fmt.Sprintf(`camprobe.Capture(%q, "llm-design", map[string]any{"file": %q, "level": "core"});`,
				probeName("exit"), fileRel)
			*sites = append(*sites, Site{Kind: ProbeExit, Level: "core", Line: lineOf(body.Rbrace), Offset: lastEnd, Code: "\n" + code})
		}
	}
}

// paramCapture 构造入口探针的参数捕获字段（仅命名简单标识符参数，且为单个名字）。
func paramCapture(params *ast.FieldList) string {
	if params == nil {
		return ""
	}
	var fields []string
	add := func(names []*ast.Ident) {
		for _, n := range names {
			if n.Name == "_" {
				continue // 空标识符 _ 不能作 map key 也不能作值，跳过
			}
			fields = append(fields, fmt.Sprintf("%q: %s", n.Name, n.Name))
		}
	}
	for _, f := range params.List {
		if len(f.Names) == 0 {
			continue // 无名字的参数（如 func(int, string)）不可引用，跳过
		}
		add(f.Names)
	}
	return strings.Join(fields, ", ")
}

// walkStmts 递归遍历语句列表，收集 return / IO / deep 探针。
// probes 非 nil（契约模式）时，每条探针注入前用 MatchProbe 精确门控。
func walkStmts(fset *token.FileSet, stmts []ast.Stmt, probeName func(string) string, fileRel string, enableDeep bool, offsetOf func(token.Pos) int, lineOf func(token.Pos) int, probes []ContractProbe, sites *[]Site) {
	for _, stmt := range stmts {
		switch s := stmt.(type) {
		case *ast.ReturnStmt:
			// return 出口（core）：在 return 前注入。取值捕获仅当无副作用。
			if MatchProbe(probeName("exit"), probes) {
				fields := returnCapture(s)
				// fields 可能为空（return 无值或有副作用表达式），此时不拼 "ret:" 字段，
				// 否则会出现 map 字面量里的 "level": "core", 空字段 trailing comma，Go 语法错误。
				suffix := ""
				if fields != "" {
					suffix = ", " + fields
				}
				code := fmt.Sprintf(`camprobe.Capture(%q, "llm-design", map[string]any{"file": %q, "level": "core"%s});`,
					probeName("exit"), fileRel, suffix)
				*sites = append(*sites, Site{Kind: ProbeExit, Level: "core", Line: lineOf(s.Pos()), Offset: offsetOf(s.Pos()), Code: code + "\n"})
			}
		case *ast.BlockStmt:
			walkStmts(fset, s.List, probeName, fileRel, enableDeep, offsetOf, lineOf, probes, sites)
		case *ast.IfStmt:
			if s.Body != nil {
				walkStmts(fset, s.Body.List, probeName, fileRel, enableDeep, offsetOf, lineOf, probes, sites)
			}
			if s.Else != nil {
				if el, ok := s.Else.(*ast.BlockStmt); ok {
					walkStmts(fset, el.List, probeName, fileRel, enableDeep, offsetOf, lineOf, probes, sites)
				}
			}
		case *ast.ForStmt:
			if s.Body != nil {
				walkStmts(fset, s.Body.List, probeName, fileRel, enableDeep, offsetOf, lineOf, probes, sites)
			}
		case *ast.RangeStmt:
			if s.Body != nil {
				walkStmts(fset, s.Body.List, probeName, fileRel, enableDeep, offsetOf, lineOf, probes, sites)
			}
		case *ast.SwitchStmt:
			if s.Body != nil {
				walkStmts(fset, s.Body.List, probeName, fileRel, enableDeep, offsetOf, lineOf, probes, sites)
			}
		case *ast.TypeSwitchStmt:
			if s.Body != nil {
				walkStmts(fset, s.Body.List, probeName, fileRel, enableDeep, offsetOf, lineOf, probes, sites)
			}
		case *ast.SelectStmt:
			if s.Body != nil {
				walkStmts(fset, s.Body.List, probeName, fileRel, enableDeep, offsetOf, lineOf, probes, sites)
			}
		case *ast.CaseClause:
			walkStmts(fset, s.Body, probeName, fileRel, enableDeep, offsetOf, lineOf, probes, sites)
		case *ast.CommClause:
			walkStmts(fset, s.Body, probeName, fileRel, enableDeep, offsetOf, lineOf, probes, sites)
		case *ast.DeferStmt:
			// defer/recover（event）：捕获 defer 调用中的错误场景（Op）
			if MatchProbe(probeName("defer"), probes) {
				if op := deferOp(s); op != "" {
					code := fmt.Sprintf(`camprobe.Capture(%q, "llm-design", map[string]any{"file": %q, "level": "event", "op": %q});`,
						probeName("defer"), fileRel, op)
					// Bug5 修复：不能注入到 s.Call.Lparen+1（参数括号内部=语法错误），
					// 改为在 defer 语句末尾之后注入，并前缀换行与原 token 分隔。
					*sites = append(*sites, Site{Kind: ProbeIO, Level: "event", Line: lineOf(s.Pos()), Offset: offsetOf(s.End()), Code: "\n" + code + "\n"})
				}
			}
		}

		// ── IO 写盘（event）：语句内含 IO 调用 → 语句后注入 ──
		// 跳过 ReturnStmt：return 表达式里的 IO 调用（如 return os.Rename(...)）
		// 已由 return 前的 exit 探针覆盖；在 return 后插任何语句都是不可达代码，
		// Go 编译器报 "missing return"。
		if _, isRetStmt := stmt.(*ast.ReturnStmt); isRetStmt {
			continue // 仅跳过当前语句的 IO 探针，不能 return（会退出整个 walkStmts，丢掉后续兄弟语句）
		}
		if op := ioOpInStmt(stmt); op != "" && MatchProbe(probeName(op), probes) {
			code := fmt.Sprintf(`camprobe.Capture(%q, "llm-design", map[string]any{"file": %q, "level": "event", "op": %q});`,
				probeName(op), fileRel, op)
			// Bug4 修复：前置换行避免与前一个 token（如 `}`）粘连成 `}camprobe` 语法错误
			*sites = append(*sites, Site{Kind: ProbeIO, Level: "event", Line: lineOf(stmt.Pos()), Offset: offsetOf(stmt.End()), Code: "\n" + code + "\n"})
		}

		// ── deep（可选）：变量赋值捕获 ──
		if enableDeep && MatchProbe(probeName("deep"), probes) {
			if code, ok := deepCapture(stmt, probeName, fileRel); ok {
				// 同 Bug4：前置换行避免粘连
				*sites = append(*sites, Site{Kind: ProbeDeep, Level: "deep", Line: lineOf(stmt.Pos()), Offset: offsetOf(stmt.End()), Code: "\n" + code + "\n"})
			}
		}
	}
}

// returnCapture 构造 return 出口探针的字段。仅当返回值表达式无副作用时捕获值。
func returnCapture(s *ast.ReturnStmt) string {
	if len(s.Results) == 0 {
		return ""
	}
	allSimple := true
	for _, r := range s.Results {
		if !isSideEffectFree(r) {
			allSimple = false
			break
		}
	}
	if !allSimple {
		return ""
	}
	parts := make([]string, 0, len(s.Results))
	for i, r := range s.Results {
		parts = append(parts, fmt.Sprintf("%q: %s", fmt.Sprintf("%d", i), exprString(r)))
	}
	return "\"ret\": map[string]any{" + strings.Join(parts, ", ") + "}"
}

// isSideEffectFree 判断表达式是否无副作用（可安全地再次求值）。
func isSideEffectFree(e ast.Expr) bool {
	switch t := e.(type) {
	case *ast.Ident, *ast.BasicLit:
		return true
	case *ast.ParenExpr:
		return isSideEffectFree(t.X)
	case *ast.UnaryExpr:
		return isSideEffectFree(t.X)
	case *ast.BinaryExpr:
		return isSideEffectFree(t.X) && isSideEffectFree(t.Y)
	case *ast.SelectorExpr:
		return isSideEffectFree(t.X)
	case *ast.IndexExpr:
		return isSideEffectFree(t.X) && isSideEffectFree(t.Index)
	case *ast.CompositeLit:
		for _, el := range t.Elts {
			if !isSideEffectFree(el) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

// exprString 渲染表达式源码（用于注入；不接受错误，仅简单表达式可渲染）。
func exprString(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.BasicLit:
		return t.Value
	case *ast.ParenExpr:
		return "(" + exprString(t.X) + ")"
	case *ast.UnaryExpr:
		return t.Op.String() + exprString(t.X)
	case *ast.BinaryExpr:
		return exprString(t.X) + " " + t.Op.String() + " " + exprString(t.Y)
	case *ast.SelectorExpr:
		return exprString(t.X) + "." + t.Sel.Name
	case *ast.IndexExpr:
		return exprString(t.X) + "[" + exprString(t.Index) + "]"
	case *ast.StarExpr:
		return "*" + exprString(t.X)
	case *ast.ArrayType:
		if t.Len == nil {
			return "[]" + exprString(t.Elt)
		}
		return "[" + exprString(t.Len) + "]" + exprString(t.Elt)
	case *ast.CompositeLit:
		// 复合字面量：&T{...} 或 T{...}。元素递归渲染（仅简单字面量，前面已有 isSideEffectFree 把关）
		typeName := exprString(t.Type)
		if typeName == "nil" {
			return "nil" // 类型无法渲染 → 整体降级为 nil，调用方会因值含 "nil" 表达式而跳过
		}
		elts := make([]string, 0, len(t.Elts))
		for _, el := range t.Elts {
			switch kv := el.(type) {
			case *ast.KeyValueExpr:
				elts = append(elts, exprString(kv.Key)+": "+exprString(kv.Value))
			default:
				elts = append(elts, exprString(el))
			}
		}
		return typeName + "{" + strings.Join(elts, ", ") + "}"
	default:
		return "nil"
	}
}

// ioOpInStmt 检测语句内是否含 IO 写盘调用，返回探针 op 名（无则空串）。
func ioOpInStmt(stmt ast.Stmt) string {
	op := ""
	ast.Inspect(stmt, func(n ast.Node) bool {
		if op != "" {
			return false
		}
		if c, ok := n.(*ast.CallExpr); ok {
			if sel, ok := c.Fun.(*ast.SelectorExpr); ok {
				if o, found := ioOps[sel.Sel.Name]; found {
					op = o
					return false
				}
			}
		}
		return true
	})
	return op
}

// deferOp 检测 defer 调用是否含 recover（Go 的错误捕获场景），返回 op 名。
func deferOp(s *ast.DeferStmt) string {
	if s.Call == nil {
		return ""
	}
	// defer func(){ ... recover() ... }() 视为 error-捕获点
	if lit, ok := s.Call.Fun.(*ast.FuncLit); ok {
		hasRecover := false
		ast.Inspect(lit.Body, func(n ast.Node) bool {
			if c, ok := n.(*ast.CallExpr); ok {
				if id, ok2 := c.Fun.(*ast.Ident); ok2 && id.Name == "recover" {
					hasRecover = true
					return false
				}
			}
			return true
		})
		if hasRecover {
			return "recover"
		}
	}
	return ""
}

// deepCapture 捕获变量赋值（deep 级）。仅当语句是「单标识符赋值 + 初值」时。
func deepCapture(stmt ast.Stmt, probeName func(string) string, fileRel string) (string, bool) {
	as, ok := stmt.(*ast.AssignStmt)
	if !ok {
		return "", false
	}
	if len(as.Lhs) != 1 || len(as.Rhs) != 1 {
		return "", false
	}
	id, ok := as.Lhs[0].(*ast.Ident)
	if !ok {
		return "", false
	}
	code := fmt.Sprintf(`camprobe.Capture(%q, "llm-design", map[string]any{"file": %q, "level": "deep", "name": %q, "value": %s});`,
		probeName("deep"), fileRel, id.Name, exprString(as.Rhs[0]))
	return code, true
}

// InstrumentDir 对目录下所有 .go 文件插桩。返回每个文件的插桩结果。
func InstrumentDir(root string, opts Options) []Result {
	files := collectGoFiles(root, opts.ExcludeDirs)
	var results []Result
	for _, f := range files {
		o := opts
		o.BackupRoot = root
		r, _ := InstrumentFile(f, o)
		results = append(results, r)
	}
	return results
}

// isProbeCall 判断语句是否为 camprobe.Capture(...) 探针调用（插桩器生成的探针）。
func isProbeCall(stmt ast.Stmt) bool {
	es, ok := stmt.(*ast.ExprStmt)
	if !ok {
		return false
	}
	ce, ok := es.X.(*ast.CallExpr)
	if !ok || len(ce.Args) == 0 {
		return false
	}
	sel, ok := ce.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	return sel.Sel.Name == "Capture"
}

// cleanupTrailingProbes 删除「块末探针破坏终止性」的探针语句。
// 场景：块（函数体/if/for/case/comm 体）的最后一条原本是终止语句，
// 但探针（IO/deep/错位 Site）被插到它之后 → 块不再以终止语句结尾 → Go 报
// "missing return"。这类探针是多余的：出口信息已由 return 前的 exit 探针覆盖。
// 返回清理后的源码；无改动时返回 nil。
func cleanupTrailingProbes(file string, src []byte) []byte {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, file, src, parser.ParseComments)
	if err != nil {
		return nil
	}
	var removes []ast.Stmt
	ast.Inspect(f, func(n ast.Node) bool {
		var list []ast.Stmt
		switch blk := n.(type) {
		case *ast.BlockStmt:
			list = blk.List
		case *ast.CaseClause:
			list = blk.Body
		case *ast.CommClause:
			list = blk.Body
		default:
			return true
		}
		if len(list) >= 2 && isProbeCall(list[len(list)-1]) && terminatesFunction(list[len(list)-2]) {
			removes = append(removes, list[len(list)-1])
		}
		return true
	})
	if len(removes) == 0 {
		return nil
	}
	// 按 Pos 降序删除，避免偏移漂移；顺带吃掉语句后随的空白/换行。
	for i := 1; i < len(removes); i++ {
		for j := i; j > 0 && removes[j].Pos() > removes[j-1].Pos(); j-- {
			removes[j], removes[j-1] = removes[j-1], removes[j]
		}
	}
	out := append([]byte(nil), src...)
	for _, r := range removes {
		start := fset.Position(r.Pos()).Offset
		end := fset.Position(r.End()).Offset
		for end < len(out) && (out[end] == '\n' || out[end] == '\r' || out[end] == '\t' || out[end] == ' ') {
			end++
		}
		out = append(out[:start], out[end:]...)
	}
	return out
}
