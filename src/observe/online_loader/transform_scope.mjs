/**
 * transform_scope.mjs — 在线插桩的模块源码转换器（在 Node loader 中复用）。
 *
 * 输入一段 ESM 模块源码，输出插桩后的版本：对每个「带块体、非箭头」的函数
 * （function / async function / class 方法）用 try/finally 包上 enterScope/exitScope：
 *
 *   function f(a, b) {            →   function f(a, b) {
 *     ...                               enterScope("mod.f", { args: { a, b } });
 *   }                                  try {
 *                                        ...
 *                                      } finally { exitScope("mod.f", {}); }
 *                                    }
 *
 * enter/exit 靠 probe 的 AsyncLocalStorage 自维护父子帧，无需返回 token。
 * 扫描器跳过字符串/模板/注释，避免把字符串里的花括号配对弄错。箭头函数不做处理。
 */
const ID = /[A-Za-z_$][\w$]*/y;

const SKIP_IMPORTS = new Set(['node:', 'data:', 'file://']);

function stateFor(ch) {
  if (ch === '"' || ch === "'") return 'str';
  if (ch === '`') return 'tmpl';
  if (ch === '/') return 'maybe-comment';
  return null;
}

/**
 * @param {string} name 函数标识（探针名用 <label>.<fn>）
 * @param {string[]} params 参数名，注入 args 捕获
 * @returns {string} 注入的 enter 文本（无缩进前置）
 */
function enterText(name, params) {
  const args = params.length ? `{ ${params.join(', ')} }` : '{}';
  return `enterScope(${JSON.stringify(name)}, { args: ${args} });`;
}
function exitText(name) {
  return `exitScope(${JSON.stringify(name)}, {});`;
}

/**
 * 把整段模块源码做 scope 插桩。
 * @param {string} src 模块源码文本
 * @param {string} label 模块标识（探针名前缀，如 "key-pool-proxy" 或文件相对路径）
 * @returns {{ source: string, injected: number }} 插桩后源码 + 注入的函数数
 */
export function instrumentSource(src, label) {
  let injected = 0;

  // 收集 "function NAME ( params )" 或 "async function..." 或 "class { NAME ( params ) { }" 的块体区间
  // 简化：只处理 function 声明 / async function / 类方法，扫描配对花括号。
  const edits = [];

  // 状态机扫描：out / str / tmpl / linecomment / blockcomment
  let i = 0;
  const n = src.length;

  const findBodyOpen = (from) => {
    // 从 from 起找到第一个不在字符串/注释里的 '{'
    let j = from;
    let st = 'out';
    while (j < n) {
      const c = src[j];
      if (st === 'out') {
        if (c === '{') return j;
        const s = stateFor(c);
        if (s === 'str' || s === 'tmpl') st = s;
        else if (c === '/') {
          if (src[j + 1] === '/') { st = 'line'; j++; }
          else if (src[j + 1] === '*') { st = 'block'; j++; }
        }
      } else if (st === 'str') {
        if (c === '\\') j++;
        else if (c === '"' || c === "'") st = 'out';
      } else if (st === 'tmpl') {
        if (c === '`') st = 'out';
        else if (c === '\\') j++;
      } else if (st === 'line') {
        if (c === '\n') st = 'out';
      } else if (st === 'block') {
        if (c === '*' && src[j + 1] === '/') { st = 'out'; j++; }
      }
      j++;
    }
    return -1;
  };

  const findBodyClose = (open) => {
    // 从 open 起配对花括号到闭合，跳字符串/模板/注释
    let depth = 0;
    let j = open;
    let st = 'out';
    while (j < n) {
      const c = src[j];
      if (st === 'out') {
        if (c === '{') { depth++; }
        else if (c === '}') {
          depth--;
          if (depth === 0) return j;
        } else {
          const s = stateFor(c);
          if (s === 'str' || s === 'tmpl') st = s;
          else if (c === '/') {
            if (src[j + 1] === '/') { st = 'line'; j++; }
            else if (src[j + 1] === '*') { st = 'block'; j++; }
          }
        }
      } else if (st === 'str') {
        if (c === '\\') j++;
        else if (c === '"' || c === "'") st = 'out';
      } else if (st === 'tmpl') {
        if (c === '`') st = 'out';
        else if (c === '\\') j++;
      } else if (st === 'line') {
        if (c === '\n') st = 'out';
      } else if (st === 'block') {
        if (c === '*' && src[j + 1] === '/') { st = 'out'; j++; }
      }
      j++;
    }
    return -1;
  };

  const skipToEndOf = (token, j) => (j < n ? src.indexOf(token, j) : -1);

  i = 0;
  while (i < n) {
    // 跳过字符串/注释
    const c = src[i];
    const st = stateFor(c);
    if (st === 'str') { i = skipToEndOf(c, i + 1); if (i < 0) break; i++; continue; }
    if (st === 'tmpl') { i = skipToEndOf('`', i + 1); if (i < 0) break; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { i = skipToEndOf('\n', i + 1); if (i < 0) break; i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }

    // function / async function / class method 探测
    const rest = src.slice(i);
    let fnStart = -1;
    let m = /^(?:function\s|\*?\s*)([*$@?#:>[\]\w\s]*?)(?:\b)([A-Za-z_$][\w$]*)\s*\(/y.exec(rest);
    // function / async function / (export) 声明探测
    const fdecl = /^(?:export\s+(?:default\s+)?|async\s+)?function\s*(\*)?\s*([A-Za-z_$][\w$]*)\s*\(/y.exec(rest);
    if (fdecl) {
      const name = fdecl[2];
      // 参数列表结束
      let closeParen = rest.indexOf(')', fdecl[0].length);
      if (closeParen < 0) { i++; continue; }
      const paramsText = rest.slice(fdecl[0].length, closeParen);
      const params = (paramsText.match(/[A-Za-z_$][\w$]*/g) || []).filter((p) => p !== 'async' && p !== 'function');
      const headEnd = i + closeParen + 1;
      const open = findBodyOpen(headEnd);
      if (open < 0) { i++; continue; }
      const close = findBodyClose(open);
      if (close < 0) { i++; continue; }
      const pname = `${label}.${name}`;
      edits.push({ at: open + 1, text: `\n${enterText(pname, params)}\ntry {` });
      edits.push({ at: close, text: `} finally {\n${exitText(pname)}\n}` });
      injected++;
      i = close + 1;
      continue;
    }

    i++;
  }

  if (edits.length === 0) return { source: src, injected: 0 };

  // 从大到小应用（避免偏移漂移）
  edits.sort((a, b) => b.at - a.at);
  let out = src;
  for (const e of edits) {
    out = out.slice(0, e.at) + e.text + out.slice(e.at);
  }
  return { source: out, injected };
}

export function shouldInstrument(url) {
  if (url.startsWith('node:') || url.startsWith('data:')) return false;
  for (const s of SKIP_IMPORTS) if (url.startsWith(s)) return false;
  // 跳过探针自身与 loader 内部文件（避免自插桩），但不跳过其它普通模块
  if (/(probe|loader|bootstrap|transform_scope)\.(m?js)$/.test(url)) return false;
  return true;
}