/**
 * CFG 提取器：函数体 → 控制流图（分支/循环/返回）
 *
 * 用途：derive_algorithm 工具的静态分析核心——把算法内部结构解析为
 * detail 层节点/边，复用分层披露渲染，用于交流学习/团队对齐/项目研究。
 *
 * 模型（实用化 CFG，非教科书完整版）：
 *   - 连续普通语句合并为一个 step 节点（避免几十节点的噪声图）
 *   - if/switch → branch 菱形节点（是/否出边）
 *   - for/while → loop 六边形节点（进入/重复回边/结束出边）
 *   - return → 终止节点（后续不可达语句标记 deadCode）
 *   - break/continue/goto 不精确建模（v1 忽略）
 *   - 嵌套深度超 maxDepth 时整个块折叠为一个 step（truncated 标记）
 *
 * 子图接口：buildSeq 返回 { entry, exits }，exit 可携带出边 label（via），
 * 由父级在连接下一节点时物化——分支的"否"边由此自然落到汇合点。
 */

import { parseAstRoot } from './kernel.js';
import type { SyntaxNodeLike } from './kernel.js';

// ─────────────────────────────────────────────────────────────
// 公开类型
// ─────────────────────────────────────────────────────────────

export type CfgNodeKind = 'entry' | 'exit' | 'step' | 'branch' | 'loop' | 'return';

export interface CfgNode {
  id: string;
  kind: CfgNodeKind;
  label: string;
  /** branch/loop 的条件原文 */
  condition?: string;
  /** 源码起始行（1-based） */
  line: number;
  /** 布局列：0=主干，1+=分支/循环体层级 */
  col: number;
}

export interface CfgEdge {
  from: string;
  to: string;
  /** 是/否/进入/重复/结束 */
  label?: string;
}

export interface FunctionCfg {
  funcName: string;
  nodes: CfgNode[];
  edges: CfgEdge[];
  /** 存在深度截断的嵌套块 */
  truncated: boolean;
  /** return 后存在不可达语句 */
  deadCode: boolean;
}

// ─────────────────────────────────────────────────────────────
// 语言节点类型表
// ─────────────────────────────────────────────────────────────

type CtrlKind = 'branch' | 'loop' | 'return' | 'continue' | 'break';

const TS_CTRL: Record<string, CtrlKind> = {
  if_statement: 'branch',
  for_statement: 'loop',
  for_in_statement: 'loop',
  while_statement: 'loop',
  do_statement: 'loop',
  switch_statement: 'branch',
  return_statement: 'return',
  continue_statement: 'continue',
  break_statement: 'break',
};

const CTRL: Record<string, Record<string, CtrlKind>> = {
  go: {
    if_statement: 'branch',
    for_statement: 'loop',
    expression_switch_statement: 'branch',
    type_switch_statement: 'branch',
    select_statement: 'branch',
    return_statement: 'return',
    continue_statement: 'continue',
    break_statement: 'break',
  },
  typescript: TS_CTRL,
  tsx: TS_CTRL,
  javascript: TS_CTRL,
  jsx: TS_CTRL,
  python: {
    if_statement: 'branch',
    elif_clause: 'branch',
    for_statement: 'loop',
    while_statement: 'loop',
    match_statement: 'branch',
    return_statement: 'return',
    continue_statement: 'continue',
    break_statement: 'break',
  },
};

/** 函数声明节点类型（name field 统一为 'name'） */
const FUNC_NODES: Record<string, string[]> = {
  go: ['function_declaration', 'method_declaration'],
  typescript: ['function_declaration', 'method_definition', 'generator_function_declaration'],
  tsx: ['function_declaration', 'method_definition', 'generator_function_declaration'],
  javascript: ['function_declaration', 'method_definition', 'generator_function_declaration'],
  jsx: ['function_declaration', 'method_definition', 'generator_function_declaration'],
  python: ['function_definition'],
};

// ─────────────────────────────────────────────────────────────
// 提取上下文
// ─────────────────────────────────────────────────────────────

interface Exit {
  id: string;
  via?: string;
}

interface Ctx {
  lang: string;
  maxDepth: number;
  nodes: CfgNode[];
  edges: CfgEdge[];
  seq: number;
  truncated: boolean;
  deadCode: boolean;
  /** 所有 return 节点 id（顶层统一连 exit 汇点） */
  returns: string[];
  /** 循环栈：continue 回连栈顶循环头，break 记入栈顶待接到循环出口 */
  loopStack: Array<{ headerId: string; breaks: string[] }>;
}

