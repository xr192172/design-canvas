/**
 * refactor_judge —— LLM 审闭环的裁决门（2026-08-25）
 *
 * 用户的组织模型："人审闭环"实为 LLM 审闭环——LLM 自己对每个候选问题下结论，
 * 只有"拿不定主意"的才上抛给人。且设计画布是 MCP，上抛 = 把不确定集返回给
 * 控制台/上下文（经 alert_inbox 入箱，下一次工具响应自动附带），不需要交互审核 UI。
 *
 * 本模块职责 = 最小编排手势：
 *   ├ 入参：候选问题清单（由检测器/我（LLM）提供）
 *   ├ 裁决：可选 decide 裁决器逐条打 采纳/驳回/不确定(+置信度+理由)；
 *   │       缺省不给裁决器 → 全部判"不确定"→ 全部上抛（等 LLM/人审），
 *   │       恰好还原"跑完工具把问题回吐给 LLM，LLM 看了再给人审"的流程。
 *   ├ 上抛：uncertain 集 → pushAlert 入箱（回控制台/上下文）→ 进结果 escalated
 *   └ 返回：{ decided:{adopt,reject}, escalated, decisions } —— 调用方（我/LLM）
 *           拿到后即可把 escalated 呈现给人，或在对话里逐条拍板再回填。
 *
 * 与 signal_review 的关系：signal_review 是"混合文件该不该拆"的专用复核；
 * refactor_judge 是**类型无关**的通用裁决门，可包住 signal_review / 死码 / 死import
 * / 大积木缺口等任何候选，统一走 采纳/驳回/上抛。
 */

import { pushAlert } from './alert_inbox.js';

export type Verdict = 'adopt' | 'reject' | 'unsure';

export interface JudgeIssue {
  /** 候选问题 id；缺省自动生成 `<type>#<序号>` */
  id?: string;
  /** 问题类型：dead_code / dead_import / mixed_signals / package_migration / 或任意 */
  type: string;
  /** 关联文件（相对路径或绝对路径），可空 */
  file?: string;
  /** 人话描述，供 LLM/人一眼看懂 */
  desc: string;
  /** 严重度（默认 medium） */
  severity?: 'low' | 'medium' | 'high';
  /** 支撑证据/上下文片段 */
  evidence?: string;
  /** 检测器给预备置信度 0..1（可选，LLM 可能覆盖） */
  confidence?: number;
}

export interface JudgeDecision {
  issue_id: string;
  verdict: Verdict;
  /** 一句话理由 */
  reason: string;
  /** 置信度 0..1 */
  confidence: number;
}

export interface JudgeInput {
  project_dir?: string;
  issues: JudgeIssue[];
  /**
   * 裁决器：喂"规范化后的候选清单"，返回逐条决策。
   * 缺省未提供 → 全部判"不确定"并上抛（等 LLM/人审）——最小形态默认行为。
   */
  decide?: (issues: JudgeIssue[]) => Promise<JudgeDecision[]> | JudgeDecision[];
  /** 是否上抛进收件箱（回上下文）。默认 true */
  escalate_to_inbox?: boolean;
}

export interface JudgeResult {
  /** 已拍板（adopt=值得做/采纳，reject=驳回/忽略） */
  decided: { adopt: JudgeIssue[]; reject: JudgeIssue[] };
  /** 拿不定主意 → 已上抛（escalate_to_inbox 时已 pushAlert 入箱） */
  escalated: JudgeIssue[];
  decisions: JudgeDecision[];
  meta: { total: number; adopted: number; rejected: number; unsure: number };
  /** 给 LLM/人看的摘要（可直接贴给用户） */
  review_prompt: string;
}

/** 规范化：自动补 id / severity / confidence；编号稳定（<type>#<n>） */
function normalize(issues: JudgeIssue[]): { list: JudgeIssue[]; generated: number } {
  let generated = 0;
  const seenTypes: Record<string, number> = {};
  const list = issues.map((it) => {
    let id = it.id;
    if (!id) {
      generated++;
      seenTypes[it.type] = (seenTypes[it.type] ?? 0) + 1;
      id = `${it.type}#${seenTypes[it.type]}`;
    }
    return {
      ...it,
      id,
      severity: it.severity ?? 'medium',
      confidence: it.confidence ?? 0.5,
    } as JudgeIssue;
  });
  return { list, generated };
}

/** 把一条不确定问题投递进收件箱（回控制台/上下文） */
function pushEscalation(issue: JudgeIssue, projectDir: string): void {
  pushAlert({
    project_dir: projectDir,
    seq: Date.now() % 100_000,
    line: `[refactor_judge 待你审] ${issue.type} ${issue.file ?? ''} — ${issue.desc}`,
    created_at: new Date().toISOString(),
  });
}

export async function runRefactorJudge(input: JudgeInput): Promise<JudgeResult> {
  const { list, generated } = normalize(input.issues ?? []);
  const projectDir = input.project_dir ?? '';

  let decisions: JudgeDecision[];
  if (input.decide) {
    decisions = await input.decide(list);
    // 保证每条都有决策，缺省补"不确定"（裁决器漏判不吞问题）
    const byId = new Map(decisions.map((d) => [d.issue_id, d]));
    decisions = list.map((it) => {
      const d = byId.get(it.id!);
      return (
        d ?? {
          issue_id: it.id!,
          verdict: 'unsure' as Verdict,
          reason: '裁决器未覆盖该条，转人工',
          confidence: 0.4,
        }
      );
    });
  } else {
    // 最小形态默认：全部"不确定"→ 全部上抛（等 LLM/人审）
    decisions = list.map((it) => ({
      issue_id: it.id!,
      verdict: 'unsure' as Verdict,
      reason: '未提供裁决器，全部转人工复核',
      confidence: it.confidence ?? 0.5,
    }));
  }

  const adopt: JudgeIssue[] = [];
  const reject: JudgeIssue[] = [];
  const escalated: JudgeIssue[] = [];
  const decById = new Map(decisions.map((d) => [d.issue_id, d] as const));
  for (const it of list) {
    const d = decById.get(it.id!);
    const verdict = d?.verdict ?? 'unsure';
    if (verdict === 'adopt') adopt.push(it);
    else if (verdict === 'reject') reject.push(it);
    else {
      escalated.push(it);
      if (input.escalate_to_inbox !== false) pushEscalation(it, projectDir);
    }
  }

  const n = list.length;
  const review_prompt =
    `【LLM 审闭环】共 ${n} 个候选问题 → 采纳 ${adopt.length} / 驳回 ${reject.length} / ` +
    `拿不定主意 ${escalated.length}。\n` +
    (escalated.length > 0
      ? `待你审（已回上下文）：\n${escalated.map((e) => `  • [${e.type}] ${e.file ?? ''} — ${e.desc}`).join('\n')}`
      : '全部已裁定，无需上抛。') +
    `${generated > 0 ? `\n（${generated} 条已自动补 id）` : ''}`;

  return {
    decided: { adopt, reject },
    escalated,
    decisions,
    meta: { total: n, adopted: adopt.length, rejected: reject.length, unsure: escalated.length },
    review_prompt,
  };
}