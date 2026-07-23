// Package v2
// 当前轮对话 + DraftZone 草稿段
package v2

import (
	// "internal/context/v2/section_queue.go"  // TODO: 调整为正确的 module path
)

type CurrentRound struct {
	// TODO: 定义 CurrentRound 字段
}

func (r *CurrentRound) AddMessage(msg Message) {
	// TODO: 实现
}

// mid-round 切分新 section
func (r *CurrentRound) AdvanceConveyor() {
	// TODO: 实现
}

// 行为约束：单轮消息上限 CurrentRoundCap（EB×0.25，floor 64K），超限切分