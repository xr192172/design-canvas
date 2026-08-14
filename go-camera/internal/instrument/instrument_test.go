package instrument

import (
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
	if !strings.Contains(content, "camera:instrumented") {
		t.Error("缺少幂等标记 camera:instrumented")
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
	if !strings.Contains(content, "camera:deep") {
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

	files := collectGoFiles(dir)
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