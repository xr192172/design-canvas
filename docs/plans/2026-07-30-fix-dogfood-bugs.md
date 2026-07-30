# 修复 dogfooding 发现的两个 design-canvas 自身 bug

> 类型：开发窗口实施单 · 创建：2026-07-30 · 严重度：高（design-canvas 自身 bug，影响所有用户）
>
> 来源：[dogfood_audit.mjs](../../scripts/dogfood_audit.mjs) 扫描 .design-canvas/features/self_analyze.json 发现

## 0. 背景

用户要求 dogfooding：用 design-canvas 扫描自己，看能否发现项目缺陷。审计脚本 [scripts/dogfood_audit.mjs](../../scripts/dogfood_audit.mjs) 跑出 5 个缺陷，其中 3 个是架构问题（dsl 循环依赖、edit_result 入度、import_project 复杂度），2 个是 **design-canvas 自身 bug**：

| 缺陷 | 类型 | 严重度 |
|---|---|---|
| semantic.files[].lines 全为 0 | design-canvas bug | 高 |
| derive_detail_chain 节点 id 用代码片段 | design-canvas bug | 高 |

本单修复这两个 design-canvas 自身 bug。架构问题（dsl 循环依赖等）另开单处理。

## 1. Bug A：semantic.files[].lines 全为 0

### 1.1 现象

[dogfood_audit.mjs](../../scripts/dogfood_audit.mjs) 输出：

```
【缺陷 6：巨石文件 Top 10】
  1. db/db.ts          0 行 / 4 API
  2. db/symbols.ts     0 行 / 19 API
  ...
```

所有文件的 `lines` 字段都是 0。但 [self_analyze.mjs](../../scripts/self_analyze.mjs) 生成的 monolith_report 明明显示 scripts.ts 4435 行。

### 1.2 根因

