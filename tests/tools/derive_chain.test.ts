/**
 * derive_detail_chain 工具测试（D2 变形链推导）
 *
 * 覆盖场景：
 * - Go 文件：入口自动推导 + DFS 调用链排序 + 参数/返回类型 → shapes
 * - Go 参数共享类型（a, b int）+ context.Context 滤除 + error 返回滤除
 * - Go 命名多返回值 → object properties
 * - TS 文件：name: type 参数 + Promise<T> 解包 + T[] 数组
 * - Python 文件：list[T] 数组 + 无注解参数降级
 * - 幂等重跑：旧 derived 节点/边清理重建
 * - max_steps 截断 + skipped 名单
 * - 显式 entry 覆盖自动推导
 * - 错误：node 不存在 / 源文件缺失 / 无可用函数
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { deriveDetailChain } from '../../src/tools/derive_chain';
import { createFeature } from '../../src/tools/feature_ops';
import { addNode } from '../../src/tools/node_ops';
import { addFile } from '../../src/tools/file_ops';
import { clearAllFeatures, getDSL, getLiveDslFile } from '../../src/storage';

// ─────────────────────────────────────────────────────────────
// fixtures
// ─────────────────────────────────────────────────────────────

let tmpDir: string;

function writeFixture(name: string, content: string): string {
  const p = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

const GO_FIXTURE = `package compose

import "context"

type Section struct { ID string }
type Composition struct { Text string }

func Compose(ctx context.Context, sections []Section, tokenBudget int) (Composition, error) {
	used, over := checkBudget(sections, tokenBudget)
	if over {
		return Composition{}, ErrOverBudget
	}
	text := assemble(sections, used)
	helperUnused(1, 2)
	return text, nil
}

func checkBudget(sections []Section, budget int) (used int, over bool) {
	return 0, false
}

func assemble(sections []Section, budget int) Composition {
	return Composition{}
}

func helperUnused(a, b int) int {
	return a + b
}
`;

const TS_FIXTURE = `interface User { id: string; name: string }

async function loadUser(token: string, tags: string[]): Promise<User> {
  const raw = await verifyToken(token);
  return enrich(raw, tags);
}

function verifyToken(token: string): User {
  return { id: '1', name: 'x' };
}

function enrich(u: User, tags: string[]): User {
  return u;
}
`;

const PY_FIXTURE = `def compose(sections: list[str], budget: int) -> dict:
    checked = check(sections)
    return build(checked, budget)

def check(sections):
    return sections

def build(checked: list[str], budget: int) -> dict:
    return {}
`;

/** 建一个带宿主节点的 feature，返回宿主节点 id */
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
  // clearAllFeatures 只清 features/ 目录，活态文件也要清（getDSL 优先读它）
  const live = getLiveDslFile();
  if (fs.existsSync(live)) fs.unlinkSync(live);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'derive_chain_'));
});
afterEach(() => {
  clearAllFeatures();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────
// Go：主干链路
// ─────────────────────────────────────────────────────────────

describe('derive_detail_chain - Go', () => {
  it('入口自动推导 + DFS 调用链生成 detail 节点/边', async () => {
    writeFixture('compose.go', GO_FIXTURE);
    setupHost('f_go', 'compose.go');

    const result = await deriveDetailChain({ feature: 'f_go', node_id: 'host_node', project_root: tmpDir });

    // 链序 = DFS 调用序：Compose → checkBudget → assemble → helperUnused
    expect(result.chain.map((c) => c.name)).toEqual(['Compose', 'checkBudget', 'assemble', 'helperUnused']);
    expect(result.nodes_created).toBe(4);
    // 3 链边 + 2 跳边（Compose→assemble、Compose→helperUnused 非紧邻后继）
    expect(result.edges_created).toBe(5);

    const dsl = getDSL('f_go')!;
    const derived = dsl.geometry.nodes.filter((n) => n.host === 'host_node');
    expect(derived).toHaveLength(4);
    for (const n of derived) {
      expect(n.layer).toBe('detail');
      expect(n.id).toMatch(/^host_node__s\d+_/);
    }
    // 链边
    const chainEdges = dsl.geometry.edges.filter((e) => e.id.startsWith('host_node__chain_'));
    expect(chainEdges).toHaveLength(3);
    expect(chainEdges[0].layer).toBe('detail');
    expect(chainEdges[0].from).toContain('Compose');
    expect(chainEdges[0].to).toContain('checkBudget');
  });

  it('shapes 从签名推导：ctx 滤除、error 滤除、命名多返回包 object', async () => {
    writeFixture('compose.go', GO_FIXTURE);
    setupHost('f_go', 'compose.go');
    const result = await deriveDetailChain({ feature: 'f_go', node_id: 'host_node', project_root: tmpDir });
    const dsl = getDSL('f_go')!;
    const byName = new Map(result.chain.map((c) => [c.name, c.node_id]));

    const compose = dsl.geometry.nodes.find((n) => n.id === byName.get('Compose'))!;
    // context.Context 参数滤除；[]Section → array(object label Section)
    expect(compose.shapes?.in?.properties?.sections).toEqual({
      type: 'array',
      items: { type: 'object', label: 'Section' },
    });
    expect(compose.shapes?.in?.properties?.tokenBudget).toEqual({ type: 'integer' });
    expect(compose.shapes?.in?.properties?.ctx).toBeUndefined();
    // (Composition, error) → 滤 error → object label Composition
    expect(compose.shapes?.out).toEqual({ type: 'object', label: 'Composition' });

    // 命名多返回 (used int, over bool) → object properties
    const checkBudget = dsl.geometry.nodes.find((n) => n.id === byName.get('checkBudget'))!;
    expect(checkBudget.shapes?.out).toEqual({
      type: 'object',
      properties: { used: { type: 'integer' }, over: { type: 'boolean' } },
    });

    // 共享类型参数 a, b int → 两个 integer
    const helper = dsl.geometry.nodes.find((n) => n.id === byName.get('helperUnused'))!;
    expect(helper.shapes?.in?.properties?.a).toEqual({ type: 'integer' });
    expect(helper.shapes?.in?.properties?.b).toEqual({ type: 'integer' });
    expect(helper.shapes?.out).toEqual({ type: 'integer' });
  });

  it('不在主调用路径的函数进 skipped', async () => {
    const orphan = GO_FIXTURE + `\nfunc lonelyHelper(x string) string {\n\treturn x\n}\n`;
    writeFixture('compose.go', orphan);
    setupHost('f_go', 'compose.go');
    const result = await deriveDetailChain({ feature: 'f_go', node_id: 'host_node', project_root: tmpDir });
    expect(result.skipped).toContain('lonelyHelper');
    // 4 个入链（lonelyHelper 不进）
    expect(result.nodes_created).toBe(4);
  });

  it('显式 entry 覆盖自动推导', async () => {
    writeFixture('compose.go', GO_FIXTURE);
    setupHost('f_go', 'compose.go');
    const result = await deriveDetailChain({
      feature: 'f_go',
      node_id: 'host_node',
      project_root: tmpDir,
      entry: 'checkBudget',
    });
    expect(result.chain[0].name).toBe('checkBudget');
  });

  it('入口推导偏好最长调用链（跳过无调用的构造函数）', async () => {
    // 真实工程教训（ai-base summary_zone.go）：先入度 0 + 导出的构造函数无调用，
    // 真正的流水线入口在后面的方法上 → 应选链最长的候选
    const fixture = `package store

type Store struct{}

func NewStore(cap int) *Store {
	return &Store{}
}

func (s *Store) Process(items []string) string {
	valid := s.validate(items)
	return s.save(valid)
}

func (s *Store) validate(items []string) []string {
	return items
}

func (s *Store) save(items []string) string {
	return ""
}
`;
    writeFixture('store.go', fixture);
    setupHost('f_flat', 'store.go');
    const result = await deriveDetailChain({ feature: 'f_flat', node_id: 'host_node', project_root: tmpDir });
    expect(result.chain.map((c) => c.name)).toEqual(['Process', 'validate', 'save']);
    expect(result.skipped).toContain('NewStore');
  });

  it('扁平文件（函数互不调用）退化为单节点并给出提示', async () => {
    const fixture = `package flat

func Alpha(x int) int { return x }

func Beta(y string) string { return y }
`;
    writeFixture('flat.go', fixture);
    setupHost('f_flat2', 'flat.go');
    const result = await deriveDetailChain({ feature: 'f_flat2', node_id: 'host_node', project_root: tmpDir });
    expect(result.nodes_created).toBe(1);
    expect(result.message).toContain('扁平');
  });

  it('Go []byte 特判为可读字节串（非 integer 数组）', async () => {
    // 真实工程教训（ai-base media_replacer.go）：[]byte 推成 array<integer> 非开发者看不懂
    const fixture = `package media

func Process(data []byte) []byte {
	return decode(data)
}

func decode(data []byte) []byte {
	return data
}
`;
    writeFixture('media.go', fixture);
    setupHost('f_byte', 'media.go');
    const result = await deriveDetailChain({ feature: 'f_byte', node_id: 'host_node', project_root: tmpDir });
    const dsl = getDSL('f_byte')!;
    const proc = dsl.geometry.nodes.find((n) => n.id === result.chain[0].node_id)!;
    expect(proc.shapes?.in?.properties?.data).toEqual({ type: 'string', label: '字节串' });
    expect(proc.shapes?.out).toEqual({ type: 'string', label: '字节串' });
  });

  it('max_steps 截断：未入链但被主链调用的函数变 extra 分支节点（不再算 skipped）', async () => {
    writeFixture('compose.go', GO_FIXTURE);
    setupHost('f_go', 'compose.go');
    const result = await deriveDetailChain({ feature: 'f_go', node_id: 'host_node', project_root: tmpDir, max_steps: 2 });
    // 主链截断为 2：Compose、checkBudget；assemble/helperUnused 被 Compose 调用 → extra 分支节点
    expect(result.chain.map((c) => c.name)).toEqual(['Compose', 'checkBudget']);
    expect(result.nodes_created).toBe(4);
    expect(result.edges_created).toBe(3); // 1 链边 + 2 extra 分支边
    expect(result.skipped).toEqual([]);
    expect(result.branch.filter((b) => b.kind === 'extra').map((b) => b.name).sort()).toEqual(['assemble', 'helperUnused']);
  });

  it('幂等重跑：旧 derived 节点/边被清理重建', async () => {
    writeFixture('compose.go', GO_FIXTURE);
    setupHost('f_go', 'compose.go');
    await deriveDetailChain({ feature: 'f_go', node_id: 'host_node', project_root: tmpDir });
    const before = getDSL('f_go')!;
    const nodeCount = before.geometry.nodes.length;
    const edgeCount = before.geometry.edges.length;

    await deriveDetailChain({ feature: 'f_go', node_id: 'host_node', project_root: tmpDir });
    const after = getDSL('f_go')!;
    expect(after.geometry.nodes.length).toBe(nodeCount);
    expect(after.geometry.edges.length).toBe(edgeCount);
  });

  it('detail 节点布局在宿主下方一行（x 递增）', async () => {
    writeFixture('compose.go', GO_FIXTURE);
    setupHost('f_go', 'compose.go');
    await deriveDetailChain({ feature: 'f_go', node_id: 'host_node', project_root: tmpDir });
    const dsl = getDSL('f_go')!;
    const derived = dsl.geometry.nodes
      .filter((n) => n.host === 'host_node')
      .sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
    const host = dsl.geometry.nodes.find((n) => n.id === 'host_node')!;
    expect(derived[0].y!).toBeGreaterThan((host.y ?? 0) + (host.height ?? 60));
    for (let i = 1; i < derived.length; i++) {
      expect(derived[i].x!).toBeGreaterThan(derived[i - 1].x!);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// TypeScript
// ─────────────────────────────────────────────────────────────

describe('derive_detail_chain - TypeScript', () => {
  it('name: type 参数 + Promise<T> 解包 + T[] 数组', async () => {
    writeFixture('user.ts', TS_FIXTURE);
    setupHost('f_ts', 'user.ts');
    const result = await deriveDetailChain({ feature: 'f_ts', node_id: 'host_node', project_root: tmpDir });

    expect(result.chain.map((c) => c.name)).toEqual(['loadUser', 'verifyToken', 'enrich']);
    const dsl = getDSL('f_ts')!;
    const loadUser = dsl.geometry.nodes.find((n) => n.id.includes('loadUser'))!;
    expect(loadUser.shapes?.in?.properties?.token).toEqual({ type: 'string' });
    expect(loadUser.shapes?.in?.properties?.tags).toEqual({ type: 'array', items: { type: 'string' } });
    // Promise<User> 解包 → object label User
    expect(loadUser.shapes?.out).toEqual({ type: 'object', label: 'User' });
  });
});

// ─────────────────────────────────────────────────────────────
// Python
// ─────────────────────────────────────────────────────────────

describe('derive_detail_chain - Python', () => {
  it('list[T] → array + 无注解参数降级为任意', async () => {
    writeFixture('comp.py', PY_FIXTURE);
    setupHost('f_py', 'comp.py');
    const result = await deriveDetailChain({ feature: 'f_py', node_id: 'host_node', project_root: tmpDir });

    expect(result.chain.map((c) => c.name)).toEqual(['compose', 'check', 'build']);
    const dsl = getDSL('f_py')!;
    const compose = dsl.geometry.nodes.find((n) => n.id.includes('compose'))!;
    expect(compose.shapes?.in?.properties?.sections).toEqual({ type: 'array', items: { type: 'string' } });
    expect(compose.shapes?.in?.properties?.budget).toEqual({ type: 'integer' });
    const check = dsl.geometry.nodes.find((n) => n.id.includes('__s2_check'))!;
    // 无注解 → 类型未知但占位可渲染
    expect(check.shapes?.in?.properties?.sections).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────
// 错误处理
// ─────────────────────────────────────────────────────────────

describe('derive_detail_chain - 错误', () => {
  it('node 不存在 → 报错', async () => {
    createFeature({ feature: 'f_err' });
    await expect(
      deriveDetailChain({ feature: 'f_err', node_id: 'ghost', project_root: tmpDir }),
    ).rejects.toThrow(/不存在/);
  });

  it('源文件缺失 → 报错', async () => {
    setupHost('f_err2', 'not_exist.go');
    await expect(
      deriveDetailChain({ feature: 'f_err2', node_id: 'host_node', project_root: tmpDir }),
    ).rejects.toThrow(/不存在|无法读取/);
  });

  it('源文件无可解析函数 → 报错', async () => {
    writeFixture('empty.go', 'package x\n\nvar A = 1\n');
    setupHost('f_err3', 'empty.go');
    await expect(
      deriveDetailChain({ feature: 'f_err3', node_id: 'host_node', project_root: tmpDir }),
    ).rejects.toThrow(/函数|解析/);
  });

  it('source_path 显式指定优先于 semantic.files', async () => {
    const abs = writeFixture('direct.go', GO_FIXTURE);
    setupHost('f_direct'); // 无 semantic file
    const result = await deriveDetailChain({ feature: 'f_direct', node_id: 'host_node', source_path: abs });
    expect(result.nodes_created).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────
// AST 调用图 + 分支 + 跨文件标注（调用边接入渲染）
// ─────────────────────────────────────────────────────────────

const BRANCH_FIXTURE = `package branch

func Entry(items []string) string {
	a := stepA(items)
	if len(items) > 3 {
		return a + stepB(items)
	}
	return a
}

func stepA(items []string) string { return "a" }

func stepB(items []string) string { return "b" }

func orphan(x int) int { return x }
`;

describe('derive_detail_chain - AST 调用图 + 分支', () => {
  it('同调用者多分支：非紧邻后继画虚线跳边（谁调谁的图结构）', async () => {
    writeFixture('branch.go', BRANCH_FIXTURE);
    setupHost('f_branch', 'branch.go');
    const result = await deriveDetailChain({ feature: 'f_branch', node_id: 'host_node', project_root: tmpDir });

    // DFS 全遍历：Entry → stepA → stepB（stepA 无子调用）；orphan 无入边 → skipped
    expect(result.chain.map((c) => c.name)).toEqual(['Entry', 'stepA', 'stepB']);
    expect(result.skipped).toEqual(['orphan']);
    expect(result.nodes_created).toBe(3);
    expect(result.edges_created).toBe(3); // 2 链边 + 1 跳边（Entry→stepB）

    // 跳边：Entry → stepB（stepB 非 Entry 紧邻后继）
    const jumps = result.branch.filter((b) => b.kind === 'jump');
    expect(jumps).toHaveLength(1);
    expect(jumps[0].caller).toBe('Entry');
    expect(jumps[0].name).toBe('stepB');

    const dsl = getDSL('f_branch')!;
    const chainByQn = new Map(result.chain.map((c) => [c.name, c.node_id]));
    // 链上节点无 ·分支 标记；stepB 是链节点
    expect(dsl.geometry.nodes.find((n) => n.id === chainByQn.get('stepB'))!.label).not.toContain('·分支');
    // 跳边：虚线 + label 分支 + detail 层 + Entry → stepB
    const branchEdges = dsl.geometry.edges.filter((e) => e.id.startsWith('host_node__branch_'));
    expect(branchEdges).toHaveLength(1);
    expect(branchEdges[0].type).toBe('dashed');
    expect(branchEdges[0].label).toBe('分支');
    expect(branchEdges[0].layer).toBe('detail');
    expect(branchEdges[0].from).toBe(chainByQn.get('Entry'));
    expect(branchEdges[0].to).toBe(chainByQn.get('stepB'));
  });

  it('AST 精确性：局部闭包（非符号）不再被文本法误连为调用', async () => {
    // 文本法会把 x( 出现即连边；AST 级只认真实 call 节点且 callee 须为符号
    const fixture = `package precise

func Run(n int) int {
	// 注释里的 foo( 与字符串 "bar(" 都不应连边
	x := func(v int) int { return v * 2 }
	y := x(n)
	if y > 10 {
		return y
	}
	return n
}
`;
    writeFixture('precise.go', fixture);
    setupHost('f_precise', 'precise.go');
    const result = await deriveDetailChain({ feature: 'f_precise', node_id: 'host_node', project_root: tmpDir });
    // x 是局部闭包（不是符号）→ 不产生符号节点；链只有 Run 一个符号
    expect(result.chain.map((c) => c.name)).toEqual(['Run']);
    expect(result.nodes_created).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(result.branch).toEqual([]);
  });

  it('跨文件调用标注：cache.db 有 cross 边时节点 label 加 → 标记', async () => {
    writeFixture('branch.go', BRANCH_FIXTURE);
    setupHost('f_cross', 'branch.go');
    // 造项目缓存：tmpDir/.design-canvas/cache.db，插一条跨文件调用边（绕过外键）
    const { openDb } = await import('../../src/db/db');
    const db = openDb(path.join(tmpDir, '.design-canvas', 'cache.db'));
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(
      "INSERT INTO edges(source, target, kind, line, col, metadata) VALUES (?, ?, 'call', 6, NULL, ?)",
    ).run('branch.go#Entry', 'other.ts#OtherFn', JSON.stringify({ cross: true }));
    db.close();

    const result = await deriveDetailChain({ feature: 'f_cross', node_id: 'host_node', project_root: tmpDir });
    expect(result.cross_calls.length).toBe(1);
    expect(result.cross_calls[0].caller).toBe('Entry');
    expect(result.cross_calls[0].targets).toEqual(['other.ts#OtherFn']);

    const dsl = getDSL('f_cross')!;
    const entryNode = dsl.geometry.nodes.find((n) => n.id === result.chain[0].node_id)!;
    expect(entryNode.label).toContain('·→other.ts');
    expect(entryNode.description).toContain('other.ts#OtherFn');
  });

  it('无 cache.db 时跨文件标注静默跳过', async () => {
    writeFixture('branch.go', BRANCH_FIXTURE);
    setupHost('f_nocache', 'branch.go');
    const result = await deriveDetailChain({ feature: 'f_nocache', node_id: 'host_node', project_root: tmpDir });
    expect(result.cross_calls).toEqual([]);
    expect(result.nodes_created).toBe(3);
  });

  it('max_branches 限制跳边数量', async () => {
    const fixture = `package many

func Main() int {
	a := f1()
	b := f2()
	c := f3()
	return a + b + c
}

func f1() int { return 1 }
func f2() int { return 2 }
func f3() int { return 3 }
`;
    writeFixture('many.go', fixture);
    setupHost('f_many', 'many.go');
    const result = await deriveDetailChain({ feature: 'f_many', node_id: 'host_node', project_root: tmpDir, max_branches: 2 });
    // DFS 全遍历：Main → f1 → f2 → f3（链边 3）；跳边 Main→f2、Main→f3（非紧邻），截 2
    expect(result.chain.map((c) => c.name)).toEqual(['Main', 'f1', 'f2', 'f3']);
    expect(result.branch).toHaveLength(2);
    expect(result.branch.every((b) => b.kind === 'jump')).toBe(true);
    expect(result.skipped).toEqual([]);
    expect(result.nodes_created).toBe(4);
    expect(result.edges_created).toBe(5); // 3 链边 + 2 跳边
  });
});
