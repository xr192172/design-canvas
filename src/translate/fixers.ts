/**
 * fixers —— C1 内建 deterministic fixer（翻译产物后处理通道）
 *
 * 背景：实测对整仓翻译产物，用户靠 40 个手写 `fix_*.cjs`（const→let、去未用 import、
 * 合 import、转义等）层层叠加才压过编译——"改错→打补丁→再改错"失控。
 * C1 目标是把这些**可机械判定的高频错**内建于翻译器、幂等地一次修完，
 * 而不是等人在产物上叠脚本。
 *
 * 原则：只做确定性、可证明、幂等的改写（不动语义）；改不动就保持原样。
 * 与 verify 闸的关系：fixer 在"组装/落盘"前跑，产出更干净的模块；verify 仍负责拦截坏产物。
 */

/**
 * 去除未使用的 import：对每个 `import { A, B } from 'm'`，A/B 只要不在"非 import 体"
 * 中出现就删；整条全删为空则移除该行。别名 `A as AA` 按本地名 AA 判断使用，重建时保留原说明符。
 * 幂等（第二次跑无变化）。
 */
export function fixUnusedImports(source: string): string {
  const lines = source.split('\n');
  // 去 import 头后的"正文" → 用名字集合
  const body = lines.filter((l) => !/^\s*import\s*\{/.test(l)).join('\n');
  const re = /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/;
  const out: string[] = [];
  for (const line of lines) {
    const m = re.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const specifiers = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    const localOf = (spec: string): string => (/\s+as\s+([\w$]+)$/.exec(spec) ?? [])[1] ?? spec.replace(/[^\w$]/g, '');
    const kept = specifiers.filter((s) => new RegExp(`\\b${localOf(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(body));
    if (kept.length === 0) continue; // 整条 import 全未用 → 移除
    out.push(`import { ${kept.join(', ')} } from '${m[2]}';`);
  }
  return out.join('\n');
}

/**
 * 合并同源 import（去重 + 排序名字）：`import { A } from 'm'; import { B } from 'm';`
 * → `import { A, B } from 'm';`。幂等。
 */
export function squashImports(source: string): string {
  const bySource = new Map<string, string[]>();
  const other: string[] = [];
  for (const line of source.split('\n')) {
    const m = /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?$/.exec(line);
    if (m) {
      const names = m[1].split(',').map((s) => s.trim()).filter(Boolean);
      const existing = bySource.get(m[2]) ?? [];
      bySource.set(m[2], [...existing, ...names]);
    } else {
      other.push(line);
    }
  }
  const importLines: string[] = [];
  for (const [src, names] of bySource) {
    importLines.push(`import { ${[...new Set(names)].sort().join(', ')} } from '${src}';`);
  }
  // import 头放在最前，随后是其它行
  return [...importLines, ...other].join('\n');
}

/** 组合所有确定性 fixer（保持原有顺序；幂等） */
export function applyDeterministicFixers(source: string): string {
  return fixUnusedImports(squashImports(source));
}