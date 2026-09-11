/**
 * tool —— translate_go_ts MCP handler 测试（走确定性骨架路径，不发 LLM/不跑 go）
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { translateGoTsHandler } from '../../src/translate/tool.js';

function tmpGo(src: string): string {
  const p = path.join(os.tmpdir(), `dc-tr-tool-${Date.now()}-${Math.random().toString(36).slice(2)}.go`);
  fs.writeFileSync(p, src, 'utf-8');
  return p;
}

describe('translate_go_ts tool handler', () => {
  it('默认骨架：读 Go 文件 → 输出 TS 骨架 + 单元数，列含函数/接口', async () => {
    const file = tmpGo(`package calc
func Add(a, b int) int {
\treturn a + b
}
type User struct { Name string }
`);
    try {
      const r = await translateGoTsHandler({ file });
      expect(r.data).toBeTruthy();
      expect((r.data as { output: string }).output).toContain('export function Add(a: number, b: number): number');
      expect((r.data as { output: string }).output).toContain('export interface User');
      expect(r.message).toContain('2 个单元');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('file 缺失 → 友好报错', async () => {
    const r = await translateGoTsHandler({ file: path.join(os.tmpdir(), 'no_such_file_xyz.go') });
    expect(r.message).toContain('不存在');
  });
});