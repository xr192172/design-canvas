/**
 * install-package —— 语言包按需安装 CLI 的纯计算部分测试
 *
 * 覆盖：list 清单结构（每个 LANGUAGES.pkg 皆有条目）、派生语言（tsx/jsx）随父包判定
 * 已装且不标独立钉版。install/uninstall 真跑 npm（慢+副作用）不做单测，其守卫逻辑由
 * list 数据 + 命令行拦截保证（派生/未知语言在 CLI 层拒绝）。
 */
import { describe, it, expect } from 'vitest';
import { collect, rangeOk, verifyAbi, checkPrebuild, ghSource } from '../../src/tools/install_package_cli.js';
import { LANGUAGES } from '../../src/tools/ts_kernel/languages.js';

describe('install-package 语言包清单', () => {
  it('每个 LANGUAGES 语言都有清单条目（含派生语言与通用语言）', () => {
    const rows = collect();
    const byPkg = new Map(rows.map((r) => [r.pkg, r]));
    for (const l of LANGUAGES) {
      if (!l.pkg) continue;
      expect(byPkg.has(l.pkg), `语言 ${l.name}(pkg=${l.pkg}) 缺清单条目`).toBe(true);
    }
    // 深适配核心语言都在（钉版表覆盖 go/python/java/rust/c_sharp/php）
    for (const pkg of ['go', 'python', 'java', 'rust', 'c-sharp', 'php']) {
      expect(byPkg.has(pkg)).toBe(true);
    }
  });

  it('派生语言 tsx/jsx 随父包判定已装，无独立钉版', () => {
    const rows = collect();
    const tsx = rows.find((r) => r.pkg === 'tsx')!;
    const jsx = rows.find((r) => r.pkg === 'jsx')!;
    // 父包 typescript/javascript 在本仓库是硬依赖 → 派生语言应判已装
    const parentTs = rows.find((r) => r.pkg === 'typescript');
    expect(tsx.installed).toBe(true);
    expect(jsx.installed).toBe(true);
    // 派生语言无独立钉版（不误导 install）
    expect(tsx.pin).toBeUndefined();
    expect(jsx.pin).toBeUndefined();
    expect(parentTs).toBeDefined();
  });

  it('已装语言可从近 node_modules 探出版本', () => {
    const rows = collect();
    const go = rows.find((r) => r.pkg === 'go')!;
    expect(go.installed).toBe(true); // go 是仓库 optionalDependency 且已装
    expect(typeof go.installedVersion).toBe('string');
    expect(go.installedVersion!.length).toBeGreaterThan(0);
  });

  it('ABI 范围匹配（rangeOk）：同 major 兼容、不同 major 不兼容、极简范围不误报', () => {
    expect(rangeOk('^0.21.0', '0.21.1')).toBe(true);
    expect(rangeOk('^0.21.0', '0.22.0')).toBe(false); // ^0.21.0 → [0.21.0,0.22.0)；0.22.0 超出
    expect(rangeOk('>=0.21.0', '0.22.1')).toBe(true);
    expect(rangeOk('~0.21', '0.21.9')).toBe(true);
    expect(rangeOk('~0.21.0', '0.21.5')).toBe(false); // ~0.21.0 → [0.21.0,0.21.1)；0.21.5 超出
    expect(rangeOk('>=1.0.0', '0.9.0')).toBe(false); // 下限高于当前 → 不兼容
  });

  it('verifyAbi：语言包声明 peer 与已装核心匹配时不告警（repo 当前核心 0.21.1）', () => {
    // go 声明 ^0.21.0，核心 0.21.1 → 无告警
    expect(verifyAbi('go')).toEqual([]);
    // 未知包 → 无告警（拿不准不误报）
    expect(verifyAbi('no_such_pkg')).toEqual([]);
  });

  it('checkPrebuild：主语言包带当前平台 prebuild 或无该目录时均不抛出', () => {
    // 只是不 throw 的健全性；返回数组可空（部分包无 prebuild 目录也视为缺）
    expect(Array.isArray(checkPrebuild('go'))).toBe(true);
  });

  it('ghSource：登记语言直连官方仓库，未登记按 tree-sitter-{pkg} 推断', () => {
    expect(ghSource('go')).toBe('https://github.com/tree-sitter/tree-sitter-go');
    expect(ghSource('c-sharp')).toBe('https://github.com/tree-sitter/tree-sitter-c-sharp');
    // 未登记的通用语言（如 bash 不在 GH_SOURCES）→ 推断组织
    expect(ghSource('bash')).toBe('https://github.com/tree-sitter/tree-sitter-bash');
  });
});