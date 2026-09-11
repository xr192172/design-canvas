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
import { DEFAULT_CONSTRAINTS, type TransUnit, type TranslateParam, type TranslateKind, type TranslateMethod } from './unit.js';
import { evalConstExpr, constToTsLiteral, type ConstValue } from './const_eval.js';

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

/** 解析 receiver 文本 → 参名 + 基类型名 + 泛型实参 + 可渲染全类型
 *  `(u *User)` → base User；`(p *Pair[T])` → base Pair, typeArgs ['T'], fullType 'Pair<T>' */
function parseReceiver(recvText: string): { name: string; base: string; typeArgs: string[]; fullType: string } | null {
  const m = recvText.match(/\(?\s*([A-Za-z_]\w*)\s+(?:\*\s*)?([\w.]+)(?:\[([^\]]*)\])?/);
  if (!m) return null;
  const base = m[2].replace(/\./g, '_');
  const typeArgs = (m[3] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z_]\w*$/.test(s));
  return { name: m[1], base, typeArgs, fullType: typeArgs.length ? `${base}<${typeArgs.join(', ')}>` : base };
}

/** 类型参数名（泛型）：`[T any]` / `[T comparable]` → ['T'] */
function extractTypeParams(node: SyntaxNodeLike): string[] {
  const list = childField(node, 'type_parameters') || findChildOfType(node, 'type_parameter_list');
  if (!list) return [];
  const names: string[] = [];
  for (let i = 0; i < list.childCount; i++) {
    const c = list.child(i);
    if (!c || c.type !== 'type_parameter_declaration') continue;
    for (let j = 0; j < c.childCount; j++) {
      const id = c.child(j);
      if (id && id.type === 'identifier') {
        names.push(id.text);
        break;
      }
    }
  }
  return names;
}

/** 各类型参数 → 约束原文（`T comparable` → {T:'comparable'}；`T any` → {T:'any'}） */
function extractTypeConstraints(node: SyntaxNodeLike): Record<string, string> {
  const list = childField(node, 'type_parameters') || findChildOfType(node, 'type_parameter_list');
  if (!list) return {};
  const out: Record<string, string> = {};
  for (let i = 0; i < list.childCount; i++) {
    const c = list.child(i);
    if (!c || c.type !== 'type_parameter_declaration') continue;
    let name: string | undefined;
    let constraint = '';
    for (let j = 0; j < c.childCount; j++) {
      const k = c.child(j);
      if (!k) continue;
      if (!name && k.type === 'identifier') name = k.text;
      else if (name && (k.type === 'type_constraint' || k.type === 'type_identifier')) constraint = k.text;
    }
    if (name && constraint) out[name] = constraint;
  }
  return out;
}

/** 函数体里的并发/资源语义 → 给 LLM 的提示（不硬猜，只指导映射方向） */
function appendBodyHints(snippet: string, constraints: string[]): void {
  if (/\bdefer\b/.test(snippet)) constraints.push('函数体含 defer：建议映射为 try/finally（或显式 close/finally），勿丢清理语义');
  if (/\bgo\s+\w/.test(snippet)) constraints.push('函数体含 go 语句：建议映射为异步 fire-and-forget（Promise），注意并发时序差异');
  if (/\bselect\b/.test(snippet)) constraints.push('函数体含 select：Go select 的 first-ready 竞态语义 TS 无等价物，需人工或 Promise.race 近似');
  if (/<-/.test(snippet)) constraints.push('函数体含 <- 通道收发：Channel<T> 垫片为近似，阻塞/竞态语义需人工核');
}

/** 归一化返回类型：去命名返回的名字，`(x int, err error)` → `(int, error)`；`(x int)` → `int` */
function normResult(s: string): string {
  const t = s.trim();
  if (t.startsWith('(') && t.endsWith(')')) {
    const parts = t
      .slice(1, -1)
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const m = /^[A-Za-z_]\w*\s+(.+)$/.exec(p);
        return m ? m[1].trim() : p;
      });
    return parts.length === 1 ? parts[0] : '(' + parts.join(', ') + ')';
  }
  return t;
}

/** func/方法 单元：`func Add(...)` 或 `func (u *User) Greet(...)` → TransUnit(kind='func')
 *  方法映射为 TS 自由函数：receiver 作首参，名取 `${recvType}_${method}`（防同文件多类型方法撞名）。 */
