/**
 * Tree-sitter Kernel
 *
 * 统一接口：parseFile(path, content) → ParsedSymbol[]
 *
 * 设计原则：
 *   1. 零硬编码 import（不再有 `import Go from 'tree-sitter-go'`）
 *   2. 自动探测本地已装的语言包（probe）
 *   3. 动态加载（loader）+ 缓存
 *   4. 失败优雅降级（返回空数组，不抛）
 *   5. 可被多个工具共享（consistency / backfill / 未来的 lint/format）
 *
 * 用法：
 *   import { parseFile, listSupportedLanguages } from './ts_kernel';
 *   const symbols = await parseFile('src/app.go', goSource);
 *
 * 共享给其他项目（如 ai-base）：
 *   - 抽出为 @design-canvas/ts-kernel 包
 *   - 两边项目 npm install 后都能用
 *   - 用户只需装一次 tree-sitter-* 包
 */

import type Parser from 'tree-sitter';
import { findLanguageByExt, LanguageEntry } from './languages.js';
import { isLanguageInstalled, isExtSupported, listSupportedExts, probeInstalledLanguages } from './probe.js';
import { getParser, clearLoaderCache } from './loader.js';

export interface ParsedSymbol {
  name: string;
  kind: 'function' | 'method' | 'class' | 'interface' | 'type';
  start_line: number;
  end_line: number;
  qualified_name: string;
  signature: string;
  parent?: string;
}

// ─────────────────────────────────────────────────────────────
// 节点类型 → 通用 Symbol kind 映射
// ─────────────────────────────────────────────────────────────

function nodeTypeToKind(nodeType: string, parent?: string): ParsedSymbol['kind'] {
  if (nodeType.includes('class')) return 'class';
  if (nodeType.includes('interface')) return 'interface';
  if (nodeType.includes('method')) return 'method';
  if (nodeType.includes('struct') || nodeType.includes('trait') || nodeType.includes('impl')) return 'type';
  if (nodeType === 'function_definition' || nodeType === 'function_declaration' || nodeType === 'function_item' || nodeType === 'FnDecl' || nodeType === 'proc_def' || nodeType === 'method' || nodeType === 'sub' || nodeType === 'proc') {
    return parent ? 'method' : 'function';
  }
  if (nodeType.includes('type') || nodeType.includes('FnDecl') || nodeType === 'method_declaration') {
    if (parent) return 'method';
    if (nodeType.includes('declaration') || nodeType.includes('definition') || nodeType.includes('spec')) return 'type';
  }
  if (nodeType === 'method_declaration') return 'method';
  if (parent) return 'method';
  return 'function';
}

// ─────────────────────────────────────────────────────────────
// 通用遍历器
// ─────────────────────────────────────────────────────────────

interface SyntaxNodeLike {
  type: string;
  startPosition: { row: number };
  endPosition: { row: number };
  text: string;
  childForFieldName(name: string): SyntaxNodeLike | null;
  child(index: number): SyntaxNodeLike | null;
  childCount: number;
}

function fieldText(node: SyntaxNodeLike | null, fieldName: string): string {
  if (!node) return '';
  const child = node.childForFieldName(fieldName);
  return child ? child.text : '';
}

function extractName(node: SyntaxNodeLike, fieldMap: LanguageEntry['field_map']): string {
  const direct = fieldText(node, fieldMap.name);
  if (direct) return direct;

  // 兜底：从第一个 identifier 子节点取
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && (child.type === 'identifier' || child.type === 'property_identifier' || child.type === 'type_identifier' || child.type === 'name')) {
      return child.text;
    }
  }
  return '';
}

function stripParens(s: string): string {
  s = s.trim();
  if (s.startsWith('(') && s.endsWith(')')) {
    s = s.slice(1, -1);
  }
  return s.trim();
}

