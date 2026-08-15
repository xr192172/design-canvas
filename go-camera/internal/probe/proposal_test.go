package probe

import (
	"context"
	"os"
	"path/filepath"
	"strings"
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
		{Rule: "design:silent-error-discard", Probe: "fs.writefile", Expect: "写文件必须处理错误"},
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
	if doc.Version != 2 || len(doc.Decls) != 1 || doc.Decls[0].Rule != "design:silent-error-discard" {
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

func TestVerifyRuleRegression_Coverage(t *testing.T) {
	reg := VerifyRuleRegression([]DSLDecl{
		{Rule: "design:silent-error-discard", Expect: "有谓词"},
		{Rule: "design:no-op-io", Expect: "无谓词"},
		{Rule: "design:another-unknown", Expect: "无谓词"},
	})
	if reg.Checked != 3 {
		t.Fatalf("Checked=%d 期望 3", reg.Checked)
	}
	if reg.Covered != 1 {
		t.Fatalf("Covered=%d 期望 1", reg.Covered)
	}
	if len(reg.Uncovered) != 2 || reg.Uncovered[0] != "design:another-unknown" || reg.Uncovered[1] != "design:no-op-io" {
		t.Fatalf("Uncovered=%v 期望按字典序 [design:another-unknown design:no-op-io]", reg.Uncovered)
	}
}

func TestApprove_RecordsVerificationEvidence(t *testing.T) {
	dir := t.TempDir()
	dsl := NewDesignDSLStore(dir)
	if _, err := dsl.SeedDefault(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	ps := NewProposalStore(dir)
	// 混合声明：一条有谓词（可规则秒判）、一条无谓词（需 LLM 复核）
	decls := []DSLDecl{
		{Rule: "design:silent-error-discard", Probe: "svc.write", Expect: "写盘错误必须处理"},
		{Rule: "design:no-op-io", Probe: "fs.copy", Expect: "复制必须处理错误"},
	}
	p, err := ps.Create(decls, "验证门证据测试", "llm-revise")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// LLM 复核门：对无谓词声明返回 ok（通过）
	gate := VerifyGate{LLMReview: func(_ context.Context, decls []DSLDecl) ([]LLMVerdict, error) {
		return []LLMVerdict{
			{Rule: "design:no-op-io", Result: "ok", Reason: "契约语义合理，可定稿"},
		}, nil
	}}
	if _, err := ps.ApproveGated(context.Background(), p.ID, "reviewer-gate", dsl, gate); err != nil {
		t.Fatalf("ApproveGated: %v", err)
	}

	// 提案落盘了验证门证据
	got, _ := ps.Get(p.ID)
	if got.VerifiedBy == "" || got.Verification == "" {
		t.Fatalf("审批后提案应有验证门证据，got %+v", got)
	}
	if !strings.Contains(got.VerifiedBy, "1/2") {
		t.Fatalf("VerifiedBy 应标注 1/2 声明可判定，got %q", got.VerifiedBy)
	}
	if !strings.Contains(got.VerifiedBy, "llm-review") {
		t.Fatalf("VerifiedBy 应含 llm-review 证据，got %q", got.VerifiedBy)
	}

	// 定稿的 dsl.json 里声明带验证证据与状态
	doc, err := dsl.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(doc.Decls) != 2 {
		t.Fatalf("定稿声明数=%d 期望 2", len(doc.Decls))
	}
	if doc.Decls[0].VerifiedBy != "rule-regression" || doc.Decls[0].Status != "verified" {
		t.Fatalf("有谓词声明应 verified/rule-regression，got %+v", doc.Decls[0])
	}
	if doc.Decls[1].VerifiedBy != "llm-review" || doc.Decls[1].Status != "verified" {
		t.Fatalf("无谓词声明经 LLM 复核应 verified/llm-review，got %+v", doc.Decls[1])
	}

	// 审计历史带验证门证据（HistoryEntry.Verification）
	hist, _ := dsl.History()
	if len(hist) != 2 {
		t.Fatalf("审计链应含 2 条，got %d", len(hist))
	}
	if !strings.Contains(hist[1].Verification, "llm-review") {
		t.Fatalf("审计 v2 应带验证门证据（llm-review），got %q", hist[1].Verification)
	}
	if hist[1].Action != "approve" || hist[1].FromVersion != 1 {
		t.Fatalf("审计 v2 应 action=approve from=1，got %+v", hist[1])
	}
}

// 严格门：提案含无谓词声明且 LLM 复核不可用 → 定稿冻结，dsl.json 维持旧版。
func TestApprove_StrictGateFreezesUncoveredWithoutLLM(t *testing.T) {
	dir := t.TempDir()
	dsl := NewDesignDSLStore(dir)
	if _, err := dsl.SeedDefault(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	ps := NewProposalStore(dir)
	// 只有无谓词声明（无确定性谓词）
	p, err := ps.Create([]DSLDecl{{Rule: "design:no-op-io", Probe: "fs.copy", Expect: "复制必须处理错误"}}, "无谓词", "llm-revise")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := ps.Approve(p.ID, "reviewer-x", dsl); err == nil {
		t.Fatal("无 LLM 复核能力时，含无谓词声明的提案应被冻结（拒绝定稿）")
	}
	// 提案标记 rejected（冻结）
	got, _ := ps.Get(p.ID)
	if got.Status != ProposalRejected {
		t.Fatalf("冻结提案应 rejected，got %s", got.Status)
	}
	if !strings.Contains(got.VerifiedBy, "frozen") {
		t.Fatalf("冻结提案应带 frozen 证据，got %q", got.VerifiedBy)
	}
	// dsl.json 未变，判定继续用旧版
	if v := dslVersion(t, dsl); v != 1 {
		t.Fatalf("冻结后 dsl.json 应保持 v1，got v%d", v)
	}
}

// 严格门：LLM 复核调用失败 → 冻结，不落盘。
func TestApproveGated_LLMReviewFailureFreezes(t *testing.T) {
	dir := t.TempDir()
	dsl := NewDesignDSLStore(dir)
	if _, err := dsl.SeedDefault(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	ps := NewProposalStore(dir)
	p, err := ps.Create([]DSLDecl{{Rule: "design:no-op-io", Probe: "fs.copy", Expect: "复制必须处理错误"}}, "复核失败", "llm-revise")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	gate := VerifyGate{LLMReview: func(_ context.Context, _ []DSLDecl) ([]LLMVerdict, error) {
		return nil, context.DeadlineExceeded
	}}
	if _, err := ps.ApproveGated(context.Background(), p.ID, "r", dsl, gate); err == nil {
		t.Fatal("LLM 复核失败应冻结提案")
	}
	if v := dslVersion(t, dsl); v != 1 {
		t.Fatalf("复核失败后 dsl.json 应保持 v1，got v%d", v)
	}
}

// 严格门：LLM 复核未覆盖全部无谓词声明 → 冻结（防部分放行漏洞）。
func TestApproveGated_LLMReviewIncompleteFreezes(t *testing.T) {
	dir := t.TempDir()
	dsl := NewDesignDSLStore(dir)
	if _, err := dsl.SeedDefault(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	ps := NewProposalStore(dir)
	p, err := ps.Create([]DSLDecl{
		{Rule: "design:no-op-io", Probe: "fs.copy", Expect: "复制必须处理错误"},
		{Rule: "design:another-unknown", Probe: "net.http", Expect: "网络必须处理错误"},
	}, "复核不全", "llm-revise")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// 只复核了一条无谓词声明 → 覆盖不全 → 冻结
	gate := VerifyGate{LLMReview: func(_ context.Context, _ []DSLDecl) ([]LLMVerdict, error) {
		return []LLMVerdict{{Rule: "design:no-op-io", Result: "ok", Reason: "ok"}}, nil
	}}
	if _, err := ps.ApproveGated(context.Background(), p.ID, "r", dsl, gate); err == nil {
		t.Fatal("LLM 复核未覆盖全部无谓词声明应冻结")
	}
	if v := dslVersion(t, dsl); v != 1 {
		t.Fatalf("复核不全后 dsl.json 应保持 v1，got v%d", v)
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