function addNode(ctx: Ctx, kind: CfgNodeKind, label: string, col: number, src?: SyntaxNodeLike, condition?: string): string {
  const id = `n${++ctx.seq}`;
  const node: CfgNode = { id, kind, label, line: src ? src.startPosition.row + 1 : 0, col };
  if (condition) node.condition = condition;
  ctx.nodes.push(node);
  return id;
}

function link(ctx: Ctx, exits: Exit[], to: string): void {
  for (const e of exits) {
    const edge: CfgEdge = { from: e.id, to };
    if (e.via) edge.label = e.via;
    ctx.edges.push(edge);
  }
}

// ─────────────────────────────────────────────────────────────
// 文本摘要
// ─────────────────────────────────────────────────────────────

function oneLine(s: string, max = 40): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** 语句块摘要：首语句 + 条数 */
function summarize(stmts: SyntaxNodeLike[]): string {
  const first = oneLine(stmts[0].text, 36);
  return stmts.length > 1 ? `${first}（等 ${stmts.length} 条）` : first;
}

/** 控制流头部文本：截取到 '{' 或 ':' 之前。Go 只截 '{'——for 头含 :=（如 `for _, v := range items`），冒号截断会丢条件 */
function headText(node: SyntaxNodeLike, lang: string): string {
  const t = node.text;
  let cut = t.length;
  const stops = lang === 'go' ? ['{'] : ['{', ':'];
  for (const ch of stops) {
    const i = t.indexOf(ch);
    if (i >= 0 && i < cut) cut = i;
  }
  return oneLine(t.slice(0, cut), 44);
}

/** 条件文本：优先 condition field，退化用头部文本 */
function condText(node: SyntaxNodeLike, lang: string): string {
  const cond = node.childForFieldName('condition');
  if (cond) return oneLine(cond.text, 44);
  return headText(node, lang);
}

// ─────────────────────────────────────────────────────────────
// 结构遍历
// ─────────────────────────────────────────────────────────────

/** 命名节点判定：isNamed 优先，缺失时退化 \w 正则（标点可滤，关键字滤不掉，仅作兜底） */
function isNamedNode(n: SyntaxNodeLike): boolean {
  return n.isNamed ?? /^\w+$/.test(n.type);
}

/** 块内 named 语句列表（匿名关键字/标点过滤——'else' 等匿名关键字 type 也是纯字母，必须靠 isNamed） */
function stmtsOf(block: SyntaxNodeLike | null): SyntaxNodeLike[] {
  if (!block) return [];
  const out: SyntaxNodeLike[] = [];
  for (let i = 0; i < block.childCount; i++) {
    const c = block.child(i);
    if (c && isNamedNode(c)) out.push(c);
  }
  return out;
}

/** then 分支体：优先 consequence field，fallback 第一个 block 类 child（实测各语言 field 布局不一） */
function consequenceOf(stmt: SyntaxNodeLike): SyntaxNodeLike | null {
  const f = stmt.childForFieldName('consequence');
  if (f) return f;
  for (let i = 0; i < stmt.childCount; i++) {
    const c = stmt.child(i);
    if (c && (c.type === 'block' || c.type === 'statement_block')) return c;
  }
  return null;
}

/**
 * else/elif 部分列表。实测差异（scripts/debug_cfg_ast.mjs）：
 *   Go  ：alternative field 直达（block 或嵌套 if_statement）
 *   TS  ：else_clause 是普通 child（无 alternative field）
 *   Py  ：alternative field 是 elif_clause，而 elif_clause 的 else 部分又是普通 child
 * 统一策略：field alternative + else_clause/elif_clause child 双路收集。
 */
function elseParts(stmt: SyntaxNodeLike): SyntaxNodeLike[] {
  const parts: SyntaxNodeLike[] = [];
  const fieldAlt = stmt.childForFieldName('alternative');
  if (fieldAlt) parts.push(fieldAlt);
  for (let i = 0; i < stmt.childCount; i++) {
    const c = stmt.child(i);
    if (c && c !== fieldAlt && (c.type === 'else_clause' || c.type === 'elif_clause')) {
      parts.push(c);
    }
  }
  return parts;
}