function buildSignature(node: SyntaxNodeLike, fieldMap: LanguageEntry['field_map'], lang: LanguageEntry): string {
  const name = extractName(node, fieldMap);
  const rawParams = fieldText(node, fieldMap.parameters || '');
  const params = stripParens(rawParams);

  if (lang.name === 'go') {
    const result = fieldText(node, fieldMap.return_type || '');
    const receiver = fieldText(node, fieldMap.receiver || '');
    // receiver text 如 "(u *UserService)" 或 "u *UserService"
    const receiverClean = stripParens(receiver);
    const receiverMatch = receiverClean.match(/(?:\*\s*)?(\w+)$/);
    const receiverName = receiverMatch ? receiverMatch[1] : '';
    if (receiverName) {
      return `${receiverName}.${name}(${params})${result ? ' ' + result : ''}`;
    }
    return `${name}(${params})${result ? ' ' + result : ''}`;
  }

  if (lang.name === 'python') {
    const ret = fieldText(node, fieldMap.return_type || '');
    // 移除 self 参数
    const cleanParams = params.replace(/^self\s*,?\s*/, '').trim();
    return `${name}(${cleanParams})${ret ? ' -> ' + ret : ''}`;
  }

  if (lang.name === 'rust') {
    const ret = fieldText(node, fieldMap.return_type || '');
    return `${name}(${params})${ret ? ' -> ' + ret : ''}`;
  }

  if (lang.name === 'java' || lang.name === 'c_sharp' || lang.name === 'kotlin' || lang.name === 'swift') {
    const ret = fieldText(node, fieldMap.return_type || '');
    return `${name}(${params})${ret ? ': ' + ret : ''}`;
  }

  // TypeScript / JavaScript / C / C++ 等
  const ret = fieldText(node, fieldMap.return_type || '');
  return `${name}(${params})${ret ? ': ' + ret : ''}`;
}

// ─────────────────────────────────────────────────────────────
// 通用遍历提取符号
// ─────────────────────────────────────────────────────────────

function traverseAndExtract(
  node: SyntaxNodeLike,
  lang: LanguageEntry,
  symbols: ParsedSymbol[],
  parent: string | undefined,
  depth: number = 0
): void {
  if (depth > 100) return; // 防止无限递归

  if (lang.symbol_nodes.includes(node.type)) {
    const name = extractName(node, lang.field_map);
    if (name) {
      const kind = nodeTypeToKind(node.type, parent);
      const signature = buildSignature(node, lang.field_map, lang);
      const qn = parent ? `${parent}.${name}` : name;
      symbols.push({
        name,
        kind,
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        qualified_name: qn,
        signature,
        parent,
      });

      // 进入 body 继续提取（找方法/嵌套类）
      const body = node.childForFieldName('body') || node.childForFieldName('suite');
      if (body) {
        for (let i = 0; i < body.childCount; i++) {
          const child = body.child(i);
          if (child) traverseAndExtract(child, lang, symbols, name, depth + 1);
        }
        return;
      }
      // 兜底：直接遍历子节点（如 Python class 的 body 可能不是标准 body 字段）
      if (node.type === 'class_definition' || node.type === 'class_declaration') {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) traverseAndExtract(child, lang, symbols, name, depth + 1);
        }
        return;
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) traverseAndExtract(child, lang, symbols, parent, depth + 1);
  }
}

// ─────────────────────────────────────────────────────────────
// 公开 API
// ─────────────────────────────────────────────────────────────

/**
 * 解析文件的符号。返回空数组表示：文件类型不支持 / 解析失败 / 文件为空。
 */
export async function parseFile(filePath: string, content: string): Promise<ParsedSymbol[]> {
  const ext = '.' + (filePath.split('.').pop() || '');
  const lang = isExtSupported(ext);
  if (!lang) return [];

  const parser = await getParser(ext, lang);
  if (!parser) return [];

  try {
    const tree = (parser as { parse: (input: string) => { rootNode: SyntaxNodeLike } }).parse(content);
    const symbols: ParsedSymbol[] = [];
    traverseAndExtract(tree.rootNode, lang, symbols, undefined);
    return symbols;
  } catch (e) {
    console.warn(`[ts_kernel] parse ${filePath} failed: ${(e as Error).message}`);
    return [];
  }
}

/** 检查扩展名是否被支持（且已安装对应语言包） */
export function isSupported(ext: string): boolean {
  return isExtSupported(ext) !== null;
}

/** 列出所有已安装并启用的语言 */
export function listSupportedLanguages(): string[] {
  return probeInstalledLanguages().map((l) => l.name);
}

/** 列出所有支持的扩展名 */
export function listSupportedExtensions(): string[] {
  return listSupportedExts();
}

/** 重置内部缓存（测试用） */
export function _reset(): void {
  clearLoaderCache();
}

export { findLanguageByExt, isLanguageInstalled };
export type { LanguageEntry };
