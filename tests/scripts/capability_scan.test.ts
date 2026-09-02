/**
 * capability_scan —— 能力语言指纹扫描（mjs 纯函数）测试
 *
 * 覆盖 scanFile / resolveFeatureFiles / capDecl / scanFeature：
 *   - scanFile：语言分支提取（Set/lang/ext/语言 key 数组）、AST 与全语言 API 判定、Regex 回退
 *   - resolveFeatureFiles：单文件原样 / 目录递归（跳过 .d.ts）
 *   - capDecl：从 register_capabilities 文本提取 default/overrides（只认三档）
 *   - scanFeature：声明 vs 实现对比 → warn（确定漏登记）/ info（语义待决）分级
 * 全部用临时目录构造最小实现 + 声明片段，经 filesMap 注入驱动 scanFeature 完整链路，不依赖真实工程。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanFile, resolveFeatureFiles, capDecl, scanFeature } from '../../scripts/capability_scan.mjs';

function mkRoot() {
  return mkdtempSync(path.join(tmpdir(), 'capscan-'));
}
function rmForce(dir) {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      /* 句柄未释放 */
    }
  }
}

/** 构造一个 register_capabilities.ts（含指定 id 的声明片段） */
function writeCapReg(dir, decls) {
  const p = path.join(dir, 'src/tools/register_capabilities.ts');
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, decls, 'utf-8');
}

describe('scanFile: 语言分支提取与 AST/全语言判定', () => {
  it('识别 Set([...]) 语言名单 + AST API → isAst', () => {
    const dir = mkRoot();
    writeFileSync(path.join(dir, 'impl.ts'), "const TS_FAMILY = new Set(['typescript','tsx','javascript','jsx']);\nconst r = parseFileFull('x', 'y');");
    const s = scanFile('impl.ts', dir);
    expect(s.langs).toContain('typescript');
    expect(s.langs).toContain('jsx');
    expect(s.isAst).toBe(true);
    expect(s.hasRegex).toBe(false);
    rmForce(dir);
  });

  it('识别 lang === / ext === 显式分支（.py → python 归一）', () => {
    const dir = mkRoot();
    writeFileSync(path.join(dir, 'impl.ts'), "if (lang === 'go') {}\nif (ext === '.py') {}");
    const s = scanFile('impl.ts', dir);
    expect(s.langs).toContain('go');
    expect(s.langs).toContain('python');
    rmForce(dir);
  });

  it('识别语言 key 数组（COMPLEXITY_BRANCH_NODES 样式）', () => {
    const dir = mkRoot();
    writeFileSync(path.join(dir, 'impl.ts'), "const NODES = { go: ['if_statement'], python: ['while_statement'] };");
    const s = scanFile('impl.ts', dir);
    expect(s.langs).toContain('go');
    expect(s.langs).toContain('python');
    rmForce(dir);
  });

  it('含 listSupportedExtensions → isGeneric=true；纯函数无语言分支 → isGeneric=false', () => {
    const dir = mkRoot();
    writeFileSync(path.join(dir, 'a.ts'), 'const exts = listSupportedExtensions();');
    writeFileSync(path.join(dir, 'b.ts'), 'export const x = 1;');
    expect(scanFile('a.ts', dir).isGeneric).toBe(true);
    expect(scanFile('b.ts', dir).isGeneric).toBe(false);
    expect(scanFile('b.ts', dir).langs).toEqual([]);
    rmForce(dir);
  });

  it('Regex 回退函数 → hasRegex=true', () => {
    const dir = mkRoot();
    writeFileSync(path.join(dir, 'impl.ts'), 'export function extractNamedImportsRegex(s){ return s; }');
    const s = scanFile('impl.ts', dir);
    expect(s.hasRegex).toBe(true);
    rmForce(dir);
  });
});

describe('resolveFeatureFiles: 文件 vs 目录递归', () => {
  it('单文件原样返回', () => {
    const dir = mkRoot();
    writeFileSync(path.join(dir, 'a.ts'), 'x');
    expect(resolveFeatureFiles('a.ts', dir)).toEqual(['a.ts']);
    rmForce(dir);
  });
  it('目录递归收集全部 .ts（跳过 .d.ts）', () => {
    const dir = mkRoot();
    mkdirSync(path.join(dir, 'impl', 'sub'), { recursive: true });
    writeFileSync(path.join(dir, 'impl', 'a.ts'), 'x');
    writeFileSync(path.join(dir, 'impl', 'sub', 'b.ts'), 'y');
    writeFileSync(path.join(dir, 'impl', 'c.d.ts'), 'z');
    expect(resolveFeatureFiles('impl', dir).sort()).toEqual(['impl/a.ts', 'impl/sub/b.ts'].sort());
    rmForce(dir);
  });
});