function unitFromFunc(node: SyntaxNodeLike): TransUnit | null {
  const nameNode = childField(node, 'name');
  if (!nameNode) return null;
  const method = nameNode.text;
  const paramsNode = childField(node, 'parameters');
  const params = paramsNode ? extractParamList(paramsNode) : [];
  const resultNode = childField(node, 'result');
  const result = resultNode ? normResult(resultNode.text.trim()) : null;
  const snippet = node.text.trim();
  const constraints = [...DEFAULT_CONSTRAINTS];
  appendBodyHints(snippet, constraints);

  const recvNode = childField(node, 'receiver');
  const recv = recvNode ? parseReceiver(recvNode.text) : null;
  const ownTypeParams = extractTypeParams(node);
  const typeParamConstraints = extractTypeConstraints(node);
  if (recv) {
    // 方法：receiver 作首参（泛型 receiver 用全类型如 Pair<T>）；命名带类型基名前缀防撞名
    params.unshift({ name: recv.name, type: recv.fullType });
    const qn = `${recv.base}_${method}`;
    // 方法自身无类型参数时，继承 receiver 的泛型实参作为自由函数的 <T...>
    const typeParams = ownTypeParams.length ? ownTypeParams : recv.typeArgs;
    return { id: qn, kind: 'func', dstLang: 'ts', name: qn, params, result, typeParams, typeParamConstraints, srcSnippet: snippet, skeleton: '', bodyHole: true, constraints };
  }
  return { id: method, kind: 'func', dstLang: 'ts', name: method, params, result, typeParams: ownTypeParams, typeParamConstraints, srcSnippet: snippet, skeleton: '', bodyHole: true, constraints };
}

/** 直接子节点里找某类型（字段名兜底；tree-sitter-go 的 struct body 字段名是 body） */
function findChildOfType(node: SyntaxNodeLike, childType: string): SyntaxNodeLike | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === childType) return c;
  }
  return null;
}

/** 单个 method_elem：`Greet(n string) string` → { name, params, result } */
function methodFromElem(elem: SyntaxNodeLike): TranslateMethod | null {
  let name = '';
  let params: TranslateParam[] = [];
  let result: string | null | undefined;
  let paramSeen = false;
  for (let i = 0; i < elem.childCount; i++) {
    const c = elem.child(i);
    if (!c) continue;
    if (c.type === 'field_identifier' && !name) name = c.text;
    else if (c.type === 'parameter_list') {
      if (paramSeen) result = normResult(c.text); // 第二个参数表 = 多返回值结果
      else {
        params = extractParamList(c);
        paramSeen = true;
      }
    } else if (c.type === 'type_identifier' && result === undefined) {
      result = normResult(c.text); // 单返回值
    }
  }
  if (!name) return null;
  return { name, params, ...(result !== undefined ? { result } : {}) };
}

/** interface_type 里的方法：方法体是 method_elem 节点（与 interface/花括号平级于 interface_type 下） */
function extractInterfaceMethods(iface: SyntaxNodeLike): TranslateMethod[] {
  const methods: TranslateMethod[] = [];
  for (let i = 0; i < iface.childCount; i++) {
    const c = iface.child(i);
    if (c && c.type === 'method_elem') {
      const m = methodFromElem(c);
      if (m) methods.push(m);
    }
  }
  return methods;
}

/** 顶层 type 单元：struct → interface；interface → interface(方法)；其余 → type 别名 */
function unitFromTypeSpec(spec: SyntaxNodeLike): TransUnit | null {
  const nameNode = childField(spec, 'name');
  const typeNode = childField(spec, 'type');
  if (!nameNode || !typeNode) return null;
  const name = nameNode.text;
  const base = { id: name, kind: 'type' as TranslateKind, dstLang: 'ts', name, typeParams: extractTypeParams(spec), typeParamConstraints: extractTypeConstraints(spec), srcSnippet: spec.text.trim(), skeleton: '', bodyHole: false, constraints: [...DEFAULT_CONSTRAINTS] };

  // struct → TS interface（数据字段）
  if (typeNode.type === 'struct_type') {
    const fields: { name: string; type: string }[] = [];
    const embedded: string[] = [];
    const list = childField(typeNode, 'field_declaration_list') || childField(typeNode, 'body') || findChildOfType(typeNode, 'field_declaration_list');
    if (list) {
      for (let i = 0; i < list.childCount; i++) {
        const fd = list.child(i);
        if (!fd || fd.type !== 'field_declaration') continue;
        const typeNode2 = childField(fd, 'type');
        if (!typeNode2) continue;
        const type = typeNode2.text;
        let named = false;
        for (let j = 0; j < fd.childCount; j++) {
          const c = fd.child(j);
          if (c && c.type === 'field_identifier') {
            fields.push({ name: c.text, type });
            named = true;
          }
        }
        if (!named) embedded.push(type); // 嵌入字段（无独立 name）：机械展开会丢字段提升语义，跳过并如实标注
      }
    }
    const constraints = [...base.constraints];
    for (const e of embedded) constraints.push(`struct 含嵌入字段「${e}」：字段提升语义需 LLM/人工决定（未机械展开）`);
    if (fields.length === 0) return null; // 空结构体无翻译价值，跳过
    return { ...base, typeKind: 'struct', fields, constraints };
  }

  // interface → TS interface（方法签名契约）
  if (typeNode.type === 'interface_type') {
    const methods = extractInterfaceMethods(typeNode);
    if (methods.length === 0) return null; // 空接口跳过
    return { ...base, typeKind: 'interface', methods };
  }

  // 其它（type_identifier / array_type / map_type / pointer_type / func_type…）→ type 别名
  return { ...base, typeKind: 'alias', aliasType: typeNode.text };
}

