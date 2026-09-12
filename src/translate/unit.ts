/**
 * unit —— trans_unit「待译契约」协议层
 *
 * 核心思想（对标三段式落地的"契约层"）：
 *   翻译的锚点不是"一棵要 round-trip 的公共 AST"，而是一条自包含的
 *   `TransUnit`（待译契约）。它既喂给机械骨架生成机，也直接作为 LLM
 *   单孔填充的 prompt 输入与验证闸的检查对象。
 *
 *   关键设计：`skeleton`（已生成的确定性产物）与 `bodyHole`（待 LLM 填的
 *   孔）分离。骨架是"锁定外壳"，LLM 只能在签名/导出/返回类型被焊死的
 *   框架里代换函数体——这比让 LLM 自由翻译整个包要简单且可控。
 *
 * 兼容性：本文件只放协议与纯常量，不 import 任何解析/生成实现（避免
 * 循环依赖），与 src/tools/refactor_langs.ts 的契约层定位一致。
 */

/** 一条待译契约的类型类别 */
export type TranslateKind = 'func' | 'type' | 'const';

/** 参数/字段的最小结构化描述 */
export interface TranslateParam {
  /** 本地名（Go 参数名 / struct 字段名） */
  name: string;
  /** 源语言类型原文（如 'int' / '[]byte' / '*User'） */
  type: string;
}

/** 接口的方法签名（用于 type→interface 单元） */
export interface TranslateMethod {
  name: string;
  params: TranslateParam[];
  result?: string | null;
}

/**
 * 一条待译契约。携带"源证据 + 目标骨架 + 待填孔 + 约束"四件套，
 * 让下游（骨架生成机 / LLM prompt / 验证闸 / 语言适配器）各自只认自己
 * 需要的字段，无需再回源文件。
 */
export interface TransUnit {
  /** 稳定标识：源语言限定名（如顶层函数名 'Add' / 类型名 'User'） */
  id: string;
  /** 'func' | 'type' */
  kind: TranslateKind;
  /** 目标语言（本切片恒 'ts'；协议为多目标预留） */
  dstLang: string;
  /** 符号名 */
  name: string;

  // —— func 用 ——
  /** 参数表（Go 展开成单参数单类型） */
  params?: TranslateParam[];
  /** 返回类型原文；null / undefined = 无返回值 */
  result?: string | null;
  /** Go 类型参数名（泛型），如 ['T']；渲染为 TS `<T, ...>` */
  typeParams?: string[];
  /** 各类型参数 → Go 约束原文（如 comparable/any/Ordered）；TS 无等价约束，仅传递提示 */
  typeParamConstraints?: Record<string, string>;
  /** 各类型参数 → 能表达成 TS 的 `extends` 约束（如 'number' / 'number | string' / 'Uint8Array'）；空串=不设 bound */
  typeParamBounds?: string[];
  /** A3 决策表：函数体为 switch-on-expression 时，锁定分支结构（判别式 + case 标签 + default），LLM 只填分支内动作 */
  decision?: DecisionShape;

  // —— const 用 ——
  /** 直译后的 TS 字面量源码（标量 const/var 常量表达式），如 '100' / '"hi"' / 'true' */
  value?: string;
  /** var（可变）→ 渲成 export let；const（不可变）→ export const。缺省 const */
  isVar?: boolean;

  // —— type 用 ——
  /** 具体形态：struct → interface；interface → interface(方法签名)；alias → type 别名 */
  typeKind?: 'struct' | 'interface' | 'alias';
  /** struct 字段表 */
  fields?: { name: string; type: string }[];
  /** interface 方法签名表（typeKind='interface'） */
  methods?: TranslateMethod[];
  /** alias 的底层类型原文（typeKind='alias'） */
  aliasType?: string;

  // —— 证据与目标 ——
  /** 源文件里该单元的完整原文（给 LLM 做翻译上下文；type 非孔则省略） */
  srcSnippet: string;
  /** 源 Go 中该单元起始行（1-based，用于失败清单一键定位） */
  srcLine?: number;
  /** 目标语言骨架：func = 签名外壳（body 留空为孔）；type = 完整 interface */
  skeleton: string;
  /** true = 该单元有孔待 LLM 填（func 恒 true；type 恒 false） */
  bodyHole: boolean;
  /** 本单元翻译约束（骨架生成时并入 typeMap 语义 note） */
  constraints: string[];
}

/** 一条决策分支（A3）：一组 case 标签属同一分支（`case a, b:`），或 default */
export interface DecisionCase {
  labels: string[];
  branchId: string;
}

/** A3 决策表形状：switch-on-expression 的锁定分支结构 */
export interface DecisionShape {
  /** 判别式（Go 原文，如 cfg.Kind / msg.Type；`switch {}` 为 'true'） */
  discriminant: string;
  /** 顺序分支（每个一个 TS case 组） */
  cases: DecisionCase[];
  hasDefault: boolean;
}

/** 所有单元共享的硬约束（LLM 不得越界） */
export const DEFAULT_CONSTRAINTS: string[] = [
  '不得新增或删除顶层导出（export）',
  '不得改动函数签名、参数名与返回类型',
  '不得引入除目标函数体外的副作用',
  '不翻译 srcSnippet 里未提供的语义，保留易译近似并加 TODO 注释',
];

/** 合并约束（去重、保序），返回新数组（不改变入参） */
export function withConstraints(existing: string[], more: string[]): string[] {
  const set = new Set(existing);
  for (const c of more) set.add(c);
  return [...set];
}