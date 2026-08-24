# 重构执行器 —— 多语言接力契约（给下一个接力的 AI）

> 你现在接手的是 `design-canvas` 的确定性重构管线。管线**骨架已多语言化落地**：
> 语言无关的执行器契约 + `RefactorLangRegistry` 注册表 + 目录语言命中探测已经就位，
> 默认注册了**两个独立执行器**：`ts`（TS/JS 家族）与 `go` —— **一门语言一个执行器**，
> 它们各自只处理自己语言的源文件，共享一组可复用内核（tree-sitter 解析、死代码改写）。
>
> 本文档是你的**开工说明 + 目标语言开发范式**：已落地的可插拔骨架怎么用、
> 语言无关执行器接口契约长什么样、以及一份可照着扩展的 **Python 范例实现**。
> 你要给目标语言补一个执行器并 `registerRefactorLanguage` 进去即可，**不用改管线主流程**。
>
> 使用本工具的**配置与运行**见：[refactor-pipeline-guide.md](./refactor-pipeline-guide.md)

---

## 1. 任务边界 & 你的验收标准

**凡事先对齐一个原则**：所有改写执行器必须**纯计算 + 外挂验证闭环**，绝不私自落盘。
管线统一负责"基线一次 + 每步一次改后验证 + 失败只回滚到最近绿点"。

**验收标准（满足才叫做完）**：
1. `npx tsc --noEmit` 通过。
2. `npx vitest run` 全绿，且为你的新语言新增了测试：
   - 死 import：活/死判定、副作用/特殊形态保守保留。
   - 死语句：`return` 后不可达、死分支。
   - 验证命令探测：目标语言形态能自动给出命令组。
   - 管线语言路由：`runRefactorPipeline` 能对目标语言项目走对执行器。
3. 在真实目标语言项目（哪怕一个 fixture）上跑通一键。

---

## 2. 现状盘点：哪些已落地、哪些还等你动刀

**已落地（2026-08）的可插拔骨架**：
- `src/tools/refactor_langs.ts` —— 语言无关契约接口 + `RefactorLangRegistry` + 目录语言命中探测 `forProject` / `dirHasSource`。
- `src/tools/refactor_pipeline.ts` —— `collectSteps`（聚合命中语言的 stages）+ `mergeVerifyCommands`（合并去重验证命令）+ `runRefactorPipeline` 按项目探测语言路由 + 注册入口 `registerRefactorLanguage`。
- 默认注册了两个独立执行器 `ts` 与 `go`（一门语言一个），共享一组可复用内核，`DEFAULT_LANGS` 模块级单例。

**新的默认架构已不再是"管线内硬编码两步"**，而是 `runRefactorPipeline` 里 `langs.forProject(cwd)` → 聚合执行器各自 `stages`。新增一门语言 = 注册一个执行器，管线自动拾取；混项目（如 TS+Go 并存）会**两个执行器都被拾取，各只动自己语言的文件**。

**仍需按语言实现的部分（每次新语言都要做，对应 §3 契约四段）**：

| # | 契约段 | 你要实现 | TS/Go 现状（可参照） |
|---|---|---|---|
| 1 | `isSourceFile` | 命中该语言源文件的扩展名判定 | `refactor_pipeline.ts` 内 `ts` / `go` 执行器 |
| 2 | `detectVerifyCommands` | 依项目形态给验证命令组（`go.mod`/`pyproject.toml`/`pom.xml`…） | `defaultVerifyCommands(cwd)`（见 `verify_refactor.ts`） |
| 3 | `stages[].kind='dead_imports'` compute | 死 import 检测 + 移除，纯计算 | `computeDeadImportsPlan`（复用 `removeImportsFromSource` / `detectDeadImports`，带语言过滤） |
| 4 | `stages[].kind='dead_statements'` compute | 死语句控制流分析 + 删除，纯计算 | `computeDeadStatementsPlan`（复用 `flagDeadStatements`，带语言过滤） |

> 关于 tree-sitter：仓库已依赖 `tree-sitter-python` / `tree-sitter-javascript` /
> `tree-sitter-go` / `tree-sitter-typescript`，`src/tools/ts_kernel/languages.ts` 已有内核。
> 但**重构执行器目前只用了 go/typescript 的解析能力**，python 的解析器未接线到死代码检测。
> 你的新语言若用 tree-sitter，直接复用 `ts_kernel` 里的内核。

