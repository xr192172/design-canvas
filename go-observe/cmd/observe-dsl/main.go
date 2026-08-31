// observe-dsl：Observe 设计 DSL 仓库 + 观测画像 + 偏差对比的命令行入口。
//
// 用法（在 go-observe 模块根运行）：
//   go run ./cmd/observe-dsl --project-root <projectRoot> seed
//   go run ./cmd/observe-dsl --project-root <projectRoot> actual <events.jsonl>
//   go run ./cmd/observe-dsl --project-root <projectRoot> diff
//
// 数据仓库位于 {projectRoot}/.agent/observe/。
package main

import (
	"os"
	"path/filepath"

	"go-observe/probe"
)

func main() {
	args := os.Args[1:]
	if probe.RunDSLCLI(args, observeDir(args)) {
		return
	}
	os.Exit(1)
}

// observeDir 解析 observe 数据目录。优先级：--project-root <root> → 当前目录。
func observeDir(args []string) string {
	for i := 0; i < len(args)-1; i++ {
		if args[i] == "--project-root" {
			return filepath.Join(args[i+1], ".agent", "observe")
		}
	}
	cwd, _ := os.Getwd()
	return filepath.Join(cwd, ".agent", "observe")
}