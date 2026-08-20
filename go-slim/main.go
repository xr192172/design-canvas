// go-slim —— 积木瘦身剪刀（Brick Harvest Phase 6）
//
// 用户思路原话："效仿 Go 编译器——它只编译那些，我们也只读取那些，重新连成新文件。"
// dead_deps（TS 侧）是编译器的"眼睛"：linker 可达性剪枝的源码级复刻，产出 live 集；
// 本工具是"手"：用编译器自己的 go/ast + go/printer，按 live 集重写源文件。
//
// 输入（stdin，JSON）：
//   { "root": 积木 files/ 目录, "out_root": 输出目录, "types": [活类型名全集],
//     "files": [{ "path": 相对路径, "keep": [活符号名] }] }
//
// 保守规则（宁多少剪不少剪——错杀由 slim_brick 的编译验证兜底回捞）：
//   1. 根 = keep 名单（索引可达性 BFS 的 live 集）+ init() + 包级 var（初始化
//      副作用，linker 语义：import 即执行）+ 活类型的全部方法（接口满足/反射盲区，
//      与 dead_deps 的方法挂靠规则同构）
//   2. 包内不动点：kept 声明源码文本中出现的同包顶层名逐轮激活——索引漏边不出血
//   3. iota const 块整体保留（删中间项会使后续值移位）
//   4. import 按实际引用剪枝（限定符候选集——/v4 版本后缀取前段，与 TS 侧
//      dead_deps 同规则）；`_` 空导入（副作用）与 `.` 点导入恒留
//   5. 解析/打印失败的文件原样拷贝（不丢代码）
//
// 输出（stdout，JSON）：逐文件报告（存活/丢弃声明与 import 明细、整文件剔除标记）。
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/printer"
	"go/token"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type fileSpec struct {
	Path string   `json:"path"`
	Keep []string `json:"keep"`
}

type slimInput struct {
	Root    string     `json:"root"`
	OutRoot string     `json:"out_root"`
	Types   []string   `json:"types"`
	Files   []fileSpec `json:"files"`
}

type fileReport struct {
	Path           string   `json:"path"`
	Dropped        bool     `json:"dropped"`
	KeptDecls      []string `json:"kept_decls"`
	DroppedDecls   []string `json:"dropped_decls"`
	KeptImports    []string `json:"kept_imports"`
	DroppedImports []string `json:"dropped_imports"`
}

type slimReport struct {
	Files  []fileReport `json:"files"`
	Errors []string     `json:"errors,omitempty"`
}

type parsedFile struct {
	spec fileSpec
	fset *token.FileSet
	file *ast.File
	keep map[string]bool
}

// unit：过滤粒度单元（func = 整个声明；type/var/const = GenDecl 内单个 spec）
type unit struct {
	pf       *parsedFile
	name     string // 展示名（方法 "T.M"；var/const 多名逗号连接）
	bare     []string // 裸名列表（keep 名单匹配用）
	isType   bool
	isVar    bool
	isInit   bool
	usesIota bool
	recvType string
	gd       *ast.GenDecl // type/var/const 声明块（func 时 nil）
	spec     ast.Spec     // 块内 spec（func 时 nil）
	fd       *ast.FuncDecl
	text     string // 打印后的源码文本（包内不动点的名字扫描基准）
}

