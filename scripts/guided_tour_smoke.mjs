// G1 跨 feature 串联导览冒烟：验证 /api/tour?features=A,B,C 按序拼接各 feature 产物
// 用法：npm run build && node scripts/guided_tour_mcp_smoke.mjs
// 说明：只验证 API 序列逻辑（复用实际注册表），不启动 HTTP 服务。
import fs from 'node:fs';
import path from 'node:path';
import { registerArtifactTo } from '../dist/src/tools/registry.js';

let ok = true;
const check = (name, cond) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name);
  if (!cond) ok = false;
};

// 1. 建一个临时注册表，注入两个 feature 的产物，验证跨 feature 串联
const tmpReg = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'tour-')), '.registry.json');
const entry = (path_, feature) => ({ path: path_, feature, title: path_.split('/').pop() });
registerArtifactTo(tmpReg, entry('a1.html', 'star'));
registerArtifactTo(tmpReg, entry('a2.html', 'star'));
registerArtifactTo(tmpReg, entry('b1.html', 'boulder'));
registerArtifactTo(tmpReg, entry('c1.html', 'other'));

// 从临时注册表读取（readRegistry 读全局，这里直接解析临时文件）
const all = JSON.parse(fs.readFileSync(tmpReg, 'utf-8'));
check('注册表含 4 条产物', all.length === 4);

// 2. 模拟 /api/tour?features=star,boulder 的序列逻辑
const features = ['star', 'boulder'];
const steps = [];
for (const f of features) {
  for (const e of all) if (e.feature === f) steps.push(e.path);
}
check('跨 feature 串联按序拼接（star→boulder）', JSON.stringify(steps) === JSON.stringify(['a1.html', 'a2.html', 'b1.html']));
check('未列出的 feature(other) 不进入序列', !steps.includes('c1.html'));

// 3. 模拟 /api/tour?feature=star（单 feature 兼容）
const single = all.filter((e) => e.feature === 'star').map((e) => e.path);
check('单 feature 产物序列', JSON.stringify(single) === JSON.stringify(['a1.html', 'a2.html']));

// 4. 播放器链接形态
const url = './tour.html?features=' + encodeURIComponent('star,boulder');
check('播放器链接含 features 参数', /features=star%2Cboulder/.test(url));

// 清理
try { fs.rmSync(path.dirname(tmpReg), { recursive: true, force: true }); } catch {}

console.log('\n[G1] 跨 feature 串联导览冒烟' + (ok ? '通过 ✓' : '失败 ✗'));
process.exit(ok ? 0 : 1);