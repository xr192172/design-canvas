/**
 * narration —— 叙事分镜纯函数（吸收 manim "声明式分镜叙事"：一个工序只讲一件事、靠进/出连续过渡）
 *
 * 纯函数、零副作用，供两条路复用：
 *   - narrate_step（MCP 工具）：把单条产线工序抽成可治理的叙事砖
 *   - derive_mind_map（思维导图生成）：给每个产线工序盒挂 meta.narration，前端点开看分镜
 *
 * 忠实纪律：facts 逐条引用真实数据形态（input/output 针脚，已是契约投影自代码签名），
 * 人话仅做名词翻译；绝不发明签名里没有的类型/流程。
 */

import type { TeachPin } from '../dsl/mindmap.js';

export interface NarrScene {
  /** 分镜标题（动宾，≤ 10 字） */
  title: string;
  /** 一镜人话：这镜发生什么、数据从哪到哪 */
  detail: string;
  /** 该镜引用的真实数据事实（针脚 tuple / 签名），忠实于契约投影 */
  facts: string[];
}

export interface ShapeLike {
  inputs: TeachPin[];
  outputs: TeachPin[];
}

/** 语言类型名 → 人话名词（词量大头是通用容器类型；其余回退类型本身） */
export const humanOf = (t: string): string => {
  const m: Record<string, string> = {
    string: '文本', int: '整数', int64: '整数', int32: '整数', float64: '浮点数', float32: '浮点数',
    bool: '布尔', boolean: '布尔', bytes: '字节流', '[]byte': '字节流', time: '时间点',
    Event: '事件', Events: '事件', EventMessage: '事件消息', error: '错误',
    ContextGraph: '上下文图', HubClient: '中心客户端', Sink: '输出端', Config: '配置',
  };
  return m[t] ?? t;
};

/** 进度：分镜事实必须逐条来自真实数据 */
function pinFacts(pins: TeachPin[]): string[] {
  return pins.map((p) => `${p.n}（${humanOf(p.t)}，类型 ${p.t}）`);
}

/**
 * 把一个工序的数据形态 + 名/讲解，build 成 manim 式三段分镜：
 *   「进料口 → 工序 → 出料口」，facts 逐条引用真实针脚（非 LLM 编造）。
 */
export function buildScenes(shape: ShapeLike | undefined, title: string, detail: string, signature?: string): NarrScene[] {
  const scenes: NarrScene[] = [];
  const inputs = shape?.inputs ?? [];
  const outputs = shape?.outputs ?? [];
  if (inputs.length > 0) {
    scenes.push({
      title: '进料口',
      detail: `本工序接收「${inputs.map((p) => p.n).join('、')}」作为输入。`,
      facts: pinFacts(inputs),
    });
  }
  scenes.push({
    title: title.slice(0, 10) || '工序',
    detail,
    facts: signature ? [`签名：${signature}`] : [],
  });
  if (outputs.length > 0) {
    scenes.push({
      title: '出料口',
      detail: `本工序吐出「${outputs.map((p) => p.n).join('、')}」作为产物。`,
      facts: pinFacts(outputs),
    });
  }
  if (scenes.length === 0) {
    scenes.push({ title: '工序', detail, facts: [] });
  }
  return scenes;
}