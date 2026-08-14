package probe

// Package probe — 修订提案（P3 验证门审批，写盘权分离）。
//
// 原则：提案权与写盘权分离。修订提案驻留 {dir}/proposals/ 目录，只描述
// "想把设计 DSL 改成什么"，绝不触碰权威 dsl.json。只有经过验证门审批
// （approve）后，才借 DesignDSLStore.Save 定稿为新版本并入审计链。
// LLM 无直接写盘通道——它只能产提案，不能直接改权威契约。

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync/atomic"
	"time"
)

// ProposalStatus 是修订提案的生命周期状态。
type ProposalStatus string

const (
	ProposalPending  ProposalStatus = "pending"
	ProposalApproved ProposalStatus = "approved"
	ProposalRejected ProposalStatus = "rejected"
)

// Proposal 是一条待审批的 DSL 修订提案（写盘权分离的载体）。
type Proposal struct {
	ID         string         `json:"id"`
	CreatedAt  time.Time      `json:"created_at"`
	Source     string         `json:"source"` // llm-revise / manual / loop
	Reason     string         `json:"reason"` // 修订原因（审计依据）
	Decls      []DSLDecl      `json:"decls"`  // 提案的完整新声明集
	Status     ProposalStatus `json:"status"`
	ReviewedAt time.Time      `json:"reviewed_at,omitempty"`
	Reviewer   string         `json:"reviewer,omitempty"`
	VerifiedBy string         `json:"verified_by,omitempty"` // 验证门证据摘要（approve 时产出）
	Verification string       `json:"verification,omitempty"` // 验证详情（哪些规则可判定/需复核）
}

// ProposalStore 持久化修订提案。目录结构：
//
//	{dir}/proposals/<id>.json
type ProposalStore struct {
	dir string
}

// NewProposalStore 创建提案仓库。dir 为 camera 数据目录，提案落在其 proposals/ 子目录。
func NewProposalStore(dir string) *ProposalStore {
	return &ProposalStore{dir: filepath.Join(dir, "proposals")}
}

func (s *ProposalStore) path(id string) string { return filepath.Join(s.dir, id+".json") }

// proposalSeq 是进程内提案创建序列（保证同纳秒创建时 ID 递增，List 排序确定）。
var proposalSeq atomic.Int64

// nextProposalID 生成提案 ID：纳秒时间戳 + 递增序列。
// 同纳秒创建时序列决定 ID 大小序，从而 List 按创建顺序稳定排序。
func nextProposalID() string {
	seq := proposalSeq.Add(1)
	return fmt.Sprintf("proposal-%d-%04d", time.Now().UnixNano(), seq)
}

// Create 创建一条待审批提案，返回其 ID。不触碰 dsl.json（写盘权分离）。
func (s *ProposalStore) Create(decls []DSLDecl, reason, source string) (Proposal, error) {
	if err := validateDecls(decls); err != nil {
		return Proposal{}, err
	}
	p := Proposal{
		ID:        nextProposalID(),
		CreatedAt: time.Now().UTC(),
		Source:    source,
		Reason:    reason,
		Decls:     decls,
		Status:    ProposalPending,
	}
	if err := s.write(p); err != nil {
		return Proposal{}, err
	}
	return p, nil
}

// List 返回全部提案，按创建时间升序。
func (s *ProposalStore) List() ([]Proposal, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []Proposal
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(s.dir, e.Name()))
		if err != nil {
			continue
		}
		var p Proposal
		if err := json.Unmarshal(data, &p); err != nil {
			continue
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.Before(out[j].CreatedAt)
		}
		return out[i].ID < out[j].ID // 同纳秒创建时以 ID 决胜，保证确定性
	})
	return out, nil
}

// Get 读取指定提案。
func (s *ProposalStore) Get(id string) (Proposal, error) {
	var p Proposal
	data, err := os.ReadFile(s.path(id))
	if err != nil {
		return p, err
	}
	if err := json.Unmarshal(data, &p); err != nil {
		return p, err
	}
	return p, nil
}

// Approve 验证门审批：规则回归校验 → 借 DesignDSLStore.Save 定稿为新版本
// （并入审计）→ 标记 approved。仅 pending 提案可审批。
// 验证门（定稿方案 DSLVerify）：每条声明做"规则可判定性回归"——有确定性谓词的
// 规则标记 verified + verified_by 证据；无谓词的规则（需 LLM 判定）标记为
// needs-llm-review，不阻塞定稿但作为证据留痕。
func (s *ProposalStore) Approve(id, reviewer string, dsl *DesignDSLStore) (int, error) {
	p, err := s.Get(id)
	if err != nil {
		return 0, fmt.Errorf("approve: %v", err)
	}
	if p.Status != ProposalPending {
		return 0, fmt.Errorf("approve: 提案 %s 状态为 %s，仅 pending 可审批", id, p.Status)
	}
	if err := validateDecls(p.Decls); err != nil {
		return 0, fmt.Errorf("approve: 提案校验未通过: %v", err)
	}
	// ── 验证门：规则回归 ──
	reg := VerifyRuleRegression(p.Decls)
	final := finalizeDecls(p.Decls, reg)
	p.VerifiedBy = reg.Summary()
	p.Verification = reg.Describe()

	ver, err := dsl.Save(final, p.Reason, p.Source)
	if err != nil {
		return 0, err
	}
	// 定稿成功后才把验证证据落回提案（含定稿后的声明快照）
	p.Decls = final
	p.Status = ProposalApproved
	p.ReviewedAt = time.Now().UTC()
	p.Reviewer = reviewer
	if err := s.write(p); err != nil {
		return 0, err
	}
	return ver, nil
}

