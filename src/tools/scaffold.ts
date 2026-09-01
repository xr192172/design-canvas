/**
 * scaffold 工具实现（增强版）
 *
 * 从 DSL 的 semantic 层生成代码骨架。
 *
 * 新增能力：
 *   1. 多语言模板：go / ts / py / js / vue / react
 *   2. 可配置模板系统：通过 DSL semantic.scaffold.templates 自定义模板
 *   3. 从节点内容生成 UI 骨架：将 color_block/text/image 映射为 UI 组件
 *   4. 注释标记：生成 <!-- design-canvas:node_id --> 锚点，支持 backfill 定位
 *   5. 模板占位符：{{package}}, {{imports}}, {{apis}}, {{behavior}}, {{node_id}}, {{node_label}}, {{ui_skeleton}}
 *
 * 工作原理：
 *   1. 读取已保存的 DSL
 *   2. 遍历 semantic.files，为每个文件生成骨架代码
 *   3. 根据文件扩展名推断语言（.go / .ts / .py / .js / .vue / .tsx）
 *   4. 生成内容：文件头注释 + API 签名（TODO body） + 依赖 import + 注释标记
 *   5. 如启用 generate_ui_skeleton，从对应节点的 content.blocks 生成 UI 骨架
 *   6. 额外生成 INVARIANTS.md 记录跨文件不变式
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DesignDSL, SemanticFile, CodeTemplate, Node, ContentBlock } from '../dsl/types.js';
import { getDSL } from '../storage.js';

export interface ScaffoldInput {
  /** feature 名 */
  feature: string;
  /** 输出根目录，默认 <cwd>/scaffold/<feature> */
  output_dir?: string;
  /** 是否覆盖已存在的文件，默认 false */
  overwrite?: boolean;
  /** UI 骨架类型（覆盖 DSL 配置） */
  ui_framework?: 'vue' | 'react' | 'html';
}

export interface ScaffoldResult {
  message: string;
  files: string[];
  dir: string;
}

// ─────────────────────────────────────────────────────────────
// 语言推断
// ─────────────────────────────────────────────────────────────

type Lang = 'go' | 'ts' | 'py' | 'js' | 'vue' | 'react' | 'unknown';

function detectLang(filePath: string): Lang {
  if (filePath.endsWith('.go')) return 'go';
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) return filePath.endsWith('.tsx') ? 'react' : 'ts';
  if (filePath.endsWith('.py')) return 'py';
  if (filePath.endsWith('.js') || filePath.endsWith('.jsx')) return filePath.endsWith('.jsx') ? 'react' : 'js';
  if (filePath.endsWith('.vue')) return 'vue';
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────
// 注释标记
// ─────────────────────────────────────────────────────────────

function makeMarker(nodeId: string, label?: string): string {
  return `<!-- design-canvas:${nodeId}${label ? ' ' + label : ''} -->`;
}

function makeMarkerComment(nodeId: string, lang: Lang, label?: string): string {
  const marker = makeMarker(nodeId, label);
  switch (lang) {
    case 'go':
    case 'ts':
    case 'js':
    case 'react':
      return `// ${marker}`;
    case 'py':
      return `# ${marker}`;
    case 'vue':
      return `<!-- design-canvas:${nodeId}${label ? ' ' + label : ''} -->`;
    default:
      return `// ${marker}`;
  }
}

// ─────────────────────────────────────────────────────────────
// 从 API 签名中提取函数名
// ─────────────────────────────────────────────────────────────

