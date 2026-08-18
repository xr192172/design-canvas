# Camera 插桩器实现规范（SPEC）

> 面向对象：**LLM**。当你需要为一种新语言（Python/Java/Rust/…）实现 camera 插桩器时，
> 按本规范开发，通过 `verify.mjs` 验收即正式接入。
>
> 设计依据见 [../docs/camera-abstract.md](../docs/camera-abstract.md)（语言无关契约：
> 数据流 / 事件 JSON Schema / 端口接口）。本文件只讲**怎么做、怎么验收**。

## 0. 你要构建什么

一个新语言的 **插桩器 CLI** + **探针 runtime 库**，两者职责分离：

| 产物 | 职责 | 参考实现 |
|---|---|---|
| 插桩器 CLI（编译期） | AST 分析源码 → 注入探针调用 → 输出插桩报告 | TS: `src/camera/instrument.ts`；Go: `go-camera/internal/instrument/` |
| 探针 runtime（运行期） | 提供 Capture 函数：落盘 JSONL 事件、限速、环形缓冲 | TS: `src/camera/probe.ts`；Go: `go-camera/internal/probe/probe.go` |

## 1. 插桩语义（必须全部满足）

### 1.1 四类插桩点 + 三级标签

| kind | 注入位置 | level | 记录内容 |
|---|---|---|---|
| `enter` | 函数体开头 | core | 入参（每参数名→值） |
| `exit` | 每条 return 处；无 return 的函数在体末尾补一个 | core | 返回值 |
| `catch` | catch/except/rescue 块开头 | event | err/message |
| `io` | 写盘调用（writeFile/mkdir/all 等）之后 | event | op 名 |
| `deep`（可选） | 分支/循环判定处 | deep | 条件原文与走向 |

**语义等价铁律**：return 改写时表达式只求值一次（先存临时变量再记录后返回）。

### 1.2 探针名格式

```
<scope>.<FuncName>.<suffix>
```

- scope：TS 用模块名（文件名去扩展名），Go 用包名，其他语言取最接近的模块/命名空间概念
- suffix：`enter` / `exit` / `catch` / `<ioOp>`（如 writefile/mkdirall）/ deep 场景描述
- 事件 fields 必含：`file`（相对路径）、`level`

### 1.3 幂等与还原

- **幂等**：注入前检测探针标记（如 `camera:instrumented` 注释），已插桩文件跳过
- **备份**：改写前把原文件备份（如 `.design-canvas/camera-backup/`）
- **还原**：`--restore` 从备份恢复原文件，返回还原文件数

### 1.4 双模式

- **契约模式**：`--probes '<json数组>'` 只注入清单内的探针点，其余跳过（降噪）
- **探索模式**：默认（不传 --probes），全量无脑插桩——用于挖掘未知问题，发现真问题后把探针点提升进 DSL 长期盯守

## 2. CLI 契约（验收的关键）

```
<cmd> <file|dir> [--probes '<json>'] [--deep] [--restore]
```

- 退出码：0 成功 / 非 0 失败
- **stdout 输出 JSON 报告**（verify.mjs 依赖此格式）：

```json
{
  "files": [
    { "file": "rel/path.ts", "sites": [
      { "line": 10, "kind": "enter", "level": "core", "probe": "sample.addTwo.enter" }
    ], "error": null }
  ],
  "restored": 0
}
```

- `--restore` 时 `restored` 为还原文件数，`files` 为空数组
- 插桩报告的 `probe` 必须与运行时事件里探针自报的名字**完全一致**

## 3. 探针 runtime 要求

1. Capture(name, fields, source) → 追加一行 JSON 到 `CAMERA_EVENTS_FILE` 环境变量指定的 JSONL
2. 事件格式对齐 [camera-abstract.md §2](../docs/camera-abstract.md) 的 JSON Schema（`probe/time/source/fields`）
3. 未设置环境变量时 no-op（零开销），不抛错
4. 限速（每探针 ~200/s）+ 环形缓冲（~64MB × N 份封顶），防止磁盘打爆
5. 语言无对应 Capture 前缀缓存概念时可忽略缓存优化，功能优先

## 4. 验收流程

```bash
node camera-conformance/verify.mjs --lang <ts|go|新语言>
```

verify.mjs 做三件事（全绿 = 接入成功）：

1. **静态断言**：对 `samples/sample.<lang>` 跑插桩器 → 探针清单与 `samples/expected-probes.<lang>.json` 精确一致（集合相等，含 kind/level/probe）
2. **幂等断言**：同一文件跑两次，第二次 sites 为空
3. **还原断言**：`--restore` 后文件内容与原件逐字节一致

可选第四步（语言运行时可用时）：执行插桩后样例 → 校验事件 JSONL 符合 schema。

## 5. 新语言接入指南（给 LLM 的操作序列）

1. 读本文件 + [camera-abstract.md](../docs/camera-abstract.md)
2. 选一个参考实现精读（推荐 TS 版——tree-sitter 支持绝大多数语言，思路可迁移）：
   - TS 路线：tree-sitter 解析 → 节点字节偏移从后往前注入文本 → 顶部补 import
   - Go 路线：语言官方 AST 包重写 → printer 输出
3. 选择该语言的 AST 工具：优先官方 AST（Python `ast`/`libcst`、Java `JavaParser`、Rust `syn`/`ra-ap-syntax`…）；tree-sitter 有该语言 grammar 时直接复用 TS 版思路
4. 实现 CLI（§2 契约）+ runtime（§3）
5. 写 `samples/sample.<lang>`（对照 `_reference.md` 的语义清单）+ `expected-probes.<lang>.json`
6. 跑 verify → 全绿 → 更新 camera-abstract.md §4 接入矩阵 + 本目录 README 矩阵

## 6. 黄金样例语义清单

样例代码必须覆盖（见 `samples/_reference.md`），保证各语言样例语义一致、expected 清单可对照：

1. 带参数与返回值的函数（enter + exit）
2. 多 return 路径函数（exit × 2，验证临时变量改写）
3. 无返回值函数（末尾隐式 exit）
4. catch/except 捕获并吞错的函数（catch，静默丢错场景）
5. 写盘 IO 函数（io）
6. 入口调用（让样例可执行，产出运行时事件）
