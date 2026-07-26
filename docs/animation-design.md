# 动画系统设计文档

> 本文档定义 design-canvas 的动画 DSL 设计——将动画从"装饰"升级为"可执行的开发文档载体"。
>
> 状态：设计中 | 创建：2026-07-23 | 关联：[design.md](./design.md) / [evolution.md](./evolution.md)

---

## 1. 核心定位

### 1.1 一句话定义

**动画 = 数据流的可视化执行**。不是 UI 装饰，而是设计文档的"运行时视图"。

### 1.2 要解决的问题

LLM 协作开发时依赖项目文档（README / 设计文档 / 注释），但文档会滞后、会失真、会和代码脱节。

design-canvas 的动画系统要让 DSL 成为**唯一可信的开发文档载体**：

- **施工图纸**：每个节点 = 一个文件/模块，边 = 数据流向，动画展示运行时的值流转
- **使用指南**：动画演示"输入什么 → 经过什么处理 → 输出什么"，看图即懂用法
- **演示文稿**：动画可播放/暂停/步进，向他人展示系统行为

### 1.3 核心原则

1. **动画是语义的动态视角**——semantic 层描述"文件有什么 API"（静态），animations 层描述"数据怎么流、值怎么变"（动态）。两者是同一事物的两个视角
2. **任意阶段可上手**——从"只有一个草图"到"完整可执行"的任意阶段，动画都能跑。这是通过分层精度实现的
3. **双向可逆**——正向（动画 DSL → 代码骨架）和反向（已有代码 → 动画 DSL）都支持
4. **反推价值**——动画定义清楚了，每个文件该实现什么自然就清楚了

---

## 2. 分层精度（L0-L5）

动画 DSL 有 6 个精度等级，每层都是有效的终点——不会因为没写到 L5 就跑不起来。

### 2.1 等级定义

| 级别 | 名称 | 需要写什么 | 动画效果 | 谁来写 |
|------|------|-----------|---------|--------|
| **L0** | 骨架 | 只画节点+边（现有 geometry） | 粒子沿边周期性流动 | LLM 自动初始化 |
| **L1** | 状态 | 节点加 status 字段（现有 semantic） | 状态变化时颜色闪烁 | LLM 自动初始化 |
| **L2** | 数据流 | 开始引入 `animations` 字段，定义"值类型"在节点间的流转 | 粒子携带类型标签，节点处显示输入→输出转换 | LLM 显式声明 |
| **L3** | 条件 | animations 里加分支规则 | 粒子按条件走不同路径，判断处高亮 | LLM 显式声明 |
| **L4** | 函数 | semantic.files 绑定函数签名 | 节点显示函数调用详情，可点击查看 | LLM + backfill |
| **L4.5** | 异常 | animations 的 handler 加 errors 声明 | 预期异常走红色路径，未声明异常触发警报（发现 bug） | LLM + backfill |
| **L5** | 可执行 | 接入真实代码 | 动画 = 实际运行结果，运行时异常对照 errors 声明 | backfill 反向提取 |

### 2.2 关键设计决策

**L0-L1 零成本**：
- 不需要写 `animations` 字段
- 系统从现有 `geometry`（节点+边）和 `semantic`（status 字段）**自动推导**动画
- LLM 初始化时只画图就行，和现在的工作流完全一致

**L2 才引入 animations 字段**：
- L2 是"数据流语义"的起点
- 之前的 L0-L1 都是系统默认行为，不需要显式声明
- 从 L2 开始，用户/LLM 才需要思考"数据是什么、怎么流转"

**每层都是终点**：
- 在 L0 停住 → 有粒子流动画，能展示大致流程
- 在 L2 停住 → 有数据类型标签和转换演示，能理解数据流
- 在 L5 停住 → 动画就是实际运行，能验证代码正确性
- 不会因为"没写完"而跑不起来

### 2.3 渐进式深化工作流

```
LLM 听了用户想法
  ↓
快速画节点+边（L0）→ 自动粒子流动画
  ↓
用户深入设计每个节点的状态
  ↓
给节点加 status 字段（L1）→ 自动状态高亮
  ↓
用户开始定义数据流
  ↓
写 animations.triggers（L2）→ 粒子携带类型标签
  ↓
用户定义条件分支
  ↓
animations 加 branch 规则（L3）→ 路径选择高亮
  ↓
用户绑定具体函数
  ↓
semantic.files 加 expected_apis（L4）→ 节点显示调用详情
  ↓
代码实现完成
  ↓
backfill_scaffold 反向提取（L5）→ 动画=实际运行
```

### 2.4 已有项目升级工作流

```
已有代码项目
  ↓
TreeSitterKernel 解析 → 提取函数调用链/状态机
  ↓
自动生成 L3/L4 级动画 DSL
  ↓
用户在动画基础上修改升级
  ↓
正向验证：修改后的 DSL → 重新生成骨架 → 对比差异
```

> **注意**：反向提取（代码→动画）是 L5 级能力的核心，但优先级不高。先把正向（DSL→动画）完善，反向作为后续增强。

---

## 3. DSL Schema 草案

### 3.1 L0-L1：零成本（无 animations 字段）

L0-L1 不需要任何 animations 字段。系统从现有 DSL 自动推导：

```json
{
  "geometry": {
    "nodes": [
      { "id": "node_auth", "x": 100, "y": 100, "width": 120, "height": 60, "label": "认证服务" },
      { "id": "node_api", "x": 300, "y": 100, "width": 120, "height": 60, "label": "API 网关" }
    ],
    "edges": [
      { "id": "e1", "from": "node_auth", "to": "node_api" }
    ]
  },
  "semantic": {
    "files": [
      { "id": "node_auth", "status": "done" },
      { "id": "node_api", "status": "in_progress" }
    ]
  }
}
```

