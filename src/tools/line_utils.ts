/**
 * line_utils：行分割与行尾处理的**单一基准**（2026-08-30 抽公共，杜绝行号分叉）
 *
 * 背景（狗食实证）：explore_code(action=read) 返回的行号曾与 edit_code(op=range)
 * 使用不同的分割实现，LLM 把 read 的行号喂给 edit_code 会替换错行（被语法门拦截）。
 * 为统一行号基准，splitKeepEnds / detectEol / isBlankLine 收敛于此，
 * edit_code 与 explore_code(read) 必须共用，禁止各自再复制一份。
 *
 * 行号契约：splitKeepEnds 的数组下标 +1 = 真实文件行号（1-based），
 * 与 edit_code(op=range) 的 start/end、explore_code(action=read) 的返回行号同基准。
 */

/** 按行分割并保留每行的终止符 */
export function splitKeepEnds(content: string): string[] {
  const lines = content.split(/(?<=\n)/);
  // 末尾无换行时最后元素是残段；有换行时最后元素是 ''——去掉空尾
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function detectEol(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

export function isBlankLine(line: string): boolean {
  return line.trim() === '' || line === '';
}
