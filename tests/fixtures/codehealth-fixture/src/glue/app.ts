// code_health 夹具 · 胶水层：入口，消费积木与契约（正常依赖方向：胶水 → 积木/契约）
// 真实入口模式：run() 函数体内调用积木（建调用边）+ 文件底部模块级自调用（文本兜底算引用）
// → 不产生未使用导出；胶水层自身跳过孤儿判定 → 零问题
import { User } from '../contracts/models';
import { computeScore, superComplex } from '../bricks/user_service';

function run(): void {
  const u: User = { id: 7, name: 'ada' };
  console.log(`score=${computeScore(u)}`);
  console.log(`complex=${superComplex(10)}`);
}

void run();
