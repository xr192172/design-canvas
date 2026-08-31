package instrument

import (
	"path/filepath"
	"strings"
	"testing"
)

// ─────────────────────────────────────────────
// 契约解析/匹配纯函数
// ─────────────────────────────────────────────

func TestPackageFilter(t *testing.T) {
	probes := []ContractProbe{
		{Probe: "v2.sessionsDir.mkdirall"},
		{Probe: "v2.assembleString.writefile"},
		{Probe: "core.recover.defer"},
		{Probe: ""}, // 空探针：全局规则，不入集合
	}
	got := PackageFilter(probes)
	for _, want := range []string{"v2", "core"} {
		if !got[want] {
			t.Errorf("PackageFilter: 期望包含包 %q，实际 %v", want, got)
		}
	}
	if got[""] {
		t.Error("PackageFilter: 空探针不应入包集合")
	}
	if len(got) != 2 {
		t.Errorf("PackageFilter: 期望 2 个包，实际 %d (%v)", len(got), got)
	}
}

func TestMatchProbe(t *testing.T) {
	probes := []ContractProbe{
		{Probe: "v2.sessionsDir.mkdirall"},
		{Probe: "demo.Save.writefile"},
	}
	cases := []struct {
		name string
		want bool
	}{
		{"v2.sessionsDir.mkdirall", true},
		{"demo.Save.writefile", true},
		{"demo.Save.enter", false},       // 未声明
		{"demo.MkdirAll.mkdirall", false}, // 函数不匹配
		{"v2.sessionsDir.enter", false},   // suffix 不匹配
	}
	for _, c := range cases {
		if got := MatchProbe(c.name, probes); got != c.want {
			t.Errorf("MatchProbe(%q) = %v, want %v", c.name, got, c.want)
		}
	}
}

// 探索模式：probes == nil 恒真（全量无脑插桩）。
func TestMatchProbe_ExploreNil(t *testing.T) {
	for _, name := range []string{"a.b.c", "demo.Save.enter", "any.thing.io"} {
		if !MatchProbe(name, nil) {
			t.Errorf("MatchProbe(%q, nil) 应恒真（探索模式），实际 false", name)
		}
	}
}

// ─────────────────────────────────────────────
// 契约模式端到端：精确插桩 + 包级过滤
// ─────────────────────────────────────────────

// 契约模式：只注入 DSL 声明的探针点，未声明的不注入。
func TestInstrumentFile_ContractMode_Filtered(t *testing.T) {
	dir := makeFixture(t)
	file := filepath.Join(dir, "svc", "save.go")
	// 只声明 Save.writefile——Save 的 enter/exit、MkdirAll 全部不注入
	probes := []ContractProbe{{Probe: "demo.Save.writefile"}}
	res, err := InstrumentFile(file, Options{Write: true, BackupRoot: dir, ContractProbes: probes})
	if err != nil {
		t.Fatalf("InstrumentFile: %v", err)
	}
	if len(res.Sites) != 1 {
		t.Fatalf("契约模式期望 1 个探针（Save.writefile），实际 %d: %+v", len(res.Sites), res.Sites)
	}
	if res.Sites[0].Kind != ProbeIO {
		t.Errorf("期望 IO 探针，实际 %s", res.Sites[0].Kind)
	}
	// 注入后应含 writefile 探针、不应含 enter/exit 探针
	content := readFile(t, dir, "svc/save.go")
	if !strings.Contains(content, `"demo.Save.writefile"`) {
		t.Error("契约模式应注入 Save.writefile 探针")
	}
	if strings.Contains(content, `"demo.Save.enter"`) {
		t.Error("契约模式不应注入未声明的 Save.enter")
	}
	if strings.Contains(content, `"demo.MkdirAll.mkdirall"`) {
		t.Error("契约模式不应注入未声明的 MkdirAll.mkdirall")
	}
}

// 契约模式：声明多个探针（enter + io）时全部精确注入。
func TestInstrumentFile_ContractMode_Multiple(t *testing.T) {
	dir := makeFixture(t)
	file := filepath.Join(dir, "svc", "save.go")
	probes := []ContractProbe{
		{Probe: "demo.Save.enter"},
		{Probe: "demo.Save.writefile"},
	}
	res, err := InstrumentFile(file, Options{Write: true, BackupRoot: dir, ContractProbes: probes})
	if err != nil {
		t.Fatalf("InstrumentFile: %v", err)
	}
	if len(res.Sites) != 2 {
		t.Fatalf("期望 2 个探针（enter + writefile），实际 %d: %+v", len(res.Sites), res.Sites)
	}
	content := readFile(t, dir, "svc/save.go")
	if !strings.Contains(content, `"demo.Save.enter"`) || !strings.Contains(content, `"demo.Save.writefile"`) {
		t.Error("应同时注入 enter 与 writefile 探针")
	}
	if strings.Contains(content, `"demo.MkdirAll.mkdirall"`) {
		t.Error("不应注入未声明的 MkdirAll.mkdirall")
	}
}

// 契约模式：文件级包过滤——契约探针包不含当前文件包时整文件跳过。
func TestInstrumentFile_ContractMode_PackageFilter(t *testing.T) {
	dir := makeFixture(t)
	file := filepath.Join(dir, "svc", "save.go")
	// 只声明其他包的探针——demo 包整个跳过，0 探针
	probes := []ContractProbe{{Probe: "other.fn.enter"}}
	res, err := InstrumentFile(file, Options{Write: true, BackupRoot: dir, ContractProbes: probes})
	if err != nil {
		t.Fatalf("InstrumentFile: %v", err)
	}
	if len(res.Sites) != 0 {
		t.Fatalf("包级过滤后应 0 探针，实际 %d", len(res.Sites))
	}
	content := readFile(t, dir, "svc/save.go")
	if strings.Contains(content, "camprobe.Capture") {
		t.Error("包级过滤：文件不应被注入任何探针")
	}
}

// 探索模式：probes == nil 全量插桩（与旧行为一致）。
func TestInstrumentFile_ExploreMode_Full(t *testing.T) {
	dir := makeFixture(t)
	file := filepath.Join(dir, "svc", "save.go")
	res, err := InstrumentFile(file, Options{Write: true, BackupRoot: dir, ContractProbes: nil})
	if err != nil {
		t.Fatalf("InstrumentFile: %v", err)
	}
	// Save: enter + exit(return err) + io(writefile)；MkdirAll: enter + mkdirall
	// （Save 尾部 return nil 前不再补 exit——末尾是 return，见 processFunction 注释）
	if len(res.Sites) < 4 {
		t.Fatalf("探索模式应注入全量探针（≥4），实际 %d: %+v", len(res.Sites), res.Sites)
	}
	content := readFile(t, dir, "svc/save.go")
	if !strings.Contains(content, `"demo.Save.enter"`) || !strings.Contains(content, `"demo.Save.writefile"`) ||
		!strings.Contains(content, `"demo.MkdirAll.mkdirall"`) {
		t.Error("探索模式应注入全部探针")
	}
}
