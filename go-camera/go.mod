// go-camera：design-canvas 的动态插桩（摄像头/探针）工具链。
//
// 从 ai-base（已归档，不再更新）迁移而来，作为 design-canvas 的一部分：
// 摄像头（camera）捕获真实数据流，探针（probe）打点落盘为 JSONL，
// 契约判定（contract/cll_judge）比对设计 DSL 识别代码异味。后续并入
// design-canvas 主链路做代码异味探查。
//
// 仅依赖标准库（自包含，可独立构建），与 go-trace 一致。
module go-camera

go 1.26