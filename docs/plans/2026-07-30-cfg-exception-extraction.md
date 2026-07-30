# CFG 异常处理提取（try/catch/throw）

> 类型：开发窗口实施单 · 创建：2026-07-30 · 严重度：功能补全（非 polish）
>
> 来源：用户审计"能否通过图理解错误处理"，实测 [cfg.ts](../../src/tools/ts_kernel/cfg.ts) 零命中 try/catch/throw
>
> 定位：这是 design-canvas"理解一个文件"能力的最后一公里——错误处理是核心维度，当前完全缺失

## 0. 背景

用户问"能不能通过图理解某个文件的错误处理是怎样的"。实测发现：

- [cfg.ts:26](../../src/tools/ts_kernel/cfg.ts#L26) `CfgNodeKind` 只有 5 种：`entry | exit | step | branch | loop | return`
- [cfg.ts:64-98](../../src/tools/ts_kernel/cfg.ts#L64) 语句类型映射表**不包含 try_statement / catch_clause / throw_statement**
- grep `try|catch|throw` 在 cfg.ts **零命中**

**后果**：
- `throw new Error(...)` 被当普通 step 节点（[self_analyze.json:2708](../../.design-canvas/features/self_analyze.json#L2708) 实测）
- try/catch 块的 catch 分支不画——异常路径完全缺失
- 用户在图上看不到"这个函数的错误处理是怎样的"

**与文档的差距**：
[animation-design.md](../animation-design.md) 8.4 说"L4.5 异常语义完成"——那是**动画层**（粒子流遇异常节点变红色），不是**解析层**（CFG 提取异常结构）。解析层从未实现异常提取。

本单补全解析层。

## 1. 目标

让 derive_algorithm 生成的控制流图能展示：

1. **throw 语句**：红色菱形节点，标注抛出的异常类型/消息
2. **try 块**：try entry 节点（普通 step，标注"try"）
3. **catch 子句**：绿色 handler 节点，标注捕获的异常类型
4. **异常边**：throw → 最近 catch handler（函数内有 try/catch 时）或 → 函数 exit（未捕获时）
5. **finally 块**：finally 节点，标注"finally"，所有路径必经

## 2. 设计

### 2.1 新增 CfgNodeKind

[cfg.ts:26](../../src/tools/ts_kernel/cfg.ts#L26)：

```typescript
// 现状
export type CfgNodeKind = 'entry' | 'exit' | 'step' | 'branch' | 'loop' | 'return';

// 改为
export type CfgNodeKind =
  | 'entry' | 'exit' | 'step' | 'branch' | 'loop' | 'return'
  | 'throw'      // 新增：throw 语句
  | 'handler'    // 新增：catch 子句
  | 'finally';   // 新增：finally 块
```

### 2.2 语句类型映射表扩充

[cfg.ts:63-100](../../src/tools/ts_kernel/cfg.ts#L63) 三张表（TS_CTRL / CTRL.go / CTRL.python）各加：

```typescript
// TS_CTRL（TypeScript/JS/TSX）
const TS_CTRL: Record<string, CtrlKind> = {
  // ... 现有 ...
  throw_statement: 'throw',
  try_statement: 'try',       // 注意：try 不是 CtrlKind，需特殊处理（见 2.3）
};

// CTRL.go
go: {
  // ... 现有 ...
  // Go 无 try/catch，但有 panic/recover
  expression_statement: 'throw',  // 需在 buildSeq 里判断是否 panic 调用（见 2.4）
},

// CTRL.python
python: {
  // ... 现有 ...
  raise_statement: 'throw',
  try_statement: 'try',
},
```

**问题**：`CtrlKind` 类型（[cfg.ts:61](../../src/tools/ts_kernel/cfg.ts#L61)）当前是 `'branch' | 'loop' | 'return' | 'continue' | 'break'`，需扩充：

```typescript
// 现状
type CtrlKind = 'branch' | 'loop' | 'return' | 'continue' | 'break';

// 改为
type CtrlKind = 'branch' | 'loop' | 'return' | 'continue' | 'break' | 'throw' | 'try';
```

### 2.3 try/catch/finally 子图构建

在 [buildSeq](../../src/tools/ts_kernel/cfg.ts#L275) 的 for 循环里，现有 `if (kind === 'loop')` / `if (kind === 'branch')` 分支后，新增 `if (kind === 'try')` 分支：

```typescript
if (kind === 'try') {
  // try_statement 结构（TS/Python）：
  //   try_statement
  //     ├── body (block)
  //     ├── catch_clause* (0..N)
  //     │     ├── parameter (异常类型)
  //     │     └── body (block)
  //     └── finally_clause? (0..1)
  //         └── body (block)

  const tryId = addNode(ctx, 'step', 'try', col, stmt);
  link(ctx, exits, tryId);
  if (!entry) entry = tryId;

  // try body：异常可能跳到 handler，正常路径落到 finally/出口
  const bodyNode = stmt.childForFieldName('body');
  const tryBodyRes = buildSeq(ctx, stmtsOf(bodyNode), col + 1, depth + 1);
  if (tryBodyRes.entry) {
    ctx.edges.push({ from: tryId, to: tryBodyRes.entry, label: '进入' });
  }

  // 收集 catch handlers
  const handlers: { id: string; exits: Exit[] }[] = [];
  for (let j = 0; j < stmt.childCount; j++) {
    const c = stmt.child(j);
    if (!c) continue;
    if (c.type === 'catch_clause' || c.type === 'except_clause') {
      // Python: except_clause 有 type field；TS: catch_clause 有 parameter field
      const paramNode = c.childForFieldName('parameter') || c.childForFieldName('type');
      const catchType = paramNode ? paramNode.text : '所有异常';
      const hId = addNode(ctx, 'handler', `catch ${catchType}`, col + 1, c, catchType);
      const catchBody = c.childForFieldName('body');
      const catchRes = buildSeq(ctx, stmtsOf(catchBody), col + 2, depth + 1);
      if (catchRes.entry) {
        ctx.edges.push({ from: hId, to: catchRes.entry, label: '处理' });
      }
      handlers.push({ id: hId, exits: catchRes.exits });
      // 异常边：try body 的 throw 需连到这里——见 2.4 的 throw 处理
    }
  }

  // 注册 handler 到 ctx，让 try body 里的 throw 能找到它
  // （见 2.4：throw 查 ctx.handlerStack 栈顶）

  // finally
  let finallyId: string | null = null;
  for (let j = 0; j < stmt.childCount; j++) {
    const c = stmt.child(j);
    if (c && c.type === 'finally_clause') {
      finallyId = addNode(ctx, 'finally', 'finally', col, c);
      const finBody = c.childForFieldName('body');
      const finRes = buildSeq(ctx, stmtsOf(finBody), col + 1, depth + 1);
      if (finRes.entry) {
        ctx.edges.push({ from: finallyId, to: finRes.entry, label: '进入' });
      }
      break;
    }
  }

  // 汇合出口
  const tryExits = tryBodyRes.exits;           // try 正常出口
  const catchExits = handlers.flatMap((h) => h.exits);  // catch 出口

  if (finallyId) {
    // 所有出口（try 正常 + catch）都先过 finally
    link(ctx, [...tryExits, ...catchExits], finallyId);
    const finRes = finallyBodyExits.get(finallyId) || [{ id: finallyId }];
    exits = finRes;
  } else {
    exits = [...tryExits, ...catchExits];
  }
  continue;
}
```

**注意**：finally 的 body 出口需缓存。上面伪代码用 `finallyBodyExits` Map，实际实现时可在 buildSeq 返回前把 finally 的 exits 存到 ctx 或局部变量。

### 2.4 throw 语句处理

在 buildSeq 的 for 循环里，新增 `if (kind === 'throw')` 分支：

```typescript
if (kind === 'throw') {
  // throw_statement / raise_statement
  // 提取抛出的异常类型/消息
  const argNode = stmt.childForFieldName('argument')      // TS throw_statement
                || stmt.childForFieldName('value');        // Python raise_statement
  const label = argNode ? oneLine(argNode.text, 44) : 'throw';
  const id = addNode(ctx, 'throw', label, col, stmt);
  link(ctx, exits, id);
  if (!entry) entry = id;

  // 异常边：连到最近 catch handler（栈顶），无 handler 则连函数 exit
  const top = ctx.handlerStack[ctx.handlerStack.length - 1];
  if (top) {
    ctx.edges.push({ from: id, to: top.id, label: '抛出' });
  } else {
    // 未捕获：连到函数 exit（在 extractFunctionCfg 末尾统一处理）
    ctx.uncaughtThrows.push(id);
  }

  // throw 后续语句不可达（同 return）
  exits = [];
  if (i < stmts.length - 1) ctx.deadCode = true;
  break;
}
```

### 2.5 handlerStack 与 uncaughtThrows

[cfg.ts:121](../../src/tools/ts_kernel/cfg.ts#L121) `Ctx` interface 扩充：

```typescript
interface Ctx {
  // ... 现有字段 ...
  /** 异常 handler 栈：throw 查栈顶找最近 catch */
  handlerStack: Array<{ id: string }>;
  /** 未捕获的 throw（函数内无 try/catch），由 extractFunctionCfg 末尾连到 exit */
  uncaughtThrows: string[];
}
```

try 块进入时 push handler，离开时 pop（在 2.3 的 `if (kind === 'try')` 里）：

```typescript
if (kind === 'try') {
  // ... 构建 try body 前 ...
  // 注意：handler 应在 try body 构建前注册，但 handler 节点要在 body 之后才创建
  // 解决：先创建 handler 节点占位，再构建 body，最后构建 handler body
  // 或者：先创建所有 handler 节点，push 栈，构建 body，pop 栈，再构建 handler body

  // 先创建 catch handler 节点（不带 body）
  const handlerIds: string[] = [];
  for (let j = 0; j < stmt.childCount; j++) {
    const c = stmt.child(j);
    if (c && (c.type === 'catch_clause' || c.type === 'except_clause')) {
      const paramNode = c.childForFieldName('parameter') || c.childForFieldName('type');
      const catchType = paramNode ? paramNode.text : '所有异常';
      const hId = addNode(ctx, 'handler', `catch ${catchType}`, col + 1, c, catchType);
      handlerIds.push(hId);
    }
  }

  // push 栈，构建 try body（body 里的 throw 会查栈顶）
  ctx.handlerStack.push(...handlerIds.map((id) => ({ id })));
  const tryBodyRes = buildSeq(ctx, stmtsOf(bodyNode), col + 1, depth + 1);
  ctx.handlerStack.splice(ctx.handlerStack.length - handlerIds.length, handlerIds.length);

  // 构建 handler body
  for (let j = 0; j < stmt.childCount; j++) {
    const c = stmt.child(j);
    if (c && (c.type === 'catch_clause' || c.type === 'except_clause')) {
      const hId = handlerIds.shift()!;
      const catchBody = c.childForFieldName('body');
      const catchRes = buildSeq(ctx, stmtsOf(catchBody), col + 2, depth + 1);
      if (catchRes.entry) {
        ctx.edges.push({ from: hId, to: catchRes.entry, label: '处理' });
      }
      // handler 的 exits 需要收集（同 tryExits）
      // ... 见 2.3 ...
    }
  }
  // ... finally 与汇合 ...
}
```

### 2.6 未捕获 throw 连函数 exit

[extractFunctionCfg](../../src/tools/ts_kernel/cfg.ts#L408) 末尾，现有 return/exit 汇点处理后，加：

```typescript
// 现有：所有 return 节点连到 exit 汇点
for (const r of ctx.returns) ctx.edges.push({ from: r, to: exitId });

// 新增：未捕获的 throw 也连到 exit（表示异常向上抛出函数边界）
for (const t of ctx.uncaughtThrows) ctx.edges.push({ from: t, to: exitId, label: '未捕获' });
```

### 2.7 渲染形状

[derive_algorithm.ts:48](../../src/tools/derive_algorithm.ts#L48) `KIND_SHAPE` 扩充：

```typescript
const KIND_SHAPE: Record<CfgNodeKind, { shape: 'circle' | 'diamond' | 'hexagon' | 'rounded'; w: number; h: number; color?: string }> = {
  entry: { shape: 'circle', w: 140, h: 44 },
  exit: { shape: 'circle', w: 140, h: 44 },
  return: { shape: 'circle', w: 180, h: 48 },
  branch: { shape: 'diamond', w: 220, h: 64 },
  loop: { shape: 'hexagon', w: 220, h: 56 },
  step: { shape: 'rounded', w: 240, h: 52 },
  // 新增
  throw: { shape: 'diamond', w: 220, h: 64, color: 'error' },      // 红色菱形
  handler: { shape: 'rounded', w: 220, h: 52, color: 'success' },  // 绿色圆角
  finally: { shape: 'hexagon', w: 180, h: 48, color: 'warning' },  // 橙色六边形
};
```

**color 映射到 CSS 变量**：[derive_algorithm.ts:126-135](../../src/tools/derive_algorithm.ts#L126) 节点构建处，把 color 写入 style：

```typescript
const node: Node = {
  id: `${nodePrefix}${cn.id}`,
  // ... 现有 ...
  style: {
    shape: meta.shape,
    ...(meta.color ? { color: meta.color } : {}),  // 新增
  },
};
```

### 2.8 渲染器读取 color

[scripts.ts](../../src/renderer/scripts.ts) 节点渲染处（grep `shape ===` 找到分支），加 color 分支：

```typescript
// 现有：根据 shape 选 SVG 元素
// 新增：根据 style.color 选填充色
const colorVar = node.style?.color
  ? `var(--theme-${node.style.color === 'error' ? 'error' : node.style.color === 'success' ? 'success' : 'warning'})`
  : 'var(--theme-bg)';
// 应用到 fill 或 stroke
```

需确认 styles.ts 是否有 `--theme-success`，若无则用现有绿色或新增。

### 2.9 stats 计数扩充

[derive_algorithm.ts:44](../../src/tools/derive_algorithm.ts#L44) `stats` 扩充：

```typescript
stats: { steps: number; branches: number; loops: number; returns: number; throws: number; handlers: number };
```

[derive_algorithm.ts](../../src/tools/derive_algorithm.ts) 统计处（grep `stats.` 找到）加：

```typescript
stats.throws = cfg.nodes.filter((n) => n.kind === 'throw').length;
stats.handlers = cfg.nodes.filter((n) => n.kind === 'handler').length;
```

### 2.10 Go 的 panic/recover

Go 无 try/catch，但有 panic/recover 机制：

- `panic(...)` 调用 → 当 throw 处理（在 buildSeq 里判断 expression_statement 是否 panic 调用）
- `recover()` 在 defer 里 → 当 handler 处理（简化：defer 块内有 recover 调用则整个 defer 块当 handler）

**v1 实现**（简化）：Go 暂只处理 panic，不处理 recover（recover 语义复杂，defer 时机特殊）。

```typescript
// Go: expression_statement 里若含 panic( 调用，当 throw
if (ctx.lang === 'go' && stmt.type === 'expression_statement') {
  if (stmt.text.includes('panic(')) {
    // 当 throw 处理
    const label = oneLine(stmt.text, 44);
    const id = addNode(ctx, 'throw', label, col, stmt);
    link(ctx, exits, id);
    if (!entry) entry = id;
    const top = ctx.handlerStack[ctx.handlerStack.length - 1];
    if (top) ctx.edges.push({ from: id, to: top.id, label: '抛出' });
    else ctx.uncaughtThrows.push(id);
    exits = [];
    if (i < stmts.length - 1) ctx.deadCode = true;
    break;
  }
}
```

## 3. 实施步骤

| 步骤 | 文件 | 改动 |
|---|---|---|
| 1 | [cfg.ts:26](../../src/tools/ts_kernel/cfg.ts#L26) | CfgNodeKind 加 throw/handler/finally |
| 2 | [cfg.ts:61](../../src/tools/ts_kernel/cfg.ts#L61) | CtrlKind 加 throw/try |
| 3 | [cfg.ts:63-100](../../src/tools/ts_kernel/cfg.ts#L63) | 三张映射表加 throw_statement/try_statement/raise_statement |
| 4 | [cfg.ts:121](../../src/tools/ts_kernel/cfg.ts#L121) | Ctx 加 handlerStack/uncaughtThrows |
| 5 | [cfg.ts:275](../../src/tools/ts_kernel/cfg.ts#L275) | buildSeq 加 `if (kind === 'throw')` 分支 |
| 6 | [cfg.ts:275](../../src/tools/ts_kernel/cfg.ts#L275) | buildSeq 加 `if (kind === 'try')` 分支 |
| 7 | [cfg.ts:408](../../src/tools/ts_kernel/cfg.ts#L408) | extractFunctionCfg 末尾连 uncaughtThrows → exit |
| 8 | [derive_algorithm.ts:48](../../src/tools/derive_algorithm.ts#L48) | KIND_SHAPE 加 throw/handler/finally 形状 |
| 9 | [derive_algorithm.ts:44](../../src/tools/derive_algorithm.ts#L44) | stats 加 throws/handlers |
| 10 | [derive_algorithm.ts:126](../../src/tools/derive_algorithm.ts#L126) | 节点构建传 color 到 style |
| 11 | [scripts.ts](../../src/renderer/scripts.ts) | 节点渲染读 style.color 映射到 CSS 变量 |
| 12 | Go panic 特判（[cfg.ts buildSeq](../../src/tools/ts_kernel/cfg.ts#L275)） | expression_statement 含 panic( 当 throw |

总改动 ~200 行，集中在 cfg.ts（~120 行）+ derive_algorithm.ts（~30 行）+ scripts.ts（~20 行）+ 类型声明。

## 4. 验证

### 4.1 重新扫描并检查

```bash
npm run build && node scripts/self_analyze.mjs
```

### 4.2 检查 derive_algorithm.ts 的 CFG 是否有 throw 节点

derive_algorithm.ts 本身有 5 处 throw（[L65,67,79,82,88](../../src/tools/derive_algorithm.ts#L65)），扫描后应出现：

```bash
node -e "
const d=require('./.design-canvas/features/self_analyze.json');
const throws=d.geometry.nodes.filter(n=>n.host==='file_tools_derive_algorithm_ts' && n.label && n.label.includes('Error'));
console.log('derive_algorithm 的 throw 节点数:', throws.length);
throws.forEach(n=>console.log(' ', n.id, n.label.slice(0,50)));
"
# 期望：5 个 throw 节点（对应 5 处 throw new Error）
```

### 4.3 检查 handler 节点

找一个有 try/catch 的文件（如 server.ts、monolith.ts），检查是否生成 handler 节点：

```bash
node -e "
const d=require('./.design-canvas/features/self_analyze.json');
const handlers=d.geometry.nodes.filter(n=>n.description && n.description.startsWith('handler'));
console.log('handler 节点数:', handlers.length);
handlers.slice(0,5).forEach(n=>console.log(' ', n.id, n.label));
"
```

### 4.4 视觉验证

打开 http://localhost:3000/self_analyze.html，点开 derive_algorithm.ts 的算法节点：

- 应看到红色菱形节点（throw new Error）
- 应看到"未捕获"标签的边连到 exit
- 若该函数有 try/catch，应看到绿色 handler 节点 + "抛出"边

## 5. 回归风险

| 改动 | 风险 | 缓解 |
|---|---|---|
| CfgNodeKind 扩充 | 旧 DSL 无 throw/handler/finally 节点 | 渲染器对未知 kind 回退到 step |
| try/catch 子图复杂 | 嵌套 try/catch 可能导致栈错乱 | handlerStack 严格 push/pop；加测试用例覆盖嵌套场景 |
| Go panic 特判 | 误判（如字符串含 "panic(" 但非调用） | 检查是否 expression_statement 且首 token 是 panic（非简单 includes） |
| finally 出口汇合 | finally 必经路径建模可能让图变复杂 | finally 节点显式标注，边标签"进入"清晰 |
| color 字段 | 旧 DSL 无 color，渲染器需兜底 | `node.style?.color ?? null`，null 用默认色 |

## 6. 不做什么（v1 范围外）

- **Go recover() 语义**：defer + recover 时机特殊，v1 只处理 panic 不处理 recover
- **异常类型匹配**：catch 哪种异常就处理哪种，v1 所有 throw 都连到最近 handler（不做类型匹配过滤）
- **Java checked exception**：本项目无 Java，不处理
- **async/await 异常**：Promise rejection 的异步异常流不建模（复杂度高，价值低）
- **跨函数异常传播**：throw 在当前函数未捕获 → exit，但不画"抛到调用方"的跨函数边（那是 L5 反向提取的范围）

## 7. 与其他实施单的关系

- 本单是**功能补全**，与 [fix-dogfood-bugs](./2026-07-30-fix-dogfood-bugs.md)（修 bug）、[drag-perf-diagnosis](./2026-07-30-drag-perf-diagnosis.md)（性能）、[layout-edge-driven](./2026-07-30-layout-edge-driven.md)（布局）独立
- 但本单完成后，dogfood_audit 的循环依赖检测会更准确（throw 节点不再被当普通 step 污染 Tarjan）
- 本单是 [deep-self-analyze](./2026-07-30-deep-self-analyze.md) 的**前置条件**——深度分析要展示"错误处理是怎样的"，前提是 CFG 能提取异常结构

## 8. 价值

这是 design-canvas"理解一个文件"能力的最后一公里：

| 维度 | 现状 | 本单后 |
|---|---|---|
| 文件是什么（骨架） | ✅ | ✅ |
| 文件做什么（调用链） | ✅ 5 个文件 | ✅（配合 deep-self-analyze 全量） |
| 算法控制流（分支/循环） | ✅ | ✅ |
| **错误处理** | ❌ | ✅ |
| 前后数据交互 | ⚠️ 有结构无语义 | ⚠️（本单不解决，需值流分析） |

完成后，用户打开任一有 try/catch 的文件，能看到：
- 红色 throw 节点（哪里会出错）
- 绿色 handler 节点（怎么处理）
- "抛出"边（异常流向）
- "未捕获"边（漏网的异常）

这正是"通过图理解错误处理"的完整答案。
