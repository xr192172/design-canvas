/**
 * analyze_monolith 工具测试（跨文件功能社区圈定，基于 cache.db 调用边 + 功能锚点）
 *
 * 覆盖场景：
 * - scoreAnchors：命名/导出/入度三信号的锚点资格判定
 * - labelPropagation：锚点带权沿调用边传染，功能聚一起不被切碎
 * - analyzeMonolith 集成：跨文件同一功能聚一起；多社区文件 → 拆分候选；社区间依赖边
 * - 空缓存：优雅降级
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb, type Database } from '../../src/db/db';
import {
  analyzeMonolith,
  assessCommunitySubSplit,
  buildCallGraphFromCache,
  scoreAnchors,
  labelPropagation,
} from '../../src/tools/analyze_monolith';

let root: string;
let db: Database | null = null;

function mkProject(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'analyze_monolith_'));
  fs.mkdirSync(path.join(root, '.design-canvas'), { recursive: true });
  return root;
}

/** 建缓存 db 并插入函数节点 + 文件节点 + 调用边（edges 唯一索引：同 source→target 只插一次） */
function seedDb(
  files: Array<{ path: string; lines: number }>,
  funcs: Array<{ id: string; name: string; file: string; start: number; end: number }>,
  calls: Array<[string, string]>,
): void {
  db = openDb(path.join(root, '.design-canvas', 'cache.db'));
  for (const f of files) {
    db.prepare(
      "INSERT INTO nodes(id, kind, name, qualified_name, file_path, language, start_line, end_line, updated_at) VALUES (?, 'file', ?, ?, ?, 'go', 1, ?, ?)",
    ).run(f.path, path.basename(f.path), f.path, f.path, f.lines, Date.now());
  }
  const ins = db.prepare(
    "INSERT INTO nodes(id, kind, name, qualified_name, file_path, language, start_line, end_line, updated_at) VALUES (?, 'function', ?, ?, ?, 'go', ?, ?, ?)",
  );
  for (const fn of funcs) {
    // qualified_name 用纯符号名（真实缓存为 parent.name 或 name，不含文件前缀），
    // 否则 ownerOf 会从含 '#' 的 qn 误提取 owner，触发类型锚定把符号钉死成单一社区
    ins.run(fn.id, fn.name, fn.name, fn.file, fn.start, fn.end, Date.now());
  }
  const insEdge = db.prepare(
    "INSERT INTO edges(source, target, kind, line, col, metadata) VALUES (?, ?, 'call', 1, NULL, NULL)",
  );
  for (const [src, tgt] of calls) insEdge.run(src, tgt);
  db.close();
  db = null;
}

