// go-trace：可从 design-canvas 独立构建的编译期插桩工具链（仅依赖标准库）。
// 模块路径取本地名，配合 -replace 或 vendoring 使用；trace-implant 注入的
// ttcImportPath 常量需指向目标工程内可解析的 tracecap 包路径。
module go-trace

go 1.26