package instrument

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 构造一个临时 Go 项目目录，含一个待插桩文件。
func makeFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	src := `package demo

import "os"

func Save(name string) error {
	data := []byte(name)
	err := os.WriteFile("/tmp/x", data, 0644)
	if err != nil {
		return err
	}
	return nil
}

func MkdirAll() {
	os.MkdirAll("/tmp/d", 0755)
}
`
	if err := os.MkdirAll(filepath.Join(dir, "svc"), 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "svc", "save.go")
	if err := os.WriteFile(file, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func readFile(t *testing.T, dir, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, rel))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestInstrumentFile_EnterExitIO(t *testing.T) {
	dir := makeFixture(t)
	file := filepath.Join(dir, "svc", "save.go")
	res, err := InstrumentFile(file, Options{Write: true, BackupRoot: dir})
	if err != nil {
		t.Fatalf("InstrumentFile: %v", err)
	}

	// Save: enter + exit(return err) + exit(return nil tail) + io(writefile) + deep关闭不注入
	// MkdirAll: enter + exit(tail) + io(mkdirall)
	if len(res.Sites) < 6 {
		t.Fatalf("期望 ≥6 探针点，实得 %d", len(res.Sites))
	}

	content := readFile(t, dir, "svc/save.go")
	if !strings.Contains(content, "observe:instrumented") {
		t.Error("缺少幂等标记 observe:instrumented")
	}
	if !strings.Contains(content, "camprobe.Capture") {
		t.Errorf("缺少 camprobe.Capture 探针注入")
	}
	if !strings.Contains(content, `"level": "core"`) {
		t.Errorf("缺少 core 级标签")
	}
	if !strings.Contains(content, `"level": "event"`) {
		t.Errorf("缺少 event 级标签")
	}
	if !strings.Contains(content, "demo.Save.enter") {
		t.Errorf("缺少 Save 入口探针")
	}
	if !strings.Contains(content, "demo.Save.exit") {
		t.Errorf("缺少 Save 出口探针")
	}
	if !strings.Contains(content, "demo.MkdirAll.mkdirall") {
		t.Errorf("缺少 MkdirAll 的 IO 探针")
	}
}

// TestBlockingReturnSingleRecv 回归 graph_writer.SubmitSync 死锁：
// return <-ch 的返回值曾被内联进 Capture 参数 map（"ret": <-ch），
// 第二次 return <-ch 永久阻塞。修复后应改写为临时变量单次求值：
//
//	__camRetN_0 := <-ch
//	camprobe.Capture(..., "ret": map[string]any{"0": __camRetN_0})
//	return __camRetN_0
func TestBlockingReturnSingleRecv(t *testing.T) {
	dir := t.TempDir()
	src := `package demo

func WaitReply(ch chan error) error {
	return <-ch
}

func WaitTwo(ch chan int, ok chan bool) (int, bool) {
	return <-ch, <-ok
}
`
	if err := os.MkdirAll(filepath.Join(dir, "svc"), 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "svc", "recv.go")
	if err := os.WriteFile(file, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := InstrumentFile(file, Options{Write: true, BackupRoot: dir})
	if err != nil {
		t.Fatalf("InstrumentFile: %v", err)
	}
	content := readFile(t, dir, "svc/recv.go")

	// 1. 临时变量路径生效
	if !strings.Contains(content, "__camRet") {
		t.Fatalf("含 <-ch 的 return 应走临时变量路径，实际输出:\n%s", content)
	}
	// 2. 无副作用 return（无 <-ch）不受影响，保持内联（第二个函数全阻塞、
	//    但整体应仍然生成两个 exit 探针）
	exitCount := strings.Count(content, ".exit")
	if exitCount < 2 {
		t.Fatalf("应有 ≥2 个 exit 探针，实际 %d:\n%s", exitCount, content)
	}

	// 3. 语义硬断言：解析生成代码，每个函数体中 <-ch（ARROW）只出现一次
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, file, nil, 0)
	if err != nil {
		t.Fatalf("生成代码不可解析（语法错误）: %v\n%s", err, content)
	}
	arrowCount := 0
	ast.Inspect(f, func(n ast.Node) bool {
		if u, ok := n.(*ast.UnaryExpr); ok && u.Op.String() == "<-" {
			arrowCount++
		}
		return true
	})
	// 源码 3 处（WaitReply 1 + WaitTwo 2），生成的临时变量声明各求值一次，
	// 不应有任何第二次求值 → 仍应恰为 3。
	if arrowCount != 3 {
		t.Fatalf("生成代码含 %d 处 <-（应为 3，多了即双次求值）:\n%s", arrowCount, content)
	}

	// 4. 生成代码中不再有内联进 Capture 的接收表达式
	if strings.Contains(content, `"0": <-`) || strings.Contains(content, `"1": <-`) {
		t.Fatalf("Capture 参数 map 不得内联 <-ch（双次求值死锁）:\n%s", content)
	}
	_ = res
}