function extractFuncName(signature: string): string {
  const match = signature.match(/(?:func\s+)?(\w+)\s*[\(\<]/);
  return match ? match[1] : signature.split(/\s*\(/)[0];
}

function goPackageName(filePath: string): string {
  const dir = path.dirname(filePath);
  const pkg = path.basename(dir);
  return pkg || 'main';
}

function goReturnStmt(ret: string): string {
  if (!ret) return '';
  const parts = ret.split(',').map(s => s.trim());
  const zeros = parts.map(p => {
    if (p.includes('error')) return 'nil';
    if (p.includes('string')) return '""';
    if (p.includes('bool')) return 'false';
    if (p.includes('int') || p.includes('float')) return '0';
    return 'nil';
  });
  return `\treturn ${zeros.join(', ')}  // TODO`;
}

// ─────────────────────────────────────────────────────────────
// 通用：按 receiver/class 分组方法
// ─────────────────────────────────────────────────────────────

function groupByClass(
  apis: { signature: string; notes?: string }[]
): { classes: Map<string, { name: string; args: string; ret: string; notes?: string }[]>; freeFns: { name: string; args: string; ret: string; notes?: string }[] } {
  const classes = new Map<string, { name: string; args: string; ret: string; notes?: string }[]>();
  const freeFns: { name: string; args: string; ret: string; notes?: string }[] = [];

  for (const api of apis) {
    const sig = api.signature.trim();
    const methodMatch = sig.match(/^(\w+)\.(\w+)\s*\(([^)]*)\)\s*(?::\s*(.+))?$/);
    if (methodMatch) {
      const [, className, methodName, args, ret] = methodMatch;
      if (!classes.has(className)) classes.set(className, []);
      classes.get(className)!.push({ name: methodName, args, ret: ret || '', notes: api.notes });
    } else {
      const funcMatch = sig.match(/^(\w+)\s*\(([^)]*)\)\s*(?::\s*(.+))?$/);
      if (funcMatch) {
        const [, funcName, args, ret] = funcMatch;
        freeFns.push({ name: funcName, args, ret: ret || '', notes: api.notes });
      }
    }
  }
  return { classes, freeFns };
}

// ─────────────────────────────────────────────────────────────
// UI 骨架生成：从 ContentBlock 树生成 UI 代码
// ─────────────────────────────────────────────────────────────

function generateUiSkeleton(blocks: ContentBlock[], framework: 'vue' | 'react' | 'html', indent: number = 2): string {
  const spaces = ' '.repeat(indent);
  const lines: string[] = [];

  for (const block of blocks) {
    if (block.visible === false) continue;

    switch (block.type) {
      case 'text': {
        const tag = block.style?.bold ? 'strong' : 'span';
        const cls = block.style ? buildStyleClass(block.style) : '';
        lines.push(`${spaces}<${tag}${cls}>${escapeXml(block.value || '')}</${tag}>`);
        break;
      }
      case 'image': {
        const alt = escapeXml(block.value || '');
        lines.push(`${spaces}<img src="${block.src || ''}" alt="${alt}"${block.width ? ` width="${block.width}"` : ''}${block.height ? ` height="${block.height}"` : ''} />`);
        break;
      }
      case 'color_block': {
        const style = buildInlineStyle(block);
        const children = block.children && block.children.length > 0
          ? '\n' + generateUiSkeleton(block.children, framework, indent + 2) + '\n' + spaces
          : '';
        lines.push(`${spaces}<div${style}>${children}</div>`);
        break;
      }
      case 'spacer': {
        lines.push(`${spaces}<div style="height:${block.spacerHeight ?? 8}px"></div>`);
        break;
      }
    }
  }

  return lines.join('\n');
}

function buildStyleClass(style: { fontSize?: number; bold?: boolean; italic?: boolean; color?: string; align?: string }): string {
  const classes: string[] = [];
  if (style.bold) classes.push('font-bold');
  if (style.italic) classes.push('italic');
  if (classes.length === 0) return '';
  return ` class="${classes.join(' ') + (style.color ? ` text-[${style.color}]` : '')}"`;
}

