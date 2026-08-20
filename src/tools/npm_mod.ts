/**
 * npm_mod —— package.json 依赖存档与三方依赖归并（TS 积木依赖治理，
 * 对标 go_mod 的 Phase 5+ 纪律）
 *
 * 版本事实单一来源纪律（"LLM 不产生事实"在依赖版本上的落点）：
 *   版本不猜、不查网、不升版——唯一来源是**源项目 package.json 的
 *   dependencies 块**。入盒时存档（manifest.npm_requires，
 *   harvest_from_url），拼装时原样复用（assemble_bricks 自动生成
 *   package.json）；存档缺项 → 进 pending 清单待人/LLM 补
 *   （decline rather than guess）。
 *
 * monorepo 事实：依赖不一定在根 package.json（pnpm workspace 的
 *   dependencies 挂在各子包）——按闭包文件**最近祖先 package.json**
 *   收集，近者优先（子包版本覆盖根版本），根兜底。
 *
 * 诚实边界：
 *   - workspace:/file:/link:/git+ 等非 registry 协议版本装不进拼装区
 *     （离开源 monorepo 无解）→ 拼装时进 pending，不猜替代版本
 *   - 版本形态原样存档（^7.0.5 / ~7.1.0 / 7.2.0 保留 range 语义），
 *     比较只取 base 版本数值；MVS 取高后写入的是赢家的原始 spec
 *   - overrides/resolutions 字段不解析（锁文件语义超出存档范围）
 */

/** package.json 的依赖字段并集（同名冲突时 dependencies > peer > dev）。
 *  只提版本事实不筛用途：解析是按需的（闭包真 import 的包才被问到），
 *  devDependencies 进档无害——types 包等编译期依赖在拼装区 tsc 时有用 */
export function parseNpmDeps(pkgJson: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof pkgJson !== 'object' || pkgJson === null) return out;
  for (const field of ['devDependencies', 'peerDependencies', 'dependencies'] as const) {
    const block = (pkgJson as Record<string, unknown>)[field];
    if (typeof block !== 'object' || block === null) continue;
    for (const [name, ver] of Object.entries(block)) {
      if (typeof ver === 'string') out[name] = ver; // 后写覆盖：dependencies 最后写 = 最高优先
    }
  }
  return out;
}

/** bare import source → npm 包名归并：
 *  '@scope/pkg/sub' → '@scope/pkg'（前两段）；'pkg/sub' → 'pkg'（首段）。
 *  source 本身即包名时用自己；包名不在 requires → unresolved（不猜） */
export function resolveNpmThirdParty(
  sources: string[],
  requires: Record<string, string>,
): { resolved: Record<string, string>; unresolved: string[] } {
  const resolved: Record<string, string> = {};
  const unresolved: string[] = [];
  for (const src of sources) {
    const segs = src.split('/');
    const pkg = src.startsWith('@') ? segs.slice(0, 2).join('/') : segs[0];
    if (requires[pkg] !== undefined) resolved[pkg] = requires[pkg];
    else unresolved.push(src);
  }
  return { resolved, unresolved };
}

/** 非 registry 协议版本（workspace:/file:/link:/git+）：离开源仓库无解 */
export function isNonRegistrySpec(spec: string): boolean {
  return /^(workspace|file|link|git\+|https?:\/\/)/.test(spec);
}

/** npm 语义版本比较（近似 MVS）：剥 range 操作符（^ ~ >= <= > < = v）后
 *  主/次/修订数值比较；无 prerelease > 有 prerelease。
 *  返回正数 = a 更高 */
export function compareNpmVersion(a: string, b: string): number {
  const base = (s: string) => s.trim().replace(/^[\^~>=<v]+/, '').split(/[-+]/)[0];
  const pre = (s: string) => s.trim().split(/[-+]/)[1];
  const na = base(a).split('.').map((s) => parseInt(s, 10) || 0);
  const nb = base(b).split('.').map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = na[i] ?? 0;
    const y = nb[i] ?? 0;
    if (x !== y) return x - y;
  }
  const pa = pre(a);
  const pb = pre(b);
  if (!pa && !pb) return 0;
  if (!pa) return 1; // 无 prerelease 者高
  if (!pb) return -1;
  return pa < pb ? -1 : pa > pb ? 1 : 0;
}
