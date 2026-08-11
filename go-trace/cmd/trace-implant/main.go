// Command trace-implant 是编译期自动插桩器。
//
// 用 go/ast 重写目标包源码，为每个函数注入探针：
//   __ttc := ttc.TraceEntry("pkg.(*Type).Method", "file.go", line, "a", a, "b", b)
//   defer ttc.TraceExitR(__ttc, "r0", r0, "r1", r1)
// 编译后运行时自动记录每个函数的调用、入参、出参和 token 成本。
//
// 用法：
//   trace-implant -dir <pkgdir> [-pkg <displayName>] [-backup] [-restore]
//   -dir     : 目标包目录（原地改写）
//   -pkg     : 限定名中的显示包名（默认取文件声明的包名）
//   -backup  : 改写前把原文件备份为 <file>.orig
//   -restore : 用 <file>.orig 恢复（幂等）
//   重复运行会跳过已插桩文件（已 import tracecap 即视为已插桩）。
package main

import (
	"bytes"
	"flag"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	ttcImportPath = "github.com/ai-base/agent-shell/internal/tracecap"
	ttcAlias      = "ttc"
	frameVar      = "__ttc"
)

func main() {
	dir := flag.String("dir", "", "target package directory (rewrite in place)")
	pkgOverride := flag.String("pkg", "", "display package name for Fn (default: file package name)")
	backup := flag.Bool("backup", false, "backup originals to <file>.orig before rewriting")
	restore := flag.Bool("restore", false, "restore originals from <file>.orig")
	flag.Parse()

	if *dir == "" {
		fmt.Fprintln(os.Stderr, "usage: trace-implant -dir <pkgdir> [-pkg name] [-backup] [-restore]")
		os.Exit(2)
	}

	if *restore {
		n, err := restoreDir(*dir)
		if err != nil {
			fmt.Fprintln(os.Stderr, "restore:", err)
			os.Exit(1)
		}
		fmt.Printf("restored %d files in %s\n", n, *dir)
		return
	}

	files, _ := filepath.Glob(filepath.Join(*dir, "*.go"))
	var instrumented, skipped int
	for _, f := range files {
		base := filepath.Base(f)
		if strings.HasSuffix(base, "_test.go") || strings.HasSuffix(base, ".orig") {
			continue
		}
		ok, err := processFile(f, *pkgOverride, *dir, *backup)
		if err != nil {
			fmt.Fprintf(os.Stderr, "  %s: %v\n", base, err)
			continue
		}
		if ok {
			instrumented++
		} else {
			skipped++
		}
	}
	fmt.Printf("done: instrumented=%d skipped=%d target=%s\n", instrumented, skipped, *dir)
}

func processFile(path, pkgOverride, dir string, backup bool) (bool, error) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
	if err != nil {
		return false, err
	}
	// 幂等：已 import tracecap 视为已插桩
	if fileImports(file, ttcImportPath) {
		return false, nil
	}
	// 跳过 tracecap 自身包
	if file.Name.Name == "tracecap" {
		return false, nil
	}

	pkgName := file.Name.Name
	if pkgOverride != "" {
		pkgName = pkgOverride
	}

	changed := false
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Body == nil {
			continue
		}
		if instrument(fset, file, pkgName, fn) {
			changed = true
		}
	}
	if !changed {
		return false, nil
	}

	addImport(file, ttcAlias, ttcImportPath)

	var buf bytes.Buffer
	if err := format.Node(&buf, fset, file); err != nil {
		return false, err
	}
	if backup {
		orig := path + ".orig"
		if _, err := os.Stat(orig); os.IsNotExist(err) {
			raw, _ := os.ReadFile(path)
			_ = os.WriteFile(orig, raw, 0o644)
		}
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		return false, err
	}
	return true, nil
}