**系统自动推导**：
- 有边 `e1` → 周期性粒子从 `node_auth` 流向 `node_api`
- `node_api` status = in_progress → 该节点有橙色状态指示器

### 3.2 L2：数据流（引入 animations 字段）

```json
{
  "geometry": { "...同上..." },
  "semantic": { "...同上..." },
  "animations": {
    "version": 1,
    "flows": [
      {
        "id": "flow_auth_token",
        "trigger": {
          "type": "periodic",
          "interval": 3000
        },
        "from": "node_auth",
        "to": "node_api",
        "value": {
          "type": "auth_token",
          "label": "JWT Token",
          "fields": {
            "type": "object",
            "properties": {
              "token": { "type": "string" },
              "expires_at": { "type": "number" },
              "claims": {
                "type": "object",
                "properties": {
                  "user_id": { "type": "string" },
                  "roles": { "type": "array", "items": { "type": "string" } }
                }
              }
            }
          }
        }
      }
    ]
  }
}
```

**动画效果**：
- 每 3 秒，一个携带 "JWT Token" 标签的粒子从 `node_auth` 流向 `node_api`
- 粒子上显示值类型标签
- 到达 `node_api` 后，节点处短暂显示"输入: auth_token → 输出: ???"（输出未定义时显示 ???）

### 3.3 L3：条件分支

```json
{
  "animations": {
    "version": 1,
    "flows": [
      {
        "id": "flow_request",
        "trigger": { "type": "periodic", "interval": 2000 },
        "from": "node_api",
        "branches": [
          {
            "condition": "value.status == 200",
            "to": "node_handler",
            "value": { "type": "success_response", "label": "成功响应" }
          },
          {
            "condition": "value.status == 401",
            "to": "node_auth",
            "value": { "type": "auth_error", "label": "认证失败" }
          }
        ]
      }
    ]
  }
}
```

**动画效果**：
- 粒子到达 `node_api` 后，根据条件走不同路径
- 条件判断处高亮闪烁
- 不同分支的粒子颜色不同（成功=绿，失败=红）

### 3.4 L4：函数绑定

```json
{
  "semantic": {
    "files": [
      {
        "id": "node_auth",
        "path": "internal/auth/service.go",
        "expected_apis": [
          { "signature": "func Authenticate(token string) (*Claims, error)" }
        ]
      }
    ]
  },
  "animations": {
    "flows": [
      {
        "id": "flow_auth",
        "from": "node_auth",
        "to": "node_api",
        "value": { "type": "auth_token" },
        "handler": {
          "file_id": "node_auth",
          "api": "Authenticate",
          "input_mapping": { "token": "$value.token" },
          "output_mapping": { "$value.claims": "$result" }
        }
      }
    ]
  }
}
```

**动画效果**：
- 粒子到达 `node_auth` 时，节点显示函数调用 `Authenticate(token)`
- 处理完成后，粒子携带返回值继续流动
- 可点击节点查看函数签名详情

### 3.5 L4.5：异常语义

在 L4 函数绑定基础上，为 handler 声明异常路径。异常分两档：

- **expected**（业务异常）：如 401 认证失败、余额不足——走红色粒子到对应处理节点，不报警
- **unexpected**（系统 bug）：如 panic、nil pointer——节点闪烁 + 日志标红 + 暂停可查看

```json
{
  "animations": {
    "flows": [
      {
        "id": "flow_auth",
        "from": "node_auth",
        "to": "node_api",
        "value": { "type": "auth_token" },
        "handler": {
          "file_id": "node_auth",
          "api": "Authenticate",
          "input_mapping": { "token": "$value.token" },
          "output_mapping": { "$value.claims": "$result" },
          "errors": [
            {
              "type": "ErrInvalidToken",
              "condition": "result.error.code == 401",
              "severity": "expected",
              "to": "node_auth_retry",
              "value": { "type": "auth_error", "label": "Token 无效" },
              "effect": "particle_red"
            },
            {
              "type": "ErrExpired",
              "condition": "result.error.code == 403",
              "severity": "expected",
              "to": "node_auth_refresh",
              "value": { "type": "auth_expired", "label": "Token 过期" },
              "effect": "particle_red"
            },
            {
              "type": "panic",
              "condition": "result.panic == true",
              "severity": "unexpected",
              "to": "node_error_handler",
              "effect": "node_flash_red",
              "log": "CRITICAL: Authenticate panicked"
            }
          ]
        }
      }
    ]
  }
}
```

**动画效果**：
- 正常返回 → 粒子携带 claims 继续流向 `node_api`（绿色）
- `result.error.code == 401` → 红色粒子流向 `node_auth_retry`，不报警
- `result.panic == true` → `node_auth` 闪烁红光 + 日志面板标红 + 可暂停查看（unexpected = 潜在 bug）

**发现 bug 的机制**：

L5 live 模式运行时，实际抛出的异常会对照 `errors` 声明：

| 实际异常 | errors 声明 | 结果 |
|---------|-----------|------|
| `ErrInvalidToken` | 已声明（expected） | 走红色路径，正常 |
| `ErrNetworkTimeout` | 未声明 | 标记"未声明异常"，触发 unexpected 警报 |
| `panic: nil pointer` | 已声明（unexpected） | 节点闪烁，日志标红 |
| `panic: index out of range` | 未声明 | 标记"未声明 panic"，触发 critical 警报 |

**反推价值**：

```
animations.flows[].handler.errors[].type = "ErrInvalidToken"
→ semantic.files[].expected_apis 的 Authenticate 必须返回 error
→ scaffold 生成骨架时，Authenticate 签名含 error 返回值
→ scaffold 生成对应的 errors.go 定义 ErrInvalidToken
→ backfill 检查实际代码是否处理了 ErrInvalidToken
→ live 运行时抛出未声明的异常 → 发现 bug
```

### 3.6 L5：可执行（反向提取）

L5 不需要手写 DSL，由 `backfill_scaffold` 从代码中反向提取：

