// main.mjs — 在线插桩验证样例：一次"操作"，outer → inner → inner2。
export function inner2(x) {
  return x * 3;
}

export function inner(x) {
  const scaled = inner2(x);
  return scaled + 1;
}

export function outer(input) {
  const a = inner(input);
  const b = inner2(input);
  console.log('outer result', a, b);
  return a + b;
}

// 在线插桩验证：直接跑一次链（演示入口）
outer(2);