[import_project.ts:696-703](../../src/tools/import_project.ts#L696) 写 `semanticFiles` 时**根本没填 `lines` 字段**：

```typescript
semanticFiles.push({
  id: fileNodeId(f.rel),
  path: f.rel,
  responsibility: `${f.dir === '.' ? '根目录' : f.dir} — ${apiCount} 个 API（导入自 ${(p?.imports.length || 0)} 个模块）`,
  status: 'done',
  expected_apis: apis,
  actual_apis: apis,
  // ← 缺 lines 字段
});
```

但 [L803](../../src/tools/import_project.ts#L803) 又用 `lineCounts.get(f.rel)` 做单文件化预警——数据在内存 `lineCounts` Map 里有，**只是没写进 DSL 的 semantic 层**。

### 1.3 影响

- 依赖 DSL 的下游工具（星图 tooltip、monolith_report 从 DSL 读）拿不到行数
- dogfood_audit 从 DSL 读 lines 全为 0，无法做行数排序
- monolith_report 被迫直接读文件系统绕过 DSL，违反"DSL 是唯一真相源"原则

### 1.4 修复

**改动 1**：[import_project.ts:696](../../src/tools/import_project.ts#L696) 补 `lines` 字段

```typescript
semanticFiles.push({
  id: fileNodeId(f.rel),
  path: f.rel,
  responsibility: `${f.dir === '.' ? '根目录' : f.dir} — ${apiCount} 个 API（导入自 ${(p?.imports.length || 0)} 个模块）`,
  status: 'done',
  expected_apis: apis,
  actual_apis: apis,
  lines: lineCounts.get(f.rel) ?? 0,   // ← 新增
});
```

**改动 2**：[SemanticFile 类型定义](../../src/db/symbols.ts) 确认 `lines` 字段已声明（若未声明则补）

需检查 `SemanticFile` interface 是否有 `lines?: number` 字段，若无则补。

**改动 3**（可选）：[monolith.ts](../../src/tools/monolith.ts) 改为从 DSL 读 lines，不再直接读文件系统

```typescript
// 现状：直接读文件系统
const lines = countLines(fs.readFileSync(filePath, 'utf8'));

// 改为：优先从 DSL 读，回退读文件系统
const semanticFile = dsl.semantic.files.find(f => f.path === relPath);
const lines = semanticFile?.lines ?? countLines(fs.readFileSync(filePath, 'utf8'));
```

改动 3 可选，因 import_project 已填 lines，monolith 从 DSL 读即可。但保留回退保证鲁棒性。

### 1.5 验证

```bash
# 1. 重新构建 + 重新扫描
npm run build && node scripts/self_analyze.mjs

# 2. 验证 DSL 里 lines 有值
node -e "const d=require('./.design-canvas/features/self_analyze.json'); const f=d.semantic.files.find(f=>f.path.includes('scripts.ts')); console.log(f.path, f.lines)"
# 期望：renderer/scripts.ts 4435（非 0）

# 3. 重跑 dogfood_audit
node scripts/dogfood_audit.mjs
# 期望：缺陷 6 巨石文件 Top 10 显示真实行数
```

## 2. Bug B：derive_detail_chain 节点 id 用代码片段

### 2.1 现象

[dogfood_audit.mjs](../../scripts/dogfood_audit.mjs) 输出（循环依赖检测误报）：

```
环 2（2 节点）：
  - edges.push({ id: `dep_${sanitize(fr…
  - for (const
环 4（11 节点）：
  - aggEdges.set(key, { from: a, to: b,…
  - cur.n++
  - (cur)
  ...
```

这些"节点 id"是**代码片段**，不是合法标识符。Tarjan SCC 把它们当节点跑循环检测，产生误报。

### 2.2 根因链

**根因在 [kernel.ts:99](../../src/tools/ts_kernel/kernel.ts#L99) 的 `extractName` 兜底逻辑**：

```typescript
function extractName(node: SyntaxNodeLike, fieldMap: LanguageEntry['field_map']): string {
  const direct = fieldText(node, fieldMap.name);
  if (direct) return direct;

  // 兜底：从第一个 identifier 子节点取
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && (child.type === 'identifier' || child.type === 'property_identifier' || ...)) {
      return child.text;   // ← 问题：child.text 可能是代码片段
    }
  }
  return '';
}
```

对于某些 AST 节点（语句/表达式节点被 `lang.symbol_nodes` 误判为符号），兜底返回 `child.text`——这是**整段代码文本**，不是标识符。

**传播链**：
1. `extractName` 返回代码片段 → `name = "edges.push({ id: \`dep_${sanitize(fr…"`
2. [kernel.ts:171](../../src/tools/ts_kernel/kernel.ts#L171) `qualified_name = parent ? "${parent}.${name}" : name` → qualified_name 也是代码片段
3. [derive_chain.ts:443](../../src/tools/derive_chain.ts#L443) `id = "${nodePrefix}${i+1}_${sanitize(s.qualified_name)}"` → sanitize 把非 `\w` 字符替成 `_`，生成超长但合法的 id
4. [derive_chain.ts:450](../../src/tools/derive_chain.ts#L450) `label = "${CIRCLED[i]} ${s.name}"` → label 显示代码片段
5. dogfood_audit 的 Tarjan 把这些"节点"当图节点，误报循环

### 2.3 影响

- detail 节点 id 含代码片段，`update_feature` 无法正确引用（id 虽合法但无意义）
- 星图渲染时这些节点 label 显示代码片段，不可读
- 循环依赖检测等图分析工具误报（把代码片段当节点）
- monolith_report 等下游工具可能受影响

### 2.4 修复

**改动 1（核心）**：[kernel.ts:91-103](../../src/tools/ts_kernel/kernel.ts#L91) `extractName` 兜底加标识符合法性校验

```typescript
function extractName(node: SyntaxNodeLike, fieldMap: LanguageEntry['field_map']): string {
  const direct = fieldText(node, fieldMap.name);
  if (direct && isValidIdentifier(direct)) return direct;   // ← 加校验

  // 兜底：从第一个 identifier 子节点取
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && (child.type === 'identifier' || child.type === 'property_identifier' || child.type === 'type_identifier' || child.type === 'name')) {
      const text = child.text;
      if (isValidIdentifier(text)) return text;   // ← 加校验
    }
  }
  return '';
}

/** 标识符合法性：非空、长度 ≤ 64、只含字母数字下划线 $、不以数字开头 */
function isValidIdentifier(s: string): boolean {
  if (!s || s.length === 0 || s.length > 64) return false;
  if (/^\d/.test(s)) return false;
  return /^[A-Za-z_$][\w$]*$/.test(s);
}
```

**改动 2（防御）**：[derive_chain.ts:442](../../src/tools/derive_chain.ts#L442) chain.forEach 跳过 name 为空或非法的符号

```typescript
chain.forEach((s, i) => {
  // 防御：跳过 name 为空或过长的符号（extractName 兜底失败的情况）
  if (!s.name || s.name.length > 64 || !/^[A-Za-z_$]/.test(s.name)) {
    return;   // 不为此符号生成 detail 节点
  }
  const id = `${nodePrefix}${i + 1}_${sanitize(s.qualified_name)}`;
  // ... 现有逻辑 ...
});
```

注意：跳过后 step 编号会断，需改用独立计数器：

```typescript
let stepNum = 0;
chain.forEach((s) => {
  if (!s.name || s.name.length > 64 || !/^[A-Za-z_$]/.test(s.name)) return;
  stepNum++;
  const id = `${nodePrefix}${stepNum}_${sanitize(s.qualified_name)}`;
  // ... 用 stepNum 替代 i+1 ...
});
```

**改动 3（可选）**：[derive_chain.ts:327](../../src/tools/derive_chain.ts#L327) 入口候选过滤——`candidates = symbols.filter(...)` 时排除 name 非法的符号

```typescript
const candidates = symbols.filter((s) => !called.has(s.qualified_name) && isValidSymbol(s));
// 其中 isValidSymbol 检查 name 非空且合法
```

改动 3 是源头过滤，避免非法符号进入 chain 推导，比改动 2 的末端跳过更彻底。但改动 2 仍是必要防御（防止其他路径混入）。

### 2.5 验证

```bash
# 1. 重新构建 + 重新扫描
npm run build && node scripts/self_analyze.mjs

# 2. 重跑 dogfood_audit
node scripts/dogfood_audit.mjs
# 期望：缺陷 3 循环依赖的"环 2-5"消失（代码片段节点不再生成）
# 期望：只剩"环 1"（dsl/ 5 节点真实循环，架构问题另开单）

# 3. 检查 detail 节点 id 合法性
node -e "
const d=require('./.design-canvas/features/self_analyze.json');
const bad=d.geometry.nodes.filter(n=>n.id.includes('__s') && /[^A-Za-z0-9_]/.test(n.id));
console.log('非法 detail 节点 id 数:', bad.length);
bad.slice(0,5).forEach(n=>console.log(' ', n.id.slice(0,80)));
"
# 期望：0 个非法 id
```

## 3. 实施顺序

1. **Bug A 改动 1**：import_project.ts 补 lines 字段（~1 行）
2. **Bug A 改动 2**：SemanticFile 类型声明 lines（若需，~1 行）
3. **Bug B 改动 1**：kernel.ts extractName 加 isValidIdentifier（~15 行）
4. **Bug B 改动 2**：derive_chain.ts 跳过非法符号（~10 行）
5. **构建 + 重扫 + 验证**

总改动 ~30 行，低风险。

## 4. 回归风险

| 改动 | 风险 | 缓解 |
|---|---|---|
| Bug A 补 lines | 旧 DSL 无 lines 字段，下游读 undefined | 用 `?? 0` 兜底；下游已习惯 falsy 检查 |
| Bug B extractName 加校验 | 某些合法但特殊的符号名被误拒（如含中文） | isValidIdentifier 只过滤明显非法（超长、含空格/括号）；中文标识符极少见于本项目 |
| Bug B 跳过非法符号 | chain 步骤数减少，信息量降低 | 非法符号本就是 extractName 失败的噪声，跳过是正确行为 |

## 5. 与其他实施单的关系

- 本单修复 design-canvas 自身 bug，与 [drag-perf-diagnosis.md](./2026-07-30-drag-perf-diagnosis.md)（卡顿）、[layout-edge-driven.md](./2026-07-30-layout-edge-driven.md)（布局）、[deep-self-analyze.md](./2026-07-30-deep-self-analyze.md)（深度分析）独立
- 但本单修复后，dogfood_audit 的循环依赖检测才能准确——否则代码片段节点污染 Tarjan 结果，无法发现真实的 dsl 循环依赖（[dsl/ 5 节点环](../..)）
- dsl 循环依赖是架构问题，另开单处理（不在本单范围）

## 6. dogfooding 价值佐证

这两个 bug 如果不是 dogfooding，可能一直不会被发现：

- **Bug A**：lines=0 只在"从 DSL 读行数"时才暴露，常规渲染路径不触发
- **Bug B**：detail 节点 id 用代码片段，只在"图分析工具消费 detail 节点"时才暴露（如 dogfood_audit 的 Tarjan）

这正好证明 design-canvas 的核心价值：**用图可视化 + 图分析能发现代码 review 难以发现的结构问题**——包括它自己的 bug。
