import { extractFunctionCfg } from '../dist/src/tools/ts_kernel/cfg.js';

const TS = `export function grade(score: number): string {
  let label = '';
  if (score >= 60) {
    label = 'pass';
  } else {
    label = 'fail';
  }
  let n = 0;
  while (n < score) {
    n += 10;
  }
  return label;
}
`;

const cfg = await extractFunctionCfg('g.ts', TS, 'grade');
console.log(JSON.stringify(cfg, null, 1));
