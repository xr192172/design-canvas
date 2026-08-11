/**
 * language_concepts —— 语言级编程模式识别（路线图序号 10）
 *
 * 借鉴 Understand Anything 的「Language Concepts」：检测代码中的常见编程模式
 * （泛型 / 闭包 / 装饰器 / 异步 / 依赖注入 / 工厂 / 单例 / 观察者 / 策略 /
 * 模板方法 / 错误处理 / 状态机 等），在符号节点上下文展示解释，帮助理解代码。
 *
 * 数据源零新增：复用 cache.db 的 nodes 表（name / kind / qualified_name /
 * signature / file_path）。模式识别从符号的字段启发式推断——纯函数、只读，
 * 不修改 DSL，不新增数据管线。
 *
 * 每个概念带手写解释文案（explanation，中文）。后续可复用 LLM 生成分角色
 * 文案（newbie/pm/senior），本模块只负责确定性检测与基础解释。
 */

import path from 'node:path';
import { getProjectCacheDb, type Database } from '../db/db.js';

// ─────────────────────────────────────────────────────────────
// 概念定义
// ─────────────────────────────────────────────────────────────

export interface ConceptDef {
  /** 概念 id（稳定标识，供渲染/检索复用） */
  id: string;
  /** 展示名 */
  name: string;
  /** 中文解释 */
  explanation: string;
}

/** 12 种内置编程模式概念（可按需扩展） */
export const CONCEPTS: ConceptDef[] = [
  {
    id: 'generic',
    name: '泛型',
    explanation: '用类型参数（如 <T>）让函数/类/接口适配多种类型，调用时再指定具体类型，提升复用性与类型安全。',
  },
  {
    id: 'generator',
    name: '生成器',
    explanation: '用 function* 或 yield 惰性产出序列值，每次 next() 时才计算，适合流式/大数据的按需生成。',
  },
  {
    id: 'closure',
    name: '闭包',
    explanation: '函数捕获并记住其定义时的外部作用域变量，即使外层已返回仍可访问，常用于回调和状态封装。',
  },
  {
    id: 'decorator',
    name: '装饰器',
    explanation: '以 @ 语法附加到类/方法上，在运行时包装或增强原有行为，实现横切关注点（日志、鉴权、缓存）。',
  },
  {
    id: 'async',
    name: '异步',
    explanation: '通过 async/await、Promise 或回调处理非阻塞操作，避免阻塞主线程，协调并发与 I/O。',
  },
  {
    id: 'dependency-injection',
    name: '依赖注入',
    explanation: '把依赖从外部传入而非内部 new 出来，降低耦合、便于测试与替换实现。',
  },
  {
    id: 'factory',
    name: '工厂',
    explanation: '将对象创建逻辑集中到一个方法/类，按参数返回不同类型实例，隐藏构造细节。',
  },
  {
    id: 'singleton',
    name: '单例',
    explanation: '保证一个类全局只有唯一实例，并提供一个全局访问点（如 getInstance / instance）。',
  },
  {
    id: 'observer',
    name: '观察者',
    explanation: '通过订阅/发布机制让对象在事件发生时通知监听者，实现解耦的事件驱动通信。',
  },
  {
    id: 'strategy',
    name: '策略',
    explanation: '把可互换的算法封装为独立策略对象，运行时动态选择，避免大量条件分支。',
  },
  {
    id: 'template-method',
    name: '模板方法',
    explanation: '在基类中固定算法骨架，把可变步骤留给子类覆写，复用餐具流程、定制细节。',
  },
  {
    id: 'error-handling',
    name: '错误处理',
    explanation: '通过 try/catch、抛出异常或返回错误值，对流式失败做捕获、传播与恢复。',
  },
  {
    id: 'state-machine',
    name: '状态机',
    explanation: '用显式的状态集合与转移规则建模对象行为，避免用散乱的布尔/分支管理复杂状态。',
  },
];

/** 概念 id → 定义 的快速索引 */
const CONCEPT_BY_ID = new Map(CONCEPTS.map((c) => [c.id, c]));

// ─────────────────────────────────────────────────────────────
// 确定性检测规则（纯函数）
// ─────────────────────────────────────────────────────────────

export interface SymbolInput {
  name: string;
  kind: string;
  qualified_name: string;
  signature: string | null;
}

