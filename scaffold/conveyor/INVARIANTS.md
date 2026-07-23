# conveyor - 不变式与约束

## 跨文件不变式

- SectionQueue 不直接调 Memory.VectorStore（跨层禁止）
- DraftZone 必须在 CurrentRound 内，不能跨 section
- DynamicInjection 注入顺序：DraftZone 之后，ContextComposition 之前

## 全局行为约束

- 上下文窗口上限 128K（DeepSeek V4 Pro），超限触发 Section 折叠淘汰
- 单轮消息上限 CurrentRoundCap（EB×0.25，floor 64K），超限 mid-round 切分
- DraftZone 预算 30% × CurrentRoundCap，超限 LLM 主动 draft_drop