function buildInlineStyle(block: ContentBlock): string {
  const styles: string[] = [];
  if (block.bg) styles.push(`background:${block.bg}`);
  if (block.width) styles.push(`width:${block.width}px`);
  if (block.height) styles.push(`height:${block.height}px`);
  if (block.border) styles.push(`border:${block.border}`);
  if (block.borderRadius) styles.push(`border-radius:${block.borderRadius}px`);
  if (block.padding) styles.push(`padding:${block.padding}px`);
  if (styles.length === 0) return '';
  return ` style="${styles.join('; ')}"`;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─────────────────────────────────────────────────────────────
// 各语言骨架生成
// ─────────────────────────────────────────────────────────────

function generateGo(file: SemanticFile, marker: string): string {
  const pkg = goPackageName(file.path);
  const lines: string[] = [];

  lines.push(`// Package ${pkg}`);
  lines.push(`// ${file.responsibility}`);
  lines.push(marker);
  lines.push(`package ${pkg}`);
  lines.push('');

  if (file.expected_deps && file.expected_deps.length > 0) {
    lines.push('import (');
    for (const dep of file.expected_deps) {
      lines.push(`\t// "${dep}"  // TODO: 调整为正确的 module path`);
    }
    lines.push(')');
    lines.push('');
  }

  if (file.expected_apis && file.expected_apis.length > 0) {
    const receiverMethods = new Map<string, { name: string; args: string; ret: string; notes?: string }[]>();
    const freeFunctions: { name: string; args: string; ret: string; notes?: string }[] = [];

    for (const api of file.expected_apis) {
      const sig = api.signature.trim();
      if (sig.includes('.')) {
        const [receiver, methodPart] = sig.split('.', 2);
        const methodMatch = methodPart.match(/^(\w+)\s*\(([^)]*)\)\s*(.*)$/);
        if (methodMatch) {
          const [, methodName, args, ret] = methodMatch;
          if (!receiverMethods.has(receiver)) receiverMethods.set(receiver, []);
          receiverMethods.get(receiver)!.push({ name: methodName, args, ret: ret || '', notes: api.notes });
        }
      } else {
        const funcMatch = sig.match(/^(\w+)\s*\(([^)]*)\)\s*(.*)$/);
        if (funcMatch) {
          const [, funcName, args, ret] = funcMatch;
          freeFunctions.push({ name: funcName, args, ret: ret || '', notes: api.notes });
        }
      }
    }

    for (const [receiver, methods] of receiverMethods) {
      lines.push(`type ${receiver} struct {`);
      lines.push(`\t// TODO: 定义 ${receiver} 字段`);
      lines.push('}');
      lines.push('');

      for (const m of methods) {
        if (m.notes) lines.push(`// ${m.notes}`);
        const retPart = m.ret ? ` ${m.ret}` : '';
        lines.push(`func (r *${receiver}) ${m.name}(${m.args})${retPart} {`);
        lines.push('\t// TODO: 实现');
        if (m.ret) lines.push(goReturnStmt(m.ret));
        lines.push('}');
        lines.push('');
      }
    }

    for (const f of freeFunctions) {
      if (f.notes) lines.push(`// ${f.notes}`);
      const retPart = f.ret ? ` ${f.ret}` : '';
      lines.push(`func ${f.name}(${f.args})${retPart} {`);
      lines.push('\t// TODO: 实现');
      if (f.ret) lines.push(goReturnStmt(f.ret));
      lines.push('}');
      lines.push('');
    }
  }

  if (file.expected_behavior) {
    lines.push(`// 行为约束：${file.expected_behavior}`);
  }

  return lines.join('\n');
}

function generateTs(file: SemanticFile, marker: string): string {
  const lines: string[] = [];

  lines.push('/**');
  lines.push(` * ${file.responsibility}`);
  if (file.expected_behavior) {
    lines.push(` * 行为约束：${file.expected_behavior}`);
  }
  lines.push(' */');
  lines.push(marker);
  lines.push('');

  if (file.expected_deps && file.expected_deps.length > 0) {
    for (const dep of file.expected_deps) {
      const importName = path.basename(dep, path.extname(dep));
      lines.push(`import { ${importName} } from './${importName}';  // ${dep}`);
    }
    lines.push('');
  }

  if (file.expected_apis && file.expected_apis.length > 0) {
    const { classes, freeFns } = groupByClass(file.expected_apis);

    for (const [className, methods] of classes) {
      lines.push(`export class ${className} {`);
      for (const m of methods) {
        if (m.notes) lines.push(`  // ${m.notes}`);
        const retPart = m.ret ? `: ${m.ret}` : '';
        lines.push(`  ${m.name}(${m.args})${retPart} {`);
        lines.push('    // TODO: 实现');
        lines.push("    throw new Error('Not implemented');");
        lines.push('  }');
      }
      lines.push('}');
      lines.push('');
    }

    for (const f of freeFns) {
      if (f.notes) lines.push(`// ${f.notes}`);
      const retPart = f.ret ? `: ${f.ret}` : '';
      lines.push(`export function ${f.name}(${f.args})${retPart} {`);
      lines.push('  // TODO: 实现');
      lines.push("  throw new Error('Not implemented');");
      lines.push('}');
      lines.push('');
    }
  }

  return lines.join('\n');
}

