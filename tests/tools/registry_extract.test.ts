/**
 * registry_extract（注册表提取）+ cli_extract（CLI 提取）+ collect_functions（统一
 * 功能注册面）+ classify_tools（四维标注）+ render_tools_map 测试：
 *   - MCP 提取：name/title/description/import 连线（命名 handler 扫定义体）
 *   - CLI 提取：头注释人话描述 + usage 参数
 *   - 合并：同名（CLI 去 _cli 后缀）→ 双入口 both；各自独占 → mcp_only/cli_only
 *   - 四维标注降级（rule）+ 确定性簇映射 + unmatched 诚实上报
 *   - HTML：四维分组 + 入口徽章 + 悬窗下钻
 * LLM 真调用不做单测；rule 路径即"标注层缺席"契约。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { extractRegistryTools } from '../../src/tools/registry_extract';
import { collectFunctions, type FunctionEntry } from '../../src/tools/collect_functions';
import { classifyTools, defaultDomains } from '../../src/tools/classify_tools';
import { renderToolsMapHtml } from '../../src/tools/render_tools_map';
import type { BrickifyResult } from '../../src/tools/brickify';

const FIXTURE_SRC = `import fs from 'node:fs';
import { buildBrickify } from './tools/brickify_cli.js';
import { renderSandbox } from './tools/render_sandbox.js';
import { type Foo } from './types.js';

const getDslHandler = wrap(async (a) => {
  return await buildBrickify({ project_dir: String(a.project) });
});

const TOOL_DEFS: ToolDef[] = [
  {
    name: 'get_dsl',
    title: 'Query feature data',
    description:
      '统一只读入口：' +
      '通过 query 参数查询 DSL 数据。',
    inputSchema: {},
    handler: getDslHandler,
  },
  {
    name: 'render_sandbox',
    title: 'Sandbox render',
    description: '渲染社区工作台 HTML。',
    inputSchema: {},
    handler: wrap(async (a) => {
      const html = renderSandbox(a as never);
      return html;
    }),
  },
];
`;

function brickifyFixture(): BrickifyResult {
  const files = ['tools/brickify_cli.ts', 'tools/render_sandbox.ts'];
  return {
    bricks: [
      {
        id: 'tools',
        files: { frontend: [], backend: files, shared: [] },
        total: 2,
        dominant: 'backend',
        sub_clusters: [
          {
            id: 'tools#1',
            files,
            total: 2,
            dominant: 'backend',
            role: 'brick',
            roles: { brick: files, contract: [], glue: [] },
            internal_edges: 1,
            external_edges: 0,
            cohesion: 1,
            degenerate: false,
          },
        ],
        roles: { brick: files, contract: [], glue: [] },
        role: 'brick',
        community: 'c',
        mixed_files: [],
      },
    ],
    file_deps: [],
    communities: [{ id: 'c', bricks: ['tools'], internal_edges: 0, external_edges: 0, cohesion: 1 }],
    mixed_files: [],
    call_edges: [],
    meta: {
      project_dir: '/proj',
      source_root: '/proj/src',
      scanned_files: 2,
      langs: ['ts'],
      role_totals: { brick: 2, contract: 0, glue: 0 },
    },
    limitations: [],
  };
}

const ENV_KEYS = ['LLM_API_KEY', 'DEEPSEEK_API_KEY', 'AGNES_API_KEY', 'LLM_BASE_URL', 'DEEPSEEK_BASE_URL', 'AGNES_BASE_URL'];
const saved: Record<string, string | undefined> = {};

describe('extractRegistryTools（确定性提取）', () => {
  it('name/title/description（多段引号串拼接）提取正确', () => {
    const r = extractRegistryTools(FIXTURE_SRC);
    expect(r.tools).toHaveLength(2);
    const get = r.tools[0];
    expect(get.name).toBe('get_dsl');
    expect(get.title).toBe('Query feature data');
    expect(get.description).toBe('统一只读入口：通过 query 参数查询 DSL 数据。');
    expect(get.summarySource).toBe('统一只读入口：通过 query 参数查询 DSL 数据');
  });

  it('实现模块连线：命名 handler 扫描定义体，内联 handler 扫描条目块', () => {
    const r = extractRegistryTools(FIXTURE_SRC);
    // get_dsl 的 handler 是命名引用（getDslHandler），定义体里调用 buildBrickify
    expect(r.tools[0].implModules).toContain('tools/brickify_cli');
    // render_sandbox 内联调用 renderSandbox
    expect(r.tools[1].implModules).toContain('tools/render_sandbox');
    // type-only import 不参与（Foo 未被调用）
    expect(r.tools.flatMap((t) => t.implModules)).not.toContain('types');
  });
});

describe('classifyTools（四维标注 + 确定性簇映射）', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  });

  it('rule 降级标注 + 模块→簇精确映射 + 置信度低', async () => {
    const r = extractRegistryTools(FIXTURE_SRC);
    const entries = collectFunctions(r.tools, []).entries;
    const map = await classifyTools(entries, brickifyFixture());
    expect(map.meta.mode).toBe('rule');
    expect(map.tools).toHaveLength(2);
    // 实现簇连线（确定性）
    const get = map.tools.find((t) => t.name === 'get_dsl')!;
    expect(get.implClusters).toEqual([{ cluster: 'tools#1', brick: 'tools' }]);
    expect(get.unmatchedModules).toHaveLength(0);
    // rule 标注 + kind 透传（确定性维度）
    expect(['P0', 'P1', 'P2']).toContain(get.tier);
    expect(defaultDomains().some((d) => d.id === get.domain)).toBe(true);
    expect(get.kind).toBe('mcp_only');
  });

  it('模块匹配不上簇时如实上报 unmatched（不硬塞）', async () => {
    const src = FIXTURE_SRC.replace("import { type Foo } from './types.js';", "import { ghost } from './ghost.js';").replace(
      'const html = renderSandbox(a as never);',
      'const html = renderSandbox(a as never); ghost();',
    );
    const r = extractRegistryTools(src);
    const entries = collectFunctions(r.tools, []).entries;
    const map = await classifyTools(entries, brickifyFixture());
    const render = map.tools.find((t) => t.name === 'render_sandbox')!;
    expect(render.unmatchedModules).toContain('ghost');
    expect(map.limitations.some((l) => l.includes('未匹配'))).toBe(true);
  });
});

describe('collectFunctions（统一功能注册面：MCP + CLI 合并）', () => {
  it('同名合并为双入口（both）；各自独占分开；实现模块并集', () => {
    const r = extractRegistryTools(FIXTURE_SRC);
    const cli = [
      {
        name: 'render_sandbox',
        file: 'render_sandbox_cli.ts',
        desc: '渲染社区工作台的独立阶段 CLI',
        usage: '--project <dir>',
        implModules: ['tools/render_sandbox'],
      },
      {
        name: 'signal_review',
        file: 'signal_review_cli.ts',
        desc: '混合文件解耦信号的 LLM 复核 CLI',
        usage: '--project <dir>',
        implModules: ['tools/signal_review'],
      },
    ];
    const reg = collectFunctions(r.tools, cli);
    // 三个功能：get_dsl(MCP) + render_sandbox(both) + signal_review(CLI)
    expect(reg.entries).toHaveLength(3);
    expect(reg.meta).toEqual({ mcp: 2, cli: 2, both: 1, mcp_only: 1, cli_only: 1 });
    const both = reg.entries.find((e) => e.name === 'render_sandbox')!;
    expect(both.kind).toBe('both');
    expect(both.mcp?.title).toBe('Sandbox render');
    expect(both.cli?.file).toBe('render_sandbox_cli.ts');
    expect(both.desc).toBe('渲染社区工作台 HTML。'); // 双入口取 MCP 描述
    const cliOnly = reg.entries.find((e) => e.name === 'signal_review')!;
    expect(cliOnly.kind).toBe('cli_only');
    expect(cliOnly.desc).toBe('混合文件解耦信号的 LLM 复核 CLI'); // CLI 独占用头注释
  });
});

describe('renderToolsMapHtml（功能中心多维视图）', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  });

  it('四维度分组 DOM 全渲染 + 切换脚本 + 悬窗下钻链 + 入口徽章', async () => {
    const r = extractRegistryTools(FIXTURE_SRC);
    const cli = [
      { name: 'signal_review', file: 'signal_review_cli.ts', desc: '混合文件解耦信号的 LLM 复核 CLI', usage: '--project <dir>', implModules: ['tools/signal_review'] },
    ];
    const entries = collectFunctions(r.tools, cli).entries;
    const map = await classifyTools(entries, brickifyFixture());
    const html = renderToolsMapHtml(brickifyFixture(), map);
    // 四维度 section
    expect(html).toContain('data-dim="domain"');
    expect(html).toContain('data-dim="tier"');
    expect(html).toContain('data-dim="slot"');
    expect(html).toContain('data-dim="kind"');
    // 维度切换 tabs
    expect(html).toContain('按能力域');
    expect(html).toContain('按分级');
    expect(html).toContain('按入口形态');
    expect(html).toContain('按流水线槽位');
    expect(html).toContain('showDim');
    // 入口形态分组标签 + 徽章
    expect(html).toContain('双入口（MCP + CLI）');
    expect(html).toContain('CLI 独占');
    expect(html).toContain('tm-kind-both');
    expect(html).toContain('tm-kind-cli');
    // 工具卡
    expect(html).toContain('data-tool="get_dsl"');
    // 悬窗：四维徽章 + 实现簇 + 文件下钻
    expect(html).toContain('const DETAIL');
    expect(html).toContain('实现体');
    expect(html).toContain('内联实现');
  });
});
