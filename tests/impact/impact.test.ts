/**
 * impact —— 影响面分析单元测试
 *
 * 夹具：tests/fixtures/impact-fixture
 *   src/core/math.ts   导出 double(函数) / Shape(接口) / computeSum(函数) —— 底层核心
 *   src/core/logger.ts 导出 log(函数) —— 底层核心
 *   src/mid/business.ts  消费 math(call+type_ref) + logger(import)；被 api 消费 —— 中间层
 *   src/top/api.ts       消费 business(import+call) —— 顶层
 *   src/leaf/standalone.ts 无消费无被消费 —— 孤立叶
 *
 * 依赖图预期：
 *   business → math  （call: double；type_ref: Shape；import: ../core/math）
 *   business → logger（import: ../core/logger）
 *   api      → business（import+call: scale）
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeImpact, analyzeHubs } from '../../src/impact/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(here, '..', 'fixtures', 'impact-fixture');

const files = (r: { files: Array<{ file: string }> }) => r.files.map((f) => f.file);

describe('impact: 依赖图边', () => {
  it('import 边：改 logger 波及 business(depth1, import 证据) + 传递到 api(depth2)', async () => {
    const r = await analyzeImpact(fixtureRoot, [{ file: 'src/core/logger.ts' }]);
    expect(r.missing).toEqual([]);
    expect(r.total).toBe(2);
    const names = files(r);
    expect(names).toContain('src/mid/business.ts');
    expect(names).toContain('src/top/api.ts');
    const biz = r.files.find((f) => f.file === 'src/mid/business.ts')!;
    expect(biz.depth).toBe(1);
    expect(biz.sites.some((s) => s.kind === 'import')).toBe(true);
    expect(r.direct).toBe(1);
  });

  it('call 边 + 传递闭包：改 math 波及 business(depth1) 与 api(depth2)', async () => {
    const r = await analyzeImpact(fixtureRoot, [{ file: 'src/core/math.ts' }]);
    expect(r.total).toBe(2);
    const names = files(r);
    expect(names).toContain('src/mid/business.ts');
    expect(names).toContain('src/top/api.ts');
    expect(r.files.find((f) => f.file === 'src/mid/business.ts')!.depth).toBe(1);
    expect(r.files.find((f) => f.file === 'src/top/api.ts')!.depth).toBe(2);
    expect(r.direct).toBe(1);
  });

  it('call 边证据：business 对 math 的站点含 call 且 target_symbol=double', async () => {
    const r = await analyzeImpact(fixtureRoot, [{ file: 'src/core/math.ts' }]);
    const biz = r.files.find((f) => f.file === 'src/mid/business.ts')!;
    expect(biz.sites.some((s) => s.kind === 'call' && s.target_symbol === 'double')).toBe(true);
  });
});

describe('impact: 符号级变更点', () => {
  it('改 Shape 只波及 type_ref 消费方（business + 传递到 api）', async () => {
    const r = await analyzeImpact(fixtureRoot, [{ file: 'src/core/math.ts', symbol: 'Shape' }]);
    expect(r.fell_back).toBe(false);
    expect(r.files.some((f) => f.file === 'src/mid/business.ts' && f.depth === 1)).toBe(true);
    const biz = r.files.find((f) => f.file === 'src/mid/business.ts')!;
    expect(biz.sites.some((s) => s.kind === 'type_ref' && s.target_symbol === 'Shape')).toBe(true);
    // Shape 只被 business 引用 → 闭包终点是 api（depth2）
    expect(r.files.some((f) => f.file === 'src/top/api.ts' && f.depth === 2)).toBe(true);
    expect(r.files.some((f) => f.file === 'src/leaf/standalone.ts')).toBe(false);
  });

  it('改 double：business 直接受波及且不 fell_back', async () => {
    const r = await analyzeImpact(fixtureRoot, [{ file: 'src/core/math.ts', symbol: 'double' }]);
    expect(r.fell_back).toBe(false);
    expect(r.files.some((f) => f.file === 'src/mid/business.ts' && f.depth === 1)).toBe(true);
  });

  it('改无消费方的 computeSum：符号级解析不到消费方 → 保守降级整闭包（fell_back=true）', async () => {
    const r = await analyzeImpact(fixtureRoot, [{ file: 'src/core/math.ts', symbol: 'computeSum' }]);
    expect(r.fell_back).toBe(true);
    // 降级语义 = 改整个文件：闭包仍覆盖 business + api
    expect(files(r)).toEqual(expect.arrayContaining(['src/mid/business.ts', 'src/top/api.ts']));
  });
});

describe('impact: 边界', () => {
  it('缺失变更点：未在项目中定位到 → missing 列表，不影响其它', async () => {
    const r = await analyzeImpact(fixtureRoot, [
      { file: 'src/notexist.ts' },
      { file: 'src/core/math.ts' },
    ]);
    expect(r.missing).toEqual(['src/notexist.ts']);
    expect(r.total).toBe(2);
  });

  it('孤立文件改动 → 零波及（total=0）', async () => {
    const r = await analyzeImpact(fixtureRoot, [{ file: 'src/leaf/standalone.ts' }]);
    expect(r.missing).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.files).toEqual([]);
  });

  it('maxDepth 截断：depth=1 时不透传 api', async () => {
    const r = await analyzeImpact(fixtureRoot, [{ file: 'src/core/math.ts' }], { maxDepth: 1 });
    expect(r.files.some((f) => f.file === 'src/top/api.ts')).toBe(false);
    expect(r.files.some((f) => f.file === 'src/mid/business.ts')).toBe(true);
  });
});

describe('impact: 风险热区盘点', () => {
  it('analyzeHubs：business 波及半径 + 耦合最高，排第一', async () => {
    const h = await analyzeHubs(fixtureRoot, 10);
    expect(h.fileCount).toBe(5);
    expect(h.files[0].file).toBe('src/mid/business.ts');
    expect(h.files[0].dependents).toBe(1);
    expect(h.files[0].dependencies).toBe(2);
    // 所有文件都在盘点里（top=10 > 5）
    expect(h.files.length).toBe(5);
  });
});