func TestIdempotent(t *testing.T) {
	dir := makeFixture(t)
	file := filepath.Join(dir, "svc", "save.go")
	opts := Options{Write: true, BackupRoot: dir}
	if _, err := InstrumentFile(file, opts); err != nil {
		t.Fatal(err)
	}
	before := readFile(t, dir, "svc/save.go")
	// 二次插桩（不启 deep）应跳过
	res, err := InstrumentFile(file, opts)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Sites) != 0 {
		t.Fatalf("二次插桩应跳过，实得 %d 探针点", len(res.Sites))
	}
	after := readFile(t, dir, "svc/save.go")
	if before != after {
		t.Error("二次插桩不应改写文件")
	}
}

func TestDeepCapture(t *testing.T) {
	dir := makeFixture(t)
	file := filepath.Join(dir, "svc", "save.go")
	res, err := InstrumentFile(file, Options{Write: true, BackupRoot: dir, EnableDeep: true})
	if err != nil {
		t.Fatal(err)
	}
	var deep int
	for _, s := range res.Sites {
		if s.Level == "deep" {
			deep++
		}
	}
	if deep == 0 {
		t.Error("enableDeep=true 应捕获变量赋值（data := []byte(name)）")
	}
	content := readFile(t, dir, "svc/save.go")
	if !strings.Contains(content, "observe:deep") {
		t.Errorf("缺少 deep 幂等标记")
	}
	if !strings.Contains(content, `"level": "deep"`) {
		t.Errorf("缺少 deep 级标签")
	}
}

func TestCollectGoFilesSkips(t *testing.T) {
	dir := makeFixture(t)
	// 添加应被跳过的目录
	os.MkdirAll(filepath.Join(dir, "node_modules"), 0o755)
	os.WriteFile(filepath.Join(dir, "node_modules", "x.go"), []byte("package x\n"), 0o644)
	os.MkdirAll(filepath.Join(dir, ".design-canvas"), 0o755)
	os.WriteFile(filepath.Join(dir, ".design-canvas", "y.go"), []byte("package y\n"), 0o644)
	// _test.go 也应跳过
	os.WriteFile(filepath.Join(dir, "svc", "save_test.go"), []byte("package demo\n"), 0o644)

	files := collectGoFiles(dir, nil)
	for _, f := range files {
		if strings.Contains(f, "node_modules") || strings.Contains(f, ".design-canvas") ||
			strings.HasSuffix(f, "_test.go") {
			t.Errorf("不应收集被跳过文件: %s", f)
		}
	}
	if len(files) == 0 {
		t.Error("应收集到至少一个 .go 文件")
	}
}

func TestDryRunNoWrite(t *testing.T) {
	dir := makeFixture(t)
	file := filepath.Join(dir, "svc", "save.go")
	before := readFile(t, dir, "svc/save.go")
	res, err := InstrumentFile(file, Options{Write: false, BackupRoot: dir})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Sites) == 0 {
		t.Error("dry-run 也应报告探针点")
	}
	after := readFile(t, dir, "svc/save.go")
	if before != after {
		t.Error("dry-run 不应改写文件")
	}
}

func TestRestoreInstrumented(t *testing.T) {
	dir := makeFixture(t)
	file := filepath.Join(dir, "svc", "save.go")
	orig := readFile(t, dir, "svc/save.go")
	if _, err := InstrumentFile(file, Options{Write: true, BackupRoot: dir}); err != nil {
		t.Fatal(err)
	}
	if readFile(t, dir, "svc/save.go") == orig {
		t.Fatal("插桩后文件应已改写")
	}
	restored := RestoreInstrumented(dir)
	if len(restored) == 0 {
		t.Fatal("应还原到至少一个文件")
	}
	if got := readFile(t, dir, "svc/save.go"); got != orig {
		t.Error("还原后文件应与原版一致")
	}
}