/**
 * 从单个符号的字段识别命中的概念集合。
 *
 * 规则为启发式、可叠加（一个符号可命中多种概念，如「异步 + 泛型」）。
 * 检测基于 name / kind / signature / qualified_name 的子串与模式匹配，
 * 不解析 AST——零新增依赖，确定性可单测。
 */
export function detectConcepts(sym: SymbolInput): string[] {
  const hits = new Set<string>();
  const sig = sym.signature ?? '';
  const name = sym.name;
  const qn = sym.qualified_name;
  const lowerName = name.toLowerCase();
  const lowerQn = qn.toLowerCase();
  const lowerSig = sig.toLowerCase();

  // 泛型：signature 含类型参数声明（<T> / <T, U>），或返回类型里的泛型用法
  // （Promise<T> / Map<K,V> / T[] 等）。TS buildSignature 只拼 name(params): ret，
  // 类型参数声明被丢弃，故还需识别类型参数在返回类型/参数中的使用。
  if (/<[A-Z][A-Za-z0-9_]*(\s*,|\s*>| extends|=|:)/.test(sig) && !/>$/.test(sig)) {
    hits.add('generic');
  }
  if (/<\s*[A-Z][A-Za-z0-9_,\s]*>/.test(sig) || /\b[A-Z][A-Za-z0-9_]*\[\]/.test(sig)) {
    hits.add('generic');
  }

  // 生成器：function* / yield 出现在 signature
  if (lowerSig.includes('function*') || lowerSig.includes('yield') || /: *generator/i.test(sig)) {
    hits.add('generator');
  }

  // 闭包：返回类型是函数（签名含 => 或 Function 且作为返回），或高阶函数参数
  if (/\}:?\s*=>/.test(sig) || /\)\s*=>/.test(sig) || /\([^)]*\)\s*=>\s*[A-Za-z_]/.test(sig)) {
    hits.add('closure');
  }

  // 装饰器：signature 或名字带 @
  if (sig.includes('@') || name.includes('@')) {
    hits.add('decorator');
  }

  // 异步：async / Promise / await
  if (lowerSig.includes('async') || lowerSig.includes('promise') || lowerSig.includes('await')) {
    hits.add('async');
  }

  // 依赖注入：名字/签名含 inject / provider / container / factory method 注入
  if (/(inject|provider|container|auto_wire|autowire)/.test(lowerName) || /(inject|provider)/.test(lowerQn)) {
    hits.add('dependency-injection');
  }

  // 工厂：名字以 create / build / make / new 开头，或含 factory
  if (/^(create|build|make|new)[A-Z_]/.test(name) || lowerName.includes('factory')) {
    hits.add('factory');
  }

  // 单例：getInstance / instance / singleton / get_shared
  if (/(getinstance|singleton|::instance|\.instance|get_shared|get_default)/.test(lowerQn) || /(singleton|getinstance)/.test(lowerName)) {
    hits.add('singleton');
  }

  // 观察者：subscribe / on* / emit / listener / notify / broast / pub(lish)
  if (/(subscribe|unsubscribe|emit|listener|notify|broast|publish|onchange|oncl|custom_event|event_emitter)/.test(lowerName) || /(event_emitter|eventbus)/.test(lowerQn)) {
    hits.add('observer');
  }

  // 策略：名字含 strategy / policy / handler / resolver / dispatcher
  if (/(strategy|policy|handler|resolver|dispatcher|router)/.test(lowerName)) {
    hits.add('strategy');
  }

  // 模板方法：基类中的抽象/hook/钩子方法，signature 含 abstract 或名字含 hook/template
  if (lowerSig.includes('abstract') || /(template_method|hook|on_enter|on_exit|visit_)/.test(lowerName)) {
    hits.add('template-method');
  }

  // 错误处理：名字含 error / exception / try_ / retry / wrap / safe_；或签名抛异常
  if (/(error|exception|try_|retry|wrap|safe_|recover)/.test(lowerName) || lowerSig.includes('throw') || lowerSig.includes(' raises ')) {
    hits.add('error-handling');
  }

  // 状态机：名字含 state / transition / fsm / stage
  if (/(state_machine|fsm|transition|_state\b|get_state|set_state|stage)/.test(lowerName)) {
    hits.add('state-machine');
  }

  return [...hits];
}

