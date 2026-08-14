/**
 * status_demo 真实 save 场景（供 Camera 全自动插桩狗食验证）
 *
 * 这是 status_demo 里唯一真实可运行的数据流：接收一个要保存的数据，
 * 写盘到 .data 目录，返回结果。含一个会静默丢弃错误的 catch 块——
 * 全自动插桩器应在此注入 captureProbe，运行后采集到 catch 事件。
 */

import fs from 'node:fs';
import path from 'node:path';

export class SaveSink {
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /** 保存一条数据到磁盘。目录不存在则创建。 */
  save(key: string, payload: string): string {
    const file = path.join(this.dataDir, `${key}.json`);
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(file, payload, 'utf-8');
      return file;
    } catch (e) {
      // TODO: 静默丢弃——这里应是 Camera 探针要捕获的违规点
      return file;
    }
  }
}