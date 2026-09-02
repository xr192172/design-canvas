/**
 * hybrid —— 项目杂交预检测试
 *
 * 覆盖：
 *   - manifest 解析（package.json / go.mod / pyproject.toml / requirements.txt）纯函数
 *   - compareDeps 分类：同名版本一致=shared、不一致=conflicts、仅一方=aOnly/bOnly
 *   - judgeVerdict 判定迁移：ok / fix（重叠或依赖冲突）/ blocked（符号冲突）
 *   - precheckHybrid 端到端：夹具 hybrid-a ↔ hybrid-b 三维体检 + verdict
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parsePackageJsonDeps,
  parseGoModDeps,
  parsePyprojectDeps,
  parseRequirementsDeps,
  readManifestDeps,
  compareDeps,
  judgeVerdict,
  precheckHybrid,
} from '../../src/hybrid/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fix = (name: string): string => path.join(here, '..', 'fixtures', name);

describe('hybrid: manifest 解析（纯函数）', () => {
  it('package.json：dependencies + devDependencies', () => {
    const deps = parsePackageJsonDeps(
      JSON.stringify({ dependencies: { lodash: '^4.17.21' }, devDependencies: { vitest: '^1.6.0' } }),
    );
    expect(deps).toContainEqual({ name: 'lodash', version: '^4.17.21', source: 'package.json' });
    expect(deps).toContainEqual({ name: 'vitest', version: '^1.6.0', source: 'package.json' });
  });

  it('go.mod：require block + 单行', () => {
    const deps = parseGoModDeps(
      [
        'module example.com/a',
        '',
        'require (',
        '    github.com/foo/bar v1.2.3',
        '    golang.org/x/sync v0.5.0 // indirect',
        ')',
        '',
        'require github.com/other/lib v2.0.0',
      ].join('\n'),
    );
    expect(deps).toContainEqual({ name: 'github.com/foo/bar', version: 'v1.2.3', source: 'go.mod' });
    expect(deps).toContainEqual({ name: 'golang.org/x/sync', version: 'v0.5.0', source: 'go.mod' });
    expect(deps).toContainEqual({ name: 'github.com/other/lib', version: 'v2.0.0', source: 'go.mod' });
  });

  it('pyproject.toml：[project] dependencies + optional-dependencies', () => {
    const deps = parsePyprojectDeps(
      [
        '[project]',
        'name = "app"',
        'dependencies = [',
        '    "requests>=2.31.0",',
        '    "fastapi==0.104.1",',
        ']',
        '',
        '[project.optional-dependencies]',
        'dev = ["pytest>=7.0"]',
      ].join('\n'),
    );
    expect(deps).toContainEqual({ name: 'requests', version: '>=2.31.0', source: 'pyproject.toml' });
    expect(deps).toContainEqual({ name: 'fastapi', version: '==0.104.1', source: 'pyproject.toml' });
    expect(deps).toContainEqual({ name: 'pytest', version: '>=7.0', source: 'pyproject.toml' });
  });

  it('requirements.txt：name==ver / name>=ver', () => {
    const deps = parseRequirementsDeps('requests==2.31.0\nfastapi>=0.104\n# 注释行\n');
    expect(deps).toContainEqual({ name: 'requests', version: '==2.31.0', source: 'requirements.txt' });
    expect(deps).toContainEqual({ name: 'fastapi', version: '>=0.104', source: 'requirements.txt' });
  });
});

describe('hybrid: compareDeps 分类', () => {
  it('同名同版=shared、同名异版=conflicts、仅一方=aOnly/bOnly', () => {
    const r = compareDeps(
      [
        { name: 'lodash', version: '^4.17.21', source: 'package.json' },
        { name: 'react', version: '^18.2.0', source: 'package.json' },
        { name: 'axios', version: '^1.6.0', source: 'package.json' },
      ],
      [
        { name: 'lodash', version: '^4.17.21', source: 'package.json' },
        { name: 'react', version: '^17.0.2', source: 'package.json' },
        { name: 'express', version: '^4.18.0', source: 'package.json' },
      ],
    );
    expect(r.shared.map((d) => d.name)).toEqual(['lodash']);
    expect(r.conflicts.map((d) => d.name)).toEqual(['react']);
    expect(r.conflicts[0].version).toContain('^18.2.0 (A)');
    expect(r.conflicts[0].version).toContain('^17.0.2 (B)');
    expect(r.aOnly.map((d) => d.name)).toEqual(['axios']);
    expect(r.bOnly.map((d) => d.name)).toEqual(['express']);
  });
});

describe('hybrid: judgeVerdict 判定', () => {
  it('三维全净 → ok', () => {
    const { verdict, reasons } = judgeVerdict(0, 0, 0);
    expect(verdict).toBe('ok');
    expect(reasons.length).toBe(1);
  });

  it('仅功能重叠/依赖冲突 → fix', () => {
    expect(judgeVerdict(0, 1, 0).verdict).toBe('fix');
    expect(judgeVerdict(0, 0, 1).verdict).toBe('fix');
  });

  it('存在符号冲突 → blocked（最高优先）', () => {
    expect(judgeVerdict(1, 0, 0).verdict).toBe('blocked');
    expect(judgeVerdict(1, 3, 2).verdict).toBe('blocked');
  });
});

describe('hybrid: judgeVerdict 健康度提醒（第四查，可选参数）', () => {
  it('不传 health → 行为不变（兼容既有调用）', () => {
    expect(judgeVerdict(0, 0, 0).reasons.length).toBe(1);
  });

  it('两侧健康（A/B）且三维全净 → ok + 健康度良好', () => {
    const { verdict, reasons } = judgeVerdict(0, 0, 0, { aScore: 95, aGrade: 'A', bScore: 82, bGrade: 'B' });
    expect(verdict).toBe('ok');
    expect(reasons.some((x) => x.includes('健康度良好'))).toBe(true);
  });

  it('任一侧 C/D → 只追加提醒，不改变 verdict（健康度是参考非硬闸门）', () => {
    const { verdict, reasons } = judgeVerdict(0, 0, 0, { aScore: 55, aGrade: 'D', bScore: 95, bGrade: 'A' });
    expect(verdict).toBe('ok');
    expect(reasons.some((x) => x.includes('健康度提醒：项目 A 健康分 55（D）'))).toBe(true);
    expect(reasons.some((x) => x.includes('项目 B'))).toBe(false);
  });

  it('有硬冲突时健康提醒照常追加（不挤占 blocked）', () => {
    const { verdict, reasons } = judgeVerdict(1, 0, 0, { aScore: 50, aGrade: 'D', bScore: 70, bGrade: 'C' });
    expect(verdict).toBe('blocked');
    expect(reasons.some((x) => x.includes('符号冲突'))).toBe(true);
    expect(reasons.some((x) => x.includes('健康度提醒'))).toBe(true);
  });
});

describe('hybrid: precheckHybrid 端到端（夹具 hybrid-a ↔ hybrid-b）', () => {
  it('三维体检：符号冲突 + 双胞胎重叠 + 依赖冲突，verdict=blocked', async () => {
    const r = await precheckHybrid(fix('hybrid-a'), fix('hybrid-b'));

    // 维度1：符号冲突（复用 cross_repo）
    expect(r.symbolConflicts.map((c) => c.name)).toEqual(['merge']);
    // 维度2+3：双胞胎 = 功能重叠
    expect(r.symbolDuplicates.map((c) => c.name)).toEqual(['render']);
    // 维度2：依赖对比
    expect(r.deps.shared.map((d) => d.name)).toEqual(['lodash']);
    expect(r.deps.conflicts.map((d) => d.name)).toEqual(['react']);
    expect(r.deps.aOnly.map((d) => d.name)).toEqual(['axios']);
    expect(r.deps.bOnly.map((d) => d.name)).toEqual(['express']);

    expect(r.verdict).toBe('blocked');
    expect(r.reasons.some((x) => x.includes('符号冲突 1'))).toBe(true);
    expect(r.reasons.some((x) => x.includes('功能重叠 1'))).toBe(true);
    expect(r.reasons.some((x) => x.includes('依赖版本冲突 1'))).toBe(true);
  });

  it('readManifestDeps 只读根级 manifest（package.json 生效）', () => {
    const deps = readManifestDeps(fix('hybrid-a'));
    const names = deps.map((d) => d.name).sort();
    expect(names).toEqual(['axios', 'lodash', 'react']);
  });

  it('第四查：健康度随报告返回，score∈[0,100]、grade∈A-D、理由含健康度提醒', async () => {
    const r = await precheckHybrid(fix('hybrid-a'), fix('hybrid-b'));
    expect(r.health.a.score).toBeGreaterThanOrEqual(0);
    expect(r.health.a.score).toBeLessThanOrEqual(100);
    expect(['A', 'B', 'C', 'D']).toContain(r.health.a.grade);
    expect(r.health.b.fileCount).toBeGreaterThan(0);
    // 夹具无内部引用 → 健康度偏低（孤儿/未用导出），应出现健康度提醒理由
    expect(r.reasons.some((x) => x.includes('健康度提醒'))).toBe(true);
    // 健康度提醒不应挤占既有三维理由
    expect(r.reasons.some((x) => x.includes('符号冲突 1'))).toBe(true);
  });
});
