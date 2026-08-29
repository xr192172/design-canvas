/**
 * check_monolith 单元测试
 *
 * 覆盖：行数统计/阈值分档、声明归并（class 方法 / Go receiver）、
 * 引用图构建、Louvain 社区发现、命名建议、单文件端到端分析、
 * 预览 DSL 结构、checkMonolith 主入口（files 模式）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  countLines,
  assessLines,
  tokenizeName,
  suggestFileName,
  buildDeclUnits,
  buildReferenceGraph,
  symmetrize,
  louvain,
  analyzeFileContent,
  buildSplitPreviewDsl,
  checkMonolith,
} from '../../src/tools/monolith';
import type { ParsedSymbol } from '../../src/tools/ts_kernel/index';

// ─────────────────────────────────────────────────────────────
// D1 行数与阈值
// ─────────────────────────────────────────────────────────────

describe('countLines - 行数统计', () => {
  it('空串 0 行；单行 1 行', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('hello')).toBe(1);
  });

  it('多行（末尾有/无换行一致）', () => {
    expect(countLines('a\nb\nc')).toBe(3);
    expect(countLines('a\nb\nc\n')).toBe(3);
  });
});

describe('assessLines - 阈值分档', () => {
  it('默认 warn=500 crit=1000', () => {
    expect(assessLines(499)).toBe('ok');
    expect(assessLines(500)).toBe('warning');
    expect(assessLines(999)).toBe('warning');
    expect(assessLines(1000)).toBe('critical');
  });

  it('自定义阈值', () => {
    expect(assessLines(100, 50, 80)).toBe('critical');
  });
});

// ─────────────────────────────────────────────────────────────
// D4 命名
// ─────────────────────────────────────────────────────────────

describe('tokenizeName - 标识符拆词', () => {
  it('camelCase / PascalCase / snake_case', () => {
    expect(tokenizeName('parseConfig')).toEqual(['parse', 'config']);
    expect(tokenizeName('ParseYAML')).toEqual(['parse', 'yaml']);
    expect(tokenizeName('parse_env_file')).toEqual(['parse', 'env', 'file']);
  });
});

describe('suggestFileName - 社区命名建议', () => {
  it('最长公共前缀优先', () => {
    const taken = new Set<string>();
    const name = suggestFileName(['parseConfig', 'parseYaml', 'parseEnv'], '.py', taken, 'app.py');
    expect(name).toBe('parse.py');
  });

  it('无公共前缀时用高频 token', () => {
    const taken = new Set<string>();
    const name = suggestFileName(['renderHtml', 'renderSvg', 'exportPdf'], '.go', taken, 'main.go');
    expect(name).toBe('render.go');
  });

  it('与原文件冲突时追加序号', () => {
    const taken = new Set<string>();
    const name = suggestFileName(['parseA', 'parseB'], '.py', taken, 'parse.py');
    expect(name).toBe('parse_2.py');
  });

  it('停用词跳过，兜底 part_N', () => {
    const taken = new Set<string>();
    const name = suggestFileName(['utils', 'helpers'], '.ts', taken, 'index.ts');
    expect(name).toMatch(/^part(_\d+)?\.ts$/);
  });
});

// ─────────────────────────────────────────────────────────────
// D2 声明归并
// ─────────────────────────────────────────────────────────────

function sym(name: string, start: number, end: number, parent?: string, signature?: string): ParsedSymbol {
  return {
    name,
    kind: parent ? 'method' : 'function',
    start_line: start,
    end_line: end,
    qualified_name: parent ? `${parent}.${name}` : name,
    signature: signature ?? `${name}()`,
    parent,
  };
}

describe('buildDeclUnits - 顶层声明归并', () => {
  it('class 方法（parent 字段）并入宿主', () => {
    const units = buildDeclUnits([
      sym('UserService', 1, 50),
      sym('Create', 5, 15, 'UserService'),
      sym('Delete', 20, 30, 'UserService'),
      sym('main', 60, 70),
    ]);
    expect(units.map((u) => u.name)).toEqual(['UserService', 'main']);
    expect(units[0].members.map((m) => m.name)).toContain('Create');
    expect(units[0].members.map((m) => m.name)).toContain('Delete');
  });

  it('Go receiver 签名（Type.Method()）并入同名类型', () => {
    const units = buildDeclUnits([
      sym('UserService', 1, 10, undefined, 'UserService struct'),
      sym('Create', 12, 25, undefined, 'UserService.Create(name string) error'),
      sym('Delete', 27, 40, undefined, 'UserService.Delete(id int) error'),
      sym('main', 50, 60),
    ]);
    expect(units.map((u) => u.name).sort()).toEqual(['UserService', 'main']);
    expect(units.find((u) => u.name === 'UserService')!.members.length).toBe(3);
    expect(units.find((u) => u.name === 'UserService')!.end_line).toBe(40);
  });

  it('无宿主时保持独立单元', () => {
    const units = buildDeclUnits([sym('alpha', 1, 5), sym('beta', 10, 15)]);
    expect(units.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────
// D2 引用图
// ─────────────────────────────────────────────────────────────

describe('buildReferenceGraph - 声明体文本引用计数', () => {
  it('A 调用 B → w[A][B] ≥ 1；无调用 → 无边', () => {
    const content = [
      'def alpha():',      // 1
      '    return beta()', // 2
      '',                  // 3
      'def beta():',       // 4
      '    return 1',      // 5
      '',                  // 6
      'def gamma():',      // 7
      '    return 2',      // 8
    ].join('\n');
    const units = buildDeclUnits([
      sym('alpha', 1, 2),
      sym('beta', 4, 5),
      sym('gamma', 7, 8),
    ]);
    const adj = buildReferenceGraph(units, content);
    expect(adj[0].get(1)).toBe(1); // alpha → beta
    expect(adj[0].get(2)).toBeUndefined();
    expect(adj[1].size).toBe(0);
  });

  it('多次出现权重累加；短名（<3）跳过', () => {
    const content = [
      'def alpha():',
      '    x = beta() + beta()',
      'def beta():',
      '    return 1',
      'def ab():',
      '    return 0',
    ].join('\n');
    const units = buildDeclUnits([sym('alpha', 1, 2), sym('beta', 3, 4), sym('ab', 5, 6)]);
    const adj = buildReferenceGraph(units, content);
    expect(adj[0].get(1)).toBe(2);
    expect(adj[0].get(2)).toBeUndefined(); // 'ab' 只有 2 字符
  });
});

// ─────────────────────────────────────────────────────────────
// D3 Louvain
// ─────────────────────────────────────────────────────────────

describe('louvain - 社区发现', () => {
  it('空图 / 单节点', () => {
    expect(louvain([])).toEqual([]);
    expect(louvain([new Map()])).toEqual([0]);
  });

  it('两个紧密簇 + 弱桥 → 2 个社区', () => {
    // 簇 A: 0-1-2 全连接权重 10；簇 B: 3-4-5 全连接权重 10；桥 2-3 权重 1
    const n = 6;
    const adj: Array<Map<number, number>> = Array.from({ length: n }, () => new Map());
    const link = (a: number, b: number, w: number) => {
      adj[a].set(b, (adj[a].get(b) ?? 0) + w);
      adj[b].set(a, (adj[b].get(a) ?? 0) + w);
    };
    for (const [a, b] of [[0, 1], [0, 2], [1, 2]] as Array<[number, number]>) link(a, b, 10);
    for (const [a, b] of [[3, 4], [3, 5], [4, 5]] as Array<[number, number]>) link(a, b, 10);
    link(2, 3, 1);
    const comm = louvain(adj);
    expect(comm[0]).toBe(comm[1]);
    expect(comm[1]).toBe(comm[2]);
    expect(comm[3]).toBe(comm[4]);
    expect(comm[4]).toBe(comm[5]);
    expect(comm[0]).not.toBe(comm[3]);
  });

  it('全孤立节点 → 各自独立社区', () => {
    const comm = louvain([new Map(), new Map(), new Map()]);
    expect(new Set(comm).size).toBe(3);
  });

  it('完全图 K4 强连接 → 1 个社区', () => {
    // 注：对称环拆分/合并的模块度相同（Louvain 停在平分是正确行为），
    // 完全图任意平分都会降低模块度，必然合并为单簇。
    const adj: Array<Map<number, number>> = Array.from({ length: 4 }, () => new Map());
    for (let a = 0; a < 4; a++) {
      for (let b = a + 1; b < 4; b++) {
        adj[a].set(b, 5);
        adj[b].set(a, 5);
      }
    }
    const comm = louvain(adj);
    expect(new Set(comm).size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 端到端：analyzeFileContent
// ─────────────────────────────────────────────────────────────

/** 程序生成 300+ 行 Python 文件：parse_* 簇与 render_* 簇，簇内互调，簇间无调用 */
function makeMonolithPy(): string {
  const parts: string[] = [];
  const pad = (n: number) => Array.from({ length: n }, (_, i) => `    # 填充注释 ${i}`).join('\n');
  for (const name of ['parse_config', 'parse_yaml', 'parse_env']) {
    parts.push(`def ${name}():\n${pad(40)}\n    return parse_validate()\n`);
  }
  parts.push(`def parse_validate():\n${pad(40)}\n    return True\n`);
  for (const name of ['render_html', 'render_svg', 'render_pdf']) {
    parts.push(`def ${name}():\n${pad(40)}\n    return render_layout()\n`);
  }
  parts.push(`def render_layout():\n${pad(40)}\n    return True\n`);
  return parts.join('\n');
}

