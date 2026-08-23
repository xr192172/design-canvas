/**
 * narrate_step —— 叙事砖（吸收 manim "声明式分镜叙事" 设计，落地到「单条产线工序」）
 *
 * 从一个吃进什么 / 吐出什么的生产工序，生成一段人有节奏可看懂的叙事分镜：
 *   「进料口 → 工序 → 出料口」，三段式，数据形态（input/output 针脚）由契约投影
 *   （actual_apis[0] 签名 → projectSignature）产生，是代码事实、非 LLM 编造。
 *
 * 使用自有 MCP 抽取、登记为「砖」接入积木体系：
 *   - 盒内写 manifest.json（BrickManifest 契约，可被 search_bricks 检索）
 *   - DSL semantic 落一条 brick_narr_* 条目 → 思维导图「🧱 已验证积木」区自动出卡
 *
 * 忠实纪律：分镜的 facts 逐条引用真实针脚与签名；人话只做名词翻译，不发明类型/流程。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDSL, saveDSL, getStorageRoot } from '../storage.js';
import { projectSignature } from './derive_mind_map.js';
import { buildScenes, humanOf } from '../dsl/narration.js';
import type { NarrScene } from '../dsl/narration.js';
import type { TeachPin } from '../dsl/mindmap.js';
import type { BrickManifest } from '../dsl/contract.js';
import type { SemanticFile } from '../dsl/types.js';

export interface NarrateStepInput {
  /** feature 名 */
  feature: string;
  /** 工序涉及文件（相对路径，语义层锚点）；从 actual_apis[0] 契约投影取针脚 */
  file: string;
  /** 工序名（缺省取该文件 responsibility） */
  title?: string;
  /** 工序人话（缺省取该文件 responsibility） */
  detail?: string;
  /** false 只预演不落盘（不写砖不登记，默认 true） */
  write?: boolean;
}

export interface NarrateStepResult {
  feature: string;
  file: string;
  title: string;
  /** 数据形态（== 代码事实：契约投影自签名） */
  pins: { inputs: TeachPin[]; outputs: TeachPin[] };
  /** 叙事分镜序列（manim 式：连续过渡，只推进一件事） */
  scenes: NarrScene[];
  mode: 'rule' | 'llm';
  /** 登记的叙事砖（write=true 时有） */
  brick?: {
    id: string;
    name: string;
    manifest: string;
    message: string;
  };
  message: string;
}

/** 取语义层文件（精确 path 优先，退化路径末端匹配），供契约投影 */
function resolveSemanticFile(dsl: { semantic?: { files?: SemanticFile[] } }, file: string): SemanticFile | undefined {
  const files = dsl.semantic?.files ?? [];
  return files.find((f) => f.path === file)
    ?? files.find((f) => (f.path ?? '').endsWith('/' + file) || (f.path ?? '').endsWith('/' + path.basename(file)));
}

/** 契约投影：工序文件 actual_apis[0] 签名 → 输入/输出针脚（== 代码事实） */
function projectPins(sf: SemanticFile | undefined): { inputs: TeachPin[]; outputs: TeachPin[] } {
  if (!sf) return { inputs: [], outputs: [] };
  const sig = sf.actual_apis?.[0]?.signature ?? sf.expected_apis?.[0]?.signature;
  if (!sig) return { inputs: [], outputs: [] };
  const shape = projectSignature(sig);
  return shape ? { inputs: shape.ins, outputs: shape.outs } : { inputs: [], outputs: [] };
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'step';

export function narrateStep(input: NarrateStepInput): NarrateStepResult {
  const { feature, file } = input;
  const write = input.write !== false;
  const dsl = getDSL(feature);
  if (!dsl) throw new Error(`feature "${feature}" 不存在`);

  const sf = resolveSemanticFile(dsl, file);
  const pins = projectPins(sf);
  const responsibility = sf?.responsibility ?? '（该文件无可读职责）';
  const title = input.title || responsibility.split('（')[0] || path.basename(file);
  const detail = input.detail || responsibility;

  // ── 叙事分镜（manim 式：进料口→工序→出料口，facts 引真实契约投影数据）──
  const scenes: NarrScene[] = buildScenes(pins, title, detail, sf?.actual_apis?.[0]?.signature);

  // 钉死保证 + 显式宣告编造红线
  let message = `叙事砖已生成（${pins.inputs.length} 入 / ${pins.outputs.length} 出，模式=rule，数据形态=契约投影）`;
  let brick: NarrateStepResult['brick'];

  if (write) {
    // ── 1) 盒内登记：BrickManifest 契约（可被 search_bricks 检索）──
    const boxRoot = path.join(getStorageRoot(), 'bricks');
    const brickName = `${feature}-narr-${slug(file)}`;
    const brickDir = path.join(boxRoot, brickName);
    fs.mkdirSync(brickDir, { recursive: true });
    const manifest: BrickManifest = {
      name: brickName,
      schema_version: 1,
      description: `把「${title}」讲成人话的叙事砖：进料口→工序→出料口，数据形态来自契约投影（非 LLM 编造）。`,
      seed_files: [file],
      closure: { internal: [], external: [] },
      aggregate: {
        exposes: pins.inputs.length + pins.outputs.length > 0
          ? [...pins.inputs, ...pins.outputs].map((p) => ({ name: p.n, kind: 'struct' as const, fields: [], origin: 'ast' as const }))
          : [],
        consumes: pins.inputs.map((p) => ({ name: p.n, kind: 'struct' as const, fields: [], origin: 'ast' as const })),
        emits: scenes.map((s) => s.title),
        reads_config: [],
        irreversible_effects: 0,
      },
      acceptance: {
        effect_check: `人打开该叙事砖，能看明白「${title}」这一步吃了什么、做什么、吐出什么（分镜 facts 逐条对应真实签名针脚）。`,
      },
    };
    const manifestFile = path.join(brickDir, 'manifest.json');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf-8');

    // ── 2) DSL semantic 落 brick_narr_* 条目 → 导图「🧱 已验证积木」区出卡 ──
    const bid = `brick_narr_${slug(file)}`;
    dsl.semantic = dsl.semantic ?? { files: [] };
    const existed = dsl.semantic.files.some((f) => f.id === bid);
    if (!existed) {
      dsl.semantic.files.push({
        id: bid,
        path: `${title}-叙事`,
        responsibility: `${title}：把「${file}」讲成人话的叙事砖（积木黑盒：分镜 ${scenes.length} 镜）`,
        expected_apis: scenes.map((s) => ({ name: s.title, signature: `叙述「${s.title}」` })),
        status: 'done',
        layer: 'feature',
      });
      saveDSL(dsl, 'mcp');
    }
    brick = { id: bid, name: brickName, manifest: manifestFile, message: `${manifestFile}`, };
    message += `，并已登记为砖（${brickName}），进思维导图积木区（${existed ? '已存在，复用' : '新增'}）`;
  }

  return { feature, file, title, pins, scenes, mode: 'rule', brick, message };
}