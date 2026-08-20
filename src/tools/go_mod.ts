/**
 * go_mod —— go.mod require 解析与三方依赖归并（积木重依赖治理 Phase 5+）
 *
 * 版本事实单一来源纪律（"LLM 不产生事实"在依赖版本上的落点）：
 *   版本不猜、不查网、不升版——唯一来源是**源项目 go.mod 的 require 块**。
 *   入盒时存档（manifest.go_mod_requires，harvest_from_url），
 *   拼装时原样复用（assemble_bricks 自动生成 require）；
 *   存档缺项 → 进 pending 清单待人/LLM 补（decline rather than guess）。
 *
 * 诚实边界：
 *   - 只认根 go.mod 的 require（单行 + 括号块；含 indirect——间接依赖也是版本事实）；
 *     replace/exclude 指令不解析（本地 replace 场景存不了版本，归并不上自然进 pending）
 *   - go.sum 不生成——需要 go 工具链算哈希，拼装区跑 `go mod tidy` 补
 */

/**
 * 解析 go.mod 的全部 require（module → version）。
 * 兼容形态：单行 require / 括号块（gofmt 标准）/ 行内 `// indirect` 注释 /
 * 伪版本（v0.0.0-20230101000000-abcdef123456）。
 */
export function parseGoModRequires(text: string): Record<string, string> {
  const requires: Record<string, string> = {};
  let inBlock = false;
  for (const rawLine of text.split('\n')) {
    // 去行注释（含 // indirect）——Go module 路径与版本串均不含 //
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (inBlock) {
      if (line === ')') {
        inBlock = false;
        continue;
      }
      const m = line.match(/^(?:[A-Za-z_][A-Za-z0-9_.]*\s+)?(\S+)\s+(v\S+)$/);
      if (m) requires[m[1]] = m[2];
      continue;
    }
    const single = line.match(/^require\s+(?:[A-Za-z_][A-Za-z0-9_.]*\s+)?(\S+)\s+(v\S+)$/);
    if (single) {
      requires[single[1]] = single[2];
      continue;
    }
    if (/^require\s*\(/.test(line)) {
      inBlock = true;
      continue;
    }
  }
  return requires;
}

/**
 * 把闭包三方 import source 归并到 require module root（最长段对齐前缀）：
 *   github.com/openai/openai-go/v3/option
 *     → github.com/openai/openai-go/v3（require 项命中即止）
 * source 本身在 requires 里时用自己；多个 source 归并到同一 root 只记一次；
 * 逐级去尾段仍无命中 → 进 unresolved（pending，不猜）。
 */
export function resolveGoThirdParty(
  sources: string[],
  requires: Record<string, string>,
): { resolved: Record<string, string>; unresolved: string[] } {
  const resolved: Record<string, string> = {};
  const unresolved: string[] = [];
  for (const src of sources) {
    let hit: string | null = null;
    let cur = src;
    for (;;) {
      if (requires[cur] !== undefined) {
        hit = cur;
        break;
      }
      const i = cur.lastIndexOf('/');
      if (i < 0) break;
      cur = cur.slice(0, i);
    }
    if (hit) resolved[hit] = requires[hit];
    else unresolved.push(src);
  }
  return { resolved, unresolved };
}

/**
 * Go 语义版本比较（近似 MVS）：主/次/修订数值比较；同主版本下
 * 无 prerelease > 有 prerelease；伪版本（v0.0.0-时间戳-hash）按时间戳比。
 * 返回正数 = a 更高。
 */
export function compareGoVersion(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[-+]/);
  const pb = b.replace(/^v/, '').split(/[-+]/);
  const na = pa[0].split('.').map((s) => parseInt(s, 10) || 0);
  const nb = pb[0].split('.').map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = na[i] ?? 0;
    const y = nb[i] ?? 0;
    if (x !== y) return x - y;
  }
  const preA = pa[1];
  const preB = pb[1];
  if (!preA && !preB) return 0;
  if (!preA) return 1; // 无 prerelease 者高
  if (!preB) return -1;
  return preA < preB ? -1 : preA > preB ? 1 : 0; // 时间戳字典序 = 时间序
}
