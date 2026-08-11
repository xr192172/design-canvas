/**
 * reason_validator：变更原因的「四层抗偷懒校验链」
 *
 * 目标：让 Agent 在 edit_dsl 写设计时源头留下「为什么改」，且不靠道德、靠校验兜底。
 * 设计原则（见 docs/plans/2026-08-11-live-doc-change-reason.md）：
 *   - 不依赖某个 LLM 的自律，而是让「编理由」比「说实话」更费劲。
 *   - 校验失败时返回具体命中的层与原因，方便 Agent 修正后重试。
 *
 * 四层：
 *   L1 非空      —— trim 后低于阈值字数 → 拒绝（空原因 / 纯空白）
 *   L2 信息量    —— 命中套话黑名单（"更新代码""修复bug""优化"等）→ 拒绝（占位符）
 *   L3 实体绑定  —— 必须包含 ≥1 个具体实体（trace 引用 / diff 文件名 / 数字指标 / 节点或文件 id）
 *   L4 证据回溯  —— 声称的 evidence 必须能查到；对不上 → 打回（编造的理由）
 *
 * 纯函数、无副作用，便于单测。L4 的"能否查到"通过可注入的 resolver 判定，
 * 由调用方（edit_dsl）决定如何解析（查 DSL 节点/文件、查 trace 文件等）。
 */

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 校验命中的层标识 */
export type ReasonFailLayer = 1 | 2 | 3 | 4;

/** 校验结果 */
export interface ReasonValidationResult {
  ok: boolean;
  /** 命中的层（ok=false 时有效） */
  layer?: ReasonFailLayer;
  /** 该层失败的具体原因 */
  error?: string;
}

/** 证据引用（与方案 Annotation.evidence 对齐） */
export interface ReasonEvidenceRef {
  type: 'trace' | 'diff' | 'node' | 'edge' | 'metric';
  ref: string;
}

/** L4 证据回溯的解析上下文：由调用方注入如何判定一个证据是否"存在" */
export interface ReasonEvidenceResolver {
  /** 判定单个证据引用是否真实存在 */
  exists?: (ev: ReasonEvidenceRef) => boolean;
  /** 可选的实体集合（L3 用）：节点 id / 文件 id / 文件路径 */
  entityIds?: string[];
  /** 可选的 trace 引用集合（L3 用）：如 trace 节点 id 或 token 超限标记 */
  traceRefs?: string[];
}

/** 校验入参 */
export interface ValidateReasonInput {
  /** 变更原因（自然语言，必填且需通过四层校验） */
  reason: string;
  /** 可选：显式证据链（L4 校验其可回溯） */
  evidence?: ReasonEvidenceRef[];
  /** 可选：L3/L4 的实体与证据解析上下文 */
  resolver?: ReasonEvidenceResolver;
}

// ─────────────────────────────────────────────────────────────
// 阈值与黑名单
// ─────────────────────────────────────────────────────────────

/** L1：有效内容最小字数（不含空白） */
export const MIN_REASON_CHARS = 6;

/**
 * L2：套话黑名单。命中说明这句原因是"空话"，没有信息量。
 * 注意：只在整个 reason 剥掉这些词后仍无实质内容时才判为套话，
 * 避免误杀"因为支付超时，把超时时间从 3s 改为 10s"这类包含具体信息的原因。
 */
const FILLER_WORDS = [
  '更新代码',
  '修复bug',
  '修复 bug',
  '优化代码',
  '优化',
  '改进',
  '调整',
  '修改代码',
  '修复问题',
  '修复',
  '更新',
  '修改',
  '改动',
  '变更',
  '重建',
  '重构',
  '删除',
  '添加',
  '增加',
  '补充',
  '完善',
  '完善一下',
  '调整一下',
  '改一下',
  '修一下',
  '整理',
  '微调',
  '细调',
];

/** 数字指标发电机：匹配形如 3s / 10ms / token=1200 / 超限 1200 等 */
const METRIC_RE = /\d+(\.\d+)?\s*(?:s|ms|token|tokens|tok|%|k|KB|MB|GB)?\b/i;

/**
 * 无实义的语法词/连词/语气词。它们不传达实质信息，剥掉后若什么都不剩，
 * 说明这句原因只是"套话 + 虚词"（如"只是更新代码而已""优化改进调整一下"）。
 */
