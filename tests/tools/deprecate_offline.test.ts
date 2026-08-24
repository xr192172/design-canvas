/**
 * deprecate_offline —— 废弃积木下线链（C 链）单测
 *
 * 覆盖正确性关键的判别/闸门：
 * - resolveConsumerSource：相对 import 按"消费者文件目录"解析为项目内源，非相对源（三方/内置）拒绝。
 * - aggregateProjectSources：仅当某死源的全部消费者都能 resolve 到**同一**项目内文件才视为自研积木；
 *   消费者 resolve 分散/失败 → 保守跳过（不误判为可下线积木）。
 * - remainingImporters：物理删文件前的"无活跃消费"硬闸门——死 import 与活跃引用并存时计数>0，
 *   必须阻止下线（等价于 verify_refactor 被误判的传闻场景）。
 */

import { afterAll, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConsumerSource, aggregateProjectSources, remainingImporters, hasActiveReference } from '../../src/tools/deprecate_offline';
import type { DeadDepCandidate } from '../../src/tools/dead_deps';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dco-'));
}

describe('resolveConsumerSource', () => {
  it('按消费者所在目录解析相对源，落到项目内文件', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'a'));
    fs.writeFileSync(path.join(dir, 'a', 'mod.ts'), '');
    expect(resolveConsumerSource(dir, 'a/use.ts', './mod')).toBe('a/mod.ts');
    expect(resolveConsumerSource(dir, 'a/use.ts', './mod.ts')).toBe('a/mod.ts');
  });

  it('非相对源（三方包/node 内置）拒绝', () => {
    expect(resolveConsumerSource(tmp(), 'a/use.ts', 'lodash')).toBeNull();
    expect(resolveConsumerSource(tmp(), 'a/use.ts', 'fs')).toBeNull();
  });

  it('resolve 不到实体返回 null', () => {
    expect(resolveConsumerSource(tmp(), 'a/use.ts', './not_exist')).toBeNull();
  });
});

describe('aggregateProjectSources', () => {
  it('全部死消费者 resolve 到同一文件 → 自研积木', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'x'));
    fs.writeFileSync(path.join(dir, 'x', 'legacy.ts'), '');
    const dead: DeadDepCandidate[] = [
      // 两个不同消费者，各自用不同相对写法 import 到同一文件
      { source: './legacy', files: ['x/one.ts'], reason: 'no_reference' },
      { source: '../x/legacy', files: ['y/two.ts'], reason: 'no_reference' },
    ];
    fs.mkdirSync(path.join(dir, 'y'));
    const map = aggregateProjectSources(dir, dead);
    expect(map.size).toBe(2);
    for (const [s, v] of map) {
      expect(v.moduleFile).toBe('x/legacy.ts');
      expect(v.consumers).toBe(1);
    }
  });

  it('消费者 resolve 分散到不同文件 / 失败 → 保守跳过（不判为可下线积木）', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'x'));
    fs.writeFileSync(path.join(dir, 'x', 'a.ts'), '');
    fs.writeFileSync(path.join(dir, 'x', 'b.ts'), '');
    const dead: DeadDepCandidate[] = [
      { source: './a', files: ['x/c1.ts'], reason: 'no_reference' },
      { source: './b', files: ['x/c2.ts'], reason: 'no_reference' },
    ];
    const map = aggregateProjectSources(dir, dead);
    expect(map.size).toBe(2); // 各 source 独立
  });
});

