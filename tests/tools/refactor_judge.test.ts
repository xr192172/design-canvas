/**
 * refactor_judge 测试：LLM 审闭环裁决门
 *   - 缺省（无裁决器）全部"不确定"→ 全部上抛（回上下文）
 *   - 有裁决器 → adopt/reject/unsure 三分，不确定才上抛
 *   - 自动补 id / meta / review_prompt
 */
import { describe, it, expect } from 'vitest';
import { runRefactorJudge } from '../../src/tools/refactor_judge';
import { takeAlerts, setAlertListener } from '../../src/tools/alert_inbox';

// 隔离收件箱：跑每条前清空（takeAlerts 取空 = 已读清空）
function drainInbox(): number {
  return takeAlerts().length;
}

const sampleIssues = [
  { type: 'dead_import', file: 'a.ts', desc: '死依赖 axios', severity: 'high' as const },
  { type: 'mixed_signals', file: 'b.ts', desc: '一文件多功能', evidence: '注释明言' },
  { type: 'package_migration', file: 'c.go', desc: 'v2 待提级' },
];

describe('runRefactorJudge 缺省（最小形态）', () => {
  it('未提供裁决器 → 全部判"不确定"并全部上抛，且入箱回上下文', async () => {
    drainInbox();
    setAlertListener(null);
    const r = await runRefactorJudge({ project_dir: '/p', issues: sampleIssues });
    expect(r.meta.total).toBe(3);
    expect(r.meta.unsure).toBe(3);
    expect(r.meta.adopted).toBe(0);
    expect(r.meta.rejected).toBe(0);
    expect(r.escalated).toHaveLength(3);
    expect(r.decided.adopt).toHaveLength(0);
    expect(r.decided.reject).toHaveLength(0);
    // 上抛已回上下文（收件箱非空）
    expect(drainInbox()).toBe(3);
    // 自动补 id
    expect(r.decisions.map((d) => d.issue_id)).toEqual(['dead_import#1', 'mixed_signals#1', 'package_migration#1']);
    // review_prompt 可读
    expect(r.review_prompt).toContain('拿不定主意 3');
    expect(r.review_prompt).toContain('死依赖 axios');
  });

  it('escalate_to_inbox=false → 上抛结果里有，但不再入箱', async () => {
    drainInbox();
    const r = await runRefactorJudge({ project_dir: '/p', issues: sampleIssues, escalate_to_inbox: false });
    expect(r.escalated).toHaveLength(3);
    expect(drainInbox()).toBe(0);
  });
});

describe('runRefactorJudge 有裁决器', () => {
  it('按裁决三分：采纳/驳回进 decided，不确定上抛', async () => {
    drainInbox();
    const r = await runRefactorJudge({
      project_dir: '/p',
      issues: sampleIssues,
      decide: (issues) =>
        issues.map((it) => {
          const verdict =
            it.id === 'dead_import#1' ? 'adopt' : it.id === 'mixed_signals#1' ? 'reject' : 'unsure';
          return { issue_id: it.id!, verdict, reason: 'LLM 判断', confidence: 0.8 };
        }),
    });
    expect(r.decided.adopt.map((i) => i.id)).toEqual(['dead_import#1']);
    expect(r.decided.reject.map((i) => i.id)).toEqual(['mixed_signals#1']);
    expect(r.escalated.map((i) => i.id)).toEqual(['package_migration#1']);
    expect(r.meta).toEqual({ total: 3, adopted: 1, rejected: 1, unsure: 1 });
    // 只有不确定那条入箱
    expect(drainInbox()).toBe(1);
  });

  it('裁决器漏掉的条目不吞，补"不确定"上抛', async () => {
    drainInbox();
    const r = await runRefactorJudge({
      project_dir: '/p',
      issues: sampleIssues,
      decide: () => [{ issue_id: 'dead_import#1', verdict: 'adopt', reason: 'x', confidence: 0.9 }],
    });
    expect(r.decided.adopt).toHaveLength(1);
    expect(r.escalated).toHaveLength(2); // 其余两条补为不确定
  });
});