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
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strings"
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
	Source     string         `json:"source"` // llm-revise / manual
	Reason     string         `json:"reason"` // 修订原因（审计依据）
	Decls      []DSLDecl      `json:"decls"`  // 提案的完整新声明集
	Status     ProposalStatus `json:"status"`
	ReviewedAt time.Time      `json:"reviewed_at,omitempty"`
	Reviewer   string         `json:"reviewer,omitempty"`
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

// Create 创建一条待审批提案，返回其 ID。不触碰 dsl.json（写盘权分离）。
func (s *ProposalStore) Create(decls []DSLDecl, reason, source string) (Proposal, error) {
	if err := validateDecls(decls); err != nil {
		return Proposal{}, err
	}
	p := Proposal{
		ID:        fmt.Sprintf("proposal-%d-%04x", time.Now().UnixNano(), rand.Intn(0x10000)),
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

// Approve 验证门审批：校验提案 → 借 DesignDSLStore.Save 定稿为新版本（并入审计）
// → 标记 approved。返回新版本号。仅 pending 提案可审批。
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
	ver, err := dsl.Save(p.Decls, p.Reason, p.Source)
	if err != nil {
		return 0, err
	}
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