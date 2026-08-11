/**
 * language_concepts 语言概念检测测试
 *
 * 覆盖：
 *   - detectConcepts 纯函数：泛型/生成器/闭包/装饰器/异步/依赖注入/工厂/singleton/
 *     观察者/策略/模板方法/错误处理/状态机 各模式命中
 *   - 无命中 → 空数组
 *   - 一个符号命中多种概念（异步 + 泛型）
 *   - languageConcepts 从 cache.db 批量识别 + 概念统计
 *   - concepts 过滤 / files 过滤 / limit
 *   - 空缓存 / 无法打开缓存 → 提示性空结果
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { importProject } from '../../src/tools/import_project';
import { detectConcepts, languageConcepts, CONCEPTS } from '../../src/tools/language_concepts';
import { openDb } from '../../src/db/db';

const roots: string[] = [];

afterAll(() => {
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      // Windows 文件占用，留给 OS 清理
    }
  }
});

function put(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

describe('detectConcepts 纯函数', () => {
  it('泛型：signature 含 <T> 类型参数', () => {
    expect(detectConcepts({ name: 'map', kind: 'function', qualified_name: 'map', signature: 'function map<T, U>(arr: T[], fn: (x: T) => U): U[]' })).toContain('generic');
  });

  it('生成器：function* / yield', () => {
    expect(detectConcepts({ name: 'gen', kind: 'function', qualified_name: 'gen', signature: 'function* gen() { yield 1; }' })).toContain('generator');
  });

  it('闭包：返回函数类型', () => {
    expect(detectConcepts({ name: 'curry', kind: 'function', qualified_name: 'curry', signature: '(a: number) => (b: number) => number' })).toContain('closure');
  });

  it('装饰器：signature 带 @', () => {
    expect(detectConcepts({ name: 'log', kind: 'method', qualified_name: 'Foo.log', signature: '@Log()\nlog(msg: string): void' })).toContain('decorator');
  });

  it('异步：Promise / async', () => {
    expect(detectConcepts({ name: 'fetchData', kind: 'function', qualified_name: 'fetchData', signature: 'async fetchData(): Promise<Data>' })).toContain('async');
  });

  it('依赖注入：inject / provider', () => {
    expect(detectConcepts({ name: 'injectRepo', kind: 'method', qualified_name: 'Service.injectRepo', signature: 'injectRepo(repo: Repo): void' })).toContain('dependency-injection');
  });

  it('工厂：create 前缀', () => {
    expect(detectConcepts({ name: 'createClient', kind: 'function', qualified_name: 'createClient', signature: 'createClient(cfg: Config): Client' })).toContain('factory');
  });

  it('单例：getInstance', () => {
    expect(detectConcepts({ name: 'getInstance', kind: 'method', qualified_name: 'Db.getInstance', signature: 'static getInstance(): Db' })).toContain('singleton');
  });

  it('观察者：subscribe', () => {
    expect(detectConcepts({ name: 'subscribe', kind: 'method', qualified_name: 'Bus.subscribe', signature: 'subscribe(event: string, cb: (d: any) => void): void' })).toContain('observer');
  });

  it('策略：handler / strategy', () => {
    expect(detectConcepts({ name: 'authHandler', kind: 'function', qualified_name: 'authHandler', signature: 'authHandler(req: Req): Res' })).toContain('strategy');
  });

  it('模板方法：abstract', () => {
    expect(detectConcepts({ name: 'process', kind: 'method', qualified_name: 'Base.process', signature: 'abstract process(item: T): void' })).toContain('template-method');
  });

  it('错误处理：error / throw', () => {
    expect(detectConcepts({ name: 'wrapError', kind: 'function', qualified_name: 'wrapError', signature: 'wrapError(fn: () => void): void' })).toContain('error-handling');
  });

  it('状态机：transition / state', () => {
    expect(detectConcepts({ name: 'transition', kind: 'method', qualified_name: 'Fsm.transition', signature: 'transition(from: State, to: State): void' })).toContain('state-machine');
  });

  it('一个符号命中多种概念：异步 + 泛型', () => {
    const c = detectConcepts({ name: 'fetchList', kind: 'function', qualified_name: 'fetchList', signature: 'async fetchList<T>(): Promise<T[]>' });
    expect(c).toContain('async');
    expect(c).toContain('generic');
  });

  it('无命中 → 空数组', () => {
    expect(detectConcepts({ name: 'x', kind: 'function', qualified_name: 'x', signature: 'x(): void' })).toEqual([]);
  });
});

/** 建一个含多种模式的项目并写入 cache.db */
async function makeProject(feature: string): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-'));
  roots.push(root);
  put(root, 'src/repo.ts', `export function createClient(cfg: unknown): unknown { return {}; }\n`);
  put(root, 'src/bus.ts', `export function subscribe(event: string, cb: (d: unknown) => void): void {}\n`);
  put(root, 'src/fetch.ts', `export async function fetchData<T>(): Promise<T[]> { return [] as T[]; }\n`);
  put(root, 'src/plain.ts', `export function plain(): void {}\n`);
  const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
  await importProject({ project_dir: root, feature, cache_db: db });
  db.close();
  return root;
}

