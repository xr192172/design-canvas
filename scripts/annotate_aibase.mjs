// 第二阶段：LLM 语义标注（D2 混合分工的 LLM 侧）
// 内容来自人工通读 media_replacer.go 的理解；工具只负责机械推导，人话由这里写入
// 用法：npm run build && node scripts/derive_real_aibase.mjs && node scripts/annotate_aibase.mjs
import fs from 'node:fs';
import path from 'node:path';
import { updateNode } from '../dist/src/tools/node_ops.js';
import { getDSL } from '../dist/src/storage.js';
import { renderHTML } from '../dist/src/renderer/html_renderer.js';

const FEATURE = 'smoke_aibase';

// ── 语义标注表（LLM 撰写）──
// key = 派生节点 id 后缀（{host}__sN_ 后的部分）
const ANNOTATIONS = {
  s1_ReplaceImages: {
    label: '① 扫描消息找图片',
    shapes: {
      in: {
        type: 'object',
        properties: {
          msgs: { type: 'array', label: '消息列表（可能含原生图片）' },
        },
      },
      out: { type: 'array', label: '消息列表（图片已换成占位文本）' },
    },
  },
  s2_replaceImage: {
    label: '② 单图换位（解码→入库→描述）',
    shapes: {
      in: {
        type: 'object',
        properties: {
          dataURL: { type: 'string', label: '图片 data URL（base64 编码）' },
        },
      },
      out: { type: 'string', label: '占位标记 [media://哈希 描述]' },
    },
  },
  s3_decodeDataURL: {
    label: '③ 解码 base64 拿字节',
    shapes: {
      in: {
        type: 'object',
        properties: {
          dataURL: { type: 'string', label: '图片 data URL' },
        },
      },
      // 工具推导出 r0/r1（未命名多返回），重命名为可读键名 + 字节串人话
      out: {
        type: 'object',
        properties: {
          图片字节: { type: 'string', label: '字节串' },
          扩展名: { type: 'string' },
        },
      },
    },
  },
  s4_describeImage: {
    label: '④ 生成图片描述',
    shapes: {
      in: {
        type: 'object',
        properties: {
          data: { type: 'string', label: '图片字节' },
        },
      },
      out: { type: 'string', label: '描述文本（外部识别服务，失败兜底字节数）' },
    },
  },
};

const dsl0 = getDSL(FEATURE);
if (!dsl0) throw new Error(`feature "${FEATURE}" 不存在，先跑 derive_real_aibase.mjs`);

let done = 0;
for (const n of dsl0.geometry.nodes.filter((x) => x.host === 'media_replacer')) {
  const suffix = n.id.replace('media_replacer__', '');
  const ann = ANNOTATIONS[suffix];
  if (!ann) {
    console.log(`[skip] ${n.id} 无标注`);
    continue;
  }
  updateNode({ feature: FEATURE, node_id: n.id, label: ann.label, shapes: ann.shapes });
  console.log(`[annotate] ${n.id} → ${ann.label}`);
  done++;
}
console.log(`\n[done] ${done} 个节点完成语义标注（4 步粒度合适，无需聚合）`);

// 渲染 HTML 供视觉验证
const dsl = getDSL(FEATURE);
const html = renderHTML(dsl);
fs.mkdirSync('output', { recursive: true });
const out = path.resolve('output', `${FEATURE}.html`);
fs.writeFileSync(out, html, 'utf-8');
console.log(`[render] ${out} (${(html.length / 1024).toFixed(0)}KB)`);

// 打印最终标注效果（schemaToHuman 视角）
console.log('\n===== 最终变形链（渲染文本预览）=====');
for (const n of dsl.geometry.nodes.filter((x) => x.host === 'media_replacer')) {
  const inh = n.shapes?.in ? JSON.stringify(n.shapes.in) : '-';
  const outh = n.shapes?.out ? JSON.stringify(n.shapes.out) : '-';
  console.log(`${n.label}`);
  console.log(`  in:  ${inh}`);
  console.log(`  out: ${outh}`);
}
