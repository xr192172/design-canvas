/**
 * derive_anim_flow 工具测试（路线图序号 14：调用链 + CFG → 动画流声明）
 *
 * 覆盖场景：
 * - 无 detail 节点时提示先跑 derive_detail_chain（skipped 全列，flows_added=0）
 * - 先跑 derive_detail_chain 再跑本工具：生成 L4 chain flows（handler 绑定调用方）
 * - 含 if 判定的函数生成 L3 branch flows（CFG 条件 → 分支，含 else 兜底）
 * - mock_values 从 shapes.in 生成（数值/布尔极端对）
 * - 幂等：保留手写 flows，只重建自身前缀 flows
 * - 错误：node 不存在 / 源文件缺失
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { deriveAnimFlow } from '../../src/tools/derive_anim_flow';
import { deriveDetailChain } from '../../src/tools/derive_chain';
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

/** Compose 含 if 判定（over 布尔）→ CFG 分支；checkBudget/assemble 无判定 */
const GO_FIXTURE = `package compose

type Section struct { ID string }
type Composition struct { Text string }

var ErrOverBudget = errors.New("over budget")

func Compose(sections []Section, over bool) (Composition, error) {
	used := checkBudget(sections)
	if over {
		return Composition{}, ErrOverBudget
	}
	text := assemble(sections, used)
	return text, nil
}

func checkBudget(sections []Section) int {
	if len(sections) == 0 {
		panic("empty sections")
	}
	return 0
}

func assemble(sections []Section, budget int) Composition {
	return Composition{}
}
`;

function setupHost(feature: string, withSemanticPath?: string): string {
  createFeature({ feature });
  addNode({ feature, node_id: 'host_node', label: '宿主文件节点', x: 100, y: 100, width: 200, height: 60 });
  if (withSemanticPath) {
    addFile({ feature, file_id: 'host_node', path: withSemanticPath, responsibility: '测试文件' });
  }
  return 'host_node';
}

