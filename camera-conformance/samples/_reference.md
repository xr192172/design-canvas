# 黄金样例语义清单（各语言样例必须语义等价）

> expected-probes.<lang>.json 由该语言**参考插桩器**对样例真实跑出后固化，
> 语言惯用差异（如 Go 无 catch、用 err 分支）允许在 expected 中体现。

| # | 语义 | 验证点 |
|---|---|---|
| 1 | `addTwo(a,b)` 带参带返回值 | enter(含 args) + exit(含 ret) |
| 2 | `clamp(v,lo,hi)` 多 return 路径 | exit × 3；return 表达式只求值一次 |
| 3 | `log(msg)` 无返回值 + 提前 return | 无值 exit + 末尾隐式 exit |
| 4 | `saveQuiet(path,data)` 写盘且吞错 | io(writefile)；TS=catch 吞错 / Go=err 分支吞错 |
| 5 | `main()` 调用全部函数 | 样例可执行，产出运行时事件流 |
