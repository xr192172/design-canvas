import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../../src/tools/serve';

const PORT = 39777;
const BASE = `http://127.0.0.1:${PORT}`;

describe('chain-exec 端到端', () => {
  let tmp: string;
  afterAll(() => { try { fs.rmSync(tmp!, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('POST /api/chain-exec：函数级步骤整链串联真执行（上一步出参→下一步入参）', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cnx_'));
    fs.writeFileSync(path.join(tmp, 'a.ts'), `export function a(x: number): number { return x + 1; }\n`, 'utf-8');
    fs.writeFileSync(path.join(tmp, 'b.ts'), `export function b(y: number): number { return y * 2; }\n`, 'utf-8');
    await startServer(PORT);
    const res = await fetch(`${BASE}/api/chain-exec?project_dir=${encodeURIComponent(tmp)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feature: 'scan_verify',
        steps: [
          { id: 'a.ts#a', func: 'a', file: 'a.ts' },
          { id: 'b.ts#b', func: 'b', file: 'b.ts' },
        ],
        input_value: 2,
      }),
    });
    expect(res.ok).toBe(true);
    const d = await res.json();
    expect(d.success).toBe(true);
    expect(d.steps.length).toBe(2);
    expect(d.steps[0].node_id).toBe('a.ts#a');
    expect(d.entryParams).toContain('x');
    // 链式：a(2)=3 → b(3)=6
    expect(d.steps[0].out_value).toBe(3);
    expect(d.steps[1].in_value).toBe(3);
    expect(d.steps[1].out_value).toBe(6);
  }, 20000);

  it('缺 steps 或文件不存在 → 明确 400', async () => {
    const r1 = await fetch(`${BASE}/api/chain-exec`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feature: 'x' }),
    });
    expect(r1.status).toBe(400);
    const r2 = await fetch(`${BASE}/api/chain-exec?project_dir=${encodeURIComponent(tmp)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feature: 'x', steps: [{ id: 'nope.ts#f', func: 'f', file: 'nope.ts' }] }),
    });
    expect(r2.status).toBe(400);
  }, 20000);
});