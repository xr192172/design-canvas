// other/other.go —— 与 corepkg/corepkg.go 的 Process 同名的干扰包
// 用途：制造"全局重名"。

package other

// Process 与 corepkg 的 Process 同签名重名 → 纯全局唯一匹配会得到 2 候选而跳过建边
func Process() error {
	return nil
}