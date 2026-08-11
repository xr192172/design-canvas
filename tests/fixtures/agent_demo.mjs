// traceReasoning 测试 fixture：ESM 模块，类方法链（内部 this.method() 调用）
// 用于验证零接触自动插桩：入口 free 函数 + Worker 类方法链被原型包装拦截。

export function entry(input) {
  const worker = new Worker();
  const result = worker.process(input);
  return result;
}

export class Worker {
  process(input) {
    const cleaned = this.validate(input);
    const ctx = this.retrieve(cleaned);
    return this.compose(ctx);
  }

  validate(raw) {
    return { name: String(raw), ok: true };
  }

  retrieve(query) {
    const hits = [query.name, 'dependency-a', 'dependency-b'];
    return { hits, budget: 8000 };
  }

  compose(ctx) {
    const prompt = ctx.hits.join(' + ');
    return { prompt, totalTokens: ctx.hits.length * 1200 };
  }
}