function generatePy(file: SemanticFile, marker: string): string {
  const lines: string[] = [];

  lines.push('"""');
  lines.push(file.responsibility);
  if (file.expected_behavior) {
    lines.push(`行为约束：${file.expected_behavior}`);
  }
  lines.push('"""');
  lines.push(marker);
  lines.push('');

  if (file.expected_deps && file.expected_deps.length > 0) {
    for (const dep of file.expected_deps) {
      const importName = path.basename(dep, '.py');
      lines.push(`from .${importName} import *  # ${dep}`);
    }
    lines.push('');
  }

  if (file.expected_apis && file.expected_apis.length > 0) {
    const { classes, freeFns } = groupByClass(file.expected_apis);

    for (const [className, methods] of classes) {
      lines.push(`class ${className}:`);
      lines.push('    """TODO: 定义字段"""');
      lines.push('');
      for (const m of methods) {
        if (m.notes) lines.push(`    # ${m.notes}`);
        const retPart = m.ret ? ` -> ${m.ret}` : '';
        lines.push(`    def ${m.name}(self, ${m.args})${retPart}:`);
        lines.push('        # TODO: 实现');
        lines.push('        raise NotImplementedError');
        lines.push('');
      }
    }

    for (const f of freeFns) {
      if (f.notes) lines.push(`# ${f.notes}`);
      const retPart = f.ret ? ` -> ${f.ret}` : '';
      lines.push(`def ${f.name}(${f.args})${retPart}:`);
      lines.push('    # TODO: 实现');
      lines.push('    raise NotImplementedError');
      lines.push('');
    }
  }

  return lines.join('\n');
}

