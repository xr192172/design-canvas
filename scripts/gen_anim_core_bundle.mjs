/**
 * 构建期代码生成：纯逻辑模块 → 可内联进浏览器 IIFE 的字符串常量
 *
 * 流程（对每个模块）：
 *   1. 读取 src/renderer/<module>.ts（纯逻辑单源）
 *   2. TypeScript transpileModule 编译为 ES2015（保留 export 关键字）
 *   3. 正则剥离 export（生成物将被内联进浏览器 IIFE，不需要模块语法）
 *   4. 写入 src/renderer/<module>_bundle.gen.ts（字符串常量 <NAME>_SOURCE）
 *
 * 由 npm run build 自动执行；生成物入库，保证 vitest / 干净 clone 可直接运行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** [源文件, 输出文件, 导出的常量名] */
const MODULES = [
  ['anim_core.ts', 'anim_core_bundle.gen.ts', 'ANIM_CORE_SOURCE'],
  ['edge_geom.ts', 'edge_geom_bundle.gen.ts', 'EDGE_GEOM_SOURCE'],
  ['dataflow_core.ts', 'dataflow_core_bundle.gen.ts', 'DATAFLOW_SOURCE'],
];

for (const [srcName, outName, constName] of MODULES) {
  const srcFile = path.join(root, 'src', 'renderer', srcName);
  const outFile = path.join(root, 'src', 'renderer', outName);

  const src = fs.readFileSync(srcFile, 'utf-8');
  const { outputText, diagnostics } = ts.transpileModule(src, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2015,
      // 必须显式 ES2015：ModuleKind.None(0) 是 falsy，会被归一化为默认 CommonJS，
      // 生成 exports.xxx 引用，在浏览器 IIFE 中 ReferenceError
      module: ts.ModuleKind.ES2015,
      removeComments: false,
    },
    fileName: srcName,
    reportDiagnostics: true,
  });

  const errors = (diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    for (const d of errors) {
      console.error('[gen] transpile error:', ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    }
    process.exit(1);
  }

  // 剥离 ESM export：transpile 后 export 保留为 `export function/const/class` 前缀
  const stripped = outputText
    .replace(/^export\s+(?=(function|const|let|var|class)\s)/gm, '')
    .replace(/^export\s+(?=(interface|type)\s)/gm, '') // 保险：interface 通常被 transpile 移除
    .replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '');

  const banner =
    '/**\n' +
    ` * 自动生成，请勿手改。来源：src/renderer/${srcName}\n` +
    ' * 由 scripts/gen_anim_core_bundle.mjs 在 npm run build 时生成\n' +
    ' */\n';

  fs.writeFileSync(outFile, banner + `export const ${constName} = ` + JSON.stringify(stripped) + ';\n', 'utf-8');
  console.log(`[gen] ${outName} written, ${stripped.length} chars inlined`);
}
