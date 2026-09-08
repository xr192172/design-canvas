// loader.mjs — ESM 在线插桩 loader hook。
// 被 bootstrap.mjs 通过 module.register 注册；对每个被加载的 ESM 模块做 scope 注入，
// 使 Agent 主体（@deepseek-ai/dsh 等产物）在运行时被在线插桩。
import { instrumentSource, shouldInstrument } from './transform_scope.mjs';

// 探针 import 的绝对 file:// URL，由 bootstrap 在 register 前经 DC_PROBE_URL 注入。
const probeUrl = process.env.DC_PROBE_URL || '';

/** 模块相对标识（探针名前缀），从 file:// URL 提取文件名 */
function labelOf(url) {
  try {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname).replace(/\\/g, '/');
    return p.split('/').pop()?.replace(/\.(js|mjs|ts)$/, '') || url;
  } catch {
    return url;
  }
}

export async function load(url, context, nextLoad) {
  console.error('LD', url);
  if (!shouldInstrument(url)) return nextLoad(url, context);
  const got = await nextLoad(url, context);
  console.error('DIAG', url.split('/').pop(), 'format=', got.format, 'sourceType=', typeof got.source);
  // 只跳过非 JS 模块（json/builtin/node）；entry 首次探测 format 可能为 undefined，照样注入
  if (got.format === 'json' || got.format === 'builtin' || got.format === 'node') return got;
  const src = typeof got.source === 'string' ? got.source : Buffer.from(got.source ?? '').toString('utf8');
  const label = labelOf(url);
  const { source, injected } = instrumentSource(src, label);
  if (injected === 0) return got;
  // 前置探针 import（ESM 允许 absolute file URL import）+ 运行时标记（验证加载器是否生效）
  const probed = `import { enterScope, exitScope } from ${JSON.stringify(probeUrl)};\nconsole.error('INSTRUMENTED', ${JSON.stringify(label)});\n${source}`;
  return { ...got, source: probed, format: got.format || 'module' };
}