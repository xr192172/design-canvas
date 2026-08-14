package probe

import (
	"os"
	"path/filepath"
	"testing"
)

// ── ProposalStore：写盘权分离 + 验证门审批 ──

func TestProposalStore_CreateDoesNotTouchDSL(t *testing.T) {
	dir := t.TempDir()
	dsl := NewDesignDSLStore(dir)
	if _, err := dsl.SeedDefault(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	before := dslVersion(t, dsl)

	decls := []DSLDecl{
		{Rule: "design:no-op-io", Probe: "fs.writefile", Expect: "写文件必须处理错误"},
	}
	ps := NewProposalStore(dir)
	p, err := ps.Create(decls, "补充一条契约", "manual")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if p.Status != ProposalPending {
		t.Fatalf("新提案应 pending，got %s", p.Status)
	}
	// 写盘权分离：创建提案后权威 DSL 版本不变
	if after := dslVersion(t, dsl); after != before {
		t.Fatalf("propose 不应改动 dsl.json：before=%d after=%d", before, after)
	}
	if _, err := os.Stat(filepath.Join(dir, "proposals", p.ID+".json")); err != nil {
		t.Fatalf("提案文件未落盘: %v", err)
	}
}

func TestProposalStore_ApproveWritesNewVersionAndFlags(t *testing.T) {
	dir := t.TempDir()
	dsl := NewDesignDSLStore(dir)
	if _, err := dsl.SeedDefault(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	ps := NewProposalStore(dir)
	decls := []DSLDecl{
		{Rule: "design:no-op-io", Probe: "fs.writefile", Expect: "写文件必须处理错误"},
	}
	p, err := ps.Create(decls, "补充一条契约", "llm-revise")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	ver, err := ps.Approve(p.ID, "reviewer-a", dsl)
	if err != nil {
		t.Fatalf("Approve: %v", err)
	}
	if ver != 2 {
		t.Fatalf("审批后应 v2（v1 种子 +1），got %d", ver)
	}
	// 权威 DSL 已更新为提案的完整新声明集（Save 是快照式，整体替换）
	doc, err := dsl.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if doc.Version != 2 || len(doc.Decls) != 1 || doc.Decls[0].Rule != "design:no-op-io" {
		t.Fatalf("审批后 dsl.json 应整体替换为提案声明，got version=%d decls=%+v", doc.Version, doc.Decls)
	}
	// 提案标记 approved
	got, _ := ps.Get(p.ID)
	if got.Status != ProposalApproved || got.Reviewer != "reviewer-a" {
		t.Fatalf("提案应 approved/reviewer-a，got %s/%s", got.Status, got.Reviewer)
	}
	// 审计链有 v2
	hist, _ := dsl.History()
	if len(hist) != 2 || hist[1].Version != 2 || hist[1].Source != "llm-revise" {
		t.Fatalf("审计链应含 v2(llm-revise)，got %+v", hist)
	}
}

func TestProposalStore_ApproveNonPendingRejected(t *testing.T) {
	dir := t.TempDir()
	dsl := NewDesignDSLStore(dir)
	if _, err := dsl.SeedDefault(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	ps := NewProposalStore(dir)
	p, _ := ps.Create([]DSLDecl{{Rule: "r", Expect: "e"}}, "原因", "manual")
	if err := ps.Reject(p.ID, "reviewer-b"); err != nil {
		t.Fatalf("Reject: %v", err)
	}
	if _, err := ps.Approve(p.ID, "x", dsl); err == nil {
		t.Fatal("已拒绝的提案不应可审批")
	}
	// 权威 DSL 未被改动
	if v := dslVersion(t, dsl); v != 1 {
		t.Fatalf("拒绝后 dsl.json 不应变，got v%d", v)
	}
}

func TestProposalStore_RejectSetsStatus(t *testing.T) {
	dir := t.TempDir()
	ps := NewProposalStore(dir)
	p, _ := ps.Create([]DSLDecl{{Rule: "r", Expect: "e"}}, "原因", "manual")
	if err := ps.Reject(p.ID, "reviewer-c"); err != nil {
		t.Fatalf("Reject: %v", err)
	}
	got, _ := ps.Get(p.ID)
	if got.Status != ProposalRejected || got.Reviewer != "reviewer-c" {
		t.Fatalf("应 rejected/reviewer-c，got %s/%s", got.Status, got.Reviewer)
	}
}

func TestProposalStore_ListOrdersByCreated(t *testing.T) {
	dir := t.TempDir()
	ps := NewProposalStore(dir)
	p1, _ := ps.Create([]DSLDecl{{Rule: "r1", Expect: "e1"}}, "a", "manual")
	p2, _ := ps.Create([]DSLDecl{{Rule: "r2", Expect: "e2"}}, "b", "manual")
	list, err := ps.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 2 || list[0].ID != p1.ID || list[1].ID != p2.ID {
		t.Fatalf("List 应按创建顺序返回，got %+v", list)
	}
}

func TestProposalStore_ValidateEmptyDecls(t *testing.T) {
	dir := t.TempDir()
	ps := NewProposalStore(dir)
	if _, err := ps.Create([]DSLDecl{}, "空", "manual"); err == nil {
		t.Fatal("空声明集应被验证门拒绝")
	}
	if _, err := ps.Create([]DSLDecl{{Rule: "", Expect: "缺 rule"}}, "缺 rule", "manual"); err == nil {
		t.Fatal("缺 rule 的声明应被拒绝")
	}
	if _, err := ps.Create([]DSLDecl{{Rule: "r", Expect: ""}}, "缺 expect", "manual"); err == nil {
		t.Fatal("缺 expect 的声明应被拒绝")
	}
}

// dslVersion 读取当前权威 DSL 版本号（不存在视为 0）。
func dslVersion(t *testing.T, dsl *DesignDSLStore) int {
	doc, err := dsl.Load()
	if err != nil {
		if os.IsNotExist(err) {
			return 0
		}
		t.Fatalf("Load: %v", err)
	}
	return doc.Version
}