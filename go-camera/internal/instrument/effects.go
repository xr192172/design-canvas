// effects.go — effect 级探针（Brick Harvest Phase 2c：动静对账的"动"半边）。
//
// 与 deep 级的区别：deep 捕获所有单标识符赋值（局部变量为主，量大噪音高）；
// effect 只盯"积木契约"关心的外部作用点，Capture 带 kind/target/op 结构化字段，
// 与 design-canvas 侧 extract_contracts 静态候选（origin='ast'）同构对账：
//
//	writes : 包级 var 赋值/自增        kind="write"  target=变量名（含 .字段/[下标] 归一）
//	holds  : net.Listen / sql.Open /    kind="hold"   target=listen:addr / db-pool:driver /
//	         time.NewTicker / go 语句                ticker / goroutine
//	emits  : ch <- v（chan send）      kind="emit"   target=chan:通道表达式名
//
// 不捕获值：对账只需 target 事实，值捕获有副作用风险（急切求值陷阱，见
// blockingReturnCapture 的教训），留给 exit/enter 探针。
package instrument

import (
	"go/ast"
	"go/token"
	"strconv"
)

// importsProbePkg 检查文件是否已 import 探针包（任意别名/裸）。
// 已 import 时跳过 import 注入，避免 "camprobe redeclared" 编译错
// （自初始化 sink 的 main.go 场景）。约定：自引须用 camprobe 别名。
func importsProbePkg(f *ast.File, probeImport string) bool {
	for _, imp := range f.Imports {
		if imp.Path != nil && imp.Path.Value == strconv.Quote(probeImport) {
			return true
		}
	}
	return false
}

// collectPkgVars 收集文件级（包级）var 声明的变量名。
// 赋值目标只有它们才算"写外部状态"——局部变量写不是积木的 effect。
func collectPkgVars(f *ast.File) map[string]bool {
	out := map[string]bool{}
	for _, d := range f.Decls {
		gd, ok := d.(*ast.GenDecl)
		if !ok || gd.Tok != token.VAR {
			continue
		}
		for _, spec := range gd.Specs {
			vs, ok := spec.(*ast.ValueSpec)
			if !ok {
				continue
			}
			for _, name := range vs.Names {
				if name.Name != "_" && name.Name != "" {
					out[name.Name] = true
				}
			}
		}
	}
	return out
}

// EffectHit 是一条语句里检测到的 effect 候选（插桩点）。
type EffectHit struct {
	Kind   string // write | hold | emit
	Target string // 与 design-canvas 契约 target 同构
	Op     string // write | append | acquire | release | emit
}

// effectInStmt 检测一条语句的 effect 点（每语句至多取第一个命中——
// 一条语句多个 effect 的场景罕见，语句可拆；对账按 target 计数不按探针数）。
func effectInStmt(stmt ast.Stmt, pkgVars map[string]bool) (EffectHit, bool) {
	switch s := stmt.(type) {
	case *ast.AssignStmt:
		if len(s.Lhs) == 0 {
			break
		}
		if t, ok := effectTargetOfLHS(s.Lhs[0], pkgVars); ok {
			op := "write"
			if s.Tok == token.ADD_ASSIGN {
				op = "append"
			}
			return EffectHit{Kind: "write", Target: t, Op: op}, true
		}
	case *ast.IncDecStmt:
		if t, ok := effectTargetOfLHS(s.X, pkgVars); ok {
			return EffectHit{Kind: "write", Target: t, Op: "write"}, true
		}
	case *ast.SendStmt:
		if t := chanTargetName(s.Chan); t != "" {
			return EffectHit{Kind: "emit", Target: "chan:" + t, Op: "emit"}, true
		}
	case *ast.GoStmt:
		return EffectHit{Kind: "hold", Target: "goroutine", Op: "acquire"}, true
	}

	// 调用型 hold：语句树内含 net.Listen / sql.Open / time.NewTicker / time.NewTimer。
	// 遍历整个语句（调用可出现在赋值 RHS / if 条件 / 表达式语句等位置）。
	if h, ok := holdCallInStmt(stmt); ok {
		return h, true
	}
	return EffectHit{}, false
}

// effectTargetOfLHS 判断赋值目标是否包级变量（或其字段/下标），返回归一 target。
// 归一规则与 design-canvas extract_contracts.scanVarWrites 一致：
// name / name.field.sub / name[]（下标归一为 []）。
func effectTargetOfLHS(e ast.Expr, pkgVars map[string]bool) (string, bool) {
	switch t := e.(type) {
	case *ast.Ident:
		if pkgVars[t.Name] {
			return t.Name, true
		}
	case *ast.SelectorExpr:
		if base, ok := effectTargetOfLHS(t.X, pkgVars); ok {
			return base + "." + t.Sel.Name, true
		}
	case *ast.IndexExpr:
		if base, ok := effectTargetOfLHS(t.X, pkgVars); ok {
			return base + "[]", true
		}
	}
	return "", false
}

// chanTargetName 提取 chan 表达式的名字（Ident 或 a.b 选择链）。
func chanTargetName(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.SelectorExpr:
		if base := chanTargetName(t.X); base != "" {
			return base + "." + t.Sel.Name
		}
	}
	return ""
}

// holdOps 包级资源获取调用 → target 前缀（选择器名匹配，宽松——
// 静态候选侧同名匹配，误报在对账时自然证伪）。
var holdSelectors = map[string]func(c *ast.CallExpr) (EffectHit, bool){
	"Listen": func(c *ast.CallExpr) (EffectHit, bool) {
		return EffectHit{Kind: "hold", Target: "listen", Op: "acquire"}, true
	},
	"ListenAndServe": func(c *ast.CallExpr) (EffectHit, bool) {
		return EffectHit{Kind: "hold", Target: "listen", Op: "acquire"}, true
	},
	"Open": func(c *ast.CallExpr) (EffectHit, bool) {
		// sql.Open(driver, ...) → db-pool；其他 Open（os.Open 等文件句柄）→ file 句柄
		if sel, ok := c.Fun.(*ast.SelectorExpr); ok {
			if pkg, ok2 := sel.X.(*ast.Ident); ok2 && pkg.Name == "sql" {
				return EffectHit{Kind: "hold", Target: "db-pool", Op: "acquire"}, true
			}
		}
		return EffectHit{Kind: "hold", Target: "file-handle", Op: "acquire"}, true
	},
	"NewTicker": func(c *ast.CallExpr) (EffectHit, bool) {
		return EffectHit{Kind: "hold", Target: "ticker", Op: "acquire"}, true
	},
	"NewTimer": func(c *ast.CallExpr) (EffectHit, bool) {
		return EffectHit{Kind: "hold", Target: "ticker", Op: "acquire"}, true
	},
}

// holdCallInStmt 在语句树内找资源获取调用。
func holdCallInStmt(stmt ast.Stmt) (EffectHit, bool) {
	var hit *EffectHit
	ast.Inspect(stmt, func(n ast.Node) bool {
		if hit != nil {
			return false
		}
		c, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := c.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		if mk, found := holdSelectors[sel.Sel.Name]; found {
			if h, ok := mk(c); ok {
				hit = &h
				return false
			}
		}
		return true
	})
	if hit != nil {
		return *hit, true
	}
	return EffectHit{}, false
}
