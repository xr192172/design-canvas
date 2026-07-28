/**
 * derive_algorithm 工具测试（算法控制流推导）
 *
 * 覆盖场景：
 * - Go：if 分支（是/否边 + 汇合）+ for 循环（进入/重复回边/结束）+ return 终止
 * - TS：if-else 双分支 + while 循环
 * - Python：if/elif/else 链 + for 循环
 * - 连续语句合并为单个 step
 * - 深度截断（max_depth=1 折叠嵌套块）
 * - dead code 检测（return 后不可达语句）
 * - 幂等重跑：旧 __alg_ 节点/边清理重建
 * - 错误：函数不存在 / 节点不存在
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { deriveAlgorithm } from '../../src/tools/derive_algorithm';
import { createFeature } from '../../src/tools/feature_ops';
import { addNode } from '../../src/tools/node_ops';
import { addFile } from '../../src/tools/file_ops';
import { clearAllFeatures, getDSL, getLiveDslFile } from '../../src/storage';

let tmpDir: string;

function writeFixture(name: string, content: string): string {
  const p = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

const GO_FIXTURE = `package demo

func Process(items []string, limit int) (int, error) {
	total := 0
	for _, it := range items {
		if it == "" {
			continue
		}
		total += len(it)
	}
	if total > limit {
		return 0, ErrTooLong
	}
	return total, nil
}
`;

const TS_FIXTURE = `export function grade(score: number): string {
  let label = '';
  if (score >= 60) {
    label = 'pass';
  } else {
    label = 'fail';
  }
  let n = 0;
  while (n < score) {
    n += 10;
  }
  return label;
}
`;

const PY_FIXTURE = `def classify(x):
    if x > 100:
        tag = 'big'
    elif x > 10:
        tag = 'mid'
    else:
        tag = 'small'
    total = 0
    for i in range(x):
        total += i
    return tag, total
`;

const DEAD_GO = `package demo

func Early(ok bool) int {
	if !ok {
		return -1
		println("unreachable")
	}
	return 0
}
`;

const NESTED_GO = `package demo

func Deep(a, b, c int) int {
	if a > 0 {
		if b > 0 {
			if c > 0 {
				return a + b + c
			}
		}
	}
	return 0
}
`;

function setup(feature: string, filePath: string): void {
  createFeature({ feature });
  addNode({ feature, node_id: 'host', label: 'host file', x: 0, y: 0 });
  addFile({ feature, file_id: 'host', path: filePath, responsibility: 'test host' });
}

beforeEach(() => {
  clearAllFeatures();
  // clearAllFeatures 只清 features/ 目录，活态文件也要清（getDSL 优先读它）
  const live = getLiveDslFile();
  if (fs.existsSync(live)) fs.unlinkSync(live);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-alg-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('deriveAlgorithm', () => {
  it('Go：分支/循环/return 结构完整，边 label 语义正确', async () => {
    const fp = writeFixture('demo.go', GO_FIXTURE);
    setup('f1', fp);

    const r = await deriveAlgorithm({ feature: 'f1', node_id: 'host', function: 'Process' });
    const dsl = getDSL('f1')!;
    const nodes = dsl.geometry.nodes.filter((n) => n.id.startsWith('host__alg_'));
    const edges = (dsl.geometry.edges ?? []).filter((e) => e.id.startsWith('host__alge_'));

    // 结构：entry + step(初始化) + loop + branch(空串跳过) + branch(超限) + 2 return + exit
    const kinds = nodes.map((n) => n.description?.split('·')[0].trim());
    expect(kinds).toContain('entry');
    expect(kinds).toContain('loop');
    expect(kinds?.filter((k) => k === 'branch').length).toBe(2);
    expect(kinds?.filter((k) => k === 'return').length).toBe(2);
    expect(kinds).toContain('exit');

    // 边 label：循环三件套
    const labels = edges.map((e) => e.label).filter(Boolean);
    expect(labels).toContain('进入');
    expect(labels).toContain('重复');
    expect(labels).toContain('结束');
    expect(labels).toContain('是');
    expect(labels).toContain('否');

    // 形状语义
    const shapeOf = (kind: string) =>
      nodes.find((n) => n.description?.startsWith(kind))?.style?.shape;
    expect(shapeOf('branch')).toBe('diamond');
    expect(shapeOf('loop')).toBe('hexagon');
    expect(shapeOf('entry')).toBe('circle');

    // 分支条件原文
    const branchLabels = nodes.filter((n) => n.style?.shape === 'diamond').map((n) => n.label);
    expect(branchLabels.some((l) => l?.includes('total > limit'))).toBe(true);

    // 循环体节点 col=1（布局列偏移）
    const loopBody = nodes.filter((n) => n.style?.shape === 'diamond' && n.label?.includes('it == ""'));
    expect(loopBody.length).toBe(1);
    expect(r.nodes_created).toBe(nodes.length);
    expect(r.edges_created).toBe(edges.length);
    expect(r.truncated).toBe(false);
    expect(r.dead_code).toBe(false);
  });

  it('TS：if-else 双分支 + while 循环', async () => {
    const fp = writeFixture('g.ts', TS_FIXTURE);
    setup('f2', fp);

    await deriveAlgorithm({ feature: 'f2', node_id: 'host', function: 'grade' });
    const dsl = getDSL('f2')!;
    const nodes = dsl.geometry.nodes.filter((n) => n.id.startsWith('host__alg_'));
    const edges = (dsl.geometry.edges ?? []).filter((e) => e.id.startsWith('host__alge_'));

    // if-else：'是' 与 '否' 都有实体分支入口
    const branch = nodes.find((n) => n.style?.shape === 'diamond');
    const branchId = branch!.id;
    const outEdges = edges.filter((e) => e.from === branchId);
    expect(outEdges.map((e) => e.label).sort()).toEqual(['否', '是']);

    // while 循环存在
    const loop = nodes.find((n) => n.style?.shape === 'hexagon');
    expect(loop?.label).toContain('while');

    // else 分支（label = 'fail'）挂在 col=1
    const elseStep = nodes.find((n) => n.label?.includes("'fail'"));
    expect(elseStep).toBeTruthy();
  });

  it('Python：elif 链 + for 循环', async () => {
    const fp = writeFixture('c.py', PY_FIXTURE);
    setup('f3', fp);

    await deriveAlgorithm({ feature: 'f3', node_id: 'host', function: 'classify' });
    const dsl = getDSL('f3')!;
    const nodes = dsl.geometry.nodes.filter((n) => n.id.startsWith('host__alg_'));

    // elif → 两个 branch 节点（x>100 与 x>10）
    const branches = nodes.filter((n) => n.style?.shape === 'diamond');
    expect(branches.length).toBe(2);
    expect(branches.some((b) => b.label?.includes('x > 10'))).toBe(true);

    // for 循环
    expect(nodes.some((n) => n.style?.shape === 'hexagon')).toBe(true);
  });

  it('连续普通语句合并为单个 step', async () => {
    const fp = writeFixture('s.go', `package demo
func Batch() int {
	a := 1
	b := 2
	c := a + b
	return c
}
`);
    setup('f4', fp);

    await deriveAlgorithm({ feature: 'f4', node_id: 'host', function: 'Batch' });
    const dsl = getDSL('f4')!;
    const steps = dsl.geometry.nodes.filter(
      (n) => n.id.startsWith('host__alg_') && n.description?.startsWith('step'),
    );
    expect(steps.length).toBe(1);
    expect(steps[0].label).toContain('等 3 条');
  });

  it('深度截断：max_depth=1 折叠内层嵌套', async () => {
    const fp = writeFixture('d.go', NESTED_GO);
    setup('f5', fp);

    const r = await deriveAlgorithm({ feature: 'f5', node_id: 'host', function: 'Deep', max_depth: 1 });
    expect(r.truncated).toBe(true);
    const dsl = getDSL('f5')!;
    const folded = dsl.geometry.nodes.find((n) => n.label?.includes('嵌套逻辑'));
    expect(folded).toBeTruthy();

    // 默认 depth=3 时不截断
    const r2 = await deriveAlgorithm({ feature: 'f5', node_id: 'host', function: 'Deep' });
    expect(r2.truncated).toBe(false);
  });

  it('dead code 检测并报告', async () => {
    const fp = writeFixture('e.go', DEAD_GO);
    setup('f6', fp);

    const r = await deriveAlgorithm({ feature: 'f6', node_id: 'host', function: 'Early' });
    expect(r.dead_code).toBe(true);
    expect(r.message).toContain('不可达');
  });

  it('幂等重跑：节点数不变，无重复 id', async () => {
    const fp = writeFixture('demo.go', GO_FIXTURE);
    setup('f7', fp);

    const r1 = await deriveAlgorithm({ feature: 'f7', node_id: 'host', function: 'Process' });
    const r2 = await deriveAlgorithm({ feature: 'f7', node_id: 'host', function: 'Process' });
    expect(r2.nodes_created).toBe(r1.nodes_created);

    const dsl = getDSL('f7')!;
    const ids = dsl.geometry.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('continue 回连循环头、break 接到循环出口，无顺序出边', async () => {
    const fp = writeFixture('cb.go', `package demo

func Scan(items []int, stop int) int {
	total := 0
	for _, v := range items {
		if v < 0 {
			continue
		}
		if v == stop {
			break
		}
		total += v
	}
	return total
}
`);
    setup('f9', fp);

    await deriveAlgorithm({ feature: 'f9', node_id: 'host', function: 'Scan' });
    const dsl = getDSL('f9')!;
    const nodes = dsl.geometry.nodes.filter((n) => n.id.startsWith('host__alg_'));
    const edges = (dsl.geometry.edges ?? []).filter((e) => e.id.startsWith('host__alge_'));

    const loop = nodes.find((n) => n.style?.shape === 'hexagon')!;
    const cont = nodes.find((n) => n.label === 'continue')!;
    const brk = nodes.find((n) => n.label === 'break')!;

    // continue → 循环头（label 继续），且无其他出边
    const contOut = edges.filter((e) => e.from === cont.id);
    expect(contOut.length).toBe(1);
    expect(contOut[0].to).toBe(loop.id);
    expect(contOut[0].label).toBe('继续');

    // break → 循环之后的节点（label 中断）
    const brkOut = edges.filter((e) => e.from === brk.id);
    expect(brkOut.length).toBe(1);
    expect(brkOut[0].label).toBe('中断');
    expect(brkOut[0].to).not.toBe(loop.id);

    // Go for 头文本完整（不被 := 的冒号截断）
    expect(loop.label).toContain('range items');
  });

  it('错误：函数不存在 / 节点不存在', async () => {
    const fp = writeFixture('demo.go', GO_FIXTURE);
    setup('f8', fp);

    await expect(
      deriveAlgorithm({ feature: 'f8', node_id: 'host', function: 'NoSuch' }),
    ).rejects.toThrow('NoSuch');
    await expect(
      deriveAlgorithm({ feature: 'f8', node_id: 'ghost', function: 'Process' }),
    ).rejects.toThrow('ghost');
  });
});
