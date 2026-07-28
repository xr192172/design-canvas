// 调试：查看 tree-sitter TS/Python 的 if alternative / elif 实际节点结构
import { parseAstRoot } from '../dist/src/tools/ts_kernel/kernel.js';

function dump(node, depth = 0, maxDepth = 7) {
  if (depth > maxDepth) return;
  const named = /^\w+$/.test(node.type);
  if (!named) return;
  console.log('  '.repeat(depth) + node.type + (depth <= 2 ? '' : ''));
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c) dump(c, depth + 1, maxDepth);
  }
}

const TS = `function f(x) { if (x > 1) { a(); } else { b(); } return 0; }`;
const PY = `def f(x):\n    if x > 100:\n        a()\n    elif x > 10:\n        b()\n    else:\n        c()\n    return 0\n`;

console.log('===== TS if/else =====');
const r1 = await parseAstRoot('g.ts', TS);
dump(r1.root);

console.log('===== Python elif =====');
const r2 = await parseAstRoot('f.py', PY);
dump(r2.root);

// field 探测
console.log('===== field 探测 =====');
const r3 = await parseAstRoot('g.ts', TS);
const fn = r3.root.child(0);
const ifNode = fn.childForFieldName('body').child(0);
console.log('TS if alternative field:', ifNode.childForFieldName('alternative')?.type ?? '(null)');
const r4 = await parseAstRoot('f.py', PY);
const pf = r4.root.child(0);
const pif = pf.childForFieldName('body').child(0);
const palt = pif.childForFieldName('alternative');
console.log('PY if alternative field:', palt?.type ?? '(null)');
if (palt) {
  console.log('PY alt.condition:', palt.childForFieldName('condition')?.text ?? '(null)');
  console.log('PY alt.consequence:', palt.childForFieldName('consequence')?.type ?? '(null)');
  console.log('PY alt.alternative:', palt.childForFieldName('alternative')?.type ?? '(null)');
}
