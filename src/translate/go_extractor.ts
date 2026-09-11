/**
 * go_extractor —— tree-sitter 萃取 Go 顶层函数 / 结构体，产出 trans_unit
 *
 * 定位：三段式落地的"① 语法萃取"（纯机械、可审、可回滚）。
 * 复用仓库共享解析根基 ts_kernel.parseAstRoot（tree-sitter-go，optionalDependency），
 * 不新造解析器。只做"抽取 → 归一化为 TransUnit"，不落盘、不生成目标语言。
 *
 * 切片范围（Go→TS 最小切片）：
 *   - 顶层 `func`（无 receiver，即非方法）
 *   - 顶层 `type X struct { ... }`（→ type 单元）
 *   - 方法（method_declaration）、接口、别名、并发/错误多返回值此处只透传原始
 *     result，由目标 codegen 判"不可机械翻译"并加约束，而非在此强行猜。
 */

import { parseAstRoot, type SyntaxNodeLike } from '../tools/ts_kernel/index.js';
import { DEFAULT_CONSTRAINTS, type TransUnit, type TranslateParam, type TranslateKind } from './unit.js';

/** 从 Go AST 节点取字段子节点（tree-sitter 字段名访问，防御 null） */
function childField(node: SyntaxNodeLike, name: string): SyntaxNodeLike | null {
  try {
    return node.childForFieldName(name) ?? null;
  } catch {
    return null;
  }
}

/** 收集参数列表块里的每个 parameter_declaration（展开 `a, b int` 为两条） */
function extractParamList(block: SyntaxNodeLike): TranslateParam[] {
  const out: TranslateParam[] = [];
  let idx = 0;
  for (let i = 0; i < block.childCount; i++) {
    const child = block.child(i);
    if (!child || child.type !== 'parameter_declaration') continue;
    const typeNode = childField(child, 'type');
    const type = typeNode ? typeNode.text : 'unknown';
    const names: string[] = [];
    for (let j = 0; j < child.childCount; j++) {
      const c = child.child(j);
      if (c && c.type === 'identifier') names.push(c.text);
    }
    if (names.length === 0) names.push(`arg${idx}`);
    for (const n of names) out.push({ name: n, type });
    idx++;
  }
  return out;
}

/** func 单元：`func Add(a, b int) int { ... }` → TransUnit(kind='func') */
function unitFromFunc(node: SyntaxNodeLike): TransUnit | null {
  // 有 receiver 字段 = 方法，切片跳过（保顶层函数）
  if (childField(node, 'receiver')) return null;
  const nameNode = childField(node, 'name');
  if (!nameNode) return null;
  const name = nameNode.text;
  const paramsNode = childField(node, 'parameters');
  const params = paramsNode ? extractParamList(paramsNode) : [];
  const resultNode = childField(node, 'result');
  const result = resultNode ? resultNode.text.trim() : null;
  const snippet = node.text.trim();
  return {
    id: name,
    kind: 'func',
    dstLang: 'ts',
    name,
    params,
    result,
    srcSnippet: snippet,
    skeleton: '',
    bodyHole: true,
    constraints: [...DEFAULT_CONSTRAINTS],
  };
}

/** 直接子节点里找某类型（字段名兜底；tree-sitter-go 的 struct body 字段名是 body） */
function findChildOfType(node: SyntaxNodeLike, childType: string): SyntaxNodeLike | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === childType) return c;
  }
  return null;
}

/** struct 单元：`type User struct { ... }` → TransUnit(kind='type') */
function unitFromTypeSpec(spec: SyntaxNodeLike): TransUnit | null {
  const nameNode = childField(spec, 'name');
  const typeNode = childField(spec, 'type');
  if (!nameNode || !typeNode) return null;
  // 只收 struct_type；interface/别名/数组/指针类型暂交 codegen 或后版本
  if (typeNode.type !== 'struct_type') return null;
  const name = nameNode.text;
  const fields: { name: string; type: string }[] = [];
  const list = childField(typeNode, 'field_declaration_list') || childField(typeNode, 'body') || findChildOfType(typeNode, 'field_declaration_list');
  if (list) {
    for (let i = 0; i < list.childCount; i++) {
      const fd = list.child(i);
      if (!fd || fd.type !== 'field_declaration') continue;
      const typeNode2 = childField(fd, 'type');
      if (!typeNode2) continue; // 嵌入字段无独立 name，切片跳过
      const type = typeNode2.text;
      for (let j = 0; j < fd.childCount; j++) {
        const c = fd.child(j);
        if (c && c.type === 'field_identifier') fields.push({ name: c.text, type });
      }
    }
  }
  if (fields.length === 0) return null; // 空结构体无翻译价值，跳过
  return {
    id: name,
    kind: 'type' as TranslateKind,
    dstLang: 'ts',
    name,
    fields,
    srcSnippet: spec.text.trim(),
    skeleton: '',
    bodyHole: false,
    constraints: [...DEFAULT_CONSTRAINTS],
  };
}

/** 深度遍历 AST，收集目标单元 */
function collect(node: SyntaxNodeLike, units: TransUnit[]): void {
  const isFunc = node.type === 'function_declaration';
  const isTypeDecl = node.type === 'type_declaration';
  if (isFunc) {
    const u = unitFromFunc(node);
    if (u) units.push(u);
    return; // 不进函数体（切片只收顶层，避免捕获嵌套 func/func_literal）
  }
  // type_declaration 下逐个子 type_spec
  if (isTypeDecl) {
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c && c.type === 'type_spec') {
        const u = unitFromTypeSpec(c);
        if (u) units.push(u);
      }
    }
    return; // type_spec 内部不再需要一般遍历
  }
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c) collect(c, units);
  }
}

export interface ExtractGoResult {
  units: TransUnit[];
  /** 萃取失败原因（解析失败时返回空 units + error） */
  error?: string;
}

/**
 * 解析 Go 源码 → 萃取顶层 func / struct 为 trans_unit 列表。
 * 复用 ts_kernel.parseAstRoot（含 32KB callback 规避与容错解析），
 * 解析失败返回空列表 + error（不抛，与仓库优雅降级约定一致）。
 */
export async function extractGo(filePath: string, source: string): Promise<ExtractGoResult> {
  const parsed = await parseAstRoot(filePath, source);
  if (!parsed?.root) return { units: [], error: `Go 解析失败（可解析性未知）：${filePath}` };
  const units: TransUnit[] = [];
  collect(parsed.root, units);
  return { units };
}