---

## 3. 语言无关执行器接口契约（已落地，直接照抄 import）

> 真实落地点：`src/tools/refactor_langs.ts`。下面的类型就是该文件导出的签名，**这是所有语言的公共界面**。

```ts
// src/tools/refactor_langs.ts（已存在，直接从这里 import，不要再自建一份）
import type { VerifyCommand } from './verify_refactor.js';

export type RefactorStageKind = 'dead_imports' | 'dead_statements';

/** 单步计算产物：纯计算，绝不落盘。落盘 + 验证 + 回滚全由管线负责。 */
export interface RunningChangePlan {
  absToNew: Map<string, string>;   // 绝对路径 → 新源码
  originals: Map<string, string>;  // apply 前预读的盘上内容（回滚用）
  units?: number;                  // 删除单位数；缺省由管线按步骤退化
}

export interface RefactorStageComputeArgs {
  project_dir: string;
  cwd: string;
  files?: string[];                 // 收敛范围（dead_statements 用）
  dead?: Array<{ source: string; files: string[] }>; // 死清单（dead_imports 用）
}

/** 单步执行器：纯计算 */
export interface RefactorStageExecutor {
  kind: RefactorStageKind;
  label: string;                                 // 报告展示；多语言同名步骤以语言前缀区分
  compute(args: RefactorStageComputeArgs): RunningChangePlan | Promise<RunningChangePlan>;
  limitations: string[];                         // 保守规则说明，写进报告给人类看
}

/** 一门语言的完整执行器（"新语言新路径"） */
export interface LanguageRefactorExecutor {
  lang: string;                                  // 如 'ts_go'/'py'/'java'（注册唯一 key）
  isSourceFile(rel: string): boolean;            // 目录语言命中探测用
  detectVerifyCommands(cwd: string): VerifyCommand[]; // 空数组 = 不可自动验证
  stages: RefactorStageExecutor[];               // 该语言暴露的重构步骤（保序执行）
}

export class RefactorLangRegistry {
  register(ex: LanguageRefactorExecutor): void;               // 同 lang 覆盖
  get(lang: string): LanguageRefactorExecutor | undefined;
  all(): LanguageRefactorExecutor[];
  forProject(cwd: string): LanguageRefactorExecutor[];        // 目录内有该语言源文件 → 入选（可多门并存）
}
```

**注册入口（给接力 AI 用的一个函数）**，从 `refactor_pipeline.ts` 导出：

```ts
// src/tools/refactor_pipeline.ts（已存在）
registerRefactorLanguage(ex: LanguageRefactorExecutor): void;   // 挂到模块级 DEFAULT_LANGS
```

调用 `registerRefactorLanguage(你的执行器)` 后，`runRefactorPipeline` 每次按项目自动探测拾取，**无需传 `langs` 参数、无需改管线主流程**。

**管线的约定**（接力的 AI 遵守即可，不必改 `runVerification` / 回滚机制）：
- `compute` 里**预读 originals**（= 上个绿点已应用的盘上内容），`apply` 交给管线写盘；
  改后验证失败，管线按 originals 还原，自然退到上一步绿点。
- 分层责任：**检测（detect）与改写（remove/apply）都是纯计算**；验证、回滚、基线保护全在管线。
- 验证命令：`verify:true` 时管线自动调 `mergeVerifyCommands(executors, cwd)` 聚合所有命中语言各自的 `detectVerifyCommands`（去重保序）；也可经 `verify.commands` 显式覆盖。

---

## 4. 给接力的 AI：Python 范例执行器

> 以下是一份**可直接跑通**的目标语言参考实现（文件级死 import 检测 + 移除）。
> 用 Python 做主例：一是 tree-sitter-python 已在依赖；二是它比 Java 更轻、范例更完整。
> Java 的差异点列在 §5。你写目标语言时，**照着这个结构实现 §2 表四个契约段**，并用
> `registerRefactorLanguage` 注册即可。

### 4.0 注册入口（新，骨架已就位）