/**
 * else/elif 解包 → 待递归语句列表。
 * elseIf=true 表示 elif/else-if 链（平级分支，递归不加深 depth）。
 */
function unwrapElse(node: SyntaxNodeLike): { stmts: SyntaxNodeLike[]; elseIf: boolean } {
  if (node.type === 'block' || node.type === 'statement_block') {
    return { stmts: stmtsOf(node), elseIf: false };
  }
  if (node.type === 'else_clause') {
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (!c || !isNamedNode(c)) continue;
      if (c.type === 'block' || c.type === 'statement_block') return { stmts: stmtsOf(c), elseIf: false };
      // TS else if：else_clause 直接包 if_statement
      if (/if/.test(c.type)) return { stmts: [c], elseIf: true };
      return { stmts: [c], elseIf: false };
    }
    return { stmts: [], elseIf: false };
  }
  // elif_clause / if_statement（else-if 链）：自身即 branch 节点
  return { stmts: [node], elseIf: true };
}

interface SeqResult {
  entry: string | null;
  exits: Exit[];
}

/**
 * 语句序列 → 子图。col 为布局列（主干 0，每深一层 +1），depth 为控制流嵌套深度。
 * 深度超限：整块折叠为一个 step 节点并标记 truncated。
 */
function buildSeq(ctx: Ctx, stmts: SyntaxNodeLike[], col: number, depth: number): SeqResult {
  if (stmts.length === 0) return { entry: null, exits: [] };

  const ctrl = CTRL[ctx.lang] ?? {};

  // 深度截断：只有本层还藏着 branch/loop 才算"截断"（纯语句/return 折叠不损失结构）
  if (depth > ctx.maxDepth && stmts.some((s) => ctrl[s.type] === 'branch' || ctrl[s.type] === 'loop')) {
    ctx.truncated = true;
    const id = addNode(ctx, 'step', `嵌套逻辑（${stmts.length} 条语句）`, col, stmts[0]);
    return { entry: id, exits: [{ id }] };
  }

  let entry: string | null = null;
  let exits: Exit[] = [];
  let stmtBuf: SyntaxNodeLike[] = [];

  const flush = (): void => {
    if (stmtBuf.length === 0) return;
    const id = addNode(ctx, 'step', summarize(stmtBuf), col, stmtBuf[0]);
    link(ctx, exits, id);
    if (!entry) entry = id;
    exits = [{ id }];
    stmtBuf = [];
  };

  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];
    const kind = ctrl[stmt.type];
    if (!kind) {
      stmtBuf.push(stmt);
      continue;
    }
    flush();

    if (kind === 'return') {
      const id = addNode(ctx, 'return', oneLine(stmt.text, 44), col, stmt);
      link(ctx, exits, id);
      if (!entry) entry = id;
      ctx.returns.push(id);
      exits = [];
      if (i < stmts.length - 1) ctx.deadCode = true;
      break;
    }

    if (kind === 'continue' || kind === 'break') {
      const id = addNode(ctx, 'step', kind, col, stmt);
      link(ctx, exits, id);
      if (!entry) entry = id;
      const top = ctx.loopStack[ctx.loopStack.length - 1];
      if (kind === 'continue') {
        // 回连最近循环头；之后同块语句不可达
        if (top) ctx.edges.push({ from: id, to: top.headerId, label: '继续' });
      } else {
        // break：出口挂在循环"结束"之后（循环收尾时物化）
        if (top) top.breaks.push(id);
      }
      exits = [];
      if (i < stmts.length - 1) ctx.deadCode = true;
      break;
    }

    if (kind === 'loop') {
      const cond = headText(stmt, ctx.lang);
      const id = addNode(ctx, 'loop', cond, col, stmt, cond);
      link(ctx, exits, id);
      if (!entry) entry = id;
      ctx.loopStack.push({ headerId: id, breaks: [] });
      const bodyRes = buildSeq(ctx, stmtsOf(stmt.childForFieldName('body')), col + 1, depth + 1);
      const frame = ctx.loopStack.pop()!;
      if (bodyRes.entry) {
        ctx.edges.push({ from: id, to: bodyRes.entry, label: '进入' });
        for (const be of bodyRes.exits) ctx.edges.push({ from: be.id, to: id, label: '重复' });
      }
      exits = [{ id, via: '结束' }, ...frame.breaks.map((b) => ({ id: b, via: '中断' as string | undefined }))];
      continue;
    }

    // branch：if 族（有 then 分支体）走真分支；switch/select/match 折叠分支体
    const cond = condText(stmt, ctx.lang);
    const id = addNode(ctx, 'branch', cond, col, stmt, cond);
    link(ctx, exits, id);
    if (!entry) entry = id;

    const cons = consequenceOf(stmt);
    if (cons) {
      const thenRes = buildSeq(ctx, stmtsOf(cons), col + 1, depth + 1);
      if (thenRes.entry) {
        ctx.edges.push({ from: id, to: thenRes.entry, label: '是' });
      }
      let altExits: Exit[] = [];
      let altHandled = false;
      for (const part of elseParts(stmt)) {
        const { stmts: altStmts, elseIf } = unwrapElse(part);
        // elif/else-if 是平级分支（depth 不加深），else 块正常加深
        const sub = buildSeq(ctx, altStmts, col + 1, elseIf ? depth : depth + 1);
        if (sub.entry) {
          ctx.edges.push({ from: id, to: sub.entry, label: '否' });
          altExits = altExits.concat(sub.exits);
          altHandled = true;
        }
      }
      exits = [...thenRes.exits, ...(altHandled ? altExits : [{ id, via: '否' }])];
    } else {
      // switch/select/match：分支体折叠为一个 step（case 枚举噪声大，v1 不细分）
      const bodyStmts = stmtsOf(stmt.childForFieldName('body'));
      const foldId = addNode(ctx, 'step', `case 分支体（${bodyStmts.length} 条）`, col + 1, stmt);
      ctx.edges.push({ from: id, to: foldId, label: '匹配' });
      exits = [{ id: foldId }];
    }
  }

  flush();
  return { entry, exits };
}

