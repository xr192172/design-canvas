package probe

// Package probe — DesignDSLStore: Camera 设计 DSL 的持久化仓库（P1）。
//
// 工程化目标（2026-08-14，DSL 唯一真相源）：
//   - dsl.json 是行为级判定的权威真相源（LLM 判定只喂「事件快照 + 这里声明的
//     DSLDecl」，不接触项目文档）。
//   - 版本化 + 快照式审计历史：每次定稿把完整快照写进 dsl.history.jsonl，
//     任何版本都可回滚（快照式而非 diff 式，避免重建代价）。
//   - 原子写：临时文件 + rename，崩溃不产生半写文件。
//   - 提案权与写盘权分离：本 store 只负责"定稿写入/回滚"，修订提案由后续
//     P3 的验证门审批后才落盘；LLM 无直接写盘通道。
//
// 种子策略：首次运行（dsl.json 不存在）用 SilentErrorDiscardDSL 作为 v1 种子，
// 保证 judge 装配永远有可判定的声明，同时保留演进空间。

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// DesignDSLDoc 是当前生效的设计 DSL（权威真相源）。
type DesignDSLDoc struct {
	Version   int       `json:"version"`    // 单调递增版本号
	UpdatedAt time.Time `json:"updated_at"` // 本次定稿时间
	Decls     []DSLDecl `json:"decls"`      // 全部生效声明
}

// HistoryEntry 记录一次定稿/回滚。快照式：Decls 存完整快照，可任意回滚。
type HistoryEntry struct {
	Version int       `json:"version"` // 本次写入后的版本号
	At      time.Time `json:"at"`      // 变更时间
	Reason  string    `json:"reason"`  // 变更原因（人类可读）
	Source  string    `json:"source"`  // 来源：seed / manual / llm-revise / rollback
	Decls   []DSLDecl `json:"decls"`   // 本版本的完整 DSL 快照

	// 审计增强（2026-08-15，对齐定稿方案）：
	Action       string `json:"action,omitempty"`        // seed | save | approve | rollback
	FromVersion  int    `json:"from_version,omitempty"`  // 变更前版本（0 = 初始）
	Verification string `json:"verification,omitempty"`  // 验证门证据摘要（如 rule-regression: 2/2 可判定）
}

// SaveMeta 携带定稿审计元信息（Action / Verification）。
type SaveMeta struct {
	Action       string
	Verification string
}

// DesignDSLStore 持久化设计 DSL 与审计历史。
// 目录结构：
//
//	{dir}/dsl.json            当前生效版本（权威）
//	{dir}/dsl.history.jsonl   快照式审计历史（append-only，逐行 JSON）
type DesignDSLStore struct {
	dir string
}

// NewDesignDSLStore 创建设计 DSL 仓库。dir 不存在时会自动创建。
func NewDesignDSLStore(dir string) *DesignDSLStore {
	return &DesignDSLStore{dir: dir}
}

func (s *DesignDSLStore) dslPath() string  { return filepath.Join(s.dir, "dsl.json") }
func (s *DesignDSLStore) histPath() string { return filepath.Join(s.dir, "dsl.history.jsonl") }

// Load 读取当前设计 DSL。文件不存在返回 os.ErrNotExist（调用方决定是否 seed）。
func (s *DesignDSLStore) Load() (DesignDSLDoc, error) {
	var doc DesignDSLDoc
	data, err := os.ReadFile(s.dslPath())
	if err != nil {
		return doc, err
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return doc, fmt.Errorf("design-dsl: parse %s: %w", s.dslPath(), err)
	}
	return doc, nil
}

// SeedDefault 在 dsl.json 不存在时写入 v1 种子声明。已存在则幂等跳过。
// 返回是否执行了播种（false = 已有文件，未改动）。
func (s *DesignDSLStore) SeedDefault() (bool, error) {
	if _, err := os.Stat(s.dslPath()); err == nil {
		return false, nil
	}
	doc := DesignDSLDoc{
		Version:   1,
		UpdatedAt: time.Now().UTC(),
		Decls:     []DSLDecl{SilentErrorDiscardDSL()},
	}
	if err := s.writeDoc(doc); err != nil {
		return false, err
	}
	return true, s.appendHistory(HistoryEntry{
		Version:     doc.Version,
		At:          doc.UpdatedAt,
		Reason:      "initial seed: silent-error-discard 契约",
		Source:      "seed",
		Action:      "seed",
		Decls:       doc.Decls,
	})
}