```ts
// python_refactor/index.ts —— 装配并注册，其余代码零侵入
import type { LanguageRefactorExecutor } from '../refactor_langs.js';
import { registerRefactorLanguage } from '../refactor_pipeline.js';
import { pythonVerifyCommands } from './verify_commands.js';
import { computePythonDeadImports } from './dead_imports.js';
import { computePythonDeadStatements } from './dead_statements.js';

export const pythonExecutor: LanguageRefactorExecutor = {
  lang: 'py',
  isSourceFile: (rel) => rel.endsWith('.py'),
  detectVerifyCommands: pythonVerifyCommands,
  stages: [
    { kind: 'dead_imports',     label: '[py] dead import 移除', compute: computePythonDeadImports,     limitations: ['py 保守：顶层 import 副作用恒活，零引用才报死'] },
    { kind: 'dead_statements',  label: '[py] 死语句删除',       compute: computePythonDeadStatements,  limitations: ['py 保守：return/raise 后不可达删'] },
  ],
};

// 应用入口（一次性）
registerRefactorLanguage(pythonExecutor);
```

### 4.1 验证命令探测（契约段 #2）

```ts
// python_refactor/verify_commands.ts
import fs from 'node:fs';
import path from 'node:path';
import type { VerifyCommand } from '../verify_refactor.js';

export function pythonVerifyCommands(cwd: string): VerifyCommand[] {
  const hasPyProject = fs.existsSync(path.join(cwd, 'pyproject.toml'));
  const hasReq = fs.existsSync(path.join(cwd, 'requirements.txt')) || fs.existsSync(path.join(cwd, 'setup.py'));
  if (!hasPyProject && !hasReq) return [];
  const cmds: VerifyCommand[] = [
    { label: 'py compileall', cmd: 'python', args: ['-m', 'compileall', '-q', '.'], timeoutMs: 120_000 },
  ];
  // 保守：探测到测试约定才加 pytest，测不到就当"只验证语法+导入"
  if (hasPyProject) cmds.push({ label: 'pytest', cmd: 'python', args: ['-m', 'pytest', '-q'], timeoutMs: 600_000 });
  return cmds;
}
```

### 4.2 死 import 检测 + 移除（契约段 #3；用 Python `ast` 或 tree-sitter-python）

文件级自洽思路与 TS 版完全同构：剥掉 import/from-import 语句后，某个 import 绑定的名字
在文件内**零出现** → 死；`import module`（含顶层副作用语义）保守保留，绝不误删。

