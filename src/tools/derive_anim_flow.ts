/**
 * derive_anim_flow 工具（路线图序号 14：L3 条件分支 + L4 函数绑定的自动生成层）
 *
 * 背景：动画引擎（animation_engine.ts / anim_core.ts）已在运行时实现 L3 条件分支、
 * L4 函数绑定、L4.5 异常语义，但 flows 声明只能手工写（如 design-canvas.json 中的手工 flows）。
 * 本工具补齐"生成层"：把 derive_detail_chain 已提取的调用链 + CFG 自动转成
 * animations_v2.flows，让已实现的 L3/L4 引擎能力可被自动驱动，而非仅手写。
 *
 * 生成两类 flow（P1 核心）：
 *   - chain flow（L4 函数绑定）：按调用链相邻函数对生成，handler 绑定调用方函数
 *   - branch flow（L3 条件分支）：对含 CFG 判定的函数生成，branches 用 CFG 条件，
 *     目标为链上后继（无后继则落到宿主节点）
 *
 * 依赖：先跑 derive_detail_chain 生成 detail 节点（flow 的 from/to 引用这些节点 id）。
 * 幂等：本工具只读既有 detail 节点，重跑清理重建自身前缀的 flows，不动手写 flows。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { AnimationBranch, AnimationError, AnimationFlow, AnimationValueSchema } from '../dsl/animation.js';
import type { DesignDSL, Node } from '../dsl/types.js';
import { getDSL, saveDSL } from '../storage.js';
import { parseFileFull, type ParsedSymbol } from './ts_kernel/index.js';
import { extractFunctionCfg } from './ts_kernel/cfg.js';
import { buildCallGraph, pickEntry, walkChain } from './derive_chain.js';

export interface DeriveAnimFlowInput {
  /** feature 名 */
  feature: string;
  /** 主干文件节点 id（semantic.files[].id；flows 的 handler.file_id 用它，detail 节点 host 也用它） */
  node_id: string;
  /** 源文件路径（缺省取 semantic.files[node_id].path，相对 project_root） */
  source_path?: string;
  /** 源文件根目录，默认 process.cwd() */
  project_root?: string;
  /** 入口函数名（缺省自动推导） */
  entry?: string;
  /** 入链函数上限，默认 12 */
  max_steps?: number;
  /** chain flow 的周期触发间隔毫秒，默认 4000 */
  interval?: number;
  /** 单个函数最多提取的 CFG 分支条件数，默认 3 */
  max_cfg_branches?: number;
  /** 跨文件 L4 chain flow 上限（读 cache.db 跨文件调用边，0=关闭），默认 3 */
  max_cross?: number;
}

export interface DeriveAnimFlowResult {
  message: string;
  feature: string;
  node_id: string;
  flows_added: number;
  flows: Array<{ id: string; from: string; to: string; kind: 'chain' | 'branch' | 'cross' }>;
  /** 有 detail 节点但未生成 flow 的函数（如无后继且无分支） */
  skipped: string[];
  /** 跨文件 L4 chain flows（基于 cache.db 跨文件调用边） */
  cross_flows: Array<{ id: string; from: string; to: string; caller: string; target: string }>;
}

function sanitize(s: string): string {
  return s.replace(/[^\w]/g, '_');
}

/** 从已经由 derive_detail_chain 生成的 detail 节点里，按 qname 定位节点 id */
function buildDetailNodeMap(dsl: DesignDSL, node_id: string): Map<string, string> {
  const map = new Map<string, string>();
  const prefix = `${node_id}__s`;
  for (const n of dsl.geometry.nodes) {
    if (n.host !== node_id || n.layer !== 'detail') continue;
    if (!n.id.startsWith(prefix)) continue;
    // 节点 id 形如 {node_id}__s{n}_{sanitize(qname)}（chain 用 s，外部追加用 x）
    const tail = n.id.slice(prefix.length);
    const under = tail.indexOf('_');
    if (under < 0) continue;
    const qname = tail.slice(under + 1);
    if (!qname) continue;
    // 同一 qname 可能因 sanitize 丢失信息而重复，保留先出现的
    if (!map.has(qname)) map.set(qname, n.id);
  }
  return map;
}