// Save 定稿写入新版本：版本号 +1，diff 记入审计，完整快照追加历史。
// decls 为 nil 时沿用当前声明的裸拷贝（纯 reason/source 更新场景），
// 正常情况下应传入完整新声明集。
func (s *DesignDSLStore) Save(decls []DSLDecl, reason, source string) (int, error) {
	return s.SaveWithMeta(decls, reason, source, SaveMeta{Action: "save"})
}

// SaveWithMeta 定稿写入新版本，并携带审计元信息（Action/Verification）。
// 验证门审批（Approve）用它把 verified_by 证据写进审计历史。
func (s *DesignDSLStore) SaveWithMeta(decls []DSLDecl, reason, source string, meta SaveMeta) (int, error) {
	cur, err := s.Load()
	if err != nil && !os.IsNotExist(err) {
		return 0, err
	}
	next := cur.Version + 1
	if next < 1 {
		next = 1
	}
	if decls == nil {
		decls = append([]DSLDecl(nil), cur.Decls...)
	}
	doc := DesignDSLDoc{
		Version:   next,
		UpdatedAt: time.Now().UTC(),
		Decls:     decls,
	}
	if err := s.writeDoc(doc); err != nil {
		return 0, err
	}
	action := meta.Action
	if action == "" {
		action = "save"
	}
	return next, s.appendHistory(HistoryEntry{
		Version:      doc.Version,
		At:           doc.UpdatedAt,
		Reason:       reason,
		Source:       source,
		Action:       action,
		FromVersion:  cur.Version,
		Verification: meta.Verification,
		Decls:        doc.Decls,
	})
}

// Rollback 把设计 DSL 恢复到指定历史版本（该版本必须存在于审计历史中）。
// 回滚本身也是一次新版本写入（version 单调递增），审计链不破坏。
func (s *DesignDSLStore) Rollback(targetVersion int) (int, error) {
	hist, err := s.History()
	if err != nil {
		return 0, err
	}
	for _, h := range hist {
		if h.Version == targetVersion {
			return s.Save(h.Decls, fmt.Sprintf("rollback to v%d", targetVersion), "rollback")
		}
	}
	return 0, fmt.Errorf("design-dsl: no history entry for version %d (available: %s)",
		targetVersion, s.versionList(hist))
}

// History 返回全部审计历史，按版本号升序。
func (s *DesignDSLStore) History() ([]HistoryEntry, error) {
	fh, err := os.Open(s.histPath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer fh.Close()
	return readHistory(fh)
}

// versionList 生成可读的可用版本列表（用于错误提示）。
func (s *DesignDSLStore) versionList(hist []HistoryEntry) string {
	vs := make([]string, 0, len(hist))
	for _, h := range hist {
		vs = append(vs, fmt.Sprintf("%d", h.Version))
	}
	return strings.Join(vs, ", ")
}

// writeDoc 原子写 dsl.json：临时文件 + rename，避免崩溃产生半写文件。
func (s *DesignDSLStore) writeDoc(doc DesignDSLDoc) error {
	if err := os.MkdirAll(s.dir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.dslPath() + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, s.dslPath())
}

// appendHistory 追加一条审计记录（append-only）。
func (s *DesignDSLStore) appendHistory(h HistoryEntry) error {
	if err := os.MkdirAll(s.dir, 0755); err != nil {
		return err
	}
	fh, err := os.OpenFile(s.histPath(), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer fh.Close()
	data, err := json.Marshal(h)
	if err != nil {
		return err
	}
	_, err = fh.Write(append(data, '\n'))
	return err
}

// readHistory 从 JSONL 读取全部历史并按版本升序。
func readHistory(r io.Reader) ([]HistoryEntry, error) {
	var out []HistoryEntry
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var h HistoryEntry
		if err := json.Unmarshal([]byte(line), &h); err != nil {
			return nil, fmt.Errorf("design-dsl: parse history line: %w", err)
		}
		out = append(out, h)
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Version < out[j].Version })
	return out, nil
}