func instrument(fset *token.FileSet, file *ast.File, pkgName string, fn *ast.FuncDecl) bool {
	line := fset.Position(fn.Pos()).Line
	fullName := qualify(fn, pkgName)

	// 入参 pairs
	var pairs []ast.Expr
	addPair := func(name string, val ast.Expr) {
		if name == "" || name == "_" {
			return
		}
		pairs = append(pairs, strLit(name), val)
	}
	if fn.Recv != nil && len(fn.Recv.List) > 0 {
		if len(fn.Recv.List[0].Names) > 0 {
			n := fn.Recv.List[0].Names[0].Name
			addPair(n, ast.NewIdent(n))
		}
	}
	if fn.Type.Params != nil {
		for _, f := range fn.Type.Params.List {
			for _, n := range f.Names {
				addPair(n.Name, ast.NewIdent(n.Name))
			}
		}
	}

	enterArgs := []ast.Expr{strLit(fullName), strLit(file.Name.Name), intLit(line)}
	enterArgs = append(enterArgs, pairs...)

	// 入参列全部为空时，TraceEntry 仍需要至少 fn/file/line 三参
	entryCall := callExpr(ttcAlias+".TraceEntry", enterArgs...)
	entryAssign := &ast.AssignStmt{
		Lhs: []ast.Expr{ast.NewIdent(frameVar)},
		Tok: token.DEFINE,
		Rhs: []ast.Expr{entryCall},
	}

	// 返回值处理：确保具名返回，重建 return + defer
	//
	// 关键：defer 必须用闭包形式 `defer func(){ ttc.TraceExitR(...) }()`，
	// 否则参数在 defer 语句执行时立即求值，冻结为初值，永远捕获不到返回值。
	// 闭包在函数返回时才执行，此时具名返回值已写入最终值。
	var deferStmt ast.Stmt
	if fn.Type.Results == nil || len(fn.Type.Results.List) == 0 {
		// void：defer __ttc.TraceExit(fid, "", nil)（参数全为常量，无需闭包）
		deferStmt = &ast.DeferStmt{Call: callExpr(ttcAlias+".TraceExit",
			ast.NewIdent(frameVar), strLit(""), ast.NewIdent("nil"))}
	} else {
		// 具名返回值分析：区分"全无名"与"已有具名"。
		// - 全无名：加 __rN 名字并改写 return 为赋值 + 裸 return，defer 捕获。
		// - 已有具名：不改写 return（避免遮蔽/作用域问题），defer 闭包直接读最终具名值。
		allUnnamed, namedNames := resultAnalysis(fn)
		var rpairs []ast.Expr
		if allUnnamed {
			resultNames := addUniqueNames(fn)
			rewriteReturns(fn.Body, resultNames)
			for _, n := range resultNames {
				rpairs = append(rpairs, strLit(n), ast.NewIdent(n))
			}
		} else {
			for _, n := range namedNames {
				rpairs = append(rpairs, strLit(n), ast.NewIdent(n))
			}
		}
		// 闭包 defer：func(){ ttc.TraceExitR(frameVar, "r0", r0, ...) }()
		call := callExpr(ttcAlias+".TraceExitR",
			append([]ast.Expr{ast.NewIdent(frameVar)}, rpairs...)...)
		funcLit := &ast.FuncLit{
			Type: &ast.FuncType{},
			Body: &ast.BlockStmt{List: []ast.Stmt{&ast.ExprStmt{X: call}}},
		}
		deferStmt = &ast.DeferStmt{Call: &ast.CallExpr{Fun: funcLit}}
	}

	fn.Body.List = append([]ast.Stmt{entryAssign, deferStmt}, fn.Body.List...)
	return true
}

// resultAnalysis 分析返回值：返回 (是否全无名, 已有具名返回值名字列表)。
func resultAnalysis(fn *ast.FuncDecl) (allUnnamed bool, namedNames []string) {
	if fn.Type.Results == nil || len(fn.Type.Results.List) == 0 {
		return true, nil
	}
	allUnnamed = true
	for _, f := range fn.Type.Results.List {
		if len(f.Names) > 0 {
			allUnnamed = false
			namedNames = append(namedNames, f.Names[0].Name)
		}
	}
	return allUnnamed, namedNames
}