// ─────────────────────────────────────────────────────────────
// 项目级检测（从 cache.db 拉符号批量识别）
// ─────────────────────────────────────────────────────────────

export interface ConceptHit {
  /** 符号 id（cache.db nodes.id） */
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  /** 命中的概念 id 列表 */
  concepts: string[];
}

export interface LanguageConceptsInput {
  project_dir: string;
  /** 只检测这些概念（默认全部） */
  concepts?: string[];
  /** 过滤：只返回命中这些文件的符号（可选） */
  files?: string[];
  /** 返回符号上限（默认 200） */
  limit?: number;
}

export interface LanguageConceptsResult {
  provider: 'detect';
  indexed: number;
  /** 命中至少一个概念的符号数 */
  matched: number;
  /** 概念 → 命中符号数统计 */
  concept_counts: Array<{ id: string; name: string; count: number }>;
  /** 命中概念的具体符号（按概念出现数量降序） */
  hits: ConceptHit[];
  message: string;
}

/** 校验 concepts 参数：非法 id 忽略，返回合法集合；空数组 = 全部 */
function resolveConceptFilter(ids?: string[]): Set<string> | null {
  if (!ids || ids.length === 0) return null;
  const set = new Set<string>();
  for (const id of ids) if (CONCEPT_BY_ID.has(id)) set.add(id);
  return set.size > 0 ? set : null;
}

/** 从 cache.db 批量识别语言级概念。缓存不可用时返回提示性空结果。 */
export function languageConcepts(input: LanguageConceptsInput): LanguageConceptsResult {
  const projectDir = path.resolve(input.project_dir);
  const limit = input.limit ?? 200;
  const filter = resolveConceptFilter(input.concepts);
  const fileFilter = input.files && input.files.length > 0 ? new Set(input.files) : null;

  let db: Database;
  try {
    db = getProjectCacheDb(projectDir);
  } catch (e) {
    return {
      provider: 'detect',
      indexed: 0,
      matched: 0,
      concept_counts: [],
      hits: [],
      message: `无法打开符号缓存：${(e as Error).message}。请先对该项目运行 import_project 建缓存。`,
    };
  }

  const rows = db
    .prepare(
      `SELECT id, kind, name, qualified_name, file_path, start_line, signature
       FROM nodes WHERE kind != 'file' ORDER BY start_line, id`,
    )
    .all() as Array<{
    id: string;
    kind: string;
    name: string;
    qualified_name: string;
    file_path: string;
    start_line: number;
    signature: string | null;
  }>;

  if (rows.length === 0) {
    return {
      provider: 'detect',
      indexed: 0,
      matched: 0,
      concept_counts: [],
      hits: [],
      message: '符号缓存为空。请先对该项目运行 import_project 建立符号缓存。',
    };
  }

  const counts = new Map<string, number>();
  for (const c of CONCEPTS) counts.set(c.id, 0);

  const hits: ConceptHit[] = [];
  for (const r of rows) {
    if (limit > 0 && hits.length >= limit) break;
    if (fileFilter && !fileFilter.has(r.file_path)) continue;
    const concepts = detectConcepts(r);
    if (filter) {
      const kept = concepts.filter((c) => filter.has(c));
      if (kept.length === 0) continue;
      for (const c of kept) counts.set(c, (counts.get(c) ?? 0) + 1);
      hits.push({ ...r, concepts: kept });
    } else {
      if (concepts.length === 0) continue;
      for (const c of concepts) counts.set(c, (counts.get(c) ?? 0) + 1);
      hits.push({ ...r, concepts });
    }
  }

  const concept_counts = CONCEPTS.map((c) => ({ id: c.id, name: c.name, count: counts.get(c.id) ?? 0 }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count);

  const matched = hits.length;
  const summary = concept_counts.map((c) => `${c.name}(${c.count})`).join(' / ');
  const message =
    `语言概念检测完成：扫描 ${rows.length} 个符号，命中 ${matched} 个（${concept_counts.length} 种概念：${summary || '无'}）。` +
    (filter
      ? '（按 concepts 过滤，仅统计指定概念）'
      : '') +
    (fileFilter
      ? '（按 files 过滤）'
      : '');

  return { provider: 'detect', indexed: rows.length, matched, concept_counts, hits, message };
}