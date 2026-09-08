package probe

// run_recorder.go — 帧录制落盘（"插针录制一次操作"的回放素材）。
//
// 与 incident 开箱导出不同：开箱只导出错误链路窗口；录制器把某次操作
// 的 enter/exit/catch 帧（含 trace_id/frame_id/parent_id/dur/fields）全量
// 追加到一个 JSONL，供"录制 → 重建调用树 → 逐步回放"链路消费。
//
// 默认不启用（runRec == nil 时 Emit 零开销判空），仅当显式 WithRunRecorder
// 才写出——不干扰生产热路径。

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// runRecorder 把带帧事件追加到单个 JSONL 文件（追加模式，可多次操作累计）。
type runRecorder struct {
	mu sync.Mutex
	fh *os.File
	w  *bufio.Writer
}

func newRunRecorder(path string) *runRecorder {
	if path == "" {
		return nil
	}
	dir := filepath.Dir(path)
	if dir != "" && dir != "." {
		_ = os.MkdirAll(dir, 0o755)
	}
	fh, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil
	}
	return &runRecorder{fh: fh, w: bufio.NewWriterSize(fh, 64*1024)}
}

// write 追加一个事件（含 trace/frame 才在重建侧有意义；无帧事件也原样写入，
// 由重建方按 frame_id>0 判定为"一次操作"的帧）。
func (r *runRecorder) write(ev Event) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	data, err := json.Marshal(ev)
	if err != nil {
		return
	}
	if _, err := r.w.Write(append(data, '\n')); err != nil {
		return
	}
}

// Close flush 并关闭文件。
func (r *runRecorder) Close() error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.w != nil {
		_ = r.w.Flush()
		r.w = nil
	}
	if r.fh != nil {
		err := r.fh.Close()
		r.fh = nil
		return err
	}
	return nil
}