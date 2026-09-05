/**
 * 构建期代码生成：响应契约（src/api/contract.ts 的 zod schemas）→ JSON Schema 产物
 *
 * 流程：
 *   1. import dist/src/api/contract.js（需先 tsc 编译，真实单源仍是 contract.ts 的 zod）
 *   2. 用 zod v4 内建 z.toJSONSchema 把 schemas 逐条转成自包含 JSON Schema 2020-12
 *      （不用 zod-to-json-schema：其 v3 路径对 zod v4 的 `_def.type`（无 typeName）解析失败，
 *       产物为空；v4 内建转换直接读 zod 单源，职责一致、少一层依赖）
 *   3. 写出两份中介产物（同一份单源，保持同步）：
 *      - design-canvas/schema/endpoints.schema.json（发布用）
 *      - dsl-workbench/src/data/schema/endpoints.schema.json（前端 import 做 ajv 校验的镜像）
 *
 * 运行：npm run gen:schema（需先 npm run build 让 dist 就绪）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { schemas } from '../dist/src/api/contract.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'schema', 'endpoints.schema.json');
const frontFile = path.join(root, '..', 'dsl-workbench', 'src', 'data', 'schema', 'endpoints.schema.json');

const definitions = {};
for (const [key, schema] of Object.entries(schemas)) {
  definitions[key] = z.toJSONSchema(schema);
}

const artifact = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'design-canvas 响应契约（from src/api/contract.ts zod 单源）',
  description: '自动生成，请勿手改。来源：design-canvas/src/api/contract.ts；由 scripts/gen_endpoints_schema.mjs 在 npm run gen:schema 时生成。',
  definitions,
};

fs.mkdirSync(path.dirname(frontFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(artifact, null, 2) + '\n', 'utf-8');
fs.writeFileSync(frontFile, JSON.stringify(artifact, null, 2) + '\n', 'utf-8');
console.log(`[gen:schema] ${Object.keys(definitions).join(', ')}`);
console.log(`[gen:schema] written ${outFile}`);
console.log(`[gen:schema] mirrored ${frontFile}`);