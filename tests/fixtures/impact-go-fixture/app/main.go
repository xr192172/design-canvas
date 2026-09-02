// app/main.go —— impact 前缀解析夹具：经包路径 import + `corepkg.xxx` 前缀调用
// 验证：corepkg 目录下存在与别处重名的符号 Process 时（全局唯一 2 候选），
//       前缀 `corepkg` 命中 fileBindings → 精确建边，而非因重名漏连。
package main

import (
	pkg "corepkg"
)

func Run() {
	// 前缀调用：corepkg 连到 corepkg/corepkg.go → Process 应精确定位到该文件
	pkg.Process()
}