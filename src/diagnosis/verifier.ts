/**
 * verifier —— 验证建议（诊断流水线第 6 步）
 *
 * 只给建议、不自动执行（用户偏好：验证方式只提供建议，不代跑）。
 * 按项目类型（marker 文件探测）给出最合适的验证命令：
 *   - test_failure 症状：先重跑失败用例（最窄复现）
 *   - 通用：类型检查 → 构建 → 测试
 *   - design-canvas 管理的项目（.design-canvas 目录存在）：追加渲染/截图自检
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Impact, RootCause, SymptomType, Verification } from './contract.js';

export interface VerifyInput {
  project_dir: string;
  symptom_type?: SymptomType;
  root_cause?: RootCause;
  impact: Impact;
}

interface ProjectKind {
  label: string;
  test: string;
  typecheck?: string;
  build: string;
}

/** 按 marker 文件探测项目类型（不存在返回 null） */
export function detectKind(project_dir: string): ProjectKind | null {
  const root = path.resolve(project_dir);
  const has = (...names: string[]): boolean => names.some((n) => fs.existsSync(path.join(root, n)));
  if (has('package.json')) {
    return { label: 'Node/TS', test: 'npm test', typecheck: 'npx tsc --noEmit', build: 'npm run build' };
  }
  if (has('go.mod')) {
    return { label: 'Go', test: 'go test ./...', build: 'go build ./...' };
  }
  if (has('pyproject.toml', 'requirements.txt')) {
    return { label: 'Python', test: 'pytest', build: 'python -m build' };
  }
  if (has('Cargo.toml')) {
    return { label: 'Rust', test: 'cargo test', build: 'cargo build' };
  }
  if (has('pom.xml')) {
    return { label: 'Java/Maven', test: 'mvn test', build: 'mvn compile' };
  }
  return null;
}

export function suggestVerification(input: VerifyInput): Verification[] {
  const { project_dir, symptom_type, root_cause } = input;
  const root = path.resolve(project_dir);
  const kind = detectKind(project_dir);
  const out: Verification[] = [];

  const isDesignCanvasManaged = fs.existsSync(path.join(root, '.design-canvas'));

  if (symptom_type === 'test_failure' && kind) {
    out.push({
      type: 'rerun',
      command_hint: `${kind.test}（先重跑失败用例，最窄复现）`,
    });
  }

  if (kind) {
    if (kind.typecheck) {
      out.push({ type: 'typecheck', command_hint: kind.typecheck });
    }
    out.push({ type: 'build', command_hint: kind.build });
    if (symptom_type !== 'test_failure') {
      out.push({ type: 'test', command_hint: kind.test });
    }
  } else {
    out.push({
      type: 'manual',
      command_hint: '未识别项目类型（无 package.json/go.mod/pyproject.toml/Cargo.toml/pom.xml），请按项目实际工具链验证',
    });
  }

  if (isDesignCanvasManaged) {
    out.push({
      type: 'observe',
      command_hint: `渲染自检：${root_cause?.file_path ?? '根因文件'} 修改后，用项目自带截图/渲染自检确认 DSL 图与预期一致`,
    });
  }

  return out;
}
