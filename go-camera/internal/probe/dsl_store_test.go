package probe

import (
	"os"
	"path/filepath"
	"testing"
)

func testStore(t *testing.T) *DesignDSLStore {
	t.Helper()
	dir := t.TempDir()
	return NewDesignDSLStore(filepath.Join(dir, "camera"))
}

func TestSeedDefaultCreatesV1(t *testing.T) {
	s := testStore(t)
	seeded, err := s.SeedDefault()
	if err != nil {
		t.Fatalf("SeedDefault: %v", err)
	}
	if !seeded {
		t.Fatal("expected seed to run on empty store")
	}
	doc, err := s.Load()
	if err != nil {
		t.Fatalf("Load after seed: %v", err)
	}
	if doc.Version != 1 {
		t.Fatalf("version = %d, want 1", doc.Version)
	}
	if len(doc.Decls) != 1 || doc.Decls[0].Rule != "design:silent-error-discard" {
		t.Fatalf("seed decls unexpected: %+v", doc.Decls)
	}
}

func TestSeedDefaultIdempotent(t *testing.T) {
	s := testStore(t)
	if _, err := s.SeedDefault(); err != nil {
		t.Fatalf("first seed: %v", err)
	}
	seeded, err := s.SeedDefault()
	if err != nil {
		t.Fatalf("second seed: %v", err)
	}
	if seeded {
		t.Fatal("second seed should be a no-op (idempotent)")
	}
	doc, _ := s.Load()
	if doc.Version != 1 {
		t.Fatalf("version changed on re-seed: %d", doc.Version)
	}
}

func TestSaveIncrementsVersionAndHistory(t *testing.T) {
	s := testStore(t)
	if _, err := s.SeedDefault(); err != nil {
		t.Fatalf("seed: %v", err)
	}

	extra := DSLDecl{
		Rule:   "design:extra-rule",
		Probe:  "save.mkdirall",
		Expect: "mkdirall 失败必须返回错误，不得静默",
	}
	v2, err := s.Save([]DSLDecl{SilentErrorDiscardDSL(), extra}, "add extra rule", "llm-revise")
	if err != nil {
		t.Fatalf("Save v2: %v", err)
	}
	if v2 != 2 {
		t.Fatalf("Save returned version %d, want 2", v2)
	}

	doc, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if doc.Version != 2 || len(doc.Decls) != 2 {
		t.Fatalf("doc after save: v=%d decls=%d", doc.Version, len(doc.Decls))
	}

	hist, err := s.History()
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	if len(hist) != 2 {
		t.Fatalf("history len = %d, want 2", len(hist))
	}
	if hist[1].Source != "llm-revise" || hist[1].Version != 2 {
		t.Fatalf("history[1] unexpected: %+v", hist[1])
	}
}

func TestRollbackRestoresSnapshot(t *testing.T) {
	s := testStore(t)
	if _, err := s.SeedDefault(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	extra := DSLDecl{Rule: "design:extra-rule", Expect: "extra"}
	if _, err := s.Save([]DSLDecl{SilentErrorDiscardDSL(), extra}, "add", "llm-revise"); err != nil {
		t.Fatalf("save v2: %v", err)
	}

	newVer, err := s.Rollback(1)
	if err != nil {
		t.Fatalf("Rollback(1): %v", err)
	}
	if newVer != 3 {
		t.Fatalf("rollback version = %d, want 3 (monotonic)", newVer)
	}

	doc, err := s.Load()
	if err != nil {
		t.Fatalf("Load after rollback: %v", err)
	}
	if doc.Version != 3 {
		t.Fatalf("doc version = %d, want 3", doc.Version)
	}
	if len(doc.Decls) != 1 || doc.Decls[0].Rule != "design:silent-error-discard" {
		t.Fatalf("rollback did not restore v1 snapshot: %+v", doc.Decls)
	}

	// 审计链不破坏：3 条历史，最后一条 source=rollback
	hist, err := s.History()
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	if len(hist) != 3 {
		t.Fatalf("history len = %d, want 3", len(hist))
	}
	if hist[2].Source != "rollback" {
		t.Fatalf("history[2].Source = %q, want rollback", hist[2].Source)
	}
}

func TestRollbackUnknownVersion(t *testing.T) {
	s := testStore(t)
	if _, err := s.SeedDefault(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := s.Rollback(99); err == nil {
		t.Fatal("Rollback(99) should error for unknown version")
	}
}

func TestLoadMissingFile(t *testing.T) {
	s := testStore(t)
	_, err := s.Load()
	if !os.IsNotExist(err) {
		t.Fatalf("Load on empty store: err = %v, want os.ErrNotExist", err)
	}
}

func TestPersistenceAcrossInstances(t *testing.T) {
	dir := t.TempDir()
	s1 := NewDesignDSLStore(dir)
	if _, err := s1.SeedDefault(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	extra := DSLDecl{Rule: "design:x", Expect: "y"}
	if _, err := s1.Save([]DSLDecl{SilentErrorDiscardDSL(), extra}, "add x", "manual"); err != nil {
		t.Fatalf("save: %v", err)
	}

	// 用新实例从磁盘重读（模拟重启）
	s2 := NewDesignDSLStore(dir)
	doc, err := s2.Load()
	if err != nil {
		t.Fatalf("Load via new instance: %v", err)
	}
	if doc.Version != 2 || len(doc.Decls) != 2 {
		t.Fatalf("persisted doc: v=%d decls=%d", doc.Version, len(doc.Decls))
	}
}

func TestJudgeLoadDSL(t *testing.T) {
	s := testStore(t)
	// sender 为 nil 不影响 LoadDSL（只装配声明）
	j := NewLLMJudge(nil)
	if err := j.LoadDSL(s); err != nil {
		t.Fatalf("LoadDSL: %v", err)
	}
	if len(j.decls) != 1 {
		t.Fatalf("decls after LoadDSL = %d, want 1 (seed)", len(j.decls))
	}

	// 更新仓库后再加载，decls 应整体替换
	extra := DSLDecl{Rule: "design:x", Expect: "y"}
	if _, err := s.Save([]DSLDecl{SilentErrorDiscardDSL(), extra}, "add x", "manual"); err != nil {
		t.Fatalf("save: %v", err)
	}
	if err := j.LoadDSL(s); err != nil {
		t.Fatalf("LoadDSL again: %v", err)
	}
	if len(j.decls) != 2 {
		t.Fatalf("decls after reload = %d, want 2 (replaced, not appended)", len(j.decls))
	}
}
