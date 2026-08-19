// effects_test.go — effect 级探针测试（Brick Harvest Phase 2c）。
package instrument

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// effectFixture 构造含全部四类 effect 点的项目：
// 包级变量赋值/自增（write）、chan send（emit）、go 语句 + Listen + Ticker（hold）、
// 以及局部变量赋值（负样本——不应产生 effect 探针）。
func effectFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	src := `package worker

import (
	"net"
	"time"
)

var (
	Count    int
	ErrClosed = error(nil)
	state     = map[string]int{}
)

func Run(done chan int) {
	local := 1
	local = 2
	_ = local

	Count = 1
	Count++
	ErrClosed = nil
	state["k"] = 3

	events := make(chan int, 8)
	go func() {
		events <- 1
	}()

	l, _ := net.Listen("tcp", ":8080")
	defer l.Close()
	tk := time.NewTicker(time.Second)
	defer tk.Stop()
	done <- 1
}
`
	file := filepath.Join(dir, "worker.go")
	if err := os.WriteFile(file, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestEffectProbes_DryRun(t *testing.T) {
	dir := effectFixture(t)
	res, err := InstrumentFile(filepath.Join(dir, "worker.go"), Options{Write: false, EnableEffect: true, BackupRoot: dir})
	if err != nil {
		t.Fatalf("InstrumentFile: %v", err)
	}

	var effects []Site
	for _, s := range res.Sites {
		if s.Kind == ProbeEffect {
			effects = append(effects, s)
		}
	}
	// 期望命中：Count=/Count++/ErrClosed=/state[]=（state 是 map 下标写）
	// events<-（闭包内 send）/done<-/go func/Listen/NewTicker = 9
	// local= 不命中（局部变量）
	if len(effects) < 8 {
		t.Fatalf("期望 ≥8 个 effect 探针，实得 %d：%v", len(effects), effects)
	}

	joined := strings.Join(mapToStr(effects), "\n")
	for _, want := range []string{
		`"kind": "write", "target": "Count"`,
		`"kind": "emit", "target": "chan:events"`,
		`"kind": "emit", "target": "chan:done"`,
		`"kind": "hold", "target": "goroutine"`,
		`"kind": "hold", "target": "listen"`,
		`"kind": "hold", "target": "ticker"`,
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("缺少 effect 探针字段组合: %s", want)
		}
	}
	if strings.Contains(joined, `"target": "local"`) {
		t.Error("局部变量赋值不应产生 effect 探针")
	}
	if !strings.Contains(joined, `"target": "state[]"`) {
		t.Error("包级 map 下标写应归一为 state[]")
	}
}

func TestEffectProbes_WriteAndIdempotent(t *testing.T) {
	dir := effectFixture(t)
	file := filepath.Join(dir, "worker.go")

	res1, err := InstrumentFile(file, Options{Write: true, EnableEffect: true, BackupRoot: dir})
	if err != nil {
		t.Fatalf("第一次插桩: %v", err)
	}
	if len(res1.Sites) == 0 {
		t.Fatal("第一次插桩应产生探针")
	}
	content := readFile(t, dir, "worker.go")
	if !strings.Contains(content, effectMarker) {
		t.Error("缺少 effect 级幂等标记")
	}

	// 幂等：同参数再跑，不产生新探针
	res2, err := InstrumentFile(file, Options{Write: true, EnableEffect: true, BackupRoot: dir})
	if err != nil {
		t.Fatalf("第二次插桩: %v", err)
	}
	if len(res2.Sites) != 0 {
		t.Errorf("重复插桩应幂等跳过，实得 %d 探针", len(res2.Sites))
	}
}

// mapToStr 提取每个 Site 的 Code（探针源码），便于字符串断言。
func mapToStr(sites []Site) []string {
	out := make([]string, len(sites))
	for i, s := range sites {
		out[i] = s.Code
	}
	return out
}