```
已有代码 → TreeSitterKernel 解析 → 提取调用链 → 生成 L4 级 animations DSL
→ 运行时接入实际函数 → 动画展示真实数据
```

L5 的 animations 字段会自动包含 `runtime` 配置：

```json
{
  "animations": {
    "version": 1,
    "runtime": {
      "mode": "live",
      "code_dir": "./internal",
      "entry": "main.go"
    },
    "flows": [
      {
        "id": "flow_auth_live",
        "from": "node_auth",
        "to": "node_api",
        "handler": {
          "file_id": "node_auth",
          "api": "Authenticate",
          "live": true
        }
      }
    ]
  }
}
```

---

## 4. 默认行为规则（L0-L1 自动推导）

L0-L1 不需要 animations 字段，系统按以下规则自动推导动画：

### 4.1 L0 默认规则

| 条件 | 自动动画 |
|------|---------|
| 存在 edge（任何类型） | 粒子沿边周期性流动（默认间隔 4 秒，颜色取边 stroke） |
| 存在 sim-edge | 粒子流动 + 到达终点后转换为可拖拽容器（data-shape=true） |

### 4.2 L1 默认规则

| 条件 | 自动动画 |
|------|---------|
| 节点有 status 字段 | 状态变化时颜色闪烁一次（300ms） |
| 节点有 status=in_progress | 节点边框脉冲呼吸效果 |
| 节点有 contains 关系 | 子元素进出时淡入/淡出（200ms） |

### 4.3 默认行为与显式声明的关系

- 如果 DSL **没有** `animations` 字段 → 完全使用默认行为
- 如果 DSL **有** `animations` 字段 → 默认行为仍生效，但 `animations.flows` 中显式定义的流会**覆盖**同路径的默认粒子流
- 即：显式声明是"增强"而非"替代"——你没写的部分仍有默认动画

---

## 5. 通用执行器架构

### 5.1 设计目标

- **不硬编码任何项目特定逻辑**——conveyor 的 Section 卡片动画不应出现在执行器里
- **可扩展**——新的 effect 类型可以通过注册方式加入
- **可暂停/步进**——设计文档要求，必须支持

### 5.2 架构

```
AnimationExecutor（通用执行器）
├── TriggerEngine        // 监听事件/定时器/条件，触发 flow
├── ParticleRenderer     // 渲染粒子沿路径运动
├── EffectRegistry       // 注册 effect 类型（fade_in / slide_out / height_transition ...）
├── ValueTracker         // 跟踪值在节点间的流转和转换
├── ConditionEvaluator   // 评估分支条件（L3）
├── PlaybackController   // 播放/暂停/步进/重置
└── StateManager         // 管理动画状态（与仿真器状态联动）
```

### 5.3 Effect 类型注册

执行器不硬编码效果，而是通过注册表扩展。当前已实现的内置 effect（详见附录 B）：

```javascript
// 渲染器启动时注册内置 effect（已实现 ✅）
EffectRegistry.register('card_create', CardCreateEffect);      // L2+: 卡片创建（淡入）
EffectRegistry.register('card_fold', CardFoldEffect);          // L2+: 卡片折叠（高度过渡）
EffectRegistry.register('card_evict', CardEvictEffect);        // L2+: FIFO 淘汰（左滑淡出）
// 默认粒子流由 spawnDefaultParticle 内置处理，effect 名为 'particle_flow'

// 计划中（未实现）
// EffectRegistry.register('fade_in', FadeInEffect);
// EffectRegistry.register('slide_out', SlideOutEffect);
// EffectRegistry.register('height_transition', HeightTransitionEffect);
// EffectRegistry.register('highlight', HighlightEffect);
// EffectRegistry.register('panel_append', PanelAppendEffect);
```

**调用链路**：`spawnDefaultParticle(flow)` 在生成粒子前，先检查 `flow.effect` 是否在注册表中。若已注册且返回 `true`，则跳过默认粒子流；若 effect 抛错或返回 `false`，自动回退到默认粒子流。这保证 effect 失败不会让动画完全停摆。

**手动触发**：通过 `window.__animV2__.triggerEffect(name, options)` 可在控制台或 L5 运行时手动触发任意已注册 effect（详见附录 B.5）。

### 5.4 与现有仿真器的关系

当前 `simulation` 字段（事件+规则+初始状态）是**数据源**，`animations` 字段是**展示方式**：

```
simulation（数据源）          animations（展示方式）
┌─────────────────┐          ┌─────────────────────┐
│ events          │          │ flows               │
│ rules           │ ──触发──→ │ triggers            │
│ initial_state   │          │ effects             │
│ mappings        │          │ values              │
└─────────────────┘          └─────────────────────┘
       ↓                            ↓
  状态变化                    动画播放
```

- `simulation` 定义"什么时候、什么条件、改什么状态"
- `animations` 定义"状态变化时，怎么展示"
- 两者通过节点 ID 和状态字段关联

---

## 6. 与 semantic 层的关系

### 6.1 两个视角

| 层 | 视角 | 描述什么 |
|----|------|---------|
| `semantic` | 静态结构 | 文件有什么 API、什么职责、什么依赖 |
| `animations` | 动态行为 | 数据怎么流、值怎么变、什么条件触发 |

### 6.2 关联方式

- 通过 `file_id`（= 节点 ID）关联
- `semantic.files[].id` 对应 `animations.flows[].from` / `to` / `handler.file_id`
- 状态字段共享：`semantic.files[].status` 的变化同时触发 L1 默认动画和 L2+ 显式动画

### 6.3 互相补全

- `semantic` 缺信息时，`animations` 可以补全（如 animations 定义了值类型，semantic 没写 → 反推 semantic 需要定义对应的输入/输出类型）
- `animations` 缺信息时，`semantic` 可以补全（如 animations 没写 handler，semantic 有 expected_apis → 自动绑定）