/** 从 shapes.in 的属性集合生成一组"能触发不同分支"的样例值（用于 mock_values 轮换） */
function sampleValuesFor(inSchema: AnimationValueSchema | undefined): Record<string, unknown>[] {
  const props = inSchema?.properties;
  if (!props) return [];
  const keys = Object.keys(props);
  if (keys.length === 0) return [];
  // 每个属性取两个极端值：数字 0/大、布尔 true/false、字符串 空/含x、其余 原文占位
  const majors: Record<string, unknown> = {};
  const minors: Record<string, unknown> = {};
  for (const k of keys) {
    const t = props[k].type;
    if (t === 'integer' || t === 'number') {
      majors[k] = 0;
      minors[k] = 100000;
    } else if (t === 'boolean') {
      majors[k] = false;
      minors[k] = true;
    } else if (t === 'string') {
      majors[k] = '';
      minors[k] = 'x';
    } else if (t === 'array') {
      majors[k] = [];
      minors[k] = [{}];
    } else if (t === 'object') {
      majors[k] = {};
      minors[k] = {};
    } else {
      majors[k] = null;
      minors[k] = null;
    }
  }
  return [majors, minors];
}

/** 从 CFG 分支节点提取条件表达式（去重、截断、去 entry/exit） */
function extractBranchConditions(cfg: { nodes: Array<{ kind: string; condition?: string }> }, max: number): string[] {
  const out: string[] = [];
  for (const n of cfg.nodes) {
    if (n.kind !== 'branch') continue;
    const cond = (n.condition || '').trim();
    if (!cond) continue;
    if (out.length >= max) break;
    if (!out.includes(cond)) out.push(cond);
  }
  return out;
}

/** 由文件后缀推断语言（用于错误模式匹配） */
function langOf(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.go') return 'go';
  if (ext === '.py') return 'py';
  if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'js';
  return '';
}

/**
 * 读取 cache.db 里本文件的跨文件调用边（kind='call' + metadata.cross=true）。
 * 从 project_root 向上逐级找 .design-canvas/cache.db（源文件根常是项目根子目录）。
 * source 格式：<relPath>#<caller>（relPath 相对 cache.db 所在项目根，可能与本文件计算出的
 * relPath 不一致 → 退化为 basename 匹配）。
 * 失败（无 cache.db / 损坏 / 被锁）静默返回空，不影响主流程。
 */
async function readCrossCalls(
  projectRoot: string,
  filePath: string,
): Promise<Map<string, string[]>> {
  const byCaller = new Map<string, string[]>();
  const relPath = path.relative(projectRoot, filePath).split(path.sep).join('/') || path.basename(filePath);
  let dbPath: string | null = null;
  for (let dir = path.resolve(projectRoot); dir && dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const cand = path.join(dir, '.design-canvas', 'cache.db');
    if (fs.existsSync(cand)) {
      dbPath = cand;
      break;
    }
  }
  if (!dbPath) return byCaller;
  try {
    const { openDb } = await import('../db/db.js');
    const db = openDb(dbPath);
    try {
      let rows = db
        .prepare("SELECT source, target, metadata FROM edges WHERE kind='call' AND metadata LIKE '%cross%true%'")
        .all() as Array<{ source: string; target: string; metadata: string }>;
      rows = rows.filter((r) => {
        const callerFile = r.source.slice(0, r.source.lastIndexOf('#'));
        return callerFile === relPath || callerFile === path.basename(filePath);
      });
      for (const r of rows) {
        const caller = r.source.slice(r.source.lastIndexOf('#') + 1);
        if (!caller) continue;
        let arr = byCaller.get(caller);
        if (!arr) {
          arr = [];
          byCaller.set(caller, arr);
        }
        if (!arr.includes(r.target) && arr.length < 8) arr.push(r.target);
      }
    } finally {
      try {
        db.close();
      } catch {
        /* 已关闭 */
      }
    }
  } catch {
    // 无 cache.db / 损坏 → 静默跳过跨文件 flow
  }
  return byCaller;
}

/**
 * L4.5 异常声明生成：从函数体源码扫描错误返回 / 抛出，映射为 AnimationError[]。
 *  - Go：`return ..., ErrXxx`（expected）+ `panic(...)`（unexpected）
 *  - JS/TS：`throw new Xxx(...)`（unexpected）
 *  - Python：`raise Xxx(...)`（unexpected）
 * 每个错误都流向宿主节点（红色路径 / 闪烁），供引擎 L4.5 异常短路使用。
 */
