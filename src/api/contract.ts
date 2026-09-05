/**
 * 响应契约单源（API Contract Hardening）
 *
 * 定位：HTTP 端点（serve.ts）的手序列化在此之前无任何运行时 schema 校验、无版本字段，
 * 而 dsl-workbench 前端手维护 20+ 端点的响应类型，随时可能漂移。本模块用 zod 集中定义
 * 「派生端点 + 核心端点」的响应 schema，作为唯一事实源：
 *   · serve 的 guard 用它对响应做 safeParse（不符仅记日志，护栏不阻断渲染）
 *   · scripts/gen_endpoints_schema.mjs 用它生成 schema/endpoints.schema.json（跨仓中介）
 *   · 前端用它做 ajv 运行时校验（_api 版本不符 / 缺字段 → 抛「契约不符」）
 *
 * 约定：每个 schema 顶层统一带 `_api` 字面量（= API_VERSION），平铺、向后兼容——
 * 旧前端忽略多字段，前端期望版本与之对齐则校验通过。
 */
import { z } from 'zod';

/** 顶层版本字段名（响应平铺带 `_api: API_VERSION`） */
export const RESPONSE_SCHEMA_AT = '_api';
/** 当前契约版本：仅当后端响应结构与前端 TS 类型对齐到「漂移即显」时才递增 */
export const API_VERSION = 1;

/** 统一版本字段：每个响应 schema 顶层都带它 */
const apiVersion = z.object({ [RESPONSE_SCHEMA_AT]: z.literal(API_VERSION) });

/* ─────────────────────────────────────────────────────────────
   核心端点
   ───────────────────────────────────────────────────────────── */

/** GET /api/features —— feature 列表里的单条 */
const featureItem = z
  .object({
    feature: z.string(),
    title: z.string().optional(),
    files: z.number().optional(),
    nodes: z.number().optional(),
    language: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .passthrough();

export const featuresResp = apiVersion.extend({ features: z.array(featureItem) }).passthrough();

/** POST /api/save —— 保存成功分支（200）；409 冲突分支走 sendError 不进 guard */
export const saveResp = apiVersion
  .extend({
    success: z.literal(true),
    message: z.string().optional(),
    feature: z.string().optional(),
    saved_at: z.string().optional(),
    rev: z.number().optional(),
  })
  .passthrough();

/* ─────────────────────────────────────────────────────────────
   派生端点（漂移风险最高：overview / mind-map-teach / mind-map / archify-demo）
   ───────────────────────────────────────────────────────────── */

/** GET/POST /api/overview —— 小白视图数据（摘要 + 功能树 + 上手步骤） */
export const overviewResp = apiVersion
  .extend({
    success: z.literal(true),
    feature: z.string().optional(),
    title: z.string().optional(),
    summary: z
      .object({ one_liner: z.string(), brief: z.string(), mode: z.string() })
      .passthrough()
      .optional(),
    mind_map: z.unknown().optional(),
    first_steps: z.array(z.unknown()).optional(),
    generated_at: z.string().optional(),
  })
  .passthrough();

/** GET /api/mind-map* —— 结构骨架 / 科普导图（均带 success + mind_map 顶层字段） */
export const mindMapResp = apiVersion
  .extend({ success: z.literal(true), mind_map: z.unknown() })
  .passthrough();

/** POST /api/archify-demo —— 5 类 showcase 图交付清单 */
const archifyDemoItem = z
  .object({
    type: z.enum(['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle']),
    delivered: z.boolean(),
    htmlPath: z.string().optional(),
    note: z.string().optional(),
  })
  .passthrough();

export const archifyDemoResp = apiVersion
  .extend({
    delivered: z.boolean(),
    manifest: z.array(archifyDemoItem),
  })
  .passthrough();

/** 路径键 → zod schema：guard 与 gen schema 共用同一份映射 */
export const schemas = {
  features: featuresResp,
  save: saveResp,
  overview: overviewResp,
  'mind-map': mindMapResp,
  'mind-map-teach': mindMapResp,
  'archify-demo': archifyDemoResp,
} as const satisfies Record<string, z.ZodType>;

export type ResponseSchemaKey = keyof typeof schemas;