describe('languageConcepts 批量检测', () => {
  it('从 cache.db 正确识别概念并统计', async () => {
    const feature = `lc_${Date.now()}`;
    const root = await makeProject(feature);
    const r = languageConcepts({ project_dir: root });

    expect(r.provider).toBe('detect');
    expect(r.indexed).toBeGreaterThan(0);
    expect(r.matched).toBeGreaterThan(0);

    const byName = new Map(r.hits.map((h) => [h.name, h.concepts]));
    expect(byName.get('createClient')).toContain('factory');
    expect(byName.get('subscribe')).toContain('observer');
    expect(byName.get('fetchData') ?? []).toEqual(expect.arrayContaining(['async', 'generic']));
    // 无模式的符号不命中
    expect(byName.has('plain')).toBe(false);

    const counts = new Map(r.concept_counts.map((c) => [c.id, c.count]));
    expect((counts.get('factory') ?? 0)).toBeGreaterThan(0);
    expect((counts.get('observer') ?? 0)).toBeGreaterThan(0);
  });

  it('concepts 过滤：只统计指定概念', async () => {
    const feature = `lc_filter_${Date.now()}`;
    const root = await makeProject(feature);
    const r = languageConcepts({ project_dir: root, concepts: ['async', 'observer'] });
    // 只含指定概念
    for (const h of r.hits) {
      for (const c of h.concepts) expect(['async', 'observer']).toContain(c);
    }
    expect(r.concept_counts.every((c) => ['async', 'observer'].includes(c.id))).toBe(true);
    // createClient(factory) 不当 factory 返回，但 observe/subscribe 仍命中
    expect(r.hits.some((h) => h.name === 'subscribe')).toBe(true);
  });

  it('files 过滤：只返回指定文件的符号', async () => {
    const feature = `lc_files_${Date.now()}`;
    const root = await makeProject(feature);
    const r = languageConcepts({ project_dir: root, files: ['src/fetch.ts'] });
    expect(r.hits.length).toBeGreaterThan(0);
    for (const h of r.hits) expect(h.file_path).toBe('src/fetch.ts');
  });

  it('limit 限制返回符号数', async () => {
    const feature = `lc_limit_${Date.now()}`;
    const root = await makeProject(feature);
    const r = languageConcepts({ project_dir: root, limit: 1 });
    expect(r.hits.length).toBeLessThanOrEqual(1);
  });

  it('符号缓存为空 → 提示性结果', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-empty-'));
    roots.push(root);
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    db.close();
    const r = languageConcepts({ project_dir: root });
    expect(r.matched).toBe(0);
    expect(r.message).toContain('为空');
  });

  it('目录不存在 → 自动建缓存，提示为空', () => {
    const root = path.join(os.tmpdir(), 'lc-nope-' + Date.now());
    const r = languageConcepts({ project_dir: root });
    expect(r.matched).toBe(0);
    expect(r.message).toContain('为空');
  });

  it('CONCEPTS 定义完整（13 种，含 id/name/explanation）', () => {
    expect(CONCEPTS.length).toBe(13);
    for (const c of CONCEPTS) {
      expect(c.id).toBeTruthy();
      expect(c.name).toBeTruthy();
      expect(c.explanation).toBeTruthy();
    }
  });
});