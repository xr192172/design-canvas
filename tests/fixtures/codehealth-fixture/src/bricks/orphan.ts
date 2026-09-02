// code_health 夹具 · 孤立模块：无任何项目内消费者 → 孤儿文件 + 未使用导出
export function legacyHelper(x: number): number {
  return x * 2;
}