describe('analyzeFileContent - 单文件端到端', () => {
  it('行数正常 → ok，不跑 AST', async () => {
    const r = await analyzeFileContent('small.py', 'def a():\n    pass\n', 300, 600);
    expect(r.status).toBe('ok');
    expect(r.decl_count).toBe(0);
    expect(r.communities.length).toBe(0);
  });

  it('超阈值双簇文件 → 2 个社区 + 命名建议', async () => {
    const content = makeMonolithPy();
    expect(countLines(content)).toBeGreaterThan(300);
    const r = await analyzeFileContent('app.py', content, 300, 600);
    expect(r.status).toBe('warning');
    expect(r.decl_count).toBe(8);
    expect(r.communities.length).toBe(2);
    const names = r.communities.map((c) => c.suggested_name).sort();
    expect(names).toEqual(['parse.py', 'render.py']);
    // 每社区 4 个声明
    expect(r.communities.map((c) => c.decls.length).sort()).toEqual([4, 4]);
    // 簇间无引用 → 无跨社区边
    expect(r.inter_edges.length).toBe(0);
    expect(r.suggestion).toContain('2 个功能社区');
  });

  it('单簇内聚文件 → 1 社区，默认降级为 cohesive（不标红）', async () => {
    const pad = Array.from({ length: 30 }, (_, i) => `    # 填充 ${i}`).join('\n');
    // 注意：声明名必须 ≥3 字符（短名在引用匹配中被跳过，防误匹配）；
    // 星形强连接（alpha 为中心双向互调）——对称环拆分/合并模块度相同会退化，星形必然单簇。
    const content = [
      `def fn_alpha():\n${pad}\n    return fn_beta() + fn_gamma()\n`,
      `def fn_beta():\n${pad}\n    return fn_alpha()\n`,
      `def fn_gamma():\n${pad}\n    return fn_alpha()\n`,
      `def fn_delta():\n${pad}\n    return fn_alpha()\n`,
    ].join('\n');
    const r = await analyzeFileContent('cycle.py', content, 100, 600);
    expect(r.communities.length).toBe(1);
    expect(r.status).toBe('cohesive'); // 内聚守卫：大而不拆，不标红
    expect(r.suggestion).toContain('内聚');
    expect(r.suggestion).toContain('不构成拆分候选');
  });

  it('flagCohesive=false → 内聚大文件仍按体积标红（严格档）', async () => {
    const pad = Array.from({ length: 30 }, (_, i) => `    # 填充 ${i}`).join('\n');
    const content = [
      `def fn_alpha():\n${pad}\n    return fn_beta() + fn_gamma()\n`,
      `def fn_beta():\n${pad}\n    return fn_alpha()\n`,
      `def fn_gamma():\n${pad}\n    return fn_alpha()\n`,
      `def fn_delta():\n${pad}\n    return fn_alpha()\n`,
    ].join('\n');
    const r = await analyzeFileContent('cycle.py', content, 100, 600, false);
    expect(r.communities.length).toBe(1);
    expect(r.status).toBe('warning'); // 严格档：体积即标红
  });
});