beforeEach(() => {
  clearAllFeatures();
  const live = getLiveDslFile();
  if (fs.existsSync(live)) fs.unlinkSync(live);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'derive_anim_flow_'));
});
afterEach(() => {
  clearAllFeatures();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('derive_anim_flow - 依赖检查', () => {
  it('无 detail 节点时提示先跑 derive_detail_chain（flows_added=0，skipped 全列）', async () => {
    writeFixture('compose.go', GO_FIXTURE);
    setupHost('f_nodetail', 'compose.go');
    const result = await deriveAnimFlow({ feature: 'f_nodetail', node_id: 'host_node', project_root: tmpDir });
    expect(result.flows_added).toBe(0);
    expect(result.flows).toEqual([]);
    expect(result.skipped).toEqual(['Compose', 'checkBudget', 'assemble']);
    expect(result.message).toContain('derive_detail_chain');
  });
});

describe('derive_anim_flow - L4 chain + L3 branch 生成', () => {
  it('调用链相邻对生成 L4 chain flows，handler 绑定调用方函数', async () => {
    writeFixture('compose.go', GO_FIXTURE);
    setupHost('f_chain', 'compose.go');
    await deriveDetailChain({ feature: 'f_chain', node_id: 'host_node', project_root: tmpDir });
    const result = await deriveAnimFlow({ feature: 'f_chain', node_id: 'host_node', project_root: tmpDir });

    const chainFlows = result.flows.filter((f) => f.kind === 'chain');
    // 链：Compose → checkBudget → assemble → Compose → assemble（DFS 全遍历）
    expect(chainFlows.length).toBeGreaterThanOrEqual(2);

    const dsl = getDSL('f_chain')!;
    const flows = dsl.animations_v2!.flows!;
    // 每个 chain flow：handler.file_id = host node，api = 调用方函数名
    const firstChain = flows.find((f) => f.id.endsWith('chain_1'))!;
    expect(firstChain.handler?.file_id).toBe('host_node');
    expect(firstChain.handler?.api).toBe('Compose');
    expect(firstChain.trigger?.type).toBe('periodic');
    // from/to 引用 detail 节点 id
    const detailIds = dsl.geometry.nodes.filter((n) => n.host === 'host_node').map((n) => n.id);
    expect(detailIds).toContain(firstChain.from);
    expect(detailIds).toContain(firstChain.to);
  });

  it('含 if 判定的函数生成 L3 branch flows（CFG 条件 + else 兜底）', async () => {
    writeFixture('compose.go', GO_FIXTURE);
    setupHost('f_br', 'compose.go');
    await deriveDetailChain({ feature: 'f_br', node_id: 'host_node', project_root: tmpDir });
    const result = await deriveAnimFlow({ feature: 'f_br', node_id: 'host_node', project_root: tmpDir });

    const branchFlows = result.flows.filter((f) => f.kind === 'branch');
    // Compose（if over）+ checkBudget（if len）→ 2 个 branch flow
    expect(branchFlows.length).toBe(2);

    const dsl = getDSL('f_br')!;
    const flows = dsl.animations_v2!.flows!;
    const br = flows.find((f) => f.branches && f.branches.length > 0 && f.handler?.api === 'Compose')!;
    expect(br.id).toContain('flow_br_');
    expect(br.handler?.api).toBe('Compose');
    // 首个分支条件来自 CFG（over 判定），含 else 兜底
    expect(br.branches![0].condition).toContain('over');
    expect(br.branches![br.branches!.length - 1].condition).toBe('else');
    // from 指向 Compose 的 detail 节点
    const composeId = dsl.geometry.nodes.find((n) => n.host === 'host_node' && n.id.includes('Compose'))!.id;
    expect(br.from).toBe(composeId);
  });

  it('branch flow 生成 mock_values（从 shapes.in 数值/布尔取极端对）', async () => {
    writeFixture('compose.go', GO_FIXTURE);
    setupHost('f_mock', 'compose.go');
    await deriveDetailChain({ feature: 'f_mock', node_id: 'host_node', project_root: tmpDir });
    await deriveAnimFlow({ feature: 'f_mock', node_id: 'host_node', project_root: tmpDir });

    const dsl = getDSL('f_mock')!;
    const br = dsl.animations_v2!.flows!.find((f) => f.branches && f.handler?.api === 'Compose')!;
    expect(br.mock_values).toBeDefined();
    expect(br.mock_values!.length).toBe(2);
    // Compose 的 in 含 over(boolean) → 两态 false/true 覆盖两分支
    expect(br.mock_values![0].over).toBe(false);
    expect(br.mock_values![1].over).toBe(true);
  });
});

describe('derive_anim_flow - L4.5 异常声明', () => {
  it('Go 错误返回 ErrXxx → expected 异常声明，流向宿主节点', async () => {
    writeFixture('compose.go', GO_FIXTURE);
    setupHost('f_errgo', 'compose.go');
    await deriveDetailChain({ feature: 'f_errgo', node_id: 'host_node', project_root: tmpDir });
    await deriveAnimFlow({ feature: 'f_errgo', node_id: 'host_node', project_root: tmpDir });

    const dsl = getDSL('f_errgo')!;
    const br = dsl.animations_v2!.flows!.find((f) => f.branches && f.handler?.api === 'Compose')!;
    const errs = br.handler!.errors!;
    // Compose 的 `return Composition{}, ErrOverBudget` → expected
    const over = errs.find((e) => e.type === 'ErrOverBudget')!;
    expect(over.severity).toBe('expected');
    expect(over.to).toBe('host_node');
    expect(over.condition).toContain('ErrOverBudget');
    expect(over.effect).toBe('particle_red');
  });

  it('Go panic → unexpected 异常声明（critical 语义）', async () => {
    writeFixture('compose.go', GO_FIXTURE);
    setupHost('f_errpanic', 'compose.go');
    await deriveDetailChain({ feature: 'f_errpanic', node_id: 'host_node', project_root: tmpDir });
    await deriveAnimFlow({ feature: 'f_errpanic', node_id: 'host_node', project_root: tmpDir });

    const dsl = getDSL('f_errpanic')!;
    const br = dsl.animations_v2!.flows!.find((f) => f.branches && f.handler?.api === 'checkBudget')!;
    const panic = br.handler!.errors!.find((e) => e.type === 'panic')!;
    expect(panic.severity).toBe('unexpected');
    expect(panic.effect).toBe('node_flash_red');
    expect(panic.log).toBeTruthy();
  });

  it('消息汇总包含 L4.5 异常声明行', async () => {
    writeFixture('compose.go', GO_FIXTURE);
    setupHost('f_errmsg', 'compose.go');
    await deriveDetailChain({ feature: 'f_errmsg', node_id: 'host_node', project_root: tmpDir });
    const result = await deriveAnimFlow({ feature: 'f_errmsg', node_id: 'host_node', project_root: tmpDir });
    expect(result.message).toContain('L4.5 异常声明');
    expect(result.message).toContain('ErrOverBudget(expected)');
  });
});

describe('derive_anim_flow - 跨文件 L4 chain flow（序号 15）', () => {
  it('cache.db 有跨文件调用边时生成 cross flow，handler 绑定调用方，落宿主节点', async () => {
    writeFixture('compose.go', GO_FIXTURE);
    setupHost('f_crossff', 'compose.go');
    await deriveDetailChain({ feature: 'f_crossff', node_id: 'host_node', project_root: tmpDir });
    // 造项目缓存：tmpDir/.design-canvas/cache.db，插跨文件调用边（绕过外键）
    const { openDb } = await import('../../src/db/db');
    const db = openDb(path.join(tmpDir, '.design-canvas', 'cache.db'));
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(
      "INSERT INTO edges(source, target, kind, line, col, metadata) VALUES (?, ?, 'call', 6, NULL, ?)",
    ).run('compose.go#Compose', 'other.ts#OtherFn', JSON.stringify({ cross: true }));
    db.close();

    const result = await deriveAnimFlow({ feature: 'f_crossff', node_id: 'host_node', project_root: tmpDir });
    expect(result.cross_flows.length).toBe(1);
    expect(result.cross_flows[0].caller).toBe('Compose');
    expect(result.cross_flows[0].target).toBe('other.ts#OtherFn');
    expect(result.cross_flows[0].to).toBe('host_node');

    const dsl = getDSL('f_crossff')!;
    const cross = dsl.animations_v2!.flows!.find((f) => f.id.endsWith('cross_1'))!;
    expect(cross.handler?.api).toBe('Compose');
    expect(cross.handler?.file_id).toBe('host_node');
    expect(cross.to).toBe('host_node');
    expect(cross.value?.label).toContain('other.ts#OtherFn');
  });

  it('无 cache.db 时跨文件 flow 静默跳过（cross_flows 空）', async () => {
    writeFixture('compose.go', GO_FIXTURE);
    setupHost('f_nocrossdb', 'compose.go');
    await deriveDetailChain({ feature: 'f_nocrossdb', node_id: 'host_node', project_root: tmpDir });
    const result = await deriveAnimFlow({ feature: 'f_nocrossdb', node_id: 'host_node', project_root: tmpDir });
    expect(result.cross_flows).toEqual([]);
  });

  it('max_cross=0 关闭跨文件 flow，即使有 cache.db', async () => {
    writeFixture('compose.go', GO_FIXTURE);
    setupHost('f_crossoff', 'compose.go');
    await deriveDetailChain({ feature: 'f_crossoff', node_id: 'host_node', project_root: tmpDir });
    const { openDb } = await import('../../src/db/db');
    const db = openDb(path.join(tmpDir, '.design-canvas', 'cache.db'));
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(
      "INSERT INTO edges(source, target, kind, line, col, metadata) VALUES (?, ?, 'call', 6, NULL, ?)",
    ).run('compose.go#Compose', 'other.ts#OtherFn', JSON.stringify({ cross: true }));
    db.close();

    const result = await deriveAnimFlow({ feature: 'f_crossoff', node_id: 'host_node', project_root: tmpDir, max_cross: 0 });
    expect(result.cross_flows).toEqual([]);
    const dsl = getDSL('f_crossoff')!;
    expect(dsl.animations_v2!.flows!.some((f) => f.id.includes('cross_'))).toBe(false);
  });
});

describe('derive_anim_flow - 幂等', () => {
  it('保留手写 flows，只重建自身前缀 flows', async () => {
    writeFixture('compose.go', GO_FIXTURE);
    setupHost('f_idem', 'compose.go');
    await deriveDetailChain({ feature: 'f_idem', node_id: 'host_node', project_root: tmpDir });

    // 先手工写一个 flow
    const dsl0 = getDSL('f_idem')!;
    dsl0.animations_v2 = {
      version: 1,
      flows: [{ id: 'manual_flow', trigger: { type: 'periodic', interval: 1000 }, from: 'a', to: 'b' }],
    };
    // 无法直接 saveDSL 类型断言，用 getDSL 改后通过 deriveAnimFlow 触发保存？改用手动保存
    const { saveDSL } = await import('../../src/storage');
    saveDSL(dsl0);

    await deriveAnimFlow({ feature: 'f_idem', node_id: 'host_node', project_root: tmpDir });
    const dsl = getDSL('f_idem')!;
    const flows = dsl.animations_v2!.flows!;
    expect(flows.some((f) => f.id === 'manual_flow')).toBe(true); // 手写保留
    expect(flows.some((f) => f.id.startsWith('host_node__flow_'))).toBe(true); // 自动生成

    // 重跑：flows 数量不变（幂等）
    const before = flows.length;
    await deriveAnimFlow({ feature: 'f_idem', node_id: 'host_node', project_root: tmpDir });
    const after = getDSL('f_idem')!.animations_v2!.flows!.length;
    expect(after).toBe(before);
  });
});

describe('derive_anim_flow - 错误', () => {
  it('node 不存在 → 报错', async () => {
    createFeature({ feature: 'f_err' });
    await expect(deriveAnimFlow({ feature: 'f_err', node_id: 'ghost', project_root: tmpDir })).rejects.toThrow(/不存在/);
  });

  it('源文件缺失 → 报错', async () => {
    setupHost('f_err2', 'not_exist.go');
    await expect(deriveAnimFlow({ feature: 'f_err2', node_id: 'host_node', project_root: tmpDir })).rejects.toThrow(
      /不存在|无法读取/,
    );
  });
});