func main() {
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		fatal(err)
	}
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF}) // UTF-8 BOM（PowerShell 管道常见）
	var in slimInput
	if err := json.Unmarshal(data, &in); err != nil {
		fatal(err)
	}
	if in.Root == "" || in.OutRoot == "" {
		fatal(fmt.Errorf("root / out_root 不能为空"))
	}

	liveTypes := map[string]bool{}
	for _, t := range in.Types {
		liveTypes[t] = true
	}

	rep := slimReport{}
	var pfs []*parsedFile
	for _, spec := range in.Files {
		src, err := os.ReadFile(filepath.Join(in.Root, filepath.FromSlash(spec.Path)))
		if err != nil {
			rep.Errors = append(rep.Errors, fmt.Sprintf("%s: 读取失败: %v", spec.Path, err))
			continue
		}
		fset := token.NewFileSet()
		f, err := parser.ParseFile(fset, spec.Path, src, parser.ParseComments)
		if err != nil {
			copyRaw(&in, spec.Path)
			rep.Errors = append(rep.Errors, fmt.Sprintf("%s: 解析失败，原样保留: %v", spec.Path, err))
			continue
		}
		keep := map[string]bool{}
		for _, k := range spec.Keep {
			keep[k] = true
		}
		pfs = append(pfs, &parsedFile{spec: spec, fset: fset, file: f, keep: keep})
	}

	// 按包（目录）分组做不动点
	byDir := map[string][]*parsedFile{}
	for _, pf := range pfs {
		dir := filepath.ToSlash(filepath.Dir(pf.spec.Path))
		byDir[dir] = append(byDir[dir], pf)
	}
	dirs := make([]string, 0, len(byDir))
	for d := range byDir {
		dirs = append(dirs, d)
	}
	sort.Strings(dirs)
	for _, dir := range dirs {
		rep.Files = append(rep.Files, slimPackage(&in, byDir[dir], liveTypes)...)
	}

	out, err := json.MarshalIndent(rep, "", "  ")
	if err != nil {
		fatal(err)
	}
	fmt.Println(string(out))
}

