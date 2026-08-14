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
// 依赖：被测项目须能 import 本探针包（默认 go-camera/internal/probe）。
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
	// ProbeImport 是被插桩代码 import 的探针包路径（默认 go-camera/internal/probe）。
	ProbeImport string
	// Write 是否实际写盘；false 只做 dry-run 报告（默认 true）。
	Write bool
	// EnableDeep 是否启用 deep 级插桩（变量赋值捕获，默认 false）。
	EnableDeep bool
	// BackupRoot 备份根：写盘前把原文件备份到 <backupRoot>/.design-canvas/camera-backup/<rel>。
	BackupRoot string
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
func collectGoFiles(root string) []string {
	var out []string
	skip := map[string]bool{
		"node_modules": true, "dist": true, ".git": true,
		".design-canvas": true, "coverage": true, "vendor": false,
	}
	_ = skip
	filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if d.Name() == "node_modules" || d.Name() == ".git" ||
				d.Name() == ".design-canvas" || d.Name() == "coverage" {
				return filepath.SkipDir
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
		backupRoot = filepath.Dir(findProjectRoot(file, f.Name.Name))
	}

	probeImport := opts.ProbeImport
	if probeImport == "" {
		probeImport = "go-camera/internal/probe"
	}

	fileRel := filepath.ToSlash(relPath(backupRoot, file))
	pkg := f.Name.Name

	var sites []Site
	collectFuncSites(fset, f, pkg, fileRel, enableDeep, &sites)

	if len(sites) == 0 {
		return res, nil
	}

	// 按 Offset 从大到小排序，从后往前注入避免偏移漂移
	sortSites(sites)

	// 探针 import 注入：在 package 声明行后补一行
	importLine := "\nimport " + probeAlias + " \"" + probeImport + "\"\n"
	insertOffset := packageLineEnd(src)

	out := src
	for i := len(sites) - 1; i >= 0; i-- {
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
func packageLineEnd(src string) int {
	// 找到 "package " 之后的包名，跳到该行末尾
	idx := strings.Index(src, "package ")
	if idx < 0 {
		return 0
	}
	rest := src[idx+len("package "):]
	nl := strings.IndexByte(rest, '\n')
	if nl < 0 {
		return len(src)
	}
	return idx + len("package ") + nl + 1
}

// sortSites 按 Offset 降序排列（注入时从文件末尾往前）。
func sortSites(sites []Site) {
	for i := 1; i < len(sites); i++ {
		for j := i; j > 0 && sites[j].Offset > sites[j-1].Offset; j-- {
			sites[j], sites[j-1] = sites[j-1], sites[j]
		}
	}
}

// collectFuncSites 遍历文件 AST，收集所有插桩点。
func collectFuncSites(fset *token.FileSet, f *ast.File, pkg, fileRel string, enableDeep bool, sites *[]Site) {
	ast.Inspect(f, func(n ast.Node) bool {
		switch t := n.(type) {
		case *ast.FuncDecl:
			if t.Body != nil {
				processFunction(fset, t.Name.Name, t.Type.Params, t.Body, pkg, fileRel, enableDeep, sites)
			}
		case *ast.FuncLit:
			if t.Body != nil {
				processFunction(fset, "", t.Type.Params, t.Body, pkg, fileRel, enableDeep, sites)
			}
		}
		return true
	})
}

// processFunction 处理一个函数体（FuncDecl 或 FuncLit）：入口/出口/return/IO/deep。
func processFunction(fset *token.FileSet, fn string, params *ast.FieldList, body *ast.BlockStmt, pkg, fileRel string, enableDeep bool, sites *[]Site) {
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
	{
		openOffset := offsetOf(body.Lbrace)
		insertAt := openOffset + 1
		argsMap := paramCapture(params)
		code := fmt.Sprintf(`camprobe.Capture(%q, "llm-design", map[string]any{"file": %q, "level": "core", "args": map[string]any{%s}});`,
			probeName("enter"), fileRel, argsMap)
		*sites = append(*sites, Site{Kind: ProbeEnter, Level: "core", Line: lineOf(body.Lbrace), Offset: insertAt, Code: "\n" + code})
	}

	// 遍历函数体语句：return / IO / deep 由语句级处理
	walkStmts(fset, body.List, probeName, fileRel, enableDeep, offsetOf, lineOf, sites)

	// 函数体末尾出口探针（处理的 return 之外的落点，如 named-return 尾部）
	{
		closeOffset := offsetOf(body.Rbrace)
		code := fmt.Sprintf(`camprobe.Capture(%q, "llm-design", map[string]any{"file": %q, "level": "core"});`,
			probeName("exit"), fileRel)
		*sites = append(*sites, Site{Kind: ProbeExit, Level: "core", Line: lineOf(body.Rbrace), Offset: closeOffset, Code: "\n" + code})
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
func walkStmts(fset *token.FileSet, stmts []ast.Stmt, probeName func(string) string, fileRel string, enableDeep bool, offsetOf func(token.Pos) int, lineOf func(token.Pos) int, sites *[]Site) {
	for _, stmt := range stmts {
		switch s := stmt.(type) {
		case *ast.ReturnStmt:
			// return 出口（core）：在 return 前注入。取值捕获仅当无副作用。
			fields := returnCapture(s)
			code := fmt.Sprintf(`camprobe.Capture(%q, "llm-design", map[string]any{"file": %q, "level": "core", %s});`,
				probeName("exit"), fileRel, fields)
			*sites = append(*sites, Site{Kind: ProbeExit, Level: "core", Line: lineOf(s.Pos()), Offset: offsetOf(s.Pos()), Code: code + "\n"})
		case *ast.BlockStmt:
			walkStmts(fset, s.List, probeName, fileRel, enableDeep, offsetOf, lineOf, sites)
		case *ast.IfStmt:
			if s.Body != nil {
				walkStmts(fset, s.Body.List, probeName, fileRel, enableDeep, offsetOf, lineOf, sites)
			}
			if s.Else != nil {
				if el, ok := s.Else.(*ast.BlockStmt); ok {
					walkStmts(fset, el.List, probeName, fileRel, enableDeep, offsetOf, lineOf, sites)
				}
			}
		case *ast.ForStmt:
			if s.Body != nil {
				walkStmts(fset, s.Body.List, probeName, fileRel, enableDeep, offsetOf, lineOf, sites)
			}
		case *ast.RangeStmt:
			if s.Body != nil {
				walkStmts(fset, s.Body.List, probeName, fileRel, enableDeep, offsetOf, lineOf, sites)
			}
		case *ast.SwitchStmt:
			if s.Body != nil {
				walkStmts(fset, s.Body.List, probeName, fileRel, enableDeep, offsetOf, lineOf, sites)
			}
		case *ast.TypeSwitchStmt:
			if s.Body != nil {
				walkStmts(fset, s.Body.List, probeName, fileRel, enableDeep, offsetOf, lineOf, sites)
			}
		case *ast.SelectStmt:
			if s.Body != nil {
				walkStmts(fset, s.Body.List, probeName, fileRel, enableDeep, offsetOf, lineOf, sites)
			}
		case *ast.CaseClause:
			walkStmts(fset, s.Body, probeName, fileRel, enableDeep, offsetOf, lineOf, sites)
		case *ast.CommClause:
			walkStmts(fset, s.Body, probeName, fileRel, enableDeep, offsetOf, lineOf, sites)
		case *ast.DeferStmt:
			// defer/recover（event）：捕获 defer 调用中的错误场景（Op）
			if op := deferOp(s); op != "" {
				code := fmt.Sprintf(`camprobe.Capture(%q, "llm-design", map[string]any{"file": %q, "level": "event", "op": %q});`,
					probeName("defer"), fileRel, op)
				*sites = append(*sites, Site{Kind: ProbeIO, Level: "event", Line: lineOf(s.Pos()), Offset: offsetOf(s.Call.Lparen) + 1, Code: code + "\n"})
			}
		}

		// ── IO 写盘（event）：语句内含 IO 调用 → 语句后注入 ──
		if op := ioOpInStmt(stmt); op != "" {
			code := fmt.Sprintf(`camprobe.Capture(%q, "llm-design", map[string]any{"file": %q, "level": "event", "op": %q});`,
				probeName(op), fileRel, op)
			*sites = append(*sites, Site{Kind: ProbeIO, Level: "event", Line: lineOf(stmt.Pos()), Offset: offsetOf(stmt.End()), Code: code + "\n"})
		}

		// ── deep（可选）：变量赋值捕获 ──
		if enableDeep {
			if code, ok := deepCapture(stmt, probeName, fileRel); ok {
				*sites = append(*sites, Site{Kind: ProbeDeep, Level: "deep", Line: lineOf(stmt.Pos()), Offset: offsetOf(stmt.End()), Code: code + "\n"})
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
	return "ret: map[string]any{" + strings.Join(parts, ", ") + "}"
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
	files := collectGoFiles(root)
	var results []Result
	for _, f := range files {
		o := opts
		o.BackupRoot = root
		r, _ := InstrumentFile(f, o)
		results = append(results, r)
	}
	return results
}