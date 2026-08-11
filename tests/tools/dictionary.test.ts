/**
 * dictionary 伪维基双层术语词典测试
 *
 * 覆盖：
 *   - 全局/项目词典读写 + project 覆盖同名 global
 *   - 别名索引（aliasesIndex）
 *   - 互链索引（links：解释文本命中其他词条 → 建立链接）
 *   - splitHighlights 高亮拆分（命中词切分、重叠合并、大小写不敏感）
 *   - 损坏 JSON 文件 → 忽略不阻塞
 *   - 项目根 == dataHome 时项目词典跳过（避免自嵌套）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  buildDictionaryView,
  saveGlobalEntry,
  saveProjectEntry,
  loadGlobalDict,
  loadProjectDict,
  splitHighlights,
  getGlobalDictFile,
  setAllowedProjectRoots,
  validateProjectRoot,
  type DictEntry,
} from '../../src/tools/dictionary';

const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-dict-'));
const projectRoot = path.join(os.tmpdir(), 'dc-dict-proj-' + Date.now());

function entry(term: string, newbie: string, opts: Partial<DictEntry> = {}): DictEntry {
  return {
    term,
    kind: 'global',
    newbie,
    pm: opts.pm ?? newbie,
    senior: opts.senior ?? newbie,
    ...opts,
    generated_at: opts.generated_at ?? new Date().toISOString(),
  };
}

beforeAll(() => {
  process.env.DESIGN_CANVAS_HOME = dataHome;
  fs.mkdirSync(projectRoot, { recursive: true });
  // 测试使用的临时目录需要显式加入安全白名单
  setAllowedProjectRoots([projectRoot, dataHome, process.cwd()]);
});

afterAll(() => {
  for (const r of [dataHome, projectRoot]) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      // Windows 文件占用，留给 OS 清理
    }
  }
});

describe('词典读写', () => {
  it('saveGlobalEntry 按 term 覆盖并持久化', () => {
    saveGlobalEntry(entry('异步', '异步旧解释'));
    saveGlobalEntry(entry('异步', '异步新解释'));
    const all = loadGlobalDict();
    const hit = all.find((e) => e.term === '异步');
    expect(hit?.newbie).toBe('异步新解释');
    expect(all.filter((e) => e.term === '异步')).toHaveLength(1);
  });

  it('项目根 == dataHome 时项目词典跳过（避免自嵌套）', () => {
    // dataHome 本身就是"项目"，loadProjectDict(dataHome) 应返回空
    expect(loadProjectDict(dataHome)).toEqual([]);
  });
});

describe('聚合视图合并', () => {
  it('project 覆盖同名 global', () => {
    saveGlobalEntry(entry('缓存', '全局缓存解释'));
    saveProjectEntry(projectRoot, entry('缓存', '项目缓存解释', { kind: 'project' }));
    const view = buildDictionaryView(projectRoot);
    const hit = view.entries.find((e) => e.term === '缓存');
    expect(hit?.newbie).toBe('项目缓存解释');
    expect(hit?.kind).toBe('project');
  });

  it('互链索引：解释命中其他词条 term → 建立链接', () => {
    saveGlobalEntry(entry('异步', '异步未来结果的机制，类似 Promise。'));
    saveGlobalEntry(entry('Promise', 'Promise 是异步的容器。'));
    const view = buildDictionaryView(projectRoot);
    expect((view.links['异步'] || []).includes('Promise')).toBe(true);
    expect((view.links['Promise'] || []).includes('异步')).toBe(true);
  });

  it('互链索引：未命中其他词条 → 无链接', () => {
    saveGlobalEntry(entry('单例', '某个类型在整个程序里只有一个实例。'));
    const view = buildDictionaryView(projectRoot);
    expect((view.links['单例'] || []).length).toBe(0);
  });

  it('别名索引：别名可命中规范词', () => {
    saveGlobalEntry(entry('依赖注入', '把依赖从外部传入，而不是内部 new。', { aliases: ['DI'] }));
    const view = buildDictionaryView(projectRoot);
    expect((view.aliasesIndex['di'] || []).includes('依赖注入')).toBe(true);
    expect((view.aliasesIndex['依赖注入'] || []).includes('依赖注入')).toBe(true);
  });
});

describe('splitHighlights 高亮拆分', () => {
  it('命中词包成高亮片段，未命中保持原样', () => {
    saveGlobalEntry(entry('异步', '异步就是不等。'));
    const view = buildDictionaryView(projectRoot);
    const text = '这里的异步处理很重要。';
    const pieces = splitHighlights(text, view);
    const hit = pieces.find((p) => p.term === '异步');
    expect(hit).toBeDefined();
    expect(hit?.text).toBe('异步');
    // 拼接后还原原文
    expect(pieces.map((p) => p.text).join('')).toBe(text);
  });

  it('多个命中 + 重叠合并', () => {
    saveGlobalEntry(entry('异步', '异步'));
    saveGlobalEntry(entry('异步处理', '异步处理'));
    const view = buildDictionaryView(projectRoot);
    const pieces = splitHighlights('异步处理流程', view);
    // 重叠词异步/异步处理 → 合并为最长命中
    const joined = pieces.map((p) => p.text).join('');
    expect(joined).toBe('异步处理流程');
    const terms = pieces.filter((p) => p.term).map((p) => p.term);
    expect(terms).toContain('异步处理');
  });

  it('大小写不敏感命中（英文）', () => {
    saveGlobalEntry(entry('Promise', 'Promise'));
    const view = buildDictionaryView(projectRoot);
    const pieces = splitHighlights('promise 对象', view);
    const hit = pieces.find((p) => p.term === 'Promise');
    expect(hit).toBeDefined();
    expect(hit?.text).toBe('promise');
  });

  it('空文本 / 无命中 → 单片段原样返回', () => {
    const view = buildDictionaryView(projectRoot);
    expect(splitHighlights('', view)).toEqual([{ text: '' }]);
    expect(splitHighlights('完全无关的词', view).map((p) => p.text).join('')).toBe('完全无关的词');
  });
});

describe('损坏处理', () => {
  it('词典文件损坏 → 返回空数组不阻塞', () => {
    // 直接写坏全局词典文件
    fs.writeFileSync(getGlobalDictFile(), '{ 这不是合法JSON', 'utf-8');
    expect(loadGlobalDict()).toEqual([]);
    // 恢复：清掉坏文件
    fs.rmSync(getGlobalDictFile());
  });
});

describe('路径安全校验（防御路径穿越）', () => {
  it('拒绝含 .. 的相对穿越路径', () => {
    expect(() => validateProjectRoot('../../etc/passwd')).toThrow(/路径穿越/);
    expect(() => validateProjectRoot('foo/../../bar')).toThrow(/路径穿越/);
    expect(() => validateProjectRoot('..')).toThrow(/路径穿越/);
    expect(() => validateProjectRoot('../other-project')).toThrow(/路径穿越/);
  });

  it('拒绝绝对路径指向白名单外系统目录', () => {
    const systemDir = process.platform === 'win32' ? 'C:\\Windows\\Temp' : '/etc';
    expect(() => validateProjectRoot(systemDir)).toThrow(/超出允许范围/);
  });

  it('允许白名单内目录（当前测试 projectRoot / dataHome / cwd）', () => {
    expect(() => validateProjectRoot(projectRoot)).not.toThrow();
    expect(() => validateProjectRoot(dataHome)).not.toThrow();
    expect(() => validateProjectRoot(process.cwd())).not.toThrow();
  });

  it('允许 cwd 的真实子目录', () => {
    const srcDir = path.join(process.cwd(), 'src');
    // 如果存在，则必须通过；不存在但仍在 cwd 子树下也应通过（本校验不检查目录是否存在）
    expect(() => validateProjectRoot(srcDir)).not.toThrow();
  });

  it('拒绝空串或纯空白', () => {
    expect(() => validateProjectRoot('')).toThrow(/不能为空/);
    expect(() => validateProjectRoot('   ')).toThrow(/不能为空/);
  });
});