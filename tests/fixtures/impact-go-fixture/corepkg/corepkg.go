// corepkg/corepkg.go —— 被 app 前缀调用 `corepkg.Process` 的底层包
package corepkg

// Process 与 other/other.go 的 Process 重名 → 全局唯一匹配 2 候选会跳过
func Process() error {
	return nil
}