/**
 * health —— 代码健康度单元测试
 *
 * 夹具：tests/fixtures/codehealth-fixture（5 文件三层）
 *   src/contracts/models.ts      契约层：User(被积木/胶水引用) / Order(未使用导出)
 *   src/contracts/bad_contract.ts 契约层违规：反向依赖积木层(分层违规) + 自身无消费者(孤儿) + ScoreBand/bandOf 未使用导出
 *   src/bricks/user_service.ts   积木层：computeScore/superComplex(被胶水消费) / unusedFn(未使用导出) /
 *                                 Order 未使用 import / superComplex 高复杂度
 *   src/bricks/orphan.ts         积木层孤立模块：孤儿文件 + legacyHelper 未使用导出
 *   src/glue/app.ts              胶水层：入口，正常消费积木/契约（零问题）
 *
 * 预期体检结果：
 *   unused_export ×5（Order / ScoreBand / bandOf / unusedFn / legacyHelper）
 *   unused_import ×1（user_service 的 Order）
 *   orphan_file  ×2（bad_contract + orphan）
 *   high_complexity ×1（superComplex）
 *   layer_violation ×1（bad_contract：契约 0 依赖积木 1）
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyLayer, estimateComplexity, unusedImportsIn, analyzeHealth } from '../../src/health/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(here, '..', 'fixtures', 'codehealth-fixture');

describe('health: 分层分类（路径启发式）', () => {
  it('契约/胶水命中特征，其余默认积木', () => {
    expect(classifyLayer('src/contracts/models.ts')).toBe('contract');
    expect(classifyLayer('src/contracts/bad_contract.ts')).toBe('contract');
    expect(classifyLayer('src/glue/app.ts')).toBe('glue');
    expect(classifyLayer('src/bricks/user_service.ts')).toBe('brick');
    expect(classifyLayer('src/bricks/orphan.ts')).toBe('brick');
    // 未命中特征 → 积木
    expect(classifyLayer('src/foo.ts')).toBe('brick');
    expect(classifyLayer('src/api/helper.ts')).toBe('brick');
  });
});

describe('health: 圈复杂度（AST 分支节点计数）', () => {
  it('无分支 = 1', async () => {
    expect(await estimateComplexity('x.ts', 'function a() { return 1; }')).toBe(1);
  });
  it('if/for/&&/|| 线性累加', async () => {
    const src = `function f(n) {\n  if (n > 1) {}\n  for (let i = 0; i < n; i++) {}\n  if (a && b) {}\n  if (x || y) {}\n  return n;\n}`;
    // 基1 + if×3 + for×1 + &&×1 + ||×1 = 7
    expect(await estimateComplexity('x.ts', src)).toBe(7);
  });
  it('剥离注释后计数（注释里的 if 不计）', async () => {
    const src = `function f() {\n  // if (true) x\n  if (false) {}\n  return 0;\n}`;
    expect(await estimateComplexity('x.ts', src)).toBe(2);
  });
  it('三元表达式计入（AST 不再漏 Python 三元）', async () => {
    const py = `def f(a, b):\n    return a if a else b\n`;
    // 基1 + conditional_expression×1 = 2
    expect(await estimateComplexity('x.py', py)).toBe(2);
  });
});

describe('health: 未使用 import 提取', () => {
  it('只导入未使用 → 报未使用；已使用不报', async () => {
    const src = `import { User, Order } from '../contracts/models';\n\nexport function f(u: User): number { return u.id; }\n`;
    const unused = await unusedImportsIn('x.ts', src);
    expect(unused).toHaveLength(1);
    expect(unused[0].name).toBe('Order');
    expect(unused[0].module).toBe('../contracts/models');
  });
  it('无 import → 空', async () => {
    expect(await unusedImportsIn('x.ts', 'export const a = 1;')).toEqual([]);
  });
  it('Python 别名 import：别名未使用才报，原始名不报', async () => {
    const src = `from mod import a, b as c\n\ndef f(x):\n    return a + x\n`;
    const unused = await unusedImportsIn('x.py', src);
    expect(unused).toHaveLength(1);
    expect(unused[0].name).toBe('c');
    expect(unused[0].module).toBe('mod');
  });
});

describe('health: 夹具整体体检', () => {
  it('五个文件三层 + 各类问题数量精确匹配', async () => {
    const r = await analyzeHealth(fixtureRoot);
    expect(r.fileCount).toBe(5);
    expect(r.layers).toEqual({ contract: 2, brick: 2, glue: 1, violations: 1 });
    expect(r.counts).toEqual({
      unused_export: 5,
      unused_import: 1,
      orphan_file: 2,
      high_complexity: 1,
      layer_violation: 1,
    });
    expect(r.issues).toHaveLength(10);
  });

  it('问题清单逐条定位（文件/类型/符号）', async () => {
    const r = await analyzeHealth(fixtureRoot);
    const by = (kind: string) => r.issues.filter((i) => i.kind === kind);

    // 未使用导出
    const unusedExports = by('unused_export');
    expect(unusedExports.map((i) => `${i.file}:${i.symbol}`).sort()).toEqual([
      'src/bricks/orphan.ts:legacyHelper',
      'src/bricks/user_service.ts:unusedFn',
      'src/contracts/bad_contract.ts:ScoreBand',
      'src/contracts/bad_contract.ts:bandOf',
      'src/contracts/models.ts:Order',
    ]);

    // 未使用 import
    const unusedImports = by('unused_import');
    expect(unusedImports).toHaveLength(1);
    expect(unusedImports[0].file).toBe('src/bricks/user_service.ts');
    expect(unusedImports[0].symbol).toBe('Order');
    expect(unusedImports[0].severity).toBe('warn');

    // 孤儿文件
    const orphans = by('orphan_file').map((i) => i.file).sort();
    expect(orphans).toEqual(['src/bricks/orphan.ts', 'src/contracts/bad_contract.ts']);

    // 高复杂度
    const complex = by('high_complexity');
    expect(complex).toHaveLength(1);
    expect(complex[0].file).toBe('src/bricks/user_service.ts');
    expect(complex[0].symbol).toBe('superComplex');
    expect(Number(complex[0].evidence)).toBeGreaterThan(10);

    // 分层违规
    const viol = by('layer_violation');
    expect(viol).toHaveLength(1);
    expect(viol[0].file).toBe('src/contracts/bad_contract.ts');
    expect(viol[0].severity).toBe('error');
    expect(viol[0].evidence).toBe('src/bricks/user_service.ts');
  });

  it('健康分/等级/摘要 + 复杂度 Top 含 superComplex', async () => {
    const r = await analyzeHealth(fixtureRoot);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(['A', 'B', 'C', 'D']).toContain(r.grade);
    expect(r.summary).toContain(`${r.score} 分`);
    const top = r.complexity.find((c) => c.symbol === 'superComplex');
    expect(top).toBeDefined();
    expect(top!.complexity).toBeGreaterThan(10);
    // 复杂度清单按分数降序
    for (let i = 1; i < r.complexity.length; i++) {
      expect(r.complexity[i - 1].complexity).toBeGreaterThanOrEqual(r.complexity[i].complexity);
    }
  });

  it('threshold 参数：调高阈值后 high_complexity 消失', async () => {
    const r = await analyzeHealth(fixtureRoot, { complexityThreshold: 100 });
    expect(r.counts.high_complexity).toBe(0);
  });
});

describe('health: Java 未使用 import（AST 绑定）', () => {
  it('Java 用了 Foo 未用 Bar → 只报 Bar', async () => {
    const src = 'package p;\nimport com.acme.Foo;\nimport com.acme.Bar;\nclass A { Foo f; }\n';
    const unused = await unusedImportsIn('a.java', src);
    expect(unused.map((u) => u.name)).toEqual(['Bar']);
  });
});