/** 包级 const/var 描述符（name + 是否 var + 表达式节点），供 fixpoint 求值 */
interface ConstDecl {
  name: string;
  isVar: boolean;
  expr: SyntaxNodeLike;
  src: string;
}

/** 在节点里取首个"表达式"子节点（找不到 value 字段时兜底） */
function firstExprChild(node: SyntaxNodeLike): SyntaxNodeLike | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && ['int_literal', 'float_literal', 'true', 'false', 'interpreted_string_literal', 'raw_string_literal', 'character_literal', 'identifier', 'binary_expression', 'unary_expression', 'parenthesized_expression', 'expression_list'].includes(c.type)) return c;
  }
  return null;
}

/** 收集一条 const/var spec → 描述符（无名字/无值则 null） */
function constDeclFromSpec(spec: SyntaxNodeLike, isVar: boolean): ConstDecl | null {
  const nameNode = childField(spec, 'name');
  const valNode = childField(spec, 'value') || firstExprChild(spec);
  const name = nameNode?.text;
  if (!name || !valNode) return null;
  return { name, isVar, expr: valNode, src: valNode.text.trim() };
}

/** 深度遍历 AST，收集目标单元。const/var 仅收包级（顶层），把表达式攒进 consts 待求值。 */
function collect(node: SyntaxNodeLike, units: TransUnit[], consts: ConstDecl[], topLevel: boolean): void {
  const isFunc = node.type === 'function_declaration' || node.type === 'method_declaration';
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
  // 包级 const/var（仅顶层；多 spec 的 declaration 逐条收）
  if (topLevel && (node.type === 'const_declaration' || node.type === 'var_declaration')) {
    const specType = node.type === 'const_declaration' ? 'const_spec' : 'var_spec';
    const isVar = node.type === 'var_declaration';
    for (let i = 0; i < node.childCount; i++) {
      const spec = node.child(i);
      if (!spec || spec.type !== specType) continue;
      const d = constDeclFromSpec(spec, isVar);
      if (d) consts.push(d);
    }
    return;
  }
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c) collect(c, units, consts, false);
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
  const consts: ConstDecl[] = [];
  for (let i = 0; i < parsed.root.childCount; i++) {
    const c = parsed.root.child(i);
    if (c) collect(c, units, consts, true); // 顶层声明（包级 const/var 只在这里收）
  }
  // 常量表达式 fixpoint 求值（支持同包常量引用；求不出 = 非编译期常量 → 跳过交 LLM/人工）
  const constVals = new Map<string, { v: ConstValue; isVar: boolean }>();
  let pending = consts.slice();
  let progressed = true;
  while (progressed && pending.length) {
    progressed = false;
    const still = [];
    for (const d of pending) {
      const v = evalConstExpr(d.expr, (n) => constVals.get(n)?.v ?? null);
      if (v) {
        constVals.set(d.name, { v, isVar: d.isVar });
        progressed = true;
      } else {
        still.push(d);
      }
    }
    pending = still;
  }
  for (const d of consts) {
    const got = constVals.get(d.name);
    if (!got) continue;
    units.push({
      id: d.name,
      kind: 'const' as TranslateKind,
      dstLang: 'ts',
      name: d.name,
      value: constToTsLiteral(got.v),
      isVar: got.isVar,
      srcSnippet: d.src,
      skeleton: '',
      bodyHole: false,
      constraints: [...DEFAULT_CONSTRAINTS],
    });
  }
  return { units };
}