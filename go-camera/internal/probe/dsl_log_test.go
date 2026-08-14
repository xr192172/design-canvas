package probe

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ── camera-dsl log：异常日志工具（默认只列偏差，--all 全列）──

func TestDSLLog_DefaultListsOnlyAnomalies(t *testing.T) {
	dir := t.TempDir()
	eventsPath := filepath.Join(dir, "events.jsonl")
	writeLines(t, eventsPath,
		`{"probe":"saveSink.writefile","time":"2026-08-14T10:00:00Z","source":"s","fields":{"op":"writefile","err":"","path":"note.json"}}`,
		`{"probe":"saveSink.writefile","time":"2026-08-14T10:00:01Z","source":"s","fields":{"op":"writefile","err":"EISDIR: illegal operation on a directory","path":"design-canvas.json"}}`,
		`{"probe":"save.enter","time":"2026-08-14T10:00:01Z","source":"s","fields":{"args":{"key":"demo"}}}`,
	)

	out := captureCLI(func() bool { return dslLog([]string{eventsPath}) })

	if !strings.Contains(out, "Camera 运行日志：3 事件 · 1 异常") {
		t.Fatalf("日志头缺失: %s", out)
	}
	// 默认只列异常：EISDIR 那条出现
	if !strings.Contains(out, "design:silent-error-discard") {
		t.Fatalf("异常未列出: %s", out)
	}
	// 正常事件（err 空 / enter）不应出现
	if strings.Contains(out, "save.enter") {
		t.Fatalf("默认模式不应列出正常事件: %s", out)
	}
}

func TestDSLLog_AllListsEverything(t *testing.T) {
	dir := t.TempDir()
	eventsPath := filepath.Join(dir, "events.jsonl")
	writeLines(t, eventsPath,
		`{"probe":"save.enter","time":"2026-08-14T10:00:01Z","source":"s","fields":{"args":{"key":"demo"}}}`,
		`{"probe":"saveSink.writefile","time":"2026-08-14T10:00:01Z","source":"s","fields":{"op":"writefile","err":"EISDIR","path":"x.json"}}`,
	)

	out := captureCLI(func() bool { return dslLog([]string{eventsPath, "--all"}) })

	if !strings.Contains(out, "Camera 运行日志：2 事件 · 1 异常") {
		t.Fatalf("日志头缺失: %s", out)
	}
	if !strings.Contains(out, "save.enter") {
		t.Fatalf("--all 应列出正常事件: %s", out)
	}
	if !strings.Contains(out, "design:silent-error-discard") {
		t.Fatalf("--all 应标记异常: %s", out)
	}
}

func TestDSLLog_NoAnomaly(t *testing.T) {
	dir := t.TempDir()
	eventsPath := filepath.Join(dir, "events.jsonl")
	writeLines(t, eventsPath,
		`{"probe":"saveSink.writefile","time":"2026-08-14T10:00:00Z","source":"s","fields":{"op":"writefile","err":"","path":"note.json"}}`,
	)

	out := captureCLI(func() bool { return dslLog([]string{eventsPath}) })

	if !strings.Contains(out, "无异常") {
		t.Fatalf("应提示无异常: %s", out)
	}
}

// captureCLI 捕获 dslLog 的 stdout 输出。
func captureCLI(fn func() bool) string {
	old := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w
	defer func() { os.Stdout = old }()
	fn()
	w.Close()
	buf := make([]byte, 4096)
	n, _ := r.Read(buf)
	os.Stdout = old
	return string(buf[:n])
}