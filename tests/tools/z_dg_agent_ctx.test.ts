/**
 * DOGFOOD RUNNER (temp): agent 提级合并 —— 经 refactor_pipeline 落盘。
 * verify:false（树半迁移基线过不了）；落盘后 go build 手动验证。
 * 已暂时 stash 用户 tracked 变更；untracked v2 文件为迁移对象（camera-backup 兜底）。
 */
import { describe, it } from 'vitest';
import { runRefactorPipeline } from '../../src/tools/refactor_pipeline';

const SHELL = 'd:/project_develop/ai-base/agent-shell';

describe('dogfood: agent 提级合并落盘', () => {
  it('agent: package v2->agent, import /agent/v2->/agent, 别名 agentv2/v2->agent', async () => {
    const r = await runRefactorPipeline({
      project_dir: SHELL,
      verify: false,
      steps: {
        package_migration: {
          enabled: true,
          migrate: {
            moduleBase: 'github.com/ai-base/agent-shell',
            prefix: 'internal/agent/v2',
            to: 'internal/agent',
            packageRename: { from: 'v2', to: 'agent' },
            aliases: [
              { importPath: 'github.com/ai-base/agent-shell/internal/agent', from: 'agentv2', to: 'agent' },
              { importPath: 'github.com/ai-base/agent-shell/internal/agent', from: 'v2', to: 'agent' },
            ],
          },
        },
      },
    });
    console.log('AGENT plan=', r.planned_steps, 'files=', r.total_files_changed);
    for (const s of r.stages) console.log('  stage', s.id, s.outcome, 'changed=', s.files_changed);
    if (!r.ok) throw new Error('agent stage rolled back / failed');
  });

  it('context: package v2->context, import /context/v2->/context, 别名 v2ctx/contextv2->context', async () => {
    const r = await runRefactorPipeline({
      project_dir: SHELL,
      verify: false,
      steps: {
        package_migration: {
          enabled: true,
          migrate: {
            moduleBase: 'github.com/ai-base/agent-shell',
            prefix: 'internal/context/v2',
            to: 'internal/context',
            packageRename: { from: 'v2', to: 'context' },
            aliases: [
              { importPath: 'github.com/ai-base/agent-shell/internal/context', from: 'v2ctx', to: 'context' },
              { importPath: 'github.com/ai-base/agent-shell/internal/context', from: 'contextv2', to: 'context' },
            ],
          },
        },
      },
    });
    console.log('CONTEXT plan=', r.planned_steps, 'files=', r.total_files_changed);
    for (const s of r.stages) console.log('  stage', s.id, s.outcome, 'changed=', s.files_changed);
    if (!r.ok) throw new Error('context stage rolled back / failed');
  });
});