func slimPackage(in *slimInput, pfs []*parsedFile, liveTypes map[string]bool) []fileReport {
	// ── 收集声明单元 ──
	var units []*unit
	names := map[string][]*unit{}   // 包内顶层裸名 → units
	methods := map[string][]*unit{} // 接收者类型名 → 方法 units
	unitByFunc := map[*ast.FuncDecl]*unit{}
	unitBySpec := map[ast.Spec]*unit{}
	for _, pf := range pfs {
		for _, d := range pf.file.Decls {
			switch decl := d.(type) {
			case *ast.FuncDecl:
				u := &unit{pf: pf, fd: decl}
				u.name = decl.Name.Name
				u.bare = []string{decl.Name.Name}
				if decl.Recv != nil {
					u.recvType = recvTypeName(decl.Recv)
					u.name = u.recvType + "." + decl.Name.Name
				}
				u.isInit = decl.Recv == nil && decl.Name.Name == "init"
				u.text = printNode(pf.fset, decl)
				units = append(units, u)
				unitByFunc[decl] = u
				if u.recvType != "" {
					methods[u.recvType] = append(methods[u.recvType], u)
				} else {
					names[u.name] = append(names[u.name], u)
				}
			case *ast.GenDecl:
				if decl.Tok == token.IMPORT {
					continue // import 单独剪枝
				}
				for _, s := range decl.Specs {
					u := &unit{pf: pf, gd: decl, spec: s}
					switch sp := s.(type) {
					case *ast.TypeSpec:
						u.isType = true
						u.name = sp.Name.Name
						u.bare = []string{sp.Name.Name}
					case *ast.ValueSpec:
						var ns []string
						for _, n := range sp.Names {
							ns = append(ns, n.Name)
						}
						u.name = strings.Join(ns, ",")
						u.bare = ns
						if decl.Tok == token.VAR {
							u.isVar = true
						}
					}
					u.text = printNode(pf.fset, s)
					if decl.Tok == token.CONST && containsIota(u.text) {
						u.usesIota = true
					}
					units = append(units, u)
					unitBySpec[s] = u
					for _, n := range u.bare {
						names[n] = append(names[n], u)
					}
				}
			}
		}
	}

	// ── 根集合 ──
	// keep 名单（索引 live 集）+ init() + 包级 var + 活类型的全部方法
	kept := map[*unit]bool{}
	var queue []*unit
	enqueue := func(u *unit) {
		if u != nil && !kept[u] {
			kept[u] = true
			queue = append(queue, u)
		}
	}
	for _, u := range units {
		keepHit := false
		for _, n := range u.bare {
			if u.pf.keep[n] {
				keepHit = true
				break
			}
		}
		if u.fd != nil {
			if u.recvType != "" {
				if liveTypes[u.recvType] || keepHit {
					enqueue(u)
				}
			} else if u.isInit || keepHit {
				enqueue(u)
			}
			continue
		}
		if u.isVar || keepHit || (u.isType && liveTypes[u.name]) {
			enqueue(u)
		}
	}

	// ── 包内不动点（编译器语义的兜底：索引漏边不出血） ──
	for len(queue) > 0 {
		u := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		if u.isType {
			for _, m := range methods[u.name] {
				enqueue(m)
			}
		}
		for _, id := range identifiers(u.text) {
			for _, v := range names[id] {
				enqueue(v)
			}
		}
		if u.usesIota {
			for _, sib := range units {
				if sib.gd != nil && sib.gd == u.gd {
					enqueue(sib)
				}
			}
		}
	}

	// ── 逐文件重写 ──
	var reports []fileReport
	for _, pf := range pfs {
		// 空数组初始化：nil slice 会被 JSON 编成 null，消费端按数组处理会炸
		fr := fileReport{Path: pf.spec.Path, KeptDecls: []string{}, DroppedDecls: []string{}, KeptImports: []string{}, DroppedImports: []string{}}
		var fileUnits []*unit
		for _, u := range units {
			if u.pf == pf {
				fileUnits = append(fileUnits, u)
			}
		}

		// kept 正文（import 剪枝判定基准：只认声明体文本，注释不算数）
		var body bytes.Buffer
		for _, u := range fileUnits {
			if kept[u] {
				body.WriteString(u.text)
				body.WriteByte('\n')
			}
		}
		bodyText := body.String()

		// import 收集与剪枝（`_`/`.` 恒留：副作用/无法归属）
		type imp struct {
			spec  *ast.ImportSpec
			path  string
			cands []string // 候选限定符（alias 唯一；无 alias 按路径派生）
		}
		var imps []imp
		for _, d := range pf.file.Decls {
			gd, ok := d.(*ast.GenDecl)
			if !ok || gd.Tok != token.IMPORT {
				continue
			}
			for _, s := range gd.Specs {
				is, ok := s.(*ast.ImportSpec)
				if !ok {
					continue
				}
				p := strings.Trim(is.Path.Value, `"`)
				var cands []string
				if is.Name != nil {
					cands = []string{is.Name.Name}
				} else {
					cands = importPathCandidates(p)
				}
				imps = append(imps, imp{spec: is, path: p, cands: cands})
			}
		}
		var keptImports []*ast.ImportSpec
		for _, im := range imps {
			keep := false
			for _, c := range im.cands {
				if c == "_" || c == "." || usesQualifier(bodyText, c) {
					keep = true
					break
				}
			}
			if keep {
				keptImports = append(keptImports, im.spec)
				fr.KeptImports = append(fr.KeptImports, im.path)
			} else {
				fr.DroppedImports = append(fr.DroppedImports, im.path)
			}
		}

		// 报告声明明细
		for _, u := range fileUnits {
			if kept[u] {
				fr.KeptDecls = append(fr.KeptDecls, u.name)
			} else {
				fr.DroppedDecls = append(fr.DroppedDecls, u.name)
			}
		}

		// 全空文件（无存活声明且无副作用导入）→ 整文件剔除
		hasBody := false
		for _, u := range fileUnits {
			if kept[u] {
				hasBody = true
				break
			}
		}
		sideEffectImport := false
		for _, s := range keptImports {
			if s.Name != nil && (s.Name.Name == "_" || s.Name.Name == ".") {
				sideEffectImport = true
				break
			}
		}
		if !hasBody && !sideEffectImport {
			fr.Dropped = true
			reports = append(reports, fr)
			continue
		}

		// 重建 decls：合并后的 import 块 + 按 spec 过滤的 GenDecl + kept funcs
		var newDecls []ast.Decl
		if len(keptImports) > 0 {
			igd := &ast.GenDecl{Tok: token.IMPORT, Lparen: 1, Rparen: 1}
			igd.TokPos = keptImports[0].Pos()
			igd.Specs = make([]ast.Spec, 0, len(keptImports))
			for _, s := range keptImports {
				igd.Specs = append(igd.Specs, s)
			}
			newDecls = append(newDecls, igd)
		}
		for _, d := range pf.file.Decls {
			switch decl := d.(type) {
			case *ast.FuncDecl:
				if u := unitByFunc[decl]; u != nil && kept[u] {
					newDecls = append(newDecls, decl)
				}
			case *ast.GenDecl:
				if decl.Tok == token.IMPORT {
					continue
				}
				var specs []ast.Spec
				for _, s := range decl.Specs {
					if u := unitBySpec[s]; u != nil && kept[u] {
						specs = append(specs, s)
					}
				}
				if len(specs) == 0 {
					continue
				}
				// TokPos 必须带原始位置：缺省 NoPos 时 printer 无法定位关键字，
				// doc 注释会被冲刷到 `const`/`type` 与声明名之间（曾产出
				// `const\n\n// 注释\nDiffContextLines = 3` 的畸形排版）
				nd := &ast.GenDecl{Tok: decl.Tok, TokPos: decl.TokPos, Doc: decl.Doc, Specs: specs}
				if decl.Lparen.IsValid() {
					nd.Lparen = decl.Lparen
					nd.Rparen = decl.Rparen
				}
				newDecls = append(newDecls, nd)
			}
		}

		// 注释过滤：丢弃声明的注释不残留（文件头/kept 声明的 doc/行内/行尾注释保留）
		pf.file.Comments = filterComments(pf, newDecls)

		pf.file.Decls = newDecls
		out, fmtErr := formatFile(pf.fset, pf.file)
		if fmtErr != nil {
			copyRaw(in, pf.spec.Path)
			reports = append(reports, fileReport{Path: pf.spec.Path, KeptDecls: fr.KeptDecls, DroppedDecls: fr.DroppedDecls, KeptImports: fr.KeptImports, DroppedImports: fr.DroppedImports})
			continue
		}
		dest := filepath.Join(in.OutRoot, filepath.FromSlash(pf.spec.Path))
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			fatal(err)
		}
		if err := os.WriteFile(dest, out, 0o644); err != nil {
			fatal(err)
		}
		reports = append(reports, fr)
	}
	return reports
}

