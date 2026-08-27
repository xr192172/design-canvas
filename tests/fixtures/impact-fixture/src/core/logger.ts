// impact 夹具 · 底层核心：被 business 仅以 import 边消费
export function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[log] ${msg}`);
}
