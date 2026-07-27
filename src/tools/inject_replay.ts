/**
 * inject_replay（D3 注入回放）：静态推演一次 flow 回放，不跑真实代码、不改 DSL
 *
 * 设计锚点（animation-design §10.4）：
 *   注入值替代 mock_results 作为 flow 的 value/result；
 *   某一步形状不匹配 / 条件不满足 / 异常被触发 → 暴露问题。
 *
 * 回放语义（与 animation_engine mock 模式对齐）：
 *   1. 注入值作为 handler result
 *   2. classifyError：命中 errors 声明 → 异常路径（declared）；
 *      结果像异常但未命中声明 → undeclared（疑似 bug）
 *   3. 正常结果 → pickBranch 按 branches condition 求值（value 上下文可传，
 *      缺省取 flow.mock_values[0]，再没有则 {}）
 *   4. 形状质检：handler.file_id 节点的 shapes.out 存在时，ajv 校验注入值，
 *      违例 = DSL 与代码漂移 / 数据非法
 *
 * 预设异常场景：preset = errors[].type，自动构造候选注入值
 *   （{error:{code:type}} / {panic:true} 等形态，取第一个命中 decl.condition 的）。
 */

import { Ajv } from 'ajv';
import { getDSL } from '../storage.js';
import { classifyError, pickBranch, evalCondition, formatValueShort } from '../renderer/anim_core.js';
import type { AnimationError, AnimationFlow, AnimationValueSchema } from '../dsl/types.js';

export interface InjectReplayInput {
  feature: string;
  flow_id: string;
  /** 注入值（作为 handler result）。与 preset 二选一 */
  inject?: unknown;
  /** 预设异常场景：handler.errors[].type，自动构造注入值 */
  preset?: string;
  /** 分支求值的 value 上下文（缺省取 flow.mock_values[0] ?? {}） */
  value?: unknown;
  /** 只列出可用预设场景，不执行回放 */
  list_presets?: boolean;
}

export interface ReplayRoute {
  kind: 'error' | 'branch' | 'direct' | 'none';
  to?: string;
  /** kind=error 时命中的 errors[].type */
  error_type?: string;
  severity?: string;
  log?: string;
  /** kind=branch 时命中分支的 condition 与序号 */
  branch_condition?: string;
  branch_index?: number;
  effect?: string;
}

export interface ShapeCheck {
  /** 校验目标描述（如 "compose.shapes.out"） */
  target: string;
  valid: boolean;
  violations: string[];
}

export interface InjectReplayResult {
  message: string;
  feature: string;
  flow_id: string;
  inject: unknown;
  classification: 'none' | 'declared' | 'undeclared';
  route: ReplayRoute;
  shape_check?: ShapeCheck;
  presets?: string[];
}

const ajv = new Ajv({ allErrors: true, strict: false });

/** 从 condition 提取字符串字面量（如 'BUDGET_EXCEEDED'）作为错误码候选 */
function extractStringLiterals(condition: string): string[] {
  const out: string[] = [];
  const re = /'([^'\\]*)'|"([^"\\]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(condition)) !== null) {
    out.push(m[1] ?? m[2]);
  }
  return out;
}

/** 预设场景候选注入值：condition 字面量 × 字段形态（code / message / 裸字符串），其次常见形态
 *  真实工程教训：condition 可能是 message 子串匹配（indexOf）或裸字符串比较（result.error === 'EOF'），
 *  只会构造 code 字段的值永远命中不了这类声明 */
function presetCandidates(decl: AnimationError): unknown[] {
  const literals = extractStringLiterals(decl.condition);
  const out: unknown[] = [];
  for (const lit of literals) {
    out.push({ error: { code: lit, message: decl.type } });
    out.push({ error: { code: decl.type, message: lit } });
    out.push({ error: { message: lit } });
    out.push({ error: lit });
  }
  out.push(
    { error: { code: decl.type, message: decl.type } },
    { error: { code: decl.type } },
    { panic: true, message: decl.type },
    { error: { type: decl.type } },
    { error: decl.type },
  );
  return out;
}

/** 为 errors 声明自动构造注入值；都不命中 condition 时返回首选形态 + hit=false */
function buildPresetValue(decl: AnimationError): { value: unknown; hit: boolean } {
  for (const candidate of presetCandidates(decl)) {
    if (evalCondition(decl.condition, undefined, candidate)) {
      return { value: candidate, hit: true };
    }
  }
  return { value: presetCandidates(decl)[0], hit: false };
}

/** ajv 校验注入值 vs AnimationValueSchema（label 等非标关键字在 strict:false 下忽略） */
function checkShape(
  schema: AnimationValueSchema,
  inject: unknown,
  target: string,
): ShapeCheck {
  const validate = ajv.compile(schema);
  const valid = validate(inject) as boolean;
  const violations = (validate.errors ?? []).map(
    (e) => `${e.instancePath || '/'}: ${e.message ?? '未知违例'}`,
  );
  return { target, valid, violations };
}

function findFlow(flows: AnimationFlow[], flowId: string): AnimationFlow {
  const flow = flows.find((f) => f.id === flowId);
  if (!flow) {
    const available = flows.map((f) => f.id).join(', ') || '（无）';
    throw new Error(`flow "${flowId}" 不存在。可用 flow：${available}`);
  }
  return flow;
}