### 6.4 反推价值

动画 DSL 定义清楚后，可以反推每个文件需要实现什么：

```
animations.flows[].handler.api = "Authenticate"
→ semantic.files[].expected_apis 必须包含 "Authenticate"
→ scaffold 生成骨架时必须生成 Authenticate 函数
→ backfill 检查实际代码是否有 Authenticate
```

---

## 7. conveyor 迁移计划

### 7.1 迁移策略

**先设计通用 DSL，再用 conveyor 验证**——而非拿 conveyor 当参考来抽象。

conveyor 的需求类型（数据流、状态变化、容器管理、值转换）可以告诉我们要覆盖哪些场景，但具体实现重新设计。

### 7.2 conveyor 动画归类

| conveyor 现有动画 | 归类 | 迁移方式 |
|------------------|------|---------|
| 消息粒子沿 sim-edge 流动 | L0 默认行为 | 自动推导，无需显式声明 |
| 粒子到达终点转可拖拽容器 | L0 默认行为 | 自动推导，无需显式声明 |
| 节点 status 变化高亮 | L1 默认行为 | 自动推导，无需显式声明 |
| Section 卡片创建淡入 | L2 显式声明 | `card_create` effect |
| Section 卡片折叠/展开 | L2 显式声明 | `card_fold` effect |
| Section FIFO 淘汰左滑 | L2 显式声明 | `card_evict` effect |
| 右侧消息流面板更新 | L2 显式声明 | `panel_append` effect |

### 7.3 迁移步骤

1. **设计通用执行器**——按第 5 章架构实现，注册 8-10 个内置 effect
2. **实现 L0-L1 默认行为**——替换当前 scripts.ts 中的粒子/状态高亮代码
3. **为 conveyor 编写 L2 级 animations 字段**——在 conveyor.json 中声明 card_create/card_fold/card_evict 等 flow
4. **删除 scripts.ts 中的专用动画代码**——`createSectionCardContainer` / `updateSectionVisuals` 等，改为通用执行器读取 animations 字段播放
5. **验证**——conveyor 动画效果应与迁移前一致或更好

### 7.4 从 scripts.ts 抽出动画模块

迁移过程中，将 scripts.ts 末尾的动画代码（约 1550 行，3129-4677）抽出为独立模块：

```
src/renderer/
├── scripts.ts          // 主脚本（缩减后约 3000 行）
├── animation/
│   ├── executor.ts     // AnimationExecutor 通用执行器
│   ├── effects.ts      // 内置 effect 注册
│   ├── defaults.ts     // L0-L1 默认行为推导
│   └── playback.ts     // 播放/暂停/步进控制
```

这同时完成了 [evolution.md](./evolution.md) 中记录的 "scripts.ts 拆分" 技术债。

---

## 8. 实施路径

### 8.1 阶段划分

| 阶段 | 内容 | 依赖 | 产出 |
|------|------|------|------|
| **A** | DSL schema 定义 + 类型 | 无 | `src/dsl/types.ts` 加 AnimationFlow 等类型 |
| **B** | L0-L1 默认行为执行器 | A | 通用粒子流 + 状态高亮，替换现有专用代码 |
| **C** | L2 数据流执行器 | B | 值类型标签 + 节点处输入/输出展示 |
| **D** | 内置 effect 注册（card_create/fold/evict） | C | conveyor 卡片动画迁移 |
| **E** | conveyor.json 迁移到 L2 | D | 删除 scripts.ts 专用动画代码 |
| **F** | L3 条件分支 | E | 路径选择高亮 |
| **G** | L4 函数绑定 | F | 节点显示函数调用详情 |
| **G2** | L4.5 异常语义 | G | handler.errors 声明 + expected/unexpected 分档 + 未声明异常警报 |
| **H** | L5 反向提取（backfill 增强） | G2 | 从代码提取动画 DSL + 异常声明 |
| **I** | 播放控制（暂停/步进） | E | PlaybackController |

### 8.2 优先级

- **阶段 A-E**：核心价值，优先完成。完成后 conveyor 迁移到通用动画系统，scripts.ts 技术债解决
- **阶段 F-G**：增强能力，中等优先级
- **阶段 G2**：异常语义，中等优先级——让动画具备"发现 bug"能力，依赖 L4 完成
- **阶段 H**：反向提取，低优先级（用户确认不急）
- **阶段 I**：播放控制，可并行进行

### 8.3 验收标准

每个阶段完成后验证：

1. **DSL 校验通过**——新增的 animations 字段通过 schema 校验
2. **默认行为正确**——无 animations 字段时，L0-L1 动画自动生效
3. **显式声明生效**——有 animations 字段时，显式 flow 覆盖默认行为
4. **conveyor 效果一致**——迁移后 conveyor 动画与迁移前效果一致或更好
5. **无硬编码**——执行器代码中不出现 `node_section_queue` 等项目特定 ID
6. **scripts.ts 缩减**——动画代码抽出后，scripts.ts 体积显著下降
7. **异常分档正确**（G2 后）——expected 异常走红色路径不报警，unexpected 异常触发警报
8. **未声明异常发现**（G2 + H 后）——live 运行时未声明的异常被标记为"未声明 bug"

### 8.4 实现进度

