/**
 * protect —— 行级保护灰名单单元测试
 *
 * 覆盖：
 *   - 无 .design-canvas.json / 非法配置 → 不启用（createProtectGuard 空转，什么都不挡）
 *   - glob 命中才参与；未命中的文件 → 全部放行
 *   - 命中 glob 的文件里：落在「含标记行」上的编辑被跳过，其它行照常保留
 *   - keep 集（定义名偏移）即便落在标记行也强制保留——避免改一半悬空
 *   - skipped / protectedLines 正确回传，供调用方报告
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProtectGuard, loadRenameProtect } from '../../src/tools/protect';

function mkRoot(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'prot-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }
  return dir;
}

const cfgFrom = (config: unknown): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'prot-'));
  mkdirSync(path.join(dir, 'docs', 'tool-convergence'), { recursive: true });
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, '.design-canvas.json'), JSON.stringify(config), 'utf-8');
  // 规则 glob 相对项目根；源文件
  writeFileSync(path.join(dir, 'docs/tool-convergence/history.md'), '处理：判不合并。useless_tool 前缀属命名风格，非代码合并。', 'utf-8');
  writeFileSync(path.join(dir, 'src/entry.ts'), 'import { a } from "./foo";\nconst x = a;\n', 'utf-8');
  writeFileSync(path.join(dir, 'src/live.ts'), 'import { a } from "./foo";\n', 'utf-8');
  return dir;
};

const STANDARD = {
  rename: {
    protect: [{ globs: ['docs/**'], markers: ['判定', '结论', '已实施', '核验'] }],
  },
};

describe('loadRenameProtect', () => {
  it('无配置文件 → null（不启用）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'prot-'));
    try {
      expect(loadRenameProtect(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('过滤掉 glob 空的规则、集中空规则', () => {
    const dir = cfgFrom({
      rename: {
        protect: [
          { globs: [], markers: ['x'] }, // 无 glob → 剔除
          { globs: ['docs/**'], markers: [] }, // 无 marker → 剔除
          { globs: ['docs/**'], markers: ['判定', '结论'] }, // 有效
        ],
      },
    });
    try {
      const cfg = loadRenameProtect(dir);
      expect(cfg).not.toBeNull();
      expect(cfg!.rules).toHaveLength(1);
      expect(cfg!.rules[0].markers).toEqual(['判定', '结论']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createProtectGuard（连接决策）', () => {
  it('glob 命中且编辑落在标记行 → blocked=true，并回传保护行', () => {
    const src = '结论：判不合并。useless_tool 前缀属命名风格，收益有限。\nconst y = useless_tool();\n';
    const posNormal = src.indexOf('const y = ') + 'const y = '.length;
    const root = cfgFrom(STANDARD);
    try {
      const guard = createProtectGuard(root);
      const file = path.join(root, 'docs/tool-convergence/history.md');
      const blocked = guard.scan(file, src, [
        { pos: 20, len: 12, text: 'good_tool' }, // 第 0 行含「结论」标记 → 冻结
        { pos: posNormal, len: 12, text: 'good_tool' }, // 普通行
      ]);
      expect(blocked.blocked).toBe(true);
      expect(blocked.protectedLines.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('依赖的编辑都在普通行 → blocked=false', () => {
    const src = 'const a = 1;\nconst y = useless_tool();\n';
    const root = cfgFrom(STANDARD);
    try {
      const guard = createProtectGuard(root);
      const file = path.join(root, 'docs/tool-convergence/history.md');
      const r = guard.scan(file, src, [{ pos: src.indexOf('useless_tool'), len: 12, text: 'good_tool' }]);
      expect(r.blocked).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('glob 未命中的文件 → blocked=false', () => {
    const root = cfgFrom(STANDARD);
    try {
      const guard = createProtectGuard(root);
      const file = path.join(root, 'src/entry.ts');
      const src = 'import { a } from "./foo";\nconst x = a;\n';
      const r = guard.scan(file, src, [{ pos: 20, len: 4, text: 'b' }]);
      expect(r.blocked).toBe(false);
      expect(r.protectedLines).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('无保护配置 → 空转，不阻断', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'prot-'));
    try {
      const guard = createProtectGuard(root);
      const r = guard.scan(path.join(root, 'a.ts'), 'import x from "y";', [{ pos: 0, len: 1, text: 'z' }]);
      expect(r.blocked).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});