export function injectReplay(input: InjectReplayInput): InjectReplayResult {
  const { feature, flow_id } = input;
  const dsl = getDSL(feature);
  if (!dsl) throw new Error(`feature "${feature}" 不存在，请先 create_feature 或 render_dsl`);

  const flows = dsl.animations_v2?.flows ?? [];
  const flow = findFlow(flows, flow_id);
  const errors = flow.handler?.errors ?? [];
  const presets = errors.map((e) => e.type);

  // ── list_presets：只列场景 ──
  if (input.list_presets) {
    const lines = [
      `feature "${feature}" flow "${flow_id}" 可用预设异常场景：`,
      ...(errors.length > 0
        ? errors.map(
            (e) =>
              `  - ${e.type}（${e.severity} → ${e.to}${e.log ? `；日志：${e.log}` : ''}）`,
          )
        : ['  （该 flow 的 handler 未声明 errors，无预设场景）']),
      '',
      '用法：inject_replay({ preset: "<type>" }) 一键注入；或 inject: 自定义 JSON 值。',
    ];
    return {
      message: lines.join('\n'),
      feature,
      flow_id,
      inject: undefined,
      classification: 'none',
      route: { kind: 'none' },
      presets,
    };
  }

  // ── 确定注入值 ──
  let inject: unknown;
  let presetNote: string | null = null;
  if (input.preset !== undefined) {
    const decl = errors.find((e) => e.type === input.preset);
    if (!decl) {
      throw new Error(
        `预设场景 "${input.preset}" 不存在。可用预设：${presets.join(', ') || '（无，该 flow 未声明 errors）'}`,
      );
    }
    const built = buildPresetValue(decl);
    inject = built.value;
    presetNote = built.hit
      ? `（preset "${input.preset}" 自动构造）`
      : `（⚠ preset "${input.preset}" 的声明条件非标准形态，自动构造值未命中 condition，建议显式 inject）`;
  } else if (input.inject !== undefined) {
    inject = input.inject;
  } else {
    throw new Error('必须提供 inject（注入值）或 preset（预设异常场景）之一；或 list_presets=true 查看可用预设');
  }

  const lines: string[] = [
    `回放报告：feature "${feature}" flow "${flow_id}"`,
    `注入值：${formatValueShort(inject, 120)}${presetNote ?? ''}`,
  ];

  // ── 形状质检：handler.file_id 节点 shapes.out vs 注入值 ──
  let shapeCheck: ShapeCheck | undefined;
  const fileId = flow.handler?.file_id;
  const hostNode = fileId ? dsl.geometry.nodes.find((n) => n.id === fileId) : undefined;
  if (hostNode?.shapes?.out) {
    shapeCheck = checkShape(hostNode.shapes.out, inject, `${fileId}.shapes.out`);
    if (shapeCheck.valid) {
      lines.push(`形状校验通过：${shapeCheck.target}`);
    } else {
      lines.push(`⚠ 形状校验违例（${shapeCheck.target}）：`);
      for (const v of shapeCheck.violations) lines.push(`  ${v}`);
    }
  }

  // ── 异常分类 → 路由 ──
  const cls = classifyError(errors, inject);
  let route: ReplayRoute;
  const problems: string[] = [];

  if (cls.kind === 'declared' && cls.decl) {
    const decl = cls.decl as AnimationError;
    route = {
      kind: 'error',
      to: decl.to,
      error_type: decl.type,
      severity: decl.severity,
      log: decl.log,
      effect: decl.effect,
    };
    lines.push('', `已声明异常命中：${decl.type}（${decl.severity}）`);
    lines.push(`  流向：${decl.to}${decl.effect ? `；效果：${decl.effect}` : ''}`);
    if (decl.log) lines.push(`  日志：${decl.log}`);
  } else if (cls.kind === 'undeclared') {
    route = { kind: 'error', severity: 'undeclared' };
    lines.push('', `⚠ 未声明异常：${formatValueShort(inject, 80)}`);
    lines.push('  结果像异常但未命中任何 errors 声明 → 疑似 bug，请补 errors 声明');
    problems.push('未声明异常（疑似 bug，请补 errors 声明）');
  } else {
    // 正常结果 → 分支求值
    const valueCtx = input.value !== undefined ? input.value : (flow.mock_values?.[0] ?? {});
    if (flow.branches && flow.branches.length > 0) {
      const picked = pickBranch(flow.branches, valueCtx, inject);
      if (picked) {
        route = {
          kind: 'branch',
          to: picked.branch.to,
          branch_condition: flow.branches[picked.index].condition,
          branch_index: picked.index,
          effect: flow.branches[picked.index].effect,
        };
        lines.push('', `正常结果 → 命中分支 #${picked.index + 1}（${flow.branches[picked.index].condition}）`);
        lines.push(`  流向：${picked.branch.to}${picked.branch.effect ? `；效果：${picked.branch.effect}` : ''}`);
      } else {
        route = { kind: 'none' };
        lines.push('', '正常结果，但所有分支条件均未命中（无 else 兜底）→ 数据无处可去');
        problems.push('分支全部未命中（无 else 兜底，数据无处可去）');
      }
    } else if (flow.to) {
      route = { kind: 'direct', to: flow.to };
      lines.push('', `正常结果 → 直连流向：${flow.to}`);
    } else {
      route = { kind: 'none' };
      lines.push('', '正常结果，flow 无 branches 也无 to → 数据无处可去');
      problems.push('flow 无出口（无 branches 也无 to）');
    }
  }

  if (shapeCheck && !shapeCheck.valid) {
    problems.push('注入值与声明形状不匹配（DSL 漂移或数据非法）');
  }

  lines.push(
    '',
    problems.length > 0
      ? `结论：暴露 ${problems.length} 个问题 —— ${problems.join('；')}`
      : '结论：回放正常，未暴露问题',
  );

  return {
    message: lines.join('\n'),
    feature,
    flow_id,
    inject,
    classification: cls.kind,
    route,
    shape_check: shapeCheck,
    presets,
  };
}