```ts
// python_refactor/dead_imports.ts —— 检测 + 输出"整条语句删除计划"
import fs from 'node:fs';
import path from 'node:path';

export function collectPythonSources(project_dir: string, files?: string[]) {
  const proj = path.resolve(project_dir);
  const list: string[] = [];
  const push = (abs: string) => { if (abs.endsWith('.py')) list.push(abs); };
  if (files?.length) { for (const f of files) { const a = path.isAbsolute(f) ? f : path.resolve(proj, f); if (fs.existsSync(a)) push(a); } return list; }
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === '__pycache__' || e.name === 'venv' || e.name === '.venv' || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else push(p);
    }
  };
  walk(proj);
  return list;
}

/** 逐行安全删目标 source 的 import/from-import 语句（整条删）。返回新源码与原样比对。 */
export function removePythonImportLine(src: string, target: string): { removed: number; output: string } {
  const esc = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reImport = new RegExp(`^[ \\t]*import[ \\t]+${esc}(?:\\.|[ \\t]|$)`, 'm');
  const reFrom = new RegExp(`^[ \\t]*from[ \\t]+${esc}[ \\t]+import[ \\t]`, 'm');
  const lines = src.split('\n');
  const keep: string[] = [];
  let removed = 0;
  for (const line of lines) {
    if (reImport.test(line) || reFrom.test(line)) { removed++; continue; }
    keep.push(line);
  }
  return { removed, output: keep.join('\n') };
}

/** 聚合：每个文件里，绑定的首名在"剥掉 import 行后的源码"零出现 → 死。 */
export function computePythonDeadImports(args: {
  project_dir: string; cwd: string; files?: string[]; dead?: Array<{ source: string; files: string[] }>;
}): { absToNew: Map<string, string>; originals: Map<string, string>; units: number } {
  const { project_dir, files } = args;
  const absToNew = new Map<string, string>();
  const originals = new Map<string, string>();
  let units = 0;
  for (const abs of collectPythonSources(project_dir, files)) {
    const src = fs.readFileSync(abs, 'utf-8');
    // 示意：把命令生成的 dead 清单与"零引用"自洽判定结合；此处以自洽判定为主。
    const stripped = src.split('\n').filter((l) => !/^\s*(import|from)\s+/.test(l)).join('\n');
    const remove: string[] = [];
    for (const m of src.matchAll(/^[ \t]*(?:import[ \t]+[\w.]+[ \t]+as[ \t]+(\w+)|import[ \t]+([\w.]+)|from[ \t]+([\w.]+)[ \t]+import)/gm)) {
      const name = m[1] ?? m[2]?.split('.').slice(-1)[0] ?? m[3]?.split('.').slice(-1)[0];
      if (!name) continue;
      const s = m[3] ?? m[2] ?? name;                 // 模块说明符（from 用 m[3]，import 用 m[2]）
      const bind = m[1] ?? name;                       // 别名绑定 or 首名
      const dead = !new RegExp(`\\b${bind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(stripped);
      if (dead) remove.push(s);
    }
    if (!remove.length) continue;
    let out = src;
    let n = 0;
    for (const s of remove) { const r = removePythonImportLine(out, s); out = r.output; n += r.removed; }
    if (n > 0) { absToNew.set(abs, out); originals.set(abs, src); units += n; }
  }
  return { absToNew, originals, units };
}
```

> 上面的检测器是**示意骨架**，突出"剥 import 行 + 名字出现计数 + 零出现报死"的同构思路。
> 接力的 AI 请补：模块说明符的**规范化 key**、别名、重复 import 去重、`from a.b import x` 的归属，
> 并为它写单测。

### 4.3 死语句（契约段 #4；用 tree-sitter-python 的 CFG）

与 TS/Go 的 `computeDeadStatementsPlan` 同构：解析函数体块，找终止语句（`return`/`raise`）后
**安全可删**的兄弟语句（无副作用者）。接力的 AI：给 `isTerminal` / `isDeletable` 补一份
Python 规则（`return/raise` 为终止；赋值、普通表达式调用视副作用谨慎判定）。产物要凑齐
`{ absToNew, originals, units }`。

```ts
// python_refactor/dead_statements.ts（示意结构，请补实现与单测）
export async function computePythonDeadStatements(args: {
  project_dir: string; cwd: string; files?: string[];
}): Promise<{ absToNew: Map<string, string>; originals: Map<string, string>; units: number }> {
  // 待接力 AI 实现：解析 .py 函数体 → return/raise 后不可达兄弟语句 → 产出删除计划。
  return { absToNew: new Map(), originals: new Map(), units: 0 };
}
```

---

## 5. Java 快速映射（差异点速查）

| 维度 | Python | Java（目标语言示例） |
|---|---|---|
| manifest 探测 | `pyproject.toml` / `requirements.txt` | `pom.xml`(Maven) / `build.gradle`(Gradle) |
| 验证命令 | `python -m compileall` + `pytest` | `mvn -q -B compile test` 或 `gradle -q build` |
| 死 import 检测 | AST + 名字出现计数 | `javac -Xlint:all` 的 unused import warning，或 Javaparser 的 import 使用分析 |
| 死语句 | `return` 后不可达 | `return`/`throw` 后不可达 + try/finally 副作用守卫 |
| 保守保留 | 副作用 import 恒活 | 同包 / 静态 import / `*` 通配 import 保守保留 |

---

## 6. 你动手时的自检清单

落成代码前，把你实现的每条规则用一句话写进执行器的 `limitations`，并逐条给测试。

- [ ] 你的执行器已实现 §2 表四个契约段（`isSourceFile` / `detectVerifyCommands` / 两个 stages 的 `compute`），无残留的 `'go' | 'ts'` 双态硬编码影响你的语言。
- [ ] 已 `registerRefactorLanguage(你的执行器)` 注册；`runRefactorPipeline` 对目标语言项目能自动路由到它（`forProject` 探测到源文件即拾取）；探不到语言时行为与现在一致（无变更）。
- [ ] 新语言跑通一键：`{ project_dir, steps:{dead_imports:{enabled:true},dead_statements:{enabled:true}}, verify:true }`。
- [ ] `npx tsc --noEmit` + `npx vitest run` 全绿。
- [ ] 你的新语言带 3 类测试：死活判定、保守保留、管线语言路由。

> 上报交接时，把这份文档里"你实现过"的契约段行高亮，方便下一位 AI 快速 diff。