// filterComments：只保留与存活声明相关的注释（文档/行内/行尾）与文件头注释。
// 丢弃声明的 doc 注释若残留会成为漂浮注释——编译无碍但严重妨碍可读性（瘦身的目的之一）。
func filterComments(pf *parsedFile, newDecls []ast.Decl) []*ast.CommentGroup {
	pkgLine := pf.fset.Position(pf.file.Package).Line
	type span struct{ start, end int }
	spans := make([]span, 0, len(newDecls))
	for _, d := range newDecls {
		spans = append(spans, span{pf.fset.Position(d.Pos()).Line, pf.fset.Position(d.End()).Line})
	}
	var keptComments []*ast.CommentGroup
	for _, cg := range pf.file.Comments {
		startLine := pf.fset.Position(cg.Pos()).Line
		endLine := pf.fset.Position(cg.End()).Line
		keep := startLine < pkgLine // 文件头（build tag 等）
		for _, s := range spans {
			// doc：按 endLine 判定（多行 doc 整组以最后一行为准），紧贴上方
			// 或隔 1 空行都算——按 startLine 判会误删多行 doc（曾只保单行）
			if endLine < s.start && s.start-endLine <= 2 {
				keep = true
				break
			}
			if startLine >= s.start && endLine <= s.end { // 行内
				keep = true
				break
			}
			if startLine == s.end { // 行尾
				keep = true
				break
			}
		}
		if keep {
			keptComments = append(keptComments, cg)
		}
	}
	return keptComments
}

func copyRaw(in *slimInput, rel string) {
	src := filepath.Join(in.Root, filepath.FromSlash(rel))
	dst := filepath.Join(in.OutRoot, filepath.FromSlash(rel))
	data, err := os.ReadFile(src)
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return
	}
	_ = os.WriteFile(dst, data, 0o644)
}

