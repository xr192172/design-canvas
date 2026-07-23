// Package v2
// LLM 主动管理的草稿段（~19K token 预算）
package v2

type DraftZone struct {
	// TODO: 定义 DraftZone 字段
}

func (r *DraftZone) AddDraft(content string) (int, error) {
	// TODO: 实现
	return 0, nil  // TODO
}

func (r *DraftZone) DropDraft(index int) bool {
	// TODO: 实现
	return false  // TODO
}

func (r *DraftZone) ClearDraft() {
	// TODO: 实现
}

// 行为约束：预算 30% × CurrentRoundCap，超限 AddDraft 返回 error，LLM 需 draft_drop