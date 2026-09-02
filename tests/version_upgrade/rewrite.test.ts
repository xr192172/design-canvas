/**
 * rewrite：局部重写建议 + 编辑应用（阶段 D）测试
 *
 * 覆盖：
 *   - buildRewritePlan：把阶段 B/C 命中聚合成按文件有序的计划，子项目路径前缀正确
 *   - suggestDeterministicEdits：只对"语义零风险"的替换产出编辑（new Buffer → Buffer.from），
 *     其余（JAXB 等）不自动改
 *   - applyEdits：精确字符串替换 + 出现次数校验（唯一命中/缺失抛错/有歧义抛错/无变化跳过）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { buildRewritePlan, suggestDeterministicEdits, applyEdits } from '../../src/version_upgrade/rewrite';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      // leave to OS on Windows
    }
  }
});

function tempRoot(): string {
  const dir = path.join(os.tmpdir(), `upgrw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

const featureHit = (file: string, line: number, feature: string, since: number): Parameters<typeof buildRewritePlan>[0][number]['hits'][number] => ({
  file,
  line,
  feature,
  tool: 'java',
  since,
  rewrite: '改为显式类型',
  snippet: `var x = 1; // ${feature}`,
});

const removedHit = (file: string, line: number, api: string, since: number, snippet = `import ${api};`): Parameters<typeof buildRewritePlan>[1][number]['hits'][number] => ({
  file,
  line,
  api,
  tool: 'node',
  since,
  kind: 'removed',
  rewrite: '改用替代',
  snippet,
});

describe('buildRewritePlan', () => {
  it('聚合并按 文件→行 排序，子项目路径加前缀，removed 命中标记 auto', () => {
    const plan = buildRewritePlan(
      [
        {
          declaration: { projectDir: 'service-a' },
          hits: [featureHit('src/A.java', 20, 'record 记录类', 16), featureHit('src/A.java', 8, 'var 局部变量', 10)],
        },
        {
          declaration: { projectDir: '.' },
          hits: [featureHit('B.java', 3, '文本块', 15)],
        },
      ],
      [
        {
          declaration: { projectDir: 'frontend' },
          hits: [removedHit('src/index.js', 6, 'new Buffer(...)', 6, 'const buf = new Buffer("x");')],
        },
      ]
    );

    expect(plan).toHaveLength(4);
    expect(plan.map((i) => i.file)).toEqual([
      'B.java',
      'frontend/src/index.js',
      'service-a/src/A.java',
      'service-a/src/A.java',
    ]);
    // 同文件按行号升序（service-a 两条：8 在 20 前）
    expect(plan[2].line).toBe(8);
    expect(plan[3].line).toBe(20);
    // 确定性可自动改的 removed 命中标记 auto=true（frontend 一条）
    expect(plan[1].kind).toBe('removed');
    expect(plan[1].auto).toBe(true);
    expect(plan[0].auto).toBe(false);
  });
});

describe('suggestDeterministicEdits', () => {
  it('new Buffer 命中 → 产出 Buffer.from 替换；其余 API 不产出', () => {
    const edits = suggestDeterministicEdits([
      removedHit('src/index.js', 6, 'new Buffer(...)', 6, 'const buf = new Buffer("x");'),
      removedHit('src/App.java', 3, 'JAXB（javax.xml.bind）', 11),
      removedHit('main.go', 4, 'io/ioutil', 16),
    ]);
    expect(edits).toEqual([{ file: 'src/index.js', from: 'new Buffer(', to: 'Buffer.from(' }]);
  });

  it('命中行不含替换串（如只在 import 出现）→ 不产出', () => {
    const edits = suggestDeterministicEdits([removedHit('src/index.js', 1, 'new Buffer(...)', 6, 'import { Buffer } from "buffer";')]);
    expect(edits).toHaveLength(0);
  });
});

describe('applyEdits', () => {
  it('唯一命中的替换成功落盘，返回改动文件', () => {
    const root = tempRoot();
    write(root, 'src/index.js', 'const buf = new Buffer("x");\n');
    const r = applyEdits(root, [{ file: 'src/index.js', from: 'new Buffer(', to: 'Buffer.from(' }]);
    expect(r.applied).toBe(1);
    expect(r.changedFiles).toEqual(['src/index.js']);
    expect(fs.readFileSync(path.join(root, 'src/index.js'), 'utf-8')).toBe('const buf = Buffer.from("x");\n');
  });

  it('from 不存在 → 抛错，文件不变', () => {
    const root = tempRoot();
    write(root, 'src/index.js', 'const a = 1;\n');
    expect(() => applyEdits(root, [{ file: 'src/index.js', from: 'new Buffer(', to: 'Buffer.from(' }])).toThrow('找不到');
    expect(fs.readFileSync(path.join(root, 'src/index.js'), 'utf-8')).toBe('const a = 1;\n');
  });

  it('from 出现多次 → 有歧义抛错，文件不变', () => {
    const root = tempRoot();
    write(root, 'src/index.js', 'const a = new Buffer("x"); const b = new Buffer("y");\n');
    expect(() => applyEdits(root, [{ file: 'src/index.js', from: 'new Buffer(', to: 'Buffer.from(' }])).toThrow('有歧义');
    expect(fs.readFileSync(path.join(root, 'src/index.js'), 'utf-8')).toContain('new Buffer("x")');
  });

  it('替换后内容不变（from==to）→ applied 计一次但不进 changedFiles', () => {
    const root = tempRoot();
    write(root, 'src/b.js', 'const x = 1;\n');
    const r = applyEdits(root, [{ file: 'src/b.js', from: 'const x = 1', to: 'const x = 1' }]);
    expect(r.applied).toBe(1);
    expect(r.changedFiles).toEqual([]); // 内容未变 → 不算实际改动
  });
});
