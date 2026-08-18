// camera-dsl：Camera 设计 DSL 仓库 + 观测画像 + 偏差对比的命令行入口。
//
// 用法（在 go-camera 模块根运行）：
//   go run ./cmd/camera-dsl --project-root <projectRoot> seed
//   go run ./cmd/camera-dsl --project-root <projectRoot> actual <events.jsonl>
//   go run ./cmd/camera-dsl --project-root <projectRoot> diff
//
// 数据仓库位于 {projectRoot}/.agent/camera/。
package main

import (
	"os"
	"path/filepath"

	"go-camera/probe"
)

func main() {
	args := os.Args[1:]
	if probe.RunDSLCLI(args, cameraDir(args)) {
		return
	}
	os.Exit(1)
}

// cameraDir 解析 camera 数据目录。优先级：--project-root <root> → 当前目录。
func cameraDir(args []string) string {
	for i := 0; i < len(args)-1; i++ {
		if args[i] == "--project-root" {
			return filepath.Join(args[i+1], ".agent", "camera")
		}
	}
	cwd, _ := os.Getwd()
	return filepath.Join(cwd, ".agent", "camera")
}