describe('remainingImporters（物理下线硬闸门）', () => {
  it('死 import 与活跃引用并存 → 计数>0，禁止物理删（verify_refactor 传闻场景）', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'tools'));
    fs.writeFileSync(path.join(dir, 'tools', 'verify_refactor.ts'), 'export const A = 1;');
    // 活跃消费者（真正在用 verify_refactor，不能被下线）
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'live.ts'), "import { A } from '../tools/verify_refactor'; export const y = A + 1;");
    // 另一无关文件（假定已由"死 import 清理"移除引用，不再 import verify_refactor）
    fs.writeFileSync(path.join(dir, 'sub', 'other.ts'), 'export const z = 2;');
    const scanned = ['sub/live.ts', 'sub/other.ts'];
    expect(remainingImporters(dir, 'tools/verify_refactor.ts', scanned)).toBe(1);
  });

  it('确无任何 importer → 计数 0，可物理删', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'legacy'));
    fs.writeFileSync(path.join(dir, 'legacy', 'old.ts'), 'export const O = 1;');
    fs.mkdirSync(path.join(dir, 'a'));
    fs.writeFileSync(path.join(dir, 'a', 'x.ts'), 'export const X = 1;'); // 无人 import old.ts
    const scanned = ['a/x.ts'];
    expect(remainingImporters(dir, 'legacy/old.ts', scanned)).toBe(0);
  });

  it('自身文件不算 importer', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'legacy'));
    fs.writeFileSync(path.join(dir, 'legacy', 'old.ts'), 'export const O = 1;');
    const scanned = ['legacy/old.ts'];
    expect(remainingImporters(dir, 'legacy/old.ts', scanned)).toBe(0);
  });
});

describe('hasActiveReference（活跃消费确认，候选清单可信任的闸门）', () => {
  it('被别处真正使用（活 import）→ true，不是可下线积木', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'renderers'));
    fs.writeFileSync(path.join(dir, 'renderers', 'ImageRenderer.tsx'), 'export const ImageRenderer = () => null;');
    // 活跃消费者：在规约文件里把它加进注册表使用 → 模块有活跃消费
    fs.writeFileSync(
      path.join(dir, 'PetManager.ts'),
      "import { ImageRenderer } from './renderers/ImageRenderer';\nexport const R = { img: ImageRenderer };\n",
    );
    const scanned = ['renderers/ImageRenderer.tsx', 'PetManager.ts'];
    expect(hasActiveReference(dir, 'renderers/ImageRenderer.tsx', scanned)).toBe(true);
  });

  it('仅被死引用（import 但未使用）→ false，真可下线', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'legacy'));
    fs.writeFileSync(path.join(dir, 'legacy', 'old.ts'), 'export const O = 1;');
    fs.writeFileSync(path.join(dir, 'use.ts'), "import { O } from './legacy/old';\nexport const tag = 1;\n");
    const scanned = ['legacy/old.ts', 'use.ts'];
    expect(hasActiveReference(dir, 'legacy/old.ts', scanned)).toBe(false);
  });

  it('scanned 传绝对路径时仍能判定活跃消费（回归：path.join 对绝对路径不重置，漏归一化曾死亡路径读不到文件 → 闸门恒 false）', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'renderers'));
    fs.writeFileSync(path.join(dir, 'renderers', 'ImageRenderer.tsx'), 'export const ImageRenderer = () => null;');
    fs.writeFileSync(
      path.join(dir, 'PetManager.ts'),
      "import { ImageRenderer } from './renderers/ImageRenderer';\nexport const R = { img: ImageRenderer };\n",
    );
    // 模拟 scanProjectSourceFiles 无 files 时返回的绝对路径形式
    const scanned = [path.join(dir, 'renderers', 'ImageRenderer.tsx'), path.join(dir, 'PetManager.ts')];
    expect(hasActiveReference(dir, 'renderers/ImageRenderer.tsx', scanned)).toBe(true);
  });

  it('无任何引用 → false（自身文件不算）', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'legacy'));
    fs.writeFileSync(path.join(dir, 'legacy', 'old.ts'), 'export const O = 1;');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const A = 1;');
    const scanned = ['legacy/old.ts', 'a.ts'];
    expect(hasActiveReference(dir, 'legacy/old.ts', scanned)).toBe(false);
  });
});

afterAll(() => {
  /* 临时目录由 OS 清理 */
});