// ─────────────────────────────────────────────────────────────
// D5 预览 DSL
// ─────────────────────────────────────────────────────────────

describe('buildSplitPreviewDsl - 拆分预览图结构', () => {
  it('容器 + 社区子节点 + contains 边 + 跨社区引用边', () => {
    const dsl = buildSplitPreviewDsl(
      'prev',
      [
        {
          path: 'src/app.py',
          lines: 700,
          status: 'critical',
          decl_count: 8,
          communities: [
            { suggested_name: 'parse.py', decls: ['a', 'b'], signatures: [], est_lines: 300, internal_refs: 5 },
            { suggested_name: 'render.py', decls: ['c', 'd'], signatures: [], est_lines: 320, internal_refs: 4 },
          ],
          inter_edges: [[0, 1, 2]],
          suggestion: '测试',
        },
      ],
      300,
      600,
    );
    const cont = dsl.geometry.nodes.find((n) => n.id.startsWith('mono_'))!;
    expect(cont).toBeDefined();
    const splits = dsl.geometry.nodes.filter((n) => n.type === 'file');
    expect(splits.length).toBe(2);
    const contains = (dsl.geometry.edges ?? []).filter((e) => e.label === 'contains');
    expect(contains.length).toBe(2);
    const xref = (dsl.geometry.edges ?? []).filter((e) => e.label?.startsWith('引用'));
    expect(xref.length).toBe(1);
    // 社区子节点必须位于容器内部（坐标包含关系）
    for (const s of splits) {
      expect(s.x!).toBeGreaterThan(cont.x!);
      expect(s.y!).toBeGreaterThan(cont.y!);
      expect(s.x! + s.width!).toBeLessThanOrEqual(cont.x! + cont.width! + 1);
      expect(s.y! + s.height!).toBeLessThanOrEqual(cont.y! + cont.height! + 1);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// D6 checkMonolith 主入口（files 模式）
// ─────────────────────────────────────────────────────────────

describe('checkMonolith - 主入口', () => {
  it('files 模式：混合健康/超标文件，仅报告超标', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monolith-'));
    const big = path.join(dir, 'big.py');
    const small = path.join(dir, 'small.py');
    fs.writeFileSync(big, makeMonolithPy(), 'utf-8');
    fs.writeFileSync(small, 'def a():\n    pass\n', 'utf-8');
    try {
      const r = await checkMonolith({ files: [big, small], warn_lines: 300, crit_lines: 600 });
      expect(r.total_files).toBe(2);
      expect(r.oversized).toBe(1);
      expect(r.reports[0].path).toBe('big.py');
      expect(r.reports[0].communities.length).toBe(2);
      expect(r.message).toContain('big.py');
      expect(r.message).not.toContain('small.py —');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('无输入模式 → 抛错', async () => {
    await expect(checkMonolith({})).rejects.toThrow('project_dir / feature / files');
  });

  it('全部健康 → oversized=0', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monolith-'));
    const f = path.join(dir, 'ok.py');
    fs.writeFileSync(f, 'def a():\n    pass\n', 'utf-8');
    try {
      const r = await checkMonolith({ files: [f] });
      expect(r.oversized).toBe(0);
      expect(r.message).toContain('无单文件化风险');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('大而内聚文件：默认不进 oversized，flag_cohesive=false 时进', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monolith-'));
    const f = path.join(dir, 'cohesive.py');
    const pad = Array.from({ length: 40 }, (_, i) => `    # 填充 ${i}`).join('\n');
    const content = [
      `def fn_alpha():\n${pad}\n    return fn_beta() + fn_gamma()\n`,
      `def fn_beta():\n${pad}\n    return fn_alpha()\n`,
      `def fn_gamma():\n${pad}\n    return fn_alpha()\n`,
      `def fn_delta():\n${pad}\n    return fn_alpha()\n`,
    ].join('\n');
    fs.writeFileSync(f, content, 'utf-8');
    try {
      // 默认：cohesive 降级，不进 oversized
      const relaxed = await checkMonolith({ files: [f], warn_lines: 100, crit_lines: 600 });
      expect(relaxed.oversized).toBe(0);
      expect(relaxed.message).toContain('大而内聚');
      // 严格档：flag_cohesive=false，体积即标红
      const strict = await checkMonolith({ files: [f], warn_lines: 100, crit_lines: 600, flag_cohesive: false });
      expect(strict.oversized).toBe(1);
      expect(strict.reports[0].status).toBe('warning');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────
// symmetrize
// ─────────────────────────────────────────────────────────────

describe('symmetrize - 有向图对称化', () => {
  it('双向权重相加', () => {
    const directed = [new Map([[1, 3]]), new Map([[0, 2]])];
    const sym = symmetrize(directed);
    expect(sym[0].get(1)).toBe(5);
    expect(sym[1].get(0)).toBe(5);
  });
});