const FUNCTION_WORDS = [
  '只是', '而已', '一下', '简单地', '稍微', '仅', '只要', '就是', '仅仅',
  '因为', '由于', '为了', '把', '从', '到', '改为', '变成', '变得', '更',
  '比较', '较多', '多', '了', '的', '地', '得', '一个', '一种', '这个',
  '那个', '这些', '那些', '被', '让', '使', '在', '于', '之', '与', '和',
  '及', '并', '而', '或', '且', '但', '是', '为', '对', '向', '往', '以',
  '用', '通过', '基于', '根据', '针对', '相对', '较', '其', '这', '那',
  '我们', '需要', '要', '去', '来', '进行', '做了', '进行一下',
];

// ─────────────────────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────────────────────

/**
 * 四层校验链。逐层执行，任一失败立即返回该层失败原因。
 */
export function validateReason(input: ValidateReasonInput): ReasonValidationResult {
  const { reason, evidence = [], resolver = {} } = input;

  // ── L1 非空 ──
  const trimmed = (reason ?? '').trim();
  // 去掉空白后统计可见字符数
  const visibleChars = trimmed.replace(/\s+/g, '');
  if (visibleChars.length < MIN_REASON_CHARS) {
    return {
      ok: false,
      layer: 1,
      error: `原因过短或无实质内容（有效字符 ${visibleChars.length} < ${MIN_REASON_CHARS}）。请用一句话说明这次变更为什么发生。`,
    };
  }

  // ── L2 信息量（套话检测）──
  if (isFillerOnly(trimmed)) {
    return {
      ok: false,
      layer: 2,
      error: `原因 ${trimmed ? `"${trimmed}"` : '为空'} 命中套话黑名单，无信息量。请补充具体实体与变更动机（例如：支付超时从 3s 改为 10s，因为上游网关峰值延迟）。`,
    };
  }

  // ── L4 前置：提供了 evidence 但根本没有解析器 → 优先打回（无法回溯，必属编造/空挂）──
  if (evidence.length > 0 && !resolver.exists) {
    return {
      ok: false,
      layer: 4,
      error: '提供了 evidence 但未配置证据解析器，无法回溯。请去掉无法回溯的 evidence 或补充 resolver。',
    };
  }

  // ── L3 实体绑定 ──
  const hasEntity = matchesConcreteEntity(trimmed, resolver);
  if (!hasEntity) {
    return {
      ok: false,
      layer: 3,
      error: '原因需绑定至少一个具体实体（trace 引用 / diff 文件名 / 数字指标 / 节点或文件 id），避免泛泛而谈。',
    };
  }

  // ── L4 证据回溯 ──
  if (evidence.length > 0) {
    const exists = resolver.exists as (ev: ReasonEvidenceRef) => boolean;
    for (const ev of evidence) {
      if (!exists(ev)) {
        return {
          ok: false,
          layer: 4,
          error: `evidence 无法回溯：${ev.type} "${ev.ref}" 不存在或对不上。请核对证据或移除编造项。`,
        };
      }
    }
  }

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────────────────────

/** 判断一个 reason 是否"全程都是套话"（剥掉黑名单词与虚词后无实质内容） */
function isFillerOnly(text: string): boolean {
  // 先剥掉可能的数字指标（它们是有信息量的），避免把"改到 10s"误判为套话
  let remaining = text.replace(METRIC_RE, '');
  // 逐个剥掉黑名单动作词
  for (const w of FILLER_WORDS) {
    remaining = remaining.split(w).join('');
  }
  // 逐个剥掉无实义虚词
  for (const w of FUNCTION_WORDS) {
    remaining = remaining.split(w).join('');
  }
  // 去掉标点与空白后，若几乎没剩字，说明是纯套话
  const meaningful = remaining.replace(/[\s，。、；：！？,.!?;:（）()【】\[\]"'"“”‘’\-—]/g, '');
  return meaningful.length === 0;
}

/** 判断 reason 是否绑定了至少一个具体实体 */
function matchesConcreteEntity(text: string, resolver: ReasonEvidenceResolver): boolean {
  // 1) 数字指标（如 3s / token=1200 / 1200）
  if (METRIC_RE.test(text)) return true;
  // 2) 文件路径 / diff 文件名（含 . 扩展名或 / 分隔）
  if (/[A-Za-z0-9_\-/.]+\.(?:go|ts|js|py|java|json|vue|md|txt|sql|html|css|mjs|tsx|jsx)\b/i.test(text)) return true;
  // 3) 显式绑定集合中的实体（节点/文件 id、trace 引用）
  const ids = (resolver.entityIds ?? []).filter(Boolean);
  for (const id of ids) {
    if (text.includes(id)) return true;
  }
  const refs = (resolver.traceRefs ?? []).filter(Boolean);
  for (const r of refs) {
    if (text.includes(r)) return true;
  }
  return false;
}