function extractFunctionErrors(funcSrc: string, lang: string, toNode: string): AnimationError[] {
  const errors: AnimationError[] = [];
  if (lang === 'go') {
    // expected：return 错误常量（顶层导出的 ErrXxx / 包级 errXxx、直接量 errors.New/fmt.Errorf）
    const seen = new Set<string>();
    const reConst = /return\s+[^;]*?,\s*(Err\w+|err\w+)\b/g;
    let m: RegExpExecArray | null;
    while ((m = reConst.exec(funcSrc))) {
      const n = m[1];
      if (!seen.has(n)) {
        seen.add(n);
        errors.push({
          type: n,
          condition: `result.error === '${n}'`,
          severity: 'expected',
          to: toNode,
          value: { type: n, label: n },
          effect: 'particle_red',
        });
      }
    }
    const reLit = /return\s+[^;]*?,\s*(?:errors\.New|fmt\.Errorf|fmt\.Wrap)\(/g;
    while ((m = reLit.exec(funcSrc))) {
      if (!seen.has('error')) {
        seen.add('error');
        errors.push({
          type: 'error',
          condition: 'result.error != null',
          severity: 'expected',
          to: toNode,
          value: { type: 'error', label: 'error' },
          effect: 'particle_red',
        });
      }
    }
    // unexpected：panic
    if (/panic\s*\(/.test(funcSrc)) {
      errors.push({
        type: 'panic',
        condition: 'result.panic === true',
        severity: 'unexpected',
        to: toNode,
        value: { type: 'panic', label: 'panic' },
        effect: 'node_flash_red',
        log: '疑似 bug：panic 未捕获',
      });
    }
  } else if (lang === 'js') {
    const seen = new Set<string>();
    const reThrow = /throw\s+new\s+(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = reThrow.exec(funcSrc))) {
      const n = m[1];
      if (!seen.has(n)) {
        seen.add(n);
        errors.push({
          type: n,
          condition: `result.error?.name === '${n}' || result.error?.constructor?.name === '${n}'`,
          severity: 'unexpected',
          to: toNode,
          value: { type: n, label: n },
          effect: 'node_flash_red',
          log: `${n} 抛出`,
        });
      }
    }
  } else if (lang === 'py') {
    const seen = new Set<string>();
    const reRaise = /raise\s+(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = reRaise.exec(funcSrc))) {
      const n = m[1];
      if (!seen.has(n)) {
        seen.add(n);
        errors.push({
          type: n,
          condition: `result.error?.constructor?.name === '${n}'`,
          severity: 'unexpected',
          to: toNode,
          value: { type: n, label: n },
          effect: 'node_flash_red',
          log: `${n} raise`,
        });
      }
    }
  }
  return errors;
}