/** 按名字递归查找函数声明节点 */
function findFuncNode(root: SyntaxNodeLike, funcTypes: string[], name: string, depth = 0): SyntaxNodeLike | null {
  if (depth > 60) return null;
  if (funcTypes.includes(root.type)) {
    const nameNode = root.childForFieldName('name');
    if (nameNode && nameNode.text === name) return root;
  }
  for (let i = 0; i < root.childCount; i++) {
    const c = root.child(i);
    if (c) {
      const hit = findFuncNode(c, funcTypes, name, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 公开入口
// ─────────────────────────────────────────────────────────────

/**
 * 提取指定函数的控制流图。
 * 返回 null 的情形：语言不支持 / 解析失败 / 函数未找到。
 */
export async function extractFunctionCfg(
  filePath: string,
  content: string,
  funcName: string,
  maxDepth = 3,
): Promise<FunctionCfg | null> {
  const ast = await parseAstRoot(filePath, content);
  if (!ast) return null;
  const { root, langName } = ast;

  const funcTypes = FUNC_NODES[langName];
  if (!funcTypes) return null;

  const funcNode = findFuncNode(root, funcTypes, funcName);
  if (!funcNode) return null;

  const ctx: Ctx = {
    lang: langName,
    maxDepth,
    nodes: [],
    edges: [],
    seq: 0,
    truncated: false,
    deadCode: false,
    returns: [],
    loopStack: [],
  };

  const entryId = addNode(ctx, 'entry', `▶ ${funcName}`, 0, funcNode);
  const body = funcNode.childForFieldName('body');
  const res = buildSeq(ctx, stmtsOf(body), 0, 1);

  if (res.entry) {
    ctx.edges.push({ from: entryId, to: res.entry });
  }

  // exit 统一汇点：主流程出口 + 全部 return 逃逸边（多 return 时出口清晰可辨）
  const exitId = addNode(ctx, 'exit', '■ 结束', 0);
  if (res.entry) {
    link(ctx, res.exits, exitId);
  } else {
    // 空函数体：entry 直连 exit
    ctx.edges.push({ from: entryId, to: exitId });
  }
  for (const rid of ctx.returns) {
    ctx.edges.push({ from: rid, to: exitId });
  }

  return {
    funcName,
    nodes: ctx.nodes,
    edges: ctx.edges,
    truncated: ctx.truncated,
    deadCode: ctx.deadCode,
  };
}