| 阶段 | 状态 | 关键产出 | 验证情况 |
|------|------|---------|---------|
| **A** DSL schema 定义 | ✅ 完成 | [types.ts](file:///d:/project_develop/design-canvas/src/dsl/types.ts) 新增 AnimationFlow / AnimationValue / AnimationHandler / AnimationBranch / AnimationSystem 接口；DesignDSL 扩展 `animations_v2?` 字段 | tsc 编译通过 |
| **B** L0-L1 默认行为 | ✅ 完成 | [animation_engine.ts](file:///d:/project_develop/design-canvas/src/renderer/animation_engine.ts) 实现粒子流自动推导（跳过 sim-edge / contains 边）、状态变化闪烁（300ms）、in_progress 呼吸效果 | conveyor 验证：8 条默认流，浅蓝粒子 |
| **C** L2 数据流执行器 | ✅ 完成 | 显式 flow 支持（periodic / event 触发器）、粒子值类型标签（粒子上方显示）、节点 IO 提示浮层（输入: xxx / 输出: ???）、仿真器事件桥接（`window.__simEventListener__`） | conveyor.json 3 个 L2 flow 验证通过 |
| **D** 内置 effect 注册 | ✅ 完成 | card_create / card_fold / card_evict 三个 effect 注册；通用卡片容器机制（`ensureCardContainer` 自动创建 `<g data-card-container>`）；`triggerEffect` 手动触发接口 | 浏览器实测：创建/折叠/淘汰三步链路全通过 |
| **E** conveyor.json 迁移 | ✅ 完成 | conveyor.json 声明 `card_sync` flow（state_change 触发器监听 `sections`）+ `runtime.sim_particles`（on_arrive: chip）；scripts.ts 删除全部专用动画代码（消息流面板/粒子系统/卡片动画，processEvent 改为 `__simRuleFired__` 通知引擎 + 暴露 `window.simState`）；引擎新增 sim-edge 粒子流、card_sync effect、state_change 轮询（300ms 快照对比）；html_renderer 删消息流按钮、sim-panel 加动画控制按钮（⏸暂停/⏭步进/▶继续/↺重置） | 浏览器全链路 PASS，见下方验证记录 |
| **F** L3 条件分支 | ✅ 完成 | [anim_core.ts](file:///d:/project_develop/design-canvas/src/renderer/anim_core.ts) 纯逻辑核心（evalCondition / pickBranch / createMockRotator / resolvePath / setPath / input/output mapping / matchError / makeSnapshot），构建期经 [gen_anim_core_bundle.mjs](file:///d:/project_develop/design-canvas/scripts/gen_anim_core_bundle.mjs) 内联进引擎（单源双消费：vitest + 浏览器）；引擎 `spawnDefaultParticle` 分支选路 + 判断处闪烁 + 分支调色板（particle_red/green 显式指定优先）；schema/types 新增 `branches` / `mock_values` / `handler`（含 L4.5 errors） | vitest 28 用例全绿 + 浏览器双例验证，见下方验证记录 |
| **G** L4 函数绑定 | ✅ 完成 | AnimCore 新增 parseApiName / formatHandlerArgs；引擎 `executeHandler`（粒子出发前查 HANDLER_META 表）+ `showHandlerCall` 金色函数调用浮层（ƒ Api(args) + signature，1.8s 淡出）+ handler 节点黄色闪烁；flowConfig 装配 handlerRotator（mock_results 轮换优先于 mock_result）；storage.ts 引入 DESIGN_CANVAS_HOME 修复测试污染活态 DSL | 见下方验证记录 |
| **G2** L4.5 异常语义 | ✅ 完成 | AnimCore 新增 isErrorResult / classifyError（declared/undeclared/none 三分）；引擎异常短路（优先于分支与正常流）+ handleDeclaredError（expected 红路径不报警 / unexpected 红闪+error 日志）+ handleUndeclaredError（critical 警报"疑似 bug"）+ spawnErrorParticle；sim-panel 新增"异常日志（L4.5）"面板（#anim-log，warn/error/critical 三级样式，critical 脉冲动画，上限 30 条）；types/schema 新增 mock_result/mock_results | vitest 44 用例全绿 + Playwright 全链路验证，见下方验证记录 |
| **H** L5 反向提取 | ⏳ 计划 | 从代码提取动画 DSL + 异常声明 | — |
| **I** 播放控制 | ✅ 基础完成 | sim-panel 动画控制按钮接线引擎 pause/step/resume/reset（`setupControlButtons`） | 浏览器点击验证无报错 |

**阶段 D 验证记录**（2026-07-24）：

浏览器控制台手动触发三步链路：
1. `triggerEffect('card_create', { to: 'node_section_queue', value: { id: 'test_card_1', ... } })` → 返回 `true`，卡片创建成功，rect 坐标 `(148, 226, 884, 50)`
2. `triggerEffect('card_create', { ... value: { id: 'test_card_2', ... } })` → 第二张卡片创建，自动重排布局
3. `triggerEffect('card_fold', { ... value: { cardId: 'test_card_1' } })` → 折叠动画执行
4. `triggerEffect('card_evict', { ... to: 'node_section_queue' })` → FIFO 淘汰 test_card_1，剩余 test_card_2

关键观察：
- 三个 effect 均返回 `true`，未触发默认粒子流回退
- `layoutCards` 重排机制工作正常，多卡片场景下 y 坐标自动累加
- effect 抛错时由 try/catch 兜底，不会中断动画引擎

**阶段 E 验证记录**（2026-07-24）：

迁移完成后浏览器全链路验证（http://127.0.0.1:8080/conveyor.html）：

1. **无残留报错**——console 无 ReferenceError / TypeError，已删除的 `updateSectionVisuals` / `convertParticleToContainer` / 消息流代码无任何悬空调用
2. **引擎启动正常**——`[animV2] started, flows: 8`；`[animV2] state watchers registered: [sections]`
3. **接口完整**——`window.__animV2__` 暴露 start / pause / resume / step / reset / spawnParticle / triggerEffect
4. **UI 变更到位**——sim-panel 存在 anim-pause / anim-step / anim-resume / anim-reset 四个按钮；页脚 msg-flow-toggle 按钮已移除
5. **card_sync 生效**——仿真器发送"测试消息"后 sections 状态 4→5，SectionQueue 区域新卡片自动出现（state_change 轮询捕获 simState 变化 → 全量同步）
6. **播放控制生效**——点击暂停/继续/重置动画均无报错

架构变化要点：
- scripts.ts 不再包含任何项目特定动画代码，仿真器只负责状态机（processEvent → simState），动画完全由引擎消费 `__simRuleFired__` 事件 + 轮询 simState 驱动
- 动画 DOM（粒子/chip/卡片）统一由引擎管理，reset 时清理并重新执行 card_sync flows

**阶段 F 验证记录**（2026-07-24）：

1. **单测**——`tests/renderer/anim_core.test.ts` 28 用例全绿（evalCondition 空/else/表达式/异常安全、pickBranch 顺序命中与兜底、mock 轮换、路径解析/设置、input/output mapping、matchError、makeSnapshot 变更检测）
2. **构建**——`npm run build`（gen_anim_core_bundle + tsc）通过；bundle 5454 字符内联
3. **branch_test.html 多分支**——periodic(1800ms) + mock_values 轮换 status=200/401/429/503，浏览器观察到绿/红/橙/紫四色粒子分别流向 handler/auth/retry/fallback 四节点，判断处闪烁正常，console 无错误
4. **conveyor.html 真实条件流**——`flow_budget_check`（state_change 监听 sections，阈值 tokenBudget×0.8）：仿真推进后观察到 node_context_compose 绿色闪烁 + 绿色粒子流向 node_current_round（预算内分支）；tokens 未超阈值走红分支未触发属预期
5. **card_sync 回归**——初始 4 卡片渲染、sections 4→13 增长同步、超 8 个触发 PulseEvict 后折叠动画（46→24px）与淘汰左滑消失均正常，最终 active:6 与卡片数一致
6. **serve.ts 修复**——Windows 下 `import.meta.url === file://argv[1]` 判断失效导致 CLI 直启退出，改用 `pathToFileURL(path.resolve(...))` 比较

数据丢失教训：阶段 D/F 对 `.design-canvas/features/conveyor.json`（git 未跟踪目录）的修改随目录删除丢失，本次已将 `flow_section_cards_sync` 与 `flow_budget_check` 两个流重写进 `examples/conveyor.json`（git 跟踪）。**后续所有 DSL 示例修改必须落在 examples/ 或已跟踪路径。**

**阶段 G/G2 验证记录**（2026-07-24）：

1. **单测**——`tests/renderer/anim_core.test.ts` 44 用例全绿（新增 parseApiName 函数名解析、formatHandlerArgs 参数格式化/截断、isErrorResult 异常形态判定、classifyError 三分分类）
2. **全量测试**——171 用例 9 文件全绿；`npm run build`（gen_anim_core_bundle + tsc）通过
3. **Playwright 全链路验证**（conveyor.html?v=l45pw1，headless Chromium）：连点 6 次 `sim-advance` 按钮推进 sections 状态，flow_budget_check 的 mock_results 轮换序列精确命中预期：
   - 第1次 `{compose:"ok",tokens:1200}` → class=none（正常流）
   - 第2次 `{error:{code:"BUDGET_EXCEEDED"}}` → class=declared（expected）
   - 第3次 `{compose:"ok",tokens:980}` → class=none
   - 第4次 `{error:{code:"NETWORK_TIMEOUT"}}` → class=undeclared（未声明异常）
   - 第5次 `{panic:true}` → class=declared（unexpected）
   - 第6次回到第1项循环，轮换器状态正确
4. **anim-log 面板 DOM 验证**——4 条日志级别与内容全部正确：WARN "Compose: 预算超限，走草稿清理路径"×2、CRITICAL "未声明异常 @ Compose: ...（疑似 bug，请补 errors 声明）"、ERROR "CRITICAL: Compose panicked — 潜在 bug"
5. **验证方法修正**——此前误判"mock_results 轮换顺序异常"，实为 simulator 不会自动推进 sections（需手动点击 sim-advance 触发 advance_conveyor → push section），轮换逻辑本身一直正确

---

## 9. 已决策项（2026-07-23 确认）

1. **L2 的 value.fields 用 JSON Schema**
   - 直接上完整的 JSON Schema，避免后续从简单字符串数组迁移的成本
   - 支持字段级动画（单个字段变化高亮）和 L4 的 input_mapping/output_mapping 精确引用字段路径（如 `$value.claims.user_id`）

2. **条件表达式用简单 JS**
   - `value.status == 200` / `result.panic == true` / `value.claims.roles.includes("admin")`
   - 执行时用 `new Function('value', 'result', 'return (' + expr + ')')` 在受控作用域求值
   - 不引入 JSON Logic（冗长）也不自定义 DSL（学习成本）
   - 满足三个要求：LLM 看得懂、写得对、执行准

3. **动画执行器和仿真器合并为统一引擎**
   - `animations` 是顶层独立字段，不是 `simulation` 的子字段
   - 通过节点 ID 和状态字段与 `simulation` 联动：
     - `simulation` 触发状态变化 → `animations` 监听状态变化播放对应动画
     - 无 `simulation` 时（L0-L2），`animations` 的 trigger 用 periodic/event 自行驱动
     - 有 `simulation` 时（conveyor 场景），`animations` 的 trigger 可引用 simulation 的事件
   - 执行器内部有一个 StateManager 统一管理两者

4. **L5 分两档：L5a 静态推演 + L5b 动态执行**
   - **L5a 静态推演**（低风险，优先做）：基于 AST 提取的函数签名 + 返回值类型，用 mock 数据推演执行路径。不真正运行代码，零风险
   - **L5b 动态执行**（需沙箱，低优先级）：真正调用代码，需要 recover panic + 超时 + 副作用隔离。远期能力
   - L5a 不需要考虑安全边界（静态分析无风险），L5b 单独处理沙箱问题：
     - panic 捕获：必须 recover 并转化为 `result.panic = true`，不让进程崩溃
     - 超时机制：单次调用超时（默认 5s）
     - 副作用隔离：只读调用优先，有副作用的函数需显式声明
     - 未声明异常展示：日志标红 + 可选暂停等待人工查看

---

## 10. 职责分层（main/error/detail）与 detail 层数据变形链

> F1/F2/F3 已实现并提交（`471ebc6`，218/218 测试）。本节重点是 **detail 层（第三层）的完整设计**——下次开工按此实施。

### 10.1 三层模型（已实现）

| 层 | 职责 | 默认状态 | 展开方式 |
|----|------|---------|---------|
| main | 主干数据流转 | 显示 | — |
| error | 异常处理 | 折叠 | 宿主 ⚠ 角标 / 全局 🛡 开关 |
| detail | 文件内部数据变形链 | 折叠 | 宿主 ▸ 角标 / 全局 🧩 开关 |

- DSL：`Node.layer` / `Node.host` / `Edge.layer`（[types.ts](file:///d:/project_develop/design-canvas/src/dsl/types.ts)）；边层缺省跟随端点较深层（detail > error > main）
- F2 自动推导：`deriveLayers` 从 `handler.errors[].to` 推导 error 层 + host=flow.from；主干职责节点（flow from/to/branches.to）豁免
- F3 动画激活：`spawnDefaultParticle` 入口 `flowDomVisible` 门控——端点隐藏时 flow 无语义执行/无粒子/无日志，展开后下周期自动恢复

### 10.2 detail 层设计目标（用户原话锚点）

1. **非开发者可读**：不懂软件开发的人也能看懂每个文件是做什么的——数据进来是什么样子，经过这个文件后变成什么样子
2. **指导开发**：DSL 与文件逻辑一致 → 动画出问题 = 文件有问题（一致性即正确性）
3. **输入注入发现问题**：可设置输入输出的值；异常值导致动画异常 = 发现问题

### 10.3 核心概念：文件 = 数据加工车间

展开主干节点（文件）的 ▸ 角标，就地展示一条**加工流水线**（复用父子嵌套 + 父节点自动 resize，不跳页）：

```
┌─ 文件节点（detail 层展开）──────────────────────────┐
│ 进料口          加工链（语义步骤）           出料口  │
│ {token:       ① 拆开        ② 查库        {用户完整 │
│  一串字符} →  {user_id, →   {用户完整 →    信息}   │
│                过期时间}      信息}                  │
└──────────────────────────────────────────────────┘
```

- **进料口 / 出料口**：数据形状卡，复用 `AnimationValueSchema`，渲染成人话（`{token: 字符串}`，非开发者能读）
- **加工链**：按**语义步骤**聚合（"鉴权""查库""组装"），每步一张形状卡显示进出形状；函数细节挂步骤下（不追求每函数一节点，避免大文件链过长）
- **一致性约束**：出料口形状必须匹配主干出边期望的值类型；不匹配 = DSL 与代码漂移，动画粒子走到那一步对不上、闪红

### 10.4 输入注入 = 质检环节

- 进料口双击 → JSON 编辑面板，自由改数据后回放
- 预设异常场景下拉：从 `handler.errors` 声明自动生成（"token 过期""user_id 不存在"），一键注入对应异常值
- 回放机制完全复用现有设施：注入值替代 `mock_results` 作为 flow 的 value；某一步形状不匹配/条件不满足/异常被触发 → 异常粒子流向 error 节点 + anim-log 记录
- **不用跑真实代码，就能发现"这个文件处理不了这种数据"**

### 10.5 数据来源与一致性闭环

- **混合来源**：TreeSitterKernel 自动提取函数调用骨架（已有设施）+ LLM 补充语义标签（步骤名、形状的人话描述）
- **三方一致性**：detail 链声明形状 ↔ backfill 从真实代码解析的签名 ↔ design_check 对比；一致动画顺，漂移即暴露

### 10.6 实施顺序（默认决策，可推翻）

1. **D1 静态形状卡**：detail 节点渲染进出数据形状（人话版 JSON Schema），纯展示无交互——非开发者先能看懂 ✅ `9d9baeb`
2. **D2 变形链推导**：TreeSitter 提取函数骨架 + LLM 语义标注，生成 detail 层节点/边 ✅（工具侧：`derive_detail_chain`——骨架提取/调用图/类型→shapes 全自动，幂等可重跑；语义标注由 LLM 拿到结果后用 update_node 完成）
3. **D3 注入回放**：进料口编辑 JSON / 预设异常场景 → 回放暴露问题

---

## 附录 A：与 project_memory 约束的关系

本设计文档固化后，以下 project_memory 约束需要更新：

- **新增**：动画系统采用分层精度（L0-L5），L0-L1 零成本自动推导，L2 才引入 animations 字段
- **新增**：通用动画执行器不硬编码项目特定 ID，通过 effect 注册表扩展
- **新增**：L4.5 异常语义——handler.errors 声明预期异常，severity 分 expected/unexpected 两档，未声明异常触发 bug 警报
- **新增**：L5 live 模式必须 recover panic 并转化为 result.panic=true，不得让动画进程崩溃
- **更新**：消息粒子到达终点后转换为可拖拽容器（data-shape=true），容器定位在消息流面板内部避免遮挡
- **保留**：Section 卡片动画（card_create/card_fold/card_evict）作为通用 effect 注册，任何 DSL 可复用

---

## 附录 B：内置 Effect 参考

> 实现：[animation_engine.ts](file:///d:/project_develop/design-canvas/src/renderer/animation_engine.ts)
> 所有 effect 通过 `EffectRegistry.register(name, fn)` 注册，函数签名 `(ctx) => boolean`，返回 `true` 表示已处理。

### B.1 通用约定

**ctx 对象**：

```typescript
{
  flow: {          // flow 配置（来自 animations_v2.flows[] 或默认推导）
    to: string,    // 目标节点 ID
    from: string,  // 源节点 ID
    effect: string,
    rawFlow?: { value?: AnimationValue }  // 原始 DSL flow
  },
  value: AnimationValue | null,  // 数据值对象（取自 flow.rawFlow.value）
  targetNodeId: string           // = flow.to
}
```

**value 对象结构**（card_* effect 约定）：

```typescript
{
  id?: string,         // 卡片唯一 ID（card_fold 用于定位）
  summary?: string,    // 卡片标题（超 42 字符自动截断）
  status?: 'active' | 'folded',  // 初始状态
  messages?: number,   // 消息数（active 卡片显示）
  tokens?: number,     // token 数（active 卡片显示）
  cardId?: string      // card_fold 专用，等价于 id
}
```

**卡片容器机制**：

- 每个 `flow.to` 节点下自动创建 `<g data-card-container="true" class="card-container-v2">` 容器
- 所有卡片以 `g.card-v2` 形式追加到容器内
- `layoutCards(container, nodeRect)` 统一重排：y 坐标按 DOM 顺序累加，高度按 folded/active 切换
- 卡片样式常量见 `CARD_STYLE`（与 scripts.ts 中 Section 卡片视觉一致）

### B.2 card_create

**作用**：在 `flow.to` 节点内创建一张新卡片，淡入上移动画。

**触发方式**：
- DSL 声明：`flow.effect = "card_create"` + `flow.value = { id, summary, ... }`
- 手动触发：`__animV2__.triggerEffect('card_create', { to: 'nodeX', value: {...} })`

**动画**：
1. 创建 `g.card-v2` 元素（含 rect + title + body/badge）
2. `layoutCards` 重排所有卡片位置
3. 淡入（opacity 0→1）+ 从下方上移 12px，持续 300ms，三次方缓动

**返回**：`true`（成功）/ `false`（节点不存在或无 rect）

### B.3 card_fold

**作用**：折叠指定 `cardId` 的卡片，高度过渡 + 样式切换。

**触发方式**：
- DSL 声明：`flow.effect = "card_fold"` + `flow.value = { cardId: "xxx" }`（或 `id: "xxx"`）
- 手动触发：`__animV2__.triggerEffect('card_fold', { to: 'nodeX', value: { cardId: 'xxx' } })`

**动画**：
1. 查找 `g.card-v2[data-card-id="xxx"]`，若已 folded 则返回 false
2. 切换 class `.folded`，更新 fill/stroke/title 颜色，移除 body 文字，追加 fold badge
3. rect 高度从 50px → 26px 过渡，持续 300ms，同步 title/badge 的 y 坐标
4. 动画结束后调用 `layoutCards` 重排后续卡片

**返回**：`true`（成功）/ `false`（卡片不存在、已折叠、节点缺失）

### B.4 card_evict

**作用**：按 FIFO 淘汰容器内最旧（DOM 顺序第一张）的卡片，左滑淡出。

**触发方式**：
- DSL 声明：`flow.effect = "card_evict"`（不需要 value）
- 手动触发：`__animV2__.triggerEffect('card_evict', { to: 'nodeX' })`

**动画**：
1. 选中容器内第一个 `g.card-v2:not(.evicting)`
2. 标记 `.evicting` class（防止重复淘汰）
3. transform translateX 从 0 → -(cardW + 30)，opacity 1 → 0，持续 400ms
4. 动画结束后从 DOM 移除，调用 `layoutCards` 重排剩余卡片

**返回**：`true`（成功）/ `false`（容器为空）

### B.5 手动触发接口

```javascript
// 控制台调试 / L5 运行时调用
window.__animV2__.triggerEffect(effectName, options);

// options 结构
{
  to: string,       // 目标节点 ID（必填）
  from?: string,    // 源节点 ID（可选）
  value?: object    // 数据值对象（按 effect 约定，详见 B.1）
}

// 返回 boolean：true=effect 已处理，false=未注册或执行失败
```

**典型用法**：

```javascript
// 1. 创建卡片
__animV2__.triggerEffect('card_create', {
  to: 'node_section_queue',
  value: { id: 'sec_001', summary: '用户登录流程', messages: 3, tokens: 850 }
});

// 2. 折叠卡片
__animV2__.triggerEffect('card_fold', {
  to: 'node_section_queue',
  value: { cardId: 'sec_001' }
});

// 3. 淘汰最旧卡片
__animV2__.triggerEffect('card_evict', {
  to: 'node_section_queue'
});
```

### B.6 DSL 声明示例

在 `animations_v2.flows[]` 中声明 effect（阶段 E 将用于 conveyor.json 迁移）：

```json
{
  "animations_v2": {
    "version": 1,
    "flows": [
      {
        "id": "flow_section_create",
        "trigger": { "type": "event", "event": "section_created" },
        "from": "node_llm_aam",
        "to": "node_section_queue",
        "effect": "card_create",
        "value": {
          "type": "section",
          "label": "Section 卡片",
          "fields": {
            "type": "object",
            "properties": {
              "id": { "type": "string" },
              "summary": { "type": "string" },
              "messages": { "type": "number" },
              "tokens": { "type": "number" }
            }
          }
        }
      },
      {
        "id": "flow_section_fold",
        "trigger": { "type": "event", "event": "section_folded" },
        "from": "node_llm_aam",
        "to": "node_section_queue",
        "effect": "card_fold",
        "value": { "type": "section_id", "label": "Section ID" }
      },
      {
        "id": "flow_section_evict",
        "trigger": { "type": "event", "event": "section_evicted" },
        "from": "node_section_queue",
        "to": "node_section_queue",
        "effect": "card_evict"
      }
    ]
  }
}
```

> **注意**：`value.fields` 的 JSON Schema 仅用于文档化数据结构，当前 effect 实现直接读取 `value` 对象的 `id`/`summary`/`messages`/`tokens` 字段。L4+ 阶段会引入基于 fields 的字段级动画。