export async function deriveAnimFlow(input: DeriveAnimFlowInput): Promise<DeriveAnimFlowResult> {
  const { feature, node_id } = input;
  const projectRoot = input.project_root ? path.resolve(input.project_root) : process.cwd();
  const interval = input.interval ?? 4000;
  const maxCfgBranches = input.max_cfg_branches ?? 3;

  const dsl = getDSL(feature);
  if (!dsl) throw new Error(`feature "${feature}" 不存在，请先 create_feature 或 render_design`);
  const host = dsl.geometry.nodes.find((n) => n.id === node_id);
  if (!host) throw new Error(`节点 "${node_id}" 不存在于 feature "${feature}"`);

  // 源文件定位（与 derive_detail_chain 同策略）
  let filePath: string | undefined;
  if (input.source_path) {
    filePath = path.isAbsolute(input.source_path) ? input.source_path : path.join(projectRoot, input.source_path);
  } else {
    const rel = dsl.semantic?.files?.find((f) => f.id === node_id)?.path;
    if (rel) filePath = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
  }
  if (!filePath) throw new Error(`节点 "${node_id}" 没有对应源文件（semantic.files 无此 id，且未传 source_path）`);
  if (!fs.existsSync(filePath)) throw new Error(`源文件不存在，无法读取: ${filePath}`);

  const content = fs.readFileSync(filePath, 'utf-8');
  const parsed = await parseFileFull(filePath, content);
  if (parsed.error) throw new Error(`解析失败: ${parsed.error}`);
  const symbols = parsed.symbols.filter((s) => s.kind === 'function' || s.kind === 'method');
  if (symbols.length === 0) throw new Error(`未从 ${path.basename(filePath)} 解析到函数/方法`);

  const graph = buildCallGraph(symbols, parsed.calls);
  let entrySym: ParsedSymbol;
  if (input.entry) {
    const found = symbols.find((s) => s.name === input.entry || s.qualified_name === input.entry);
    if (!found) throw new Error(`入口函数 "${input.entry}" 在源文件中不存在`);
    entrySym = found;
  } else {
    entrySym = pickEntry(symbols, graph);
  }
  const chain = walkChain(entrySym, symbols, graph).slice(0, input.max_steps ?? 12);

  // 复用 derive_detail_chain 生成的 detail 节点作为 flow 端点
  const nodeIdByQn = buildDetailNodeMap(dsl, node_id);
  const chainWithNode = chain.filter((s) => nodeIdByQn.has(s.qualified_name));
  const skipped = chain
    .filter((s) => !nodeIdByQn.has(s.qualified_name))
    .map((s) => s.name);

  // 幂等：清理本工具前缀生成的 flows（保留手写 flows）
  const flowPrefix = `${node_id}__flow_`;
  const existing = dsl.animations_v2?.flows ?? [];
  const kept = existing.filter((f) => !f.id.startsWith(flowPrefix));

  const added: DeriveAnimFlowResult['flows'] = [];
  const newFlows: AnimationFlow[] = [];

  // ── L4 chain flows：调用链相邻函数对，handler 绑定调用方 ──
  for (let i = 0; i < chainWithNode.length - 1; i++) {
    const caller = chainWithNode[i];
    const callee = chainWithNode[i + 1];
    const fromId = nodeIdByQn.get(caller.qualified_name)!;
    const toId = nodeIdByQn.get(callee.qualified_name)!;
    const flow: AnimationFlow = {
      id: `${flowPrefix}chain_${i + 1}`,
      trigger: { type: 'periodic', interval },
      from: fromId,
      to: toId,
      // L4 函数绑定：进 handler 节点时展示 ƒ caller(...) 调用 + 结果
      handler: {
        file_id: node_id,
        api: caller.name,
      },
      value: { type: caller.name, label: caller.name },
    };
    newFlows.push(flow);
    added.push({ id: flow.id, from: fromId, to: toId, kind: 'chain' });
  }

  // ── L3 branch flows：CFG 含判定的函数 → 分支路由 ──
  for (let i = 0; i < chainWithNode.length; i++) {
    const fn = chainWithNode[i];
    const fromId = nodeIdByQn.get(fn.qualified_name)!;
    const cfg = await extractFunctionCfg(filePath, content, fn.name, 3);
    if (!cfg) continue;
    const conds = extractBranchConditions(cfg, maxCfgBranches);
    if (conds.length === 0) continue;

    // 分支目标：链上后继优先，无后继落到宿主节点
    const next = chainWithNode[i + 1];
    const firstTarget = next ? nodeIdByQn.get(next.qualified_name)! : node_id;
    const branches: AnimationBranch[] = conds.map((c, ci) => ({
      condition: c,
      to: ci === 0 ? firstTarget : node_id,
      value: { type: `${fn.name}::cond${ci + 1}`, label: c.slice(0, 24) },
      effect: ci === 0 ? 'particle_green' : 'particle_red',
    }));
    // 兜底 else 分支到宿主（全未命中时的落点）
    branches.push({ condition: 'else', to: node_id, value: { type: `${fn.name}::else`, label: '其他' } });

    // 从 shapes.in 生成 mock_values，periodic 轮换驱动不同分支命中
    const fnNode = dsl.geometry.nodes.find((n: Node) => n.id === fromId);
    const inSchema = fnNode?.shapes?.in;

    // L4.5 异常声明：从函数体源码扫描错误返回/抛出，注入 handler.errors
    const funcSrc = content.split('\n').slice(fn.start_line - 1, fn.end_line).join('\n');
    const errors = extractFunctionErrors(funcSrc, langOf(filePath), node_id);

    const flow: AnimationFlow = {
      id: `${flowPrefix}br_${sanitize(fn.qualified_name)}`,
      trigger: { type: 'periodic', interval },
      from: fromId,
      handler: { file_id: node_id, api: fn.name, ...(errors.length > 0 ? { errors } : {}) },
      branches,
      mock_values: sampleValuesFor(inSchema),
    };
    newFlows.push(flow);
    added.push({ id: flow.id, from: fromId, to: branches[0].to, kind: 'branch' });
  }

  // ── 跨文件 L4 chain flows（序号 15：基于 cache.db 跨文件调用边）──
  // 链上函数有 cache.db 跨文件调用 → 生成 chain flow：from=调用方 detail 节点，
  // to=宿主节点（跨文件目标无 detail 节点，落宿主展示"数据流越出本文件"），
  // handler 绑定调用方；value 标注目标文件#函数。
  const crossFlows: DeriveAnimFlowResult['cross_flows'] = [];
  const maxCross = input.max_cross ?? 3;
  if (maxCross > 0) {
    const crossByCaller = await readCrossCalls(projectRoot, filePath);
    let crossCount = 0;
    for (const fn of chainWithNode) {
      if (crossCount >= maxCross) break;
      const targets = crossByCaller.get(fn.name);
      if (!targets || targets.length === 0) continue;
      const fromId = nodeIdByQn.get(fn.qualified_name)!;
      for (const t of targets) {
        if (crossCount >= maxCross) break;
        crossCount++;
        const id = `${flowPrefix}cross_${crossCount}`;
        const flow: AnimationFlow = {
          id,
          trigger: { type: 'periodic', interval },
          from: fromId,
          to: node_id,
          handler: { file_id: node_id, api: fn.name },
          value: { type: `${fn.name}→${t}`, label: `→${t}` },
        };
        newFlows.push(flow);
        added.push({ id, from: fromId, to: node_id, kind: 'cross' });
        crossFlows.push({ id, from: fromId, to: node_id, caller: fn.name, target: t });
      }
    }
  }

  // 写回 animations_v2（保留既有手写 flows）
  dsl.animations_v2 = {
    version: 1,
    flows: [...kept, ...newFlows],
    runtime: dsl.animations_v2?.runtime,
  };
  saveDSL(dsl);

  const lines = [
    `已生成动画流声明：feature "${feature}" 节点 ${node_id}`,
    `源文件：${path.relative(projectRoot, filePath).split(path.sep).join('/') || path.basename(filePath)}（${chain.length} 个入链函数）`,
    '',
    'L4 函数绑定 chain flows（调用链相邻对，handler 绑定调用方）：',
    ...added.filter((a) => a.kind === 'chain').map((a) => `  ${a.id}: ${a.from} → ${a.to}`),
    added.some((a) => a.kind === 'branch') ? ['', 'L3 条件分支 branch flows（CFG 判定 → 分支路由）：',
      ...added.filter((a) => a.kind === 'branch').map((a) => `  ${a.id}: ${a.from} → 分支目标 ${a.to}`)] : [],
    // L4.5 异常声明汇总
    (() => {
      const withErr = newFlows.filter((f) => f.handler?.errors && f.handler.errors.length > 0);
      if (withErr.length === 0) return [];
      return [
        '',
        'L4.5 异常声明（handler.errors，源码扫描注入）：',
        ...withErr.map((f) => {
          const errs = f.handler!.errors!.map((e) => `${e.type}(${e.severity})`).join(', ');
          return `  ${f.id}: ${errs}`;
        }),
      ];
    })(),
    crossFlows.length > 0
      ? ['', '跨文件 L4 chain flows（基于 cache.db 跨文件调用边，数据流越出本文件）：',
        ...crossFlows.map((c) => `  ${c.id}: ${c.caller} → ${c.target}`)]
      : [],
    chainWithNode.length === 0
      ? ['', '提示：未找到已生成的 detail 节点。请先运行 derive_detail_chain 生成 detail 层节点，本工具 flows 的 from/to 引用这些节点。']
      : [],
    skipped.length > 0 ? ['', `未生成 flow（无对应 detail 节点）: ${skipped.join(', ')}`] : [],
    '',
    '说明：flow 引用的是 derive_detail_chain 生成的 detail 节点 id；重跑本工具只重建自身前缀的 flows，保留手写 flows。',
  ];

  return {
    message: lines.flat().join('\n'),
    feature,
    node_id,
    flows_added: newFlows.length,
    flows: added,
    skipped,
    cross_flows: crossFlows,
  };
}