function generateJs(file: SemanticFile, marker: string): string {
  const lines: string[] = [];

  lines.push('/**');
  lines.push(` * ${file.responsibility}`);
  if (file.expected_behavior) {
    lines.push(` * 行为约束：${file.expected_behavior}`);
  }
  lines.push(' */');
  lines.push(marker);
  lines.push('');

  if (file.expected_deps && file.expected_deps.length > 0) {
    for (const dep of file.expected_deps) {
      const importName = path.basename(dep, path.extname(dep));
      lines.push(`const ${importName} = require('./${importName}');  // ${dep}`);
    }
    lines.push('');
  }

  if (file.expected_apis && file.expected_apis.length > 0) {
    const { classes, freeFns } = groupByClass(file.expected_apis);

    for (const [className, methods] of classes) {
      lines.push(`class ${className} {`);
      for (const m of methods) {
        if (m.notes) lines.push(`  // ${m.notes}`);
        lines.push(`  ${m.name}(${m.args}) {`);
        lines.push('    // TODO: 实现');
        lines.push("    throw new Error('Not implemented');");
        lines.push('  }');
      }
      lines.push('}');
      lines.push('');
    }

    for (const f of freeFns) {
      if (f.notes) lines.push(`// ${f.notes}`);
      lines.push(`function ${f.name}(${f.args}) {`);
      lines.push('  // TODO: 实现');
      lines.push("  throw new Error('Not implemented');");
      lines.push('}');
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// Vue 模板生成
// ─────────────────────────────────────────────────────────────

function generateVue(file: SemanticFile, node: Node | undefined, marker: string): string {
  const lines: string[] = [];

  lines.push(`<!--`);
  lines.push(`  ${file.responsibility}`);
  if (file.expected_behavior) {
    lines.push(`  行为约束：${file.expected_behavior}`);
  }
  lines.push(`-->`);
  lines.push(marker);
  lines.push('');

  lines.push('<template>');

  // UI 骨架
  if (node?.content?.blocks && node.content.blocks.length > 0) {
    lines.push(generateUiSkeleton(node.content.blocks, 'vue', 2));
  } else {
    lines.push('  <div class="container">');
    lines.push('    <!-- TODO: 实现 UI -->');
    lines.push('  </div>');
  }

  lines.push('</template>');
  lines.push('');

  lines.push('<script setup>');
  if (file.expected_deps && file.expected_deps.length > 0) {
    for (const dep of file.expected_deps) {
      const importName = path.basename(dep, path.extname(dep));
      lines.push(`import { ${importName} } from './${importName}';  // ${dep}`);
    }
    lines.push('');
  }

  // 从 API 签名生成方法
  if (file.expected_apis && file.expected_apis.length > 0) {
    for (const api of file.expected_apis) {
      const name = extractFuncName(api.signature);
      lines.push(`// ${api.signature}`);
      if (api.notes) lines.push(`// ${api.notes}`);
      lines.push(`async function ${name}() {`);
      lines.push('  // TODO: 实现');
      lines.push('}');
      lines.push('');
    }
  }
  lines.push('</script>');
  lines.push('');

  lines.push('<style scoped>');
  lines.push('/* TODO: 添加样式 */');
  lines.push('</style>');

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// React 模板生成
// ─────────────────────────────────────────────────────────────

function generateReact(file: SemanticFile, node: Node | undefined, marker: string): string {
  const lines: string[] = [];
  const componentName = path.basename(file.path, path.extname(file.path));
  const componentNamePascal = componentName.charAt(0).toUpperCase() + componentName.slice(1);

  lines.push('/**');
  lines.push(` * ${file.responsibility}`);
  if (file.expected_behavior) {
    lines.push(` * 行为约束：${file.expected_behavior}`);
  }
  lines.push(' */');
  lines.push(marker);
  lines.push('');

  if (file.expected_deps && file.expected_deps.length > 0) {
    for (const dep of file.expected_deps) {
      const importName = path.basename(dep, path.extname(dep));
      lines.push(`import { ${importName} } from './${importName}';  // ${dep}`);
    }
    lines.push('');
  }

  lines.push(`export default function ${componentNamePascal}() {`);
  lines.push('  // TODO: 添加 state 和 hooks');
  lines.push('');

  // 从 API 签名生成方法
  if (file.expected_apis && file.expected_apis.length > 0) {
    for (const api of file.expected_apis) {
      const name = extractFuncName(api.signature);
      lines.push(`  // ${api.signature}`);
      if (api.notes) lines.push(`  // ${api.notes}`);
      lines.push(`  const ${name} = async () => {`);
      lines.push('    // TODO: 实现');
      lines.push('  };');
      lines.push('');
    }
  }

  lines.push('  return (');

  // UI 骨架
  if (node?.content?.blocks && node.content.blocks.length > 0) {
    const ui = generateUiSkeleton(node.content.blocks, 'react', 4);
    lines.push(ui);
  } else {
    lines.push('    <div className="container">');
    lines.push('      {/* TODO: 实现 UI */}');
    lines.push('    </div>');
  }

  lines.push('  );');
  lines.push('}');

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// HTML 模板生成（纯 UI 骨架）
// ─────────────────────────────────────────────────────────────

function generateHtml(file: SemanticFile, node: Node | undefined, marker: string): string {
  const lines: string[] = [];

  lines.push(`<!-- ${file.responsibility} -->`);
  lines.push(marker);
  lines.push('');

  if (node?.content?.blocks && node.content.blocks.length > 0) {
    lines.push(generateUiSkeleton(node.content.blocks, 'html', 0));
  } else {
    lines.push('<div class="container">');
    lines.push('  <!-- TODO: 实现 UI -->');
    lines.push('</div>');
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// 自定义模板渲染
// ─────────────────────────────────────────────────────────────

function renderCustomTemplate(
  template: CodeTemplate,
  file: SemanticFile,
  node: Node | undefined,
  marker: string
): string {
  let content = template.template;

  const pkg = goPackageName(file.path);
  content = content.replace(/\{\{package\}\}/g, pkg);
  content = content.replace(/\{\{node_id\}\}/g, file.id);
  content = content.replace(/\{\{node_label\}\}/g, node?.label || file.id);
  content = content.replace(/\{\{marker\}\}/g, marker);

  // imports
  let imports = '';
  if (file.expected_deps && file.expected_deps.length > 0) {
    imports = file.expected_deps.map(d => `// import from "${d}"`).join('\n');
  }
  content = content.replace(/\{\{imports\}\}/g, imports);

  // behavior
  const behavior = file.expected_behavior || '';
  content = content.replace(/\{\{behavior\}\}/g, behavior);

  // apis
  let apis = '';
  if (file.expected_apis && file.expected_apis.length > 0) {
    apis = file.expected_apis.map(a => `// ${a.signature}${a.notes ? ' - ' + a.notes : ''}`).join('\n');
  }
  content = content.replace(/\{\{apis\}\}/g, apis);

  // ui_skeleton
  let uiSkeleton = '';
  if (node?.content?.blocks && node.content.blocks.length > 0) {
    const fw = template.lang === 'vue' ? 'vue' : template.lang === 'react' ? 'react' : 'html';
    uiSkeleton = generateUiSkeleton(node.content.blocks, fw, 2);
  }
  content = content.replace(/\{\{ui_skeleton\}\}/g, uiSkeleton);

  return content;
}

// ─────────────────────────────────────────────────────────────
// 生成不变式文件
// ─────────────────────────────────────────────────────────────

function generateInvariants(dsl: DesignDSL): string {
  const lines: string[] = [];
  lines.push(`# ${dsl.feature} - 不变式与约束`);
  lines.push('');

  if (dsl.semantic?.multi_file_invariants && dsl.semantic.multi_file_invariants.length > 0) {
    lines.push('## 跨文件不变式');
    lines.push('');
    for (const inv of dsl.semantic.multi_file_invariants) {
      lines.push(`- ${inv}`);
    }
    lines.push('');
  }

  if (dsl.semantic?.expected_global_behavior && dsl.semantic.expected_global_behavior.length > 0) {
    lines.push('## 全局行为约束');
    lines.push('');
    for (const b of dsl.semantic.expected_global_behavior) {
      lines.push(`- ${b}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// 主函数
// ─────────────────────────────────────────────────────────────

export function scaffold(input: ScaffoldInput): ScaffoldResult {
  const { feature, output_dir, overwrite, ui_framework: inputUiFramework } = input;

  const dsl = getDSL(feature);
  if (!dsl) {
    throw new Error(`feature "${feature}" 不存在，请先使用 create_feature 或 render_design 创建`);
  }

  if (!dsl.semantic || !dsl.semantic.files || dsl.semantic.files.length === 0) {
    throw new Error(`feature "${feature}" 没有 semantic.files，无法生成代码骨架`);
  }

  const scaffoldConfig = dsl.semantic.scaffold;
  const useMarkers = scaffoldConfig?.markers !== false;
  const generateUi = scaffoldConfig?.generate_ui_skeleton || false;
  const uiFramework = inputUiFramework || scaffoldConfig?.ui_framework || 'html';

  const outDir = output_dir
    ? path.resolve(output_dir)
    : path.join(process.cwd(), 'scaffold', feature);

  const generatedFiles: string[] = [];

  // 为每个 semantic file 生成骨架
  for (const file of dsl.semantic.files) {
    const lang = detectLang(file.path);
    const node = dsl.geometry.nodes.find(n => n.id === file.id);
    const label = node?.label || file.id;
    const marker = useMarkers ? makeMarkerComment(file.id, lang, label) : '';

    // 检查是否有自定义模板匹配
    let content: string;
    const customTemplate = scaffoldConfig?.templates?.find(
      t => t.lang === lang || (t.ext && file.path.endsWith(t.ext))
    );

    if (customTemplate) {
      content = renderCustomTemplate(customTemplate, file, node, marker);
    } else {
      switch (lang) {
        case 'go':
          content = generateGo(file, marker);
          break;
        case 'ts':
          content = generateTs(file, marker);
          break;
        case 'py':
          content = generatePy(file, marker);
          break;
        case 'js':
          content = generateJs(file, marker);
          break;
        case 'vue':
          content = generateVue(file, node, marker);
          break;
        case 'react':
          content = generateReact(file, node, marker);
          break;
        default:
          if (generateUi && node?.content?.blocks) {
            content = generateHtml(file, node, marker);
          } else {
            content = [
              `// ${file.responsibility}`,
              marker,
              '// TODO: 以下 API 待实现：',
              ...(file.expected_apis || []).map(a => `//   - ${a.signature}`),
              ...(file.expected_behavior ? [`// 行为约束：${file.expected_behavior}`] : []),
            ].join('\n');
          }
      }
    }

    const fullPath = path.join(outDir, file.path);

    // 检查是否覆盖
    if (fs.existsSync(fullPath) && !overwrite) {
      generatedFiles.push(`${fullPath} (跳过，已存在)`);
      continue;
    }

    // 确保目录存在
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
    generatedFiles.push(fullPath);
  }

  // 生成不变式文件
  const invariantsPath = path.join(outDir, 'INVARIANTS.md');
  fs.writeFileSync(invariantsPath, generateInvariants(dsl), 'utf-8');
  generatedFiles.push(invariantsPath);

  const message = [
    `已为 feature "${feature}" 生成 ${generatedFiles.length} 个文件`,
    `输出目录：${outDir}`,
    useMarkers ? '已生成注释标记（<!-- design-canvas:node_id -->）' : '未生成注释标记',
    generateUi ? `UI 骨架：${uiFramework}` : '',
    '',
    '生成的文件：',
    ...generatedFiles.map((f, i) => `  ${i + 1}. ${f}`),
    '',
    '每个文件包含：',
    '  - 文件头注释（职责描述）',
    '  - API 签名（函数/方法，body 为 TODO）',
    '  - 依赖 import（注释形式）',
    '  - 行为约束注释',
    useMarkers ? '  - 注释标记（用于 backfill 定位）' : '',
    generateUi ? '  - UI 骨架（从节点 content.blocks 生成）' : '',
    '',
    'INVARIANTS.md 记录了跨文件不变式和全局行为约束。',
  ].join('\n');

  return { message, files: generatedFiles, dir: outDir };
}
