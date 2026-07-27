// 验证 byNoExt 碰撞检测 + .gen.ts 排除
// 用法: node scripts/verify_collide.mjs
import fs from 'node:fs';
import path from 'node:path';

process.env.DESIGN_CANVAS_HOME = path.resolve('.tmp_collide');

fs.mkdirSync('.tmp_collide_proj/src', { recursive: true });
fs.writeFileSync('.tmp_collide_proj/src/foo.ts', 'export function fooTs(): number { return 1 }');
fs.writeFileSync('.tmp_collide_proj/src/foo.js', 'export function fooJs() { return 2 }');
fs.writeFileSync(
  '.tmp_collide_proj/src/user.ts',
  'import { fooTs } from "./foo.js";\nexport function useIt(): number { return fooTs() }',
);

const { importProject } = await import('../dist/src/tools/import_project.js');
const { getDSL } = await import('../dist/src/storage.js');

const r = await importProject({ project_dir: '.tmp_collide_proj', feature: 'collide_test' });
console.log(r.message);
console.log('SKIPPED:', JSON.stringify(r.skipped, null, 1));

const dsl = getDSL('collide_test');
const depEdges = dsl.geometry.edges.filter((e) => e.id.startsWith('dep_'));
console.log('DEP EDGES:', depEdges.map((e) => `${e.from} -> ${e.to}`));

const okCollision = r.skipped.some((s) => s.includes('同名碰撞') && s.includes('foo.js'));
// user.ts import './foo.js' 应解析到 foo.ts（.ts 优先级高于 .js）
const okResolve = depEdges.some((e) => e.from.includes('user') && e.to.includes('foo_ts'));
console.log(okCollision ? '[ok] 碰撞已记录' : '[FAIL] 碰撞未记录');
console.log(okResolve ? '[ok] ./foo.js 解析到 foo.ts' : '[FAIL] 解析目标错误');

fs.rmSync('.tmp_collide', { recursive: true, force: true });
fs.rmSync('.tmp_collide_proj', { recursive: true, force: true });
if (!okCollision || !okResolve) process.exit(1);