// Reject 拒绝提案。仅 pending 提案可拒绝。
func (s *ProposalStore) Reject(id, reviewer string) error {
	p, err := s.Get(id)
	if err != nil {
		return err
	}
	if p.Status != ProposalPending {
		return fmt.Errorf("reject: 提案 %s 状态为 %s，仅 pending 可拒绝", id, p.Status)
	}
	p.Status = ProposalRejected
	p.ReviewedAt = time.Now().UTC()
	p.Reviewer = reviewer
	return s.write(p)
}

func (s *ProposalStore) write(p Proposal) error {
	if err := os.MkdirAll(s.dir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path(p.ID), data, 0644)
}

// validateDecls 校验一个 DSL 声明集是否能作为权威契约写入。
// 验证门：rule/expect 为必填，声明集非空，防止空/畸形契约污染权威真相源。
func validateDecls(decls []DSLDecl) error {
	if len(decls) == 0 {
		return fmt.Errorf("声明集为空，至少需要 1 条声明")
	}
	for i, d := range decls {
		if strings.TrimSpace(d.Rule) == "" {
			return fmt.Errorf("第 %d 条声明缺少 rule", i+1)
		}
		if strings.TrimSpace(d.Expect) == "" {
			return fmt.Errorf("第 %d 条声明缺少 expect", i+1)
		}
	}
	return nil
}

// RuleRegression 是验证门（规则回归）的输出：声明集里哪些规则有确定性谓词
// 可"秒判"，哪些只能靠 LLM/人工复核。这是定稿方案 DSLVerify 的可复现证据。
type RuleRegression struct {
	Checked    int      `json:"checked"`              // 检查的声明总数
	Covered    int      `json:"covered"`              // 有确定性谓词的声明数（verified）
	Uncovered  []string `json:"uncovered,omitempty"`  // 无谓词、需 LLM/人工复核的 rule（去重有序）
}

// VerifyRuleRegression 对声明集做规则可判定性回归。
// 判定依据 = defaultRulePredicates()（与 Comparator 同源），保证"验证依据"
// 与"判定依据"一致，避免验证通过但实际判不了的契约。
func VerifyRuleRegression(decls []DSLDecl) RuleRegression {
	preds := defaultRulePredicates()
	r := RuleRegression{Checked: len(decls)}
	seen := map[string]bool{}
	for _, d := range decls {
		if _, ok := preds[d.Rule]; ok {
			r.Covered++
			continue
		}
		if !seen[d.Rule] {
			seen[d.Rule] = true
			r.Uncovered = append(r.Uncovered, d.Rule)
		}
	}
	sort.Strings(r.Uncovered)
	return r
}

// Summary 一行证据摘要（写入 Proposal.VerifiedBy）。
func (r RuleRegression) Summary() string {
	return fmt.Sprintf("rule-regression: %d/%d 声明可确定性判定", r.Covered, r.Checked)
}

// Describe 详细证据（写入 Proposal.Verification）。
func (r RuleRegression) Describe() string {
	if len(r.Uncovered) == 0 {
		return "全部规则有确定性谓词，可规则秒判"
	}
	return "无确定性谓词、需 LLM/人工复核的规则: " + strings.Join(r.Uncovered, ", ")
}

// finalizeDecls 验证门通过后，为每条声明补齐验证证据与状态（写进定稿快照）：
//   - 有谓词 → verified_by=rule-regression, status=verified
//   - 无谓词 → verified_by=needs-llm-review, status=proposed（保留待复核）
func finalizeDecls(decls []DSLDecl, reg RuleRegression) []DSLDecl {
	preds := defaultRulePredicates()
	out := make([]DSLDecl, len(decls))
	for i, d := range decls {
		out[i] = d
		if _, ok := preds[d.Rule]; ok {
			out[i].VerifiedBy = "rule-regression"
			out[i].Status = "verified"
			continue
		}
		out[i].VerifiedBy = "needs-llm-review"
		if out[i].Status == "" {
			out[i].Status = "proposed"
		}
	}
	return out
}