beforeEach(() => {
  mkProject();
});
afterEach(() => {
  if (db) {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
    db = null;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────
// scoreAnchors：锚点信号判定
// ─────────────────────────────────────────────────────────────

describe('scoreAnchors', () => {
  it('命名命中 / Go 大写导出 → 锚点；纯高入度(≥3)无语义命名 → 非锚点；普通函数非锚点', () => {
    seedDb(
      [{ path: 'f1.go', lines: 100 }],
      [
        { id: 'f1.go#Compose', name: 'Compose', file: 'f1.go', start: 1, end: 10 },
        { id: 'f1.go#userService', name: 'userService', file: 'f1.go', start: 12, end: 20 },
        { id: 'f1.go#helperA', name: 'helperA', file: 'f1.go', start: 22, end: 30 },
        { id: 'f1.go#hot', name: 'hot', file: 'f1.go', start: 32, end: 40 },
        { id: 'f1.go#s1', name: 's1', file: 'f1.go', start: 42, end: 50 },
        { id: 'f1.go#s2', name: 's2', file: 'f1.go', start: 52, end: 60 },
        { id: 'f1.go#s3', name: 's3', file: 'f1.go', start: 62, end: 70 },
      ],
      [
        ['f1.go#Compose', 'f1.go#helperA'],
        ['f1.go#s1', 'f1.go#hot'],
        ['f1.go#s2', 'f1.go#hot'],
        ['f1.go#s3', 'f1.go#hot'],
      ],
    );
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    const { funcs, graph } = buildCallGraphFromCache(db);
    db.close();
    const scored = scoreAnchors(funcs, graph);
    const anchorNames = new Set(scored.filter((s) => s.anchor).map((s) => funcs[s.idx].name));
    // Compose: 大写导出；userSvc: Service 命名 → 锚点
    expect(anchorNames.has('Compose')).toBe(true);
    expect(anchorNames.has('userService')).toBe(true);
    // hot: 入度3=最高档，但无语义命名（纯 hub 工具函数）→ 不授予锚点资格
    expect(anchorNames.has('hot')).toBe(false);
    // helperA: 入度≤2、非命名、非导出 → 非锚点
    expect(anchorNames.has('helperA')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// labelPropagation：锚点传染圈社区
// ─────────────────────────────────────────────────────────────

describe('labelPropagation', () => {
  it('同一功能互调函数被锚点拉进同一社区，不被切碎', () => {
    seedDb(
      [{ path: 'f1.go', lines: 100 }],
      [
        { id: 'f1.go#Compose', name: 'Compose', file: 'f1.go', start: 1, end: 10 },
        { id: 'f1.go#helperA', name: 'helperA', file: 'f1.go', start: 12, end: 20 },
        { id: 'f1.go#helperB', name: 'helperB', file: 'f1.go', start: 22, end: 30 },
      ],
      [
        ['f1.go#Compose', 'f1.go#helperA'],
        ['f1.go#Compose', 'f1.go#helperB'],
        ['f1.go#helperA', 'f1.go#helperB'],
      ],
    );
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    const { funcs, graph } = buildCallGraphFromCache(db);
    db.close();
    const scored = scoreAnchors(funcs, graph);
    const anchors = scored.filter((s) => s.anchor);
    // 仅 Compose 是锚点（helperA/B 入度2 非锚点）
    expect(anchors.length).toBe(1);
    const groups = labelPropagation(funcs, graph, anchors, 12);
    // 单社区：3 个符号全聚一起
    expect(groups.size).toBe(1);
    expect([...groups.values()][0].length).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────
// analyzeMonolith 集成
// ─────────────────────────────────────────────────────────────

describe('analyzeMonolith', () => {
  it('跨文件同一功能聚一起；多社区文件 → 拆分候选', () => {
    seedDb(
      [
        { path: 'f1.go', lines: 50 },
        { path: 'f2.go', lines: 50 },
      ],
      [
        { id: 'f1.go#Compose', name: 'Compose', file: 'f1.go', start: 1, end: 10 },
        { id: 'f1.go#helperA', name: 'helperA', file: 'f1.go', start: 12, end: 20 },
        { id: 'f2.go#userSvc', name: 'userSvc', file: 'f2.go', start: 1, end: 10 },
        { id: 'f2.go#parseUser', name: 'parseUser', file: 'f2.go', start: 12, end: 20 },
        { id: 'f2.go#depTarget', name: 'depTarget', file: 'f2.go', start: 22, end: 30 },
      ],
      [
        ['f1.go#Compose', 'f1.go#helperA'],
        ['f1.go#Compose', 'f2.go#depTarget'], // 跨文件：depTarget 归 Compose 功能
        ['f2.go#userSvc', 'f2.go#parseUser'],
      ],
    );
    const result = analyzeMonolith({ project_dir: root, warn_lines: 10 });
    // 社区数 2：Compose 社区(f1 的 Compose/helperA + f2 的 depTarget) + userSvc 社区
    expect(result.community_count).toBe(2);
    const composeComm = result.communities.find((c) => c.symbols.includes('f1.go#Compose'))!;
    // 跨文件同一功能聚一起：depTarget 在 f2.go 却属 Compose 社区
    expect(composeComm.symbols).toContain('f2.go#depTarget');
    expect(composeComm.files).toContain('f2.go');
    // f2.go 是拆分候选（同时含 userSvc 社区 + Compose 社区的 depTarget）
    expect(result.split_candidates).toContain('f2.go');
  });

  it('社区间依赖边：一个社区调用另一社区成员', () => {
    seedDb(
      [
        { path: 'f1.go', lines: 50 },
        { path: 'f2.go', lines: 50 },
      ],
      [
        { id: 'f1.go#Compose', name: 'Compose', file: 'f1.go', start: 1, end: 10 },
        { id: 'f1.go#helperA', name: 'helperA', file: 'f1.go', start: 12, end: 20 },
        { id: 'f2.go#userSvc', name: 'userSvc', file: 'f2.go', start: 1, end: 10 },
        { id: 'f2.go#parseUser', name: 'parseUser', file: 'f2.go', start: 12, end: 20 },
      ],
      [
        ['f1.go#Compose', 'f1.go#helperA'],
        ['f2.go#userSvc', 'f2.go#parseUser'],
        ['f1.go#Compose', 'f2.go#parseUser'], // 跨社区：Compose 调 userSvc 社区成员
      ],
    );
    const result = analyzeMonolith({ project_dir: root });
    // parseUser 被 userSvc(命名锚点,强) 与 Compose(导出,弱) 调 → 归 userSvc 社区
    const composeComm = result.communities.find((c) => c.symbols.includes('f1.go#Compose'))!;
    const userComm = result.communities.find((c) => c.symbols.includes('f2.go#userSvc'))!;
    expect(userComm.symbols).toContain('f2.go#parseUser');
    // 依赖边：Compose 社区 → userSvc 社区
    const dep = result.dependencies.find(([a, b]) => a === composeComm.id && b === userComm.id);
    expect(dep).toBeDefined();
    if (dep) expect(dep[2]).toBeGreaterThanOrEqual(1);
  });

  it('多社区均衡度门槛：1主导社区+零星尾随社区 → 默认不列为拆分候选', () => {
    // main.go：process 社区 9 个符号（主导），toolSetup 社区仅 1 个符号（尾随，1/10=10% < 20%）
    seedDb(
      [{ path: 'main.go', lines: 50 }],
      [
        { id: 'main.go#process', name: 'process', file: 'main.go', start: 1, end: 10 },
        { id: 'main.go#step1', name: 'step1', file: 'main.go', start: 12, end: 20 },
        { id: 'main.go#step2', name: 'step2', file: 'main.go', start: 22, end: 30 },
        { id: 'main.go#step3', name: 'step3', file: 'main.go', start: 32, end: 40 },
        { id: 'main.go#step4', name: 'step4', file: 'main.go', start: 42, end: 50 },
        { id: 'main.go#step5', name: 'step5', file: 'main.go', start: 52, end: 60 },
        { id: 'main.go#step6', name: 'step6', file: 'main.go', start: 62, end: 70 },
        { id: 'main.go#step7', name: 'step7', file: 'main.go', start: 72, end: 80 },
        { id: 'main.go#step8', name: 'step8', file: 'main.go', start: 82, end: 90 },
        { id: 'main.go#toolSetup', name: 'toolSetup', file: 'main.go', start: 92, end: 100 },
      ],
      [
        ['main.go#process', 'main.go#step1'],
        ['main.go#process', 'main.go#step2'],
        ['main.go#process', 'main.go#step3'],
        ['main.go#process', 'main.go#step4'],
        ['main.go#process', 'main.go#step5'],
        ['main.go#process', 'main.go#step6'],
        ['main.go#process', 'main.go#step7'],
        ['main.go#process', 'main.go#step8'],
      ],
    );
    // toolSetup 无调用边 → 自成孤岛社区（1 符号），process 社区 9 符号
    const result = analyzeMonolith({ project_dir: root, warn_lines: 10 });
    // 默认门槛 0.2：toolSetup 占 10% < 20% → 仅 process 一个实质社区 → 不列为候选
    expect(result.split_candidates).not.toContain('main.go');
  });

  it('多社区均衡度门槛：调低比例后 2 个实质社区 → 列为拆分候选', () => {
    seedDb(
      [{ path: 'main.go', lines: 50 }],
      [
        { id: 'main.go#process', name: 'process', file: 'main.go', start: 1, end: 10 },
        { id: 'main.go#step1', name: 'step1', file: 'main.go', start: 12, end: 20 },
        { id: 'main.go#step2', name: 'step2', file: 'main.go', start: 22, end: 30 },
        { id: 'main.go#step3', name: 'step3', file: 'main.go', start: 32, end: 40 },
        { id: 'main.go#step4', name: 'step4', file: 'main.go', start: 42, end: 50 },
        { id: 'main.go#step5', name: 'step5', file: 'main.go', start: 52, end: 60 },
        { id: 'main.go#step6', name: 'step6', file: 'main.go', start: 62, end: 70 },
        { id: 'main.go#step7', name: 'step7', file: 'main.go', start: 72, end: 80 },
        { id: 'main.go#step8', name: 'step8', file: 'main.go', start: 82, end: 90 },
        { id: 'main.go#toolSetup', name: 'toolSetup', file: 'main.go', start: 92, end: 100 },
      ],
      [
        ['main.go#process', 'main.go#step1'],
        ['main.go#process', 'main.go#step2'],
        ['main.go#process', 'main.go#step3'],
        ['main.go#process', 'main.go#step4'],
        ['main.go#process', 'main.go#step5'],
        ['main.go#process', 'main.go#step6'],
        ['main.go#process', 'main.go#step7'],
        ['main.go#process', 'main.go#step8'],
      ],
    );
    // 门槛降到 0.05：toolSetup 占 10% ≥ 5% → 2 个实质社区 → 列为候选
    const result = analyzeMonolith({ project_dir: root, warn_lines: 10, min_community_share: 0.05 });
    expect(result.split_candidates).toContain('main.go');
  });

  it('空缓存 → 优雅降级提示先建索引', () => {
    // 不 seed，直接分析（openDb 会建空库）
    const result = analyzeMonolith({ project_dir: root });
    expect(result.community_count).toBe(0);
    expect(result.message).toContain('无函数/方法符号');
  });
});

// ─────────────────────────────────────────────────────────────
// assessCommunitySubSplit：社区内子拆分评估（P3）
// ─────────────────────────────────────────────────────────────

describe('assessCommunitySubSplit', () => {
  // 构造带 owner 的 funcs（TS 类方法：parent 已填）与一个社区
  function fixture(): { funcs: Parameters<typeof assessCommunitySubSplit>[0]; communities: Parameters<typeof assessCommunitySubSplit>[1] } {
    const mk = (id: string, owner: string): FuncNodeLike => ({
      id,
      name: id.split('#').pop()!,
      qualified_name: `${owner}.${id.split('#').pop()}`,
      file: `${id.split('#')[0]}.go`,
      start_line: 1,
      end_line: 10,
      owner,
    });
    const funcs = [
      // TypeA 3 个方法
      mk('f1.go#A1', 'TypeA'),
      mk('f1.go#A2', 'TypeA'),
      mk('f1.go#A3', 'TypeA'),
      // TypeB 3 个方法
      mk('f1.go#B1', 'TypeB'),
      mk('f1.go#B2', 'TypeB'),
      mk('f1.go#B3', 'TypeB'),
      // 顶层函数（无 owner，不应参与类型单元）
      { id: 'f1.go#top', name: 'top', qualified_name: 'top', file: 'f1.go', start_line: 1, end_line: 10 },
    ];
    const communities = [
      {
        id: 0,
        name: 'Feature',
        anchors: [],
        symbols: funcs.map((f) => f.id),
        files: ['f1.go'],
        est_lines: 50,
        symbol_count: funcs.length,
      },
    ];
    return { funcs, communities };
  }

  it('社区内 ≥2 个实质类型单元且组间耦合低 → 建议再拆', () => {
    const { funcs, communities } = fixture();
    // TypeA 与 TypeB 之间无调用边（完全独立）
    const callRows = [
      { source: 'f1.go#A1', target: 'f1.go#A2' },
      { source: 'f1.go#B1', target: 'f1.go#B2' },
    ];
    const res = assessCommunitySubSplit(funcs, communities, callRows);
    expect(res).toHaveLength(1);
    const r = res[0];
    expect(r.splittable).toBe(true);
    expect(r.groups).toHaveLength(2);
    expect(r.groups.map((g) => g.owner).sort()).toEqual(['TypeA', 'TypeB']);
    expect(r.cross_group_ratio).toBe(0);
  });

  it('组间耦合高（跨组调用占比超阈值）→ 保持凝聚不拆', () => {
    const { funcs, communities } = fixture();
    // TypeA 方法调用 TypeB 方法（跨组，占比高）
    const callRows = [
      { source: 'f1.go#A1', target: 'f1.go#B1' },
      { source: 'f1.go#A2', target: 'f1.go#B2' },
      { source: 'f1.go#A3', target: 'f1.go#B3' },
    ];
    const res = assessCommunitySubSplit(funcs, communities, callRows);
    expect(res).toHaveLength(1);
    expect(res[0].splittable).toBe(false);
    expect(res[0].cross_group_ratio).toBe(1);
  });

  it('社区内仅 1 个实质类型单元 → 不拆', () => {
    const { funcs, communities } = fixture();
    // 去掉 TypeB 成员，只剩 TypeA 一个实质单元
    const funcs2 = funcs.filter((f) => f.owner !== 'TypeB');
    const comm2 = [
      { ...communities[0], symbols: funcs2.map((f) => f.id), symbol_count: funcs2.length },
    ];
    const res = assessCommunitySubSplit(funcs2, comm2, []);
    expect(res[0].splittable).toBe(false);
    expect(res[0].groups).toHaveLength(1);
  });

  it('社区内无类型单元（纯顶层函数）→ 不拆', () => {
    const funcs = [
      { id: 'f1.go#top', name: 'top', qualified_name: 'top', file: 'f1.go', start_line: 1, end_line: 10 },
    ];
    const comm = [{ id: 0, name: 'X', anchors: [], symbols: ['f1.go#top'], files: ['f1.go'], est_lines: 10, symbol_count: 1 }];
    const res = assessCommunitySubSplit(funcs, comm, []);
    expect(res[0].splittable).toBe(false);
    expect(res[0].note).toContain('无类型单元');
  });
});

// 用于测试的最小函数节点形状
interface FuncNodeLike {
  id: string;
  name: string;
  qualified_name: string;
  file: string;
  start_line: number;
  end_line: number;
  owner?: string;
}