func printNode(fset *token.FileSet, n ast.Node) string {
	var b bytes.Buffer
	if err := printer.Fprint(&b, fset, n); err != nil {
		return ""
	}
	return b.String()
}

// formatFile：gofmt 同款规范化输出（format.Node 对非法 AST 会 panic，recover 后回退原样拷贝）
func formatFile(fset *token.FileSet, f *ast.File) (out []byte, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("format.Node panic: %v", r)
		}
	}()
	var b bytes.Buffer
	if err := format.Node(&b, fset, f); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

// recvTypeName：方法接收者类型裸名（穿透 * / 泛型参数 / 括号）
func recvTypeName(recv *ast.FieldList) string {
	if recv == nil || len(recv.List) == 0 {
		return ""
	}
	t := recv.List[0].Type
	for {
		switch x := t.(type) {
		case *ast.StarExpr:
			t = x.X
		case *ast.IndexExpr:
			t = x.X
		case *ast.IndexListExpr:
			t = x.X
		case *ast.ParenExpr:
			t = x.X
		case *ast.SelectorExpr:
			return x.Sel.Name
		case *ast.Ident:
			return x.Name
		default:
			return ""
		}
	}
}

func containsIota(text string) bool { return strings.Contains(text, "iota") }

// identifiers：文本中的标识符（粗扫——命中面宁大勿小，多激活只是少剪）
func identifiers(text string) []string {
	var out []string
	i := 0
	for i < len(text) {
		if isIdentByte(text[i]) {
			j := i
			for j < len(text) && isIdentByte(text[j]) {
				j++
			}
			out = append(out, text[i:j])
			i = j
		} else {
			i++
		}
	}
	return out
}

// usesQualifier：正文中是否以限定符形态使用（`name.`，前一字节非标识符字符）
func usesQualifier(body, name string) bool {
	target := name + "."
	for i := 0; i < len(body); {
		j := strings.Index(body[i:], target)
		if j < 0 {
			return false
		}
		k := i + j
		if k == 0 || !isIdentByte(body[k-1]) {
			return true
		}
		i = k + 1
	}
	return false
}

// importPathCandidates：无 alias 时 import 路径的候选限定符（与 TS 侧
// dead_deps.goImportQualifierCandidates 同规则）。Go 生态惯例：
//   - 末段为默认候选；
//   - 主版本后缀段（v2/v3/v4…）不是包名——github.com/bmatcuk/doublestar/v4
//     的包名是 doublestar，补上一段（曾因只认末段 v4 找 `v4.` 永不命中，
//     活 import 被误剪 → 编译报 undefined: doublestar）；
//   - gopkg.in 风格末段 yaml.v2 → yaml；
//   - 连字符段（tiktoken-go）：包名不能含 `-`，补切分 token。
//
// 命中任一候选即保留——宁多留：错留由编译验证（imported and not used）
// 兜底，错剪是 undefined，前者代价小。
func importPathCandidates(p string) []string {
	segs := strings.Split(p, "/")
	last := segs[len(segs)-1]
	seen := map[string]bool{}
	var out []string
	add := func(s string) {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	add(last)
	if len(segs) >= 2 && isVersionSeg(last) {
		add(segs[len(segs)-2])
	}
	if i := strings.Index(last, "."); i > 0 {
		add(last[:i])
	}
	if strings.Contains(last, "-") {
		for _, t := range strings.Split(last, "-") {
			add(t)
		}
	}
	return out
}

// isVersionSeg：主版本后缀段（v2/v3/v4…——纯 v + 数字）
func isVersionSeg(s string) bool {
	if len(s) < 2 || s[0] != 'v' {
		return false
	}
	for _, c := range s[1:] {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func isIdentByte(b byte) bool {
	return b == '_' || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9')
}

func fatal(err error) {
	fmt.Fprintf(os.Stderr, "go-slim: %v\n", err)
	os.Exit(1)
}
