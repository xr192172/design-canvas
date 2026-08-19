/**
 * extract_contracts 契约提取测试
 *
 * 覆盖：
 *   - role 依赖方向判定：main.ts 种子=business；util（被多方依赖、不依赖业务）=functional；
 *     service（import 业务侧？不——service 只 import util）= functional；
 *     main import service import util：business 传播正确性
 *   - shapes：TS interface 字段解析（含可选字段 required 标记）；方法行不误入
 *   - reads_config：process.env.X 提取
 *   - confidence 封顶 0.7（静态判定无 runtime 证据）
 *   - dry-run（write_dsl=false）不写 DSL；feature 写回 SemanticFile.contract
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import { importProject } from '../../src/tools/import_project';
import { extractContracts } from '../../src/tools/extract_contracts';
import { openDb } from '../../src/db/db';
import { getDSL, saveDSL, clearAllFeatures, getLiveDslFile } from '../../src/storage';
import type { DesignDSL } from '../../src/dsl/types';

const roots: string[] = [];

afterAll(() => {
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      // Windows 占用，留给 OS
    }
  }
});

function put(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

/**
 * 结构：main.ts（入口，business 种子）→ service.ts（功能）→ util.ts（功能，fan-in=2）
 * main.ts 也直接 import util.ts（fan-in=2 的另一半）。
 * util.ts 定义 interface Point { x: number; y?: string }；service.ts 读 process.env.SERVICE_MODE。
 */
async function makeProject(feature?: string): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-'));
  roots.push(root);
  put(
    root,
    'src/main.ts',
    `import { runService } from './service';\nimport { format } from './util';\n\nconsole.log(format(runService()), process.env.APP_NAME);\n`,
  );
  put(
    root,
    'src/service.ts',
    `import { Point } from './util';\n\nexport function runService(): string {\n  const p: Point = { x: 1 };\n  return process.env.SERVICE_MODE ?? 'default' + String(p.x);\n}\n`,
  );
  put(
    root,
    'src/util.ts',
    `export interface Point {\n  x: number;\n  y?: string;\n  calc(a: number): void;\n}\n\nexport function format(s: string): string {\n  return '[' + s + ']';\n}\n`,
  );
  const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
  await importProject({ project_dir: root, feature, cache_db: db });
  db.close();
  return root;
}

function makeFeatureDsl(feature: string, files: Array<{ id: string; path: string; responsibility: string }>): void {
  const dsl: DesignDSL = {
    feature,
    title: feature,
    status: 'draft',
    geometry: { nodes: [], edges: [], swimlanes: [] },
    semantic: {
      files: files.map((f) => ({ id: f.id, path: f.path, responsibility: f.responsibility })),
    },
    annotations: [],
  } as unknown as DesignDSL;
  saveDSL(dsl);
}

const cleanupLive = (): void => {
  clearAllFeatures();
  const live = getLiveDslFile();
  if (fs.existsSync(live)) fs.unlinkSync(live);
};

beforeEach(cleanupLive);
afterEach(cleanupLive);

describe('extract_contracts 契约提取', () => {
  it('role 依赖方向：main=business 种子，util=functional 高置信，service=functional', async () => {
    const root = await makeProject();
    const r = extractContracts({ project_dir: root });

    const byPath = new Map(r.files.map((f) => [f.path, f]));
    const main = byPath.get('src/main.ts')!;
    const service = byPath.get('src/service.ts')!;
    const util = byPath.get('src/util.ts')!;

    expect(main.role.class).toBe('business');
    expect(main.role.reasons?.[0]).toContain('种子');
    expect(main.role.basis).toBe('graph');

    expect(service.role.class).toBe('functional');

    expect(util.role.class).toBe('functional');
    expect(util.fan_in).toBe(2); // main + service 都依赖它
    expect(util.role.confidence).toBe(0.7); // 0.85 封顶 0.7（静态判定）
  });

  it('shapes：interface 字段解析 + 可选标记 + 方法行不误入', async () => {
    const root = await makeProject();
    const r = extractContracts({ project_dir: root });

    const util = r.files.find((f) => f.path === 'src/util.ts')!;
    expect(util.shape_count).toBe(1);
    // 字段细节从 DSL 或再次提取校验——这里通过 files 报告只有计数，深检走 feature 写回用例
    expect(r.stats.shapes_extracted).toBeGreaterThanOrEqual(1);
  });

  it('reads_config：process.env 提取', async () => {
    const root = await makeProject();
    const r = extractContracts({ project_dir: root });

    const main = r.files.find((f) => f.path === 'src/main.ts')!;
    expect(main.reads_config).toContain('APP_NAME');
    const service = r.files.find((f) => f.path === 'src/service.ts')!;
    expect(service.reads_config).toContain('SERVICE_MODE');
  });

  it('feature 写回：SemanticFile.contract 填充 + 字段级校验', async () => {
    const feature = 'contract_write_test';
    const root = await makeProject(feature);
    makeFeatureDsl(feature, [
      { id: 'f1', path: 'src/util.ts', responsibility: '工具' },
      { id: 'f2', path: 'src/main.ts', responsibility: '入口' },
    ]);
    const r = extractContracts({ project_dir: root, feature });

    expect(r.written_to_dsl).toBe(true);
    const dsl = getDSL(feature)!;
    const utilSf = dsl.semantic.files.find((f) => f.path === 'src/util.ts')!;
    expect(utilSf.contract).toBeDefined();
    expect(utilSf.contract!.role.class).toBe('functional');

    // 字段级：Point 形状 x=required number, y=optional string, calc=方法行（不应出现）
    const point = utilSf.contract!.shapes.exposes.find((s) => s.name === 'Point');
    expect(point).toBeDefined();
    const fx = point!.fields.find((f) => f.name === 'x');
    expect(fx?.type).toBe('number');
    expect(fx?.required).toBe(true);
    const fy = point!.fields.find((f) => f.name === 'y');
    expect(fy?.required).toBe(false);
    expect(point!.fields.some((f) => f.name === 'calc')).toBe(false); // 方法行不进字段

    // main 写回 business + reads_config
    const mainSf = dsl.semantic.files.find((f) => f.path === 'src/main.ts')!;
    expect(mainSf.contract!.role.class).toBe('business');
    expect(mainSf.contract!.effects.reads_config).toContain('APP_NAME');
  });

  it('dry-run：write_dsl=false 不写回', async () => {
    const feature = 'contract_dryrun_test';
    const root = await makeProject(feature);
    makeFeatureDsl(feature, [{ id: 'f1', path: 'src/util.ts', responsibility: '工具' }]);
    const r = extractContracts({ project_dir: root, feature, write_dsl: false });

    expect(r.written_to_dsl).toBe(false);
    const dsl = getDSL(feature)!;
    expect(dsl.semantic.files[0].contract).toBeUndefined();
  });
});
