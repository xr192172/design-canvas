/**
 * adapters/java —— Java/JDK 语言适配器
 *
 * 方言要点：
 *   - 声明文件：pom.xml（maven.compiler.release > source > java.version）、
 *     build.gradle(.kts)（toolchain JavaLanguageVersion.of / sourceCompatibility / targetCompatibility）、
 *     .tool-versions（java 行）
 *   - 版本边界：JDK 主版本（1.8 → 8）
 *   - 静态闸：javac --release N 单文件编译（仅限无外部 import 的自包含文件，
 *     有外部依赖的改由项目级构建验证，避免"cannot find symbol"噪声）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type {
  LanguageAdapter,
  AdapterDeclaration,
  VersionInfo,
  SourceFile,
  StaticGateItem,
  FeatureRule,
  RemovedRule,
} from './types.js';

// ── 规则表（原 features.ts / removed.ts 的 Java 段） ──────────────

export const JDK_FEATURES: FeatureRule[] = [
  { name: 'var 局部变量', tool: 'java', since: 10, pattern: /\bvar\s+\w+\s*=/, rewrite: '改为显式类型（如 List<String>）' },
  { name: 'switch 表达式 / 箭头 case', tool: 'java', since: 14, pattern: /case\s+[^:]+->/, rewrite: '改回传统 switch 语句（case x: ... break;）或 if-else' },
  { name: '文本块', tool: 'java', since: 15, pattern: /"""/, rewrite: '改为普通字符串 + 显式 \n 拼接' },
  { name: 'instanceof 模式匹配', tool: 'java', since: 16, pattern: /\binstanceof\s+\w+(?:\.\w+)*\s+\w+/, rewrite: '改回 instanceof 判断 + 显式强转' },
  { name: 'record 记录类', tool: 'java', since: 16, pattern: /\brecord\s+\w+\s*\(/, rewrite: '改为普通类（final 字段 + 构造器 + getter + equals/hashCode/toString）' },
  { name: 'sealed 密封类', tool: 'java', since: 17, pattern: /\bsealed\s+(?:non-sealed\s+)?(?:class|interface)/, rewrite: '去掉 sealed，改回普通 class/interface' },
];

export const JDK_REMOVED: RemovedRule[] = [
  { name: 'JAXB（javax.xml.bind）', tool: 'java', since: 11, kind: 'removed', pattern: /\bjavax\.xml\.bind\b/, rewrite: 'JDK 11 起不再内置：引入 jakarta.xml.bind 依赖，或改用 JAXP / Jackson XML' },
  { name: 'JAX-WS（javax.xml.ws）', tool: 'java', since: 11, kind: 'removed', pattern: /\bjavax\.xml\.ws\b/, rewrite: 'JDK 11 起不再内置：改用 Spring Web Services 或 REST 接口' },
  { name: 'JAF（javax.activation）', tool: 'java', since: 11, kind: 'removed', pattern: /\bjavax\.activation\b/, rewrite: 'JDK 11 起不再内置：引入 jakarta.activation 依赖' },
  { name: '公共注解（javax.annotation）', tool: 'java', since: 11, kind: 'removed', pattern: /\bjavax\.annotation(?!\.processing)\b/, rewrite: 'JDK 11 起不再内置（javax.annotation.processing 仍保留）：引入 jakarta.annotation 依赖' },
  { name: 'CORBA（javax.rmi / org.omg）', tool: 'java', since: 11, kind: 'removed', pattern: /\b(?:javax\.rmi|org\.omg\.)/, rewrite: 'JDK 11 起移除 CORBA：换用 RMI-over-HTTP 或 gRPC' },
  { name: 'Observer / Observable', tool: 'java', since: 9, kind: 'deprecated', pattern: /\bjava\.util\.(?:Observable|Observer)\b/, rewrite: '改用事件/回调机制（PropertyChangeListener 或发布订阅）' },
  { name: 'SecurityManager', tool: 'java', since: 17, kind: 'deprecated', pattern: /\bjava\.lang\.SecurityManager\b/, rewrite: 'JDK 17 起标记废弃（未来移除）：改用 JVM 沙箱 / 容器隔离' },
];

// ── 声明解析（原 toolchain.ts 的 pom/gradle/asdf-java 段） ─────────

function parsePomXml(content: string): { version: string; raw: string } | null {
  // 优先级：maven.compiler.release > maven.compiler.source > java.version
  const release = content.match(/<maven\.compiler\.release>\s*([\d.]+)\s*<\/maven\.compiler\.release>/);
  if (release) return { version: release[1], raw: `<maven.compiler.release>${release[1]}` };
  const source = content.match(/<maven\.compiler\.source>\s*([\d.]+)\s*<\/maven\.compiler\.source>/);
  if (source) return { version: source[1], raw: `<maven.compiler.source>${source[1]}` };
  const jv = content.match(/<java\.version>\s*([\d.]+(?:_[\d.]+)?)\s*<\/java\.version>/);
  if (jv) return { version: jv[1], raw: `<java.version>${jv[1]}` };
  return null;
}

function parseGradle(content: string): { version: string; raw: string } | null {
  const tc = content.match(/JavaLanguageVersion\.of\(\s*(\d+)\s*\)/);
  if (tc) return { version: tc[1], raw: `JavaLanguageVersion.of(${tc[1]})` };
  const sc = content.match(/sourceCompatibility\s*=\s*['"]?([\d.]+)['"]?/);
  if (sc) return { version: sc[1], raw: `sourceCompatibility = ${sc[1]}` };
  const target = content.match(/targetCompatibility\s*=\s*['"]?([\d.]+)['"]?/);
  if (target) return { version: target[1], raw: `targetCompatibility = ${target[1]}` };
  return null;
}

// ── 静态闸：javac --release N 单文件编译 ───────────────────────────

/** 本机 javac 主版本（17.0.12 → 17；无 javac → null） */
function localJavacMajor(): number | null {
  try {
    const r = spawnSync('javac', ['-version'], { encoding: 'utf-8', windowsHide: true });
    const m = `${r.stdout || ''}${r.stderr || ''}`.match(/javac\s+(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

/** 是否自包含（仅依赖 JDK 自带 API）：无 import 或只有 java.* / javax.* */
function isSelfContained(content: string): boolean {
  const m = content.match(/^\s*import\s+([\w.]+);/m);
  if (!m) return true;
  return /^(?:java|javax)\./.test(m[1]);
}

/** javac 错误输出在中文 Windows 上是 GBK 编码，Node 无法直接 utf-8 读取；用 TextDecoder('gbk') 解码 */
function decodeJavacOutput(buf: Buffer): string {
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return buf.toString('utf-8');
  }
}

/** 单文件按声明版本编译（--release 仅 JDK9+；隔离临时目录，不污染项目） */
function javacSingleFile(file: SourceFile, boundary: number): StaticGateItem {
  if (!isSelfContained(file.content)) {
    return { file: file.path, status: 'skipped', detail: '含外部依赖，无法单文件隔离编译，改由项目级构建验证' };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-javac-'));
  // 用原始文件名（不含路径），保证 public class 名与文件名一致，javac 才认
  const abs = path.join(tmp, path.basename(file.path));
  try {
    fs.writeFileSync(abs, file.content, 'utf-8');
    // -encoding UTF-8：源码显式按 UTF-8 读，避免中文 Windows 默认 GBK 导致"不可映射字符"误报
    const r = spawnSync('javac', ['-encoding', 'UTF-8', '--release', String(boundary), abs], {
      encoding: 'buffer',
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (r.status === 0) return { file: file.path, status: 'ok' };
    const raw = decodeJavacOutput(Buffer.concat([r.stdout || Buffer.alloc(0), r.stderr || Buffer.alloc(0)]));
    const lines = raw.split(/\r?\n/).filter(Boolean);
    // 保留可读的"文件:行号"定位 + 尾部错误摘要；单文件场景路径无意义，剥掉临时目录前缀
    const locs = [
      ...new Set(
        lines
          .map((l) => l.match(/^.*?\.java:(\d+):/)?.[1])
          .filter((x): x is string => !!x),
      ),
    ];
    const tail = lines.slice(-3).join(' | ').replaceAll(path.dirname(abs) + path.sep, '').slice(0, 400);
    const detail = (locs.length ? `第 ${locs.join('、')} 行 ` : '') + tail || `javac --release ${boundary} 编译失败`;
    return { file: file.path, status: 'fail', detail };
  } catch (e) {
    return { file: file.path, status: 'skipped', detail: `javac 执行异常: ${(e as Error).message}` };
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Windows 上留给 OS 清理
    }
  }
}

// ── 适配器对象 ────────────────────────────────────────────────────

export const javaAdapter: LanguageAdapter = {
  lang: 'java',
  label: 'JDK',
  declarationFiles: ['pom.xml', 'build.gradle', 'build.gradle.kts', '.tool-versions'],
  sourceExts: ['.java'],
  skipDirs: ['target', '.gradle'],
  asdfToolNames: ['java'],
  featureRules: JDK_FEATURES,
  removedRules: JDK_REMOVED,
  probe: {
    cmd: 'java',
    args: ['-version'],
    parse: (out) => out.match(/version\s+"?([\d._]+)/)?.[1] ?? null,
  },

  parseDeclarationFile(abs: string): AdapterDeclaration[] {
    const name = path.basename(abs);
    let content = '';
    try {
      content = fs.readFileSync(abs, 'utf-8');
    } catch {
      return [];
    }
    const projectDir = path.dirname(abs);
    const emit = (r: { version: string; raw: string } | null): AdapterDeclaration[] =>
      r ? [{ projectDir, source: name, declaredVersion: r.version, raw: r.raw }] : [];

    if (name === 'pom.xml') return emit(parsePomXml(content));
    if (name === 'build.gradle' || name === 'build.gradle.kts') return emit(parseGradle(content));
    if (name === '.tool-versions') {
      // asdf 多行 "tool version"，只取 java 行
      const out: AdapterDeclaration[] = [];
      for (const line of content.split(/\r?\n/)) {
        const m = line.match(/^\s*java\s+([^\s#]+)/);
        if (!m) continue;
        out.push({ projectDir, source: name, declaredVersion: m[1], raw: line.trim() });
      }
      return out;
    }
    return [];
  },

  parseVersion(v: string): VersionInfo | null {
    // 1.8 / 1.8.0_292 → major 8；17 / 17.0.9 → major 17
    const s = String(v).trim().replace(/^v/, '');
    const m = s.match(/^(?:1\.)?(\d+)/);
    return m ? { major: parseInt(m[1], 10) } : null;
  },

  featureBoundary(info: VersionInfo): number {
    return info.major;
  },

  versionSatisfies(declared: string, local: string): boolean {
    const d = this.parseVersion(declared);
    const l = this.parseVersion(local);
    if (!d || !l) return false;
    return l.major >= d.major;
  },

  staticGate(_dir: string, boundary: number, files: SourceFile[]): StaticGateItem[] {
    const jv = localJavacMajor();
    if (jv == null) {
      return files.map((f) => ({ file: f.path, status: 'skipped', detail: '本机未安装 javac，无法编译级校验' }));
    }
    if (jv < 9) {
      return files.map((f) => ({ file: f.path, status: 'skipped', detail: 'javac --release 需 JDK9+，本机 javac 过旧' }));
    }
    if (boundary > jv) {
      // 本机编译器低于声明边界（如 javac 17 编译 --release 21），无法按目标版本校验 → 降级 skipped
      return files.map((f) => ({ file: f.path, status: 'skipped', detail: `本机 javac 为 ${jv}，低于声明边界 ${boundary}，无法按目标版本编译，改由项目级构建验证` }));
    }
    return files.map((f) => javacSingleFile(f, boundary));
  },
};
