import { describe, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcileChain } from '../../src/tools/reconcile_chain';
import { saveDSL } from '../../src/storage';

describe('reconcile_chain e2e（中观档：派生 → 缓存 → 事件对账）', () => {
  it('对真实源文件 observe/chain.ts 跑通全管线', async () => {
    // 自建临时 feature：宿主节点指向真实源文件（绝对路径）
    const feature = 'cr_e2e';
    const nodeId = 'file_chain_ts';
    const realFile = path.resolve('src/observe/chain.ts');
    saveDSL({
      feature,
      title: 'reconcile_chain e2e',
      geometry: { nodes: [{ id: nodeId, label: 'chain.ts', x: 0, y: 0, width: 220, height: 60, layer: 'file' }], edges: [] },
      semantic: { files: [{ id: nodeId, path: realFile }] },
      source_root: process.cwd(),
    });
    const projectDir = process.cwd(); // 无 .agent/observe → 空事件，验证 not_run

    // 阶段1：无事件 → 自动派生（后工具自动前置），not_run 诚实标注
    const r1 = await reconcileChain({ feature, node_id: nodeId, project_dir: projectDir });
    console.log('\n[R1 自动派生] derive=' + r1.derive + ' not_run=' + r1.not_run + ' status=' + r1.chain_match.status + ' 链步数=' + r1.chain.length);
    console.log('  声明链：' + r1.chain.map((c) => c.name).join(' → '));

    // 阶段2：再跑一次 → 命中缓存跳过派生
    const r2 = await reconcileChain({ feature, node_id: nodeId, project_dir: projectDir });
    console.log('[R2 缓存命中] derive=' + r2.derive + '（应 cached）');

    // 阶段3：构造该链真跑事件（满足子序列 + 注入一条静默吞错偏差）
    const want = r2.chain.map((c) => c.name);
    const events = want.map((n, i) => ({
      trace_id: 't1',
      frame_id: i + 1,
      probe: 'observe.chain.' + n,
      time: new Date(Date.now() + i * 1000).toISOString(),
      fields: {
        file: 'src/observe/chain.ts',
        ...(i === 0 ? { op: 'writefile', err: 'disk full', benign: false } : { err: '', benign: true }),
      },
    }));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr_e2e_'));
    const ef = path.join(tmp, 'events.jsonl');
    fs.writeFileSync(ef, events.map((l) => JSON.stringify(l)).join('\n'));
    const r3 = await reconcileChain({ feature, node_id: nodeId, project_dir: projectDir, events_files: [ef] });
    console.log('[R3 事件对账] derive=' + r3.derive + ' not_run=' + r3.not_run +
      ' status=' + r3.chain_match.status + ' matched=' + r3.chain_match.matched +
      ' 偏差=' + r3.deviations.length + ' 实测链=' + r3.observed.length);
    console.log('---R3 message---\n' + r3.message);
  }, 60000);
});