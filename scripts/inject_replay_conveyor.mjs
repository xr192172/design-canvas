// D3 实测：对真实 examples/conveyor.json 跑 inject_replay 全场景
// 用法：npm run build && node scripts/inject_replay_conveyor.mjs
// 活态文件：脚本末尾自动恢复备份（上次 derive 冒烟的教训）
import fs from 'node:fs';
import { saveDSL, getLiveDslFile } from '../dist/src/storage.js';
import { injectReplay } from '../dist/src/tools/inject_replay.js';

const live = getLiveDslFile();
const bak = live + '.bak-inject';
let hadLive = false;
if (fs.existsSync(live)) {
  const cur = JSON.parse(fs.readFileSync(live, 'utf-8'));
  if (cur.feature !== 'conveyor') {
    fs.copyFileSync(live, bak);
    hadLive = true;
  }
}

try {
  // 加载 conveyor 示例进 home
  const conveyor = JSON.parse(fs.readFileSync('examples/conveyor.json', 'utf-8'));
  saveDSL(conveyor);
  console.log('[setup] conveyor 示例已加载\n');

  const scenes = [
    ['1. 列出预设场景', { list_presets: true }],
    ['2. preset=ErrBudgetExceeded（已声明 expected）', { preset: 'ErrBudgetExceeded' }],
    ['3. preset=panic（已声明 unexpected）', { preset: 'panic' }],
    ['4. 正常值 + 预算内 → 绿分支', {
      inject: { compose: 'ok', tokens: 1200 },
      value: { sections: [{ tokens: 5000 }], tokenBudget: 128000 },
    }],
    ['5. 正常值 + 超 80% 预算 → 红分支（PulseEvict）', {
      inject: { compose: 'ok', tokens: 1200 },
      value: { sections: [{ tokens: 110000 }], tokenBudget: 128000 },
    }],
    ['6. 未声明异常 NETWORK_TIMEOUT → bug 警报', {
      inject: { error: { code: 'NETWORK_TIMEOUT', message: '检索超时' } },
    }],
  ];

  for (const [title, args] of scenes) {
    console.log(`━━━ ${title} ━━━`);
    const r = injectReplay({ feature: 'conveyor', flow_id: 'flow_budget_check', ...args });
    console.log(r.message);
    console.log();
  }
} finally {
  // 恢复活态文件
  if (hadLive && fs.existsSync(bak)) {
    fs.copyFileSync(bak, live);
    fs.unlinkSync(bak);
    console.log('[restore] 活态文件已恢复');
  }
}
