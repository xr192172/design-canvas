/**
 * python_refactor/index —— 装配并暴露 Python 执行器（language executor）
 * 语言无关契约见 src/tools/refactor_langs.ts。本模块是"新语言新路径"的示例：
 * 只在 dead_imports 上落地（最安全、信号最强的第一步）；dead_statements 留给下一棒。
 * 新项目照搬此结构注册自己的语言执行器即可。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { LanguageRefactorExecutor, RefactorStageComputeArgs, RunningChangePlan } from '../refactor_langs.js';
import { detectDeadPyImports, removePyImportsFromSource } from './dead_imports.js';
import { pyVerifyCommands } from './verify_commands.js';

/** dead_imports 步：纯计算（复用检测 + 整条删除），不落盘；落盘/验证/回滚由管线负责。 */
export function computePyDeadImportsPlan(args: RefactorStageComputeArgs): RunningChangePlan {
  const proj = args.project_dir;
  const absToNew = new Map<string, string>();
  const originals = new Map<string, string>();
  const resolved =
    args.dead && args.dead.length > 0
      ? args.dead
      : detectDeadPyImports({ project_dir: proj, files: args.files }).dead;
  for (const d of resolved) {
    for (const f of d.files ?? []) {
      const abs = path.isAbsolute(f) ? path.resolve(f) : path.resolve(proj, f);
      let src: string;
      try {
        src = fs.readFileSync(abs, 'utf-8');
      } catch {
        continue;
      }
      const r = removePyImportsFromSource(src, d.source);
      if (r.removed > 0) {
        absToNew.set(abs, r.output);
        originals.set(abs, src);
      }
    }
  }
  return { absToNew, originals };
}

export const pythonExecutor: LanguageRefactorExecutor = {
  lang: 'py',
  isSourceFile: (rel) => rel.endsWith('.py'),
  detectVerifyCommands: pyVerifyCommands,
  stages: [
    {
      kind: 'dead_imports',
      label: '[py] 死 import 移除',
      compute: computePyDeadImportsPlan,
      limitations: [
        'py 保守：仅单目标 import/from-import 参与；多目标、括号续写、星号、相对导入、__future__ 恒活，不误删',
        '文件内零引用即报死；注释/字符串同名出现未剥离只会多活，安全向；删除前仍过验证闭环',
        '尚未落地 Python 的 dead_statements（死语句）——留给下一棒，按契约补 compute 即可',
      ],
    },
  ],
};