describe('capDecl: 从 register_capabilities 文本提取', () => {
  it('提取 default + overrides，只认三档', () => {
    const dir = mkRoot();
    writeCapReg(dir, "id: 'foo', default: 'unimplemented', overrides: { go: 'full_ast', python: 'partial_ast' }");
    const d = capDecl('foo', dir);
    expect(d.def).toBe('unimplemented');
    expect(d.overrides.get('go')).toBe('full_ast');
    expect(d.overrides.get('python')).toBe('partial_ast');
    rmForce(dir);
  });
  it('id 不存在 → null', () => {
    const dir = mkRoot();
    writeCapReg(dir, "");
    expect(capDecl('nope', dir)).toBeNull();
    rmForce(dir);
  });
});

describe('scanFeature: 声明 vs 实现 → warn/info 分级', () => {
  it('实现触达 go（AST）但声明 unimplemented → warn（确定漏登记）', () => {
    const dir = mkRoot();
    writeFileSync(path.join(dir, 'impl.ts'), "if (lang === 'go') {} const r = parseAstRoot('a','b');");
    writeCapReg(dir, "id: 'feat'; default: 'unimplemented'; overrides: {} id: 'ignored'; default: 'x'; overrides: {}");
    const r = scanFeature('feat', dir, { feat: ['impl.ts'] });
    expect(r.touched).toContain('go');
    expect(r.hints.some((h) => h.level === 'warn' && /go/.test(h.text))).toBe(true);
    rmForce(dir);
  });

  it('实现触达 go 且声明 full_ast → 无 warn', () => {
    const dir = mkRoot();
    writeFileSync(path.join(dir, 'impl.ts'), "if (lang === 'go') {} parseAstRoot('a','b');");
    writeCapReg(dir, "id: 'feat'; default: 'unimplemented'; overrides: { go: 'full_ast' } id: 'ignored'; default: 'x'; overrides: {}");
    const r = scanFeature('feat', dir, { feat: ['impl.ts'] });
    expect(r.hints.filter((h) => h.level === 'warn')).toEqual([]);
    rmForce(dir);
  });

  it('实现触达 go 且声明 partial_ast → 无 warn（partial 即够）', () => {
    const dir = mkRoot();
    writeFileSync(path.join(dir, 'impl.ts'), "if (lang === 'go') {} parseAstRoot('a','b');");
    writeCapReg(dir, "id: 'feat'; default: 'unimplemented'; overrides: { go: 'partial_ast' } id: 'ignored'; default: 'x'; overrides: {}");
    const r = scanFeature('feat', dir, { feat: ['impl.ts'] });
    expect(r.hints.filter((h) => h.level === 'warn')).toEqual([]);
    rmForce(dir);
  });

  it('含全语言解析 API 且声明只覆盖部分 → info（语义待决，不阻断）', () => {
    const dir = mkRoot();
    writeFileSync(path.join(dir, 'impl.ts'), 'const exts = listSupportedExtensions(); walk(exts);');
    writeCapReg(dir, "id: 'feat'; default: 'unimplemented'; overrides: { go: 'full_ast' } id: 'ignored'; default: 'x'; overrides: {}");
    const r = scanFeature('feat', dir, { feat: ['impl.ts'] });
    expect(r.genericFile).toBe('impl.ts');
    expect(r.hints.some((h) => h.level === 'info')).toBe(true);
    expect(r.hints.filter((h) => h.level === 'warn')).toEqual([]);
    rmForce(dir);
  });

  it('无声明片段 → warn（未登记）', () => {
    const dir = mkRoot();
    writeFileSync(path.join(dir, 'impl.ts'), 'export const x = 1;');
    writeCapReg(dir, "id: 'other'; default: 'x'; overrides: {}");
    const r = scanFeature('missing', dir, { missing: ['impl.ts'] });
    expect(r.hints.some((h) => h.level === 'warn' && /未找到|capDecl|该 id/.test(h.text))).toBe(true);
    rmForce(dir);
  });
});