// addUniqueNames 给所有无名返回值命名 __rN，返回名字列表。
// 仅应在全无名返回值时调用（保证 __rN 不会与已有具名名冲突）。
func addUniqueNames(fn *ast.FuncDecl) []string {
	var names []string
	for i, f := range fn.Type.Results.List {
		name := fmt.Sprintf("__r%d", i)
		f.Names = []*ast.Ident{ast.NewIdent(name)}
		names = append(names, name)
	}
	return names
}

// rewriteReturns 把 `return a, b` 改写为具名返回赋值 + 裸 return，便于 defer 捕获。
// 跳过嵌套 func literal 内部。
func rewriteReturns(body *ast.BlockStmt, resultNames []string) {
	var descend func(b *ast.BlockStmt)
	descend = func(b *ast.BlockStmt) {
		var newList []ast.Stmt
		for _, stmt := range b.List {
			if rs, ok := stmt.(*ast.ReturnStmt); ok && len(rs.Results) == len(resultNames) && len(resultNames) > 0 {
				for i, res := range rs.Results {
					newList = append(newList, &ast.AssignStmt{
						Lhs: []ast.Expr{ast.NewIdent(resultNames[i])},
						Tok: token.ASSIGN,
						Rhs: []ast.Expr{res},
					})
				}
				newList = append(newList, &ast.ReturnStmt{})
				continue
			}
			newList = append(newList, stmt)
		}
		b.List = newList
		for _, stmt := range b.List {
			ast.Inspect(stmt, func(x ast.Node) bool {
				switch t := x.(type) {
				case *ast.FuncLit:
					return false
				case *ast.BlockStmt:
					descend(t)
				}
				return true
			})
		}
	}
	descend(body)
}

func qualify(fn *ast.FuncDecl, pkgName string) string {
	if fn.Recv != nil && len(fn.Recv.List) > 0 {
		rs := exprString(fn.Recv.List[0].Type)
		if strings.HasPrefix(rs, "*") {
			rs = "(" + rs + ")"
		}
		return pkgName + "." + rs + "." + fn.Name.Name
	}
	return pkgName + "." + fn.Name.Name
}

func exprString(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.StarExpr:
		return "*" + exprString(t.X)
	case *ast.IndexExpr:
		return exprString(t.X) + "[" + exprString(t.Index) + "]"
	default:
		return fmt.Sprintf("%v", e)
	}
}

func callExpr(sel string, args ...ast.Expr) *ast.CallExpr {
	parts := strings.Split(sel, ".")
	var fun ast.Expr = ast.NewIdent(parts[0])
	for _, p := range parts[1:] {
		fun = &ast.SelectorExpr{X: fun, Sel: ast.NewIdent(p)}
	}
	return &ast.CallExpr{Fun: fun, Args: args}
}

func strLit(s string) *ast.BasicLit {
	return &ast.BasicLit{Kind: token.STRING, Value: strconv.Quote(s)}
}

func intLit(i int) *ast.BasicLit {
	return &ast.BasicLit{Kind: token.INT, Value: strconv.Itoa(i)}
}

func addImport(file *ast.File, alias, path string) {
	decl := &ast.GenDecl{
		Tok:   token.IMPORT,
		Specs: []ast.Spec{&ast.ImportSpec{Name: ast.NewIdent(alias), Path: strLit(path)}},
	}
	if len(file.Decls) == 0 {
		file.Decls = []ast.Decl{decl}
		return
	}
	idx := 0
	for i, d := range file.Decls {
		if gd, ok := d.(*ast.GenDecl); ok && gd.Tok == token.IMPORT {
			idx = i + 1
		}
	}
	file.Decls = append(file.Decls[:idx], append([]ast.Decl{decl}, file.Decls[idx:]...)...)
}

func fileImports(f *ast.File, path string) bool {
	for _, imp := range f.Imports {
		if strings.Trim(imp.Path.Value, `"`) == path {
			return true
		}
	}
	return false
}

func restoreDir(dir string) (int, error) {
	files, _ := filepath.Glob(filepath.Join(dir, "*.orig"))
	n := 0
	for _, orig := range files {
		target := strings.TrimSuffix(orig, ".orig")
		raw, err := os.ReadFile(orig)
		if err != nil {
			return n, err
		}
		if err := os.WriteFile(target, raw, 0o644); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}