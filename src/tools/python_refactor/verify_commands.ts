/**
 * python_refactor/verify_commands —— Python 项目形态 → 验证命令组探测
 * 依 pyproject.toml / requirements.txt / setup.py|cfg 断言这是 Python 工程；
 * 探测到测试约定才加 pytest，测不到当"只验证语法+导入"（compileall）。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { VerifyCommand } from '../verify_refactor.js';

export function pyVerifyCommands(cwd: string): VerifyCommand[] {
  const hasPyProject = fs.existsSync(path.join(cwd, 'pyproject.toml'));
  const hasReq =
    fs.existsSync(path.join(cwd, 'requirements.txt')) ||
    fs.existsSync(path.join(cwd, 'setup.py')) ||
    fs.existsSync(path.join(cwd, 'setup.cfg'));
  if (!hasPyProject && !hasReq) return [];
  const cmds: VerifyCommand[] = [
    { label: 'py compileall', cmd: 'python', args: ['-m', 'compileall', '-q', '.'], timeoutMs: 120_000 },
  ];
  if (hasPyProject) {
    cmds.push({ label: 'pytest', cmd: 'python', args: ['-m', 'pytest', '-q'], timeoutMs: 600_000 });
  }
  return cmds;
}