// Regression: Bug1——多函数插桩时排序降序+循环反向错配，导致后续注入点落在
// 错误字节偏移上，破坏源代码语法。验证插桩产物仍能通过 go/parser 语法解析，
// 且 import 行与探针标记位置正确，未错位截断原始代码。
func TestMultiFunctionInjectSyntaxPreserved(t *testing.T) {
	// 构造 3 个函数的文件（Save / MkdirAll / Cleanup），每个函数都有 enter/exit/IO
	// 探针，注入点至少 8+。若循环方向与排序方向错配，AST 解析必然失败。
	dir := t.TempDir()
	// 写 go.mod 让 findProjectRoot 能定位项目根（测试不传 BackupRoot 的路径）
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module demoproj\n\ngo 1.22\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	src := `package demoproj

import (
	"os"
	"fmt"
)

func Save(name string) error {
	data := []byte(name)
	if err := os.WriteFile("/tmp/x", data, 0644); err != nil {
		return fmt.Errorf("save: %w", err)
	}
	return nil
}

func MkdirAll(path string) error {
	if err := os.MkdirAll(path, 0755); err != nil {
		return err
	}
	return nil
}

func Cleanup(path string) {
	os.RemoveAll(path)
}
`
	file := filepath.Join(dir, "ops.go")
	if err := os.WriteFile(file, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	// 关键：不传 BackupRoot，让 InstrumentFile 走 findProjectRoot 分支（同时覆盖 Bug2）
	res, err := InstrumentFile(file, Options{Write: true})
	if err != nil {
		t.Fatalf("InstrumentFile 失败: %v", err)
	}
	if len(res.Sites) < 8 {
		t.Fatalf("期望 ≥8 个注入点（3函数×enter+exit+IO），实得 %d", len(res.Sites))
	}

	content := readFile(t, dir, "ops.go")

	// ① 最关键断言：插桩后产物必须能被 go/parser 解析（语法完整）
	fset := token.NewFileSet()
	if _, perr := parser.ParseFile(fset, file, content, parser.ParseComments); perr != nil {
		t.Fatalf("Bug1 回归: 多函数插桩后 Go 语法解析失败（注入顺序错配导致代码错位）\n%v\n\n产物:\n%s", perr, content)
	}

	// ② 幂等标记与 import 顺序：observe:instrumented 在第 1 行，import camprobe 紧跟
	lines := strings.Split(content, "\n")
	if len(lines) < 3 {
		t.Fatalf("产物行数不足: %d", len(lines))
	}
	if !strings.HasPrefix(lines[0], "// "+probeMarker) {
		t.Errorf("第1行应为幂等标记，实得: %q", lines[0])
	}
	// 第3行（deep未开启，第2行应为 import camprobe）或第2行
	hasImport := false
	for i := 0; i < 5 && i < len(lines); i++ {
		if strings.Contains(lines[i], "import "+probeAlias+" ") {
			hasImport = true
			break
		}
	}
	if !hasImport {
		t.Errorf("头部前5行内找不到 camprobe import 语句，可能 import 注入到了文件内部\n头几行: %v", lines[:min(5, len(lines))])
	}

	// ③ 每个函数的 enter 探针名应存在，说明 enter 探针没被错位截断
	for _, want := range []string{"demoproj.Save.enter", "demoproj.MkdirAll.enter", "demoproj.Cleanup.enter"} {
		if !strings.Contains(content, want) {
			t.Errorf("缺少函数入口探针 %q（注入错位可能导致探针名被截断）", want)
		}
	}
}

// Regression: Bug2——InstrumentFile 自动推断 BackupRoot 时多包了一层 filepath.Dir，
// 导致备份写到项目根父目录，RestoreInstrumented 找不到备份=源代码无法还原。
func TestBackupRootAutoInferAndRestore(t *testing.T) {
	dir := t.TempDir()
	// 写 go.mod 让 findProjectRoot 返回 dir（项目根）
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module projx\n\ngo 1.22\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	src := `package projx

import "os"

func F() error {
	return os.WriteFile("/tmp/y", []byte("x"), 0644)
}
`
	file := filepath.Join(dir, "f.go")
	if err := os.WriteFile(file, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	orig := string(src)

	// 关键：不传 BackupRoot → 走 findProjectRoot 自动推断分支
	if _, err := InstrumentFile(file, Options{Write: true}); err != nil {
		t.Fatalf("InstrumentFile: %v", err)
	}
	instrumented := readFile(t, dir, "f.go")
	if instrumented == orig {
		t.Fatal("插桩未生效")
	}

	// 断言备份应落在 <dir>/.design-canvas/observe-backup/f.go（项目根内）
	expectedBackup := filepath.Join(dir, backupDir, "f.go")
	if _, err := os.Stat(expectedBackup); err != nil {
		// 备份不在项目根 → Bug2复现：它被写到父目录去了
		parentOfProject := filepath.Dir(dir)
		orphanBackup := filepath.Join(parentOfProject, backupDir, filepath.Base(dir), "f.go")
		if _, oerr := os.Stat(orphanBackup); oerr == nil {
			t.Fatalf("Bug2 回归: 备份错位落到项目根父目录 %q，RestoreInstrumented 从项目根扫描时找不到，源代码无法还原", orphanBackup)
		}
		t.Fatalf("Bug2 回归: 备份既不在预期位置 %q，也未找到父目录错位项: %v", expectedBackup, err)
	}

	// 调用 RestoreInstrumented（从项目根扫）应能找到备份并还原
	restored := RestoreInstrumented(dir)
	if len(restored) != 1 {
		t.Fatalf("RestoreInstrumented 应还原 1 个文件，实得 %d", len(restored))
	}
	got := readFile(t, dir, "f.go")
	if got != orig {
		t.Errorf("还原后内容不匹配原版\n期望:\n%s\n\n实得:\n%s", orig, got)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}