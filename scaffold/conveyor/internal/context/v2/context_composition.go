// Package v2
// 最终上下文组装 + Token 预算核算
package v2

import (
	// "internal/context/v2/current_round.go"  // TODO: 调整为正确的 module path
	// "internal/context/v2/dynamic_injection.go"  // TODO: 调整为正确的 module path
)

// 按顺序组装所有层
func Compose() (string, error) {
	// TODO: 实现
	return "", nil  // TODO
}

// 128K 上限核算
func TokenBudget() int {
	// TODO: 实现
	return 0  // TODO
}

// 行为约束：按 L0→Summary→Sections→Current→Injection 顺序组装，超出预算触发折叠淘汰