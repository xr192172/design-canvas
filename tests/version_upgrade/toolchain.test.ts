/**
 * toolchain：工具链版本盘点（阶段 A）测试
 *
 * 覆盖：
 *   - 多子项目多工具链声明盘点（pom.xml JDK8/JDK21、.nvmrc、go.mod、.tool-versions、package.json engines）
 *   - 各声明文件的解析规则（优先级、降级字段）
 *   - 版本解析与比较（JDK 1.8→8、go 1.21 字典序、node 主版本）
 *   - 声明 vs 本机运行时的匹配（ok / missing / mismatch）
 *   - 跳目录（node_modules/.git 不进子项目根）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import {
  scanToolchainDeclarations,
  parseDeclarationFile,
  parseToolchainVersion,
  versionSatisfies,
  matchRuntimes,
  scanToolchains,
  type RuntimeInfo,
} from '../../src/version_upgrade/toolchain';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      // leave to OS on Windows
    }
  }
});

function tempRoot(): string {
  const dir = path.join(os.tmpdir(), `toolchain-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

describe('scanToolchainDeclarations', () => {
  it('盘点多子项目多工具链声明：pom(.java.version/release) + .nvmrc + go.mod + .tool-versions + engines', () => {
    const root = tempRoot();
    // service-a：老项目 JDK 8（java.version）
    write(root, 'service-a/pom.xml', `<project><properties><java.version>1.8</java.version></properties></project>`);
    // service-b：新项目 JDK 21（maven.compiler.release）
    write(root, 'service-b/pom.xml', `<project><properties><maven.compiler.release>21</maven.compiler.release></properties></project>`);
    // web-frontend：node 18
    write(root, 'web-frontend/.nvmrc', '18.17.0\n');
    // worker：go 1.21
    write(root, 'worker/go.mod', 'module github.com/acme/worker\n\ngo 1.21\n');
    // 根目录 asdf
    write(root, '.tool-versions', 'nodejs 20\njava 17\n');

    const decls = scanToolchainDeclarations(root);
    const pick = (d: typeof decls) => d.map((x) => `${x.projectDir}:${x.tool}=${x.declaredVersion}`).sort();

    expect(pick(decls)).toEqual([
      '.:java=17', '.:node=20', // asdf 根声明
      'service-a:java=1.8', // declaredVersion 保留原文，归一化在比较阶段
      'service-b:java=21',
      'web-frontend:node=18.17.0',
      'worker:go=1.21',
    ]);
  });

  it('跳过 node_modules / .git 等目录，不进子项目根', () => {
    const root = tempRoot();
    write(root, 'app/pom.xml', `<project><properties><java.version>17</java.version></properties></project>`);
    write(root, 'app/node_modules/dep/pom.xml', `<project><properties><java.version>8</java.version></properties></project>`);
    write(root, 'app/.git/pom.xml', `<project><properties><java.version>8</java.version></properties></project>`);

    const decls = scanToolchainDeclarations(root);
    expect(decls).toHaveLength(1);
    expect(decls[0].declaredVersion).toBe('17');
  });

  it('gradle sourceCompatibility 与 toolchain 都能解析', () => {
    const root = tempRoot();
    write(root, 'svc/build.gradle', `plugins { id 'java' }\nsourceCompatibility = '1.8'\n`);
    write(root, 'svc2/build.gradle.kts', `java {\n  toolchain { languageVersion = JavaLanguageVersion.of(21) }\n}\n`);
    const decls = scanToolchainDeclarations(root);
    const j = decls.filter((d) => d.tool === 'java');
    expect(j).toHaveLength(2);
    expect(j.some((d) => d.projectDir === 'svc' && d.declaredVersion === '1.8')).toBe(true);
    expect(j.some((d) => d.projectDir === 'svc2' && d.declaredVersion === '21')).toBe(true);
  });

  it('pom.xml 优先级：maven.compiler.release > source > java.version', () => {
    const root = tempRoot();
    write(root, 'pom.xml', `<project><properties>
      <java.version>8</java.version>
      <maven.compiler.source>11</maven.compiler.source>
      <maven.compiler.release>21</maven.compiler.release>
    </properties></project>`);
    const decls = scanToolchainDeclarations(root);
    expect(decls).toHaveLength(1);
    expect(decls[0].declaredVersion).toBe('21');
  });

  it('package.json engines.node 与 .nvmrc 并存时各记一条', () => {
    const root = tempRoot();
    write(root, 'front/.nvmrc', '16\n');
    write(root, 'front/package.json', JSON.stringify({ name: 'front', engines: { node: '>=18' } }));
    const decls = scanToolchainDeclarations(root);
    expect(decls).toHaveLength(2);
    expect(decls.every((d) => d.tool === 'node')).toBe(true);
  });
});

describe('parseToolchainVersion / versionSatisfies', () => {
  it('JDK 版本归一化：1.8→8、1.8.0_292→8、17.0.9→17、21→21', () => {
    expect(parseToolchainVersion('java', '1.8')).toEqual({ major: 8 });
    expect(parseToolchainVersion('java', '1.8.0_292')).toEqual({ major: 8 });
    expect(parseToolchainVersion('java', '17.0.9')).toEqual({ major: 17 });
    expect(parseToolchainVersion('java', '21')).toEqual({ major: 21 });
  });

  it('Go 版本按 major.minor 字典序比较：1.22 满足 1.21，1.20 不满足', () => {
    expect(versionSatisfies('go', '1.21', '1.22')).toBe(true);
    expect(versionSatisfies('go', '1.21', '1.20')).toBe(false);
    expect(versionSatisfies('go', '1.21', '1.21')).toBe(true);
  });

  it('Node 版本按主版本比较：18 满足 18，20 满足 18，16 不满足 18', () => {
    expect(versionSatisfies('node', '18', '18.17.0')).toBe(true);
    expect(versionSatisfies('node', '18', '20.11.0')).toBe(true);
    expect(versionSatisfies('node', '18', '16.20.2')).toBe(false);
  });

  it('非法版本返回 null / 比较为 false', () => {
    expect(parseToolchainVersion('java', 'abc')).toBeNull();
    expect(versionSatisfies('go', 'abc', '1.21')).toBe(false);
  });
});

describe('matchRuntimes', () => {
  const runtimes: RuntimeInfo[] = [
    { tool: 'java', version: '17.0.9' },
    { tool: 'node', version: 'v20.11.0' },
    { tool: 'go', version: null }, // 本机没装 go
  ];

  it('满足→ok；缺工具→missing；版本不足→mismatch', () => {
    const decls = [
      { projectDir: 'a', tool: 'java' as const, source: 'pom.xml', declaredVersion: '8', raw: '<java.version>8' },
      { projectDir: 'b', tool: 'java' as const, source: 'pom.xml', declaredVersion: '21', raw: '<java.version>21' },
      { projectDir: 'c', tool: 'node' as const, source: '.nvmrc', declaredVersion: '18', raw: '18' },
      { projectDir: 'd', tool: 'go' as const, source: 'go.mod', declaredVersion: '1.21', raw: 'go 1.21' },
    ];
    const matches = matchRuntimes(decls, runtimes);
    const byProj = new Map(matches.map((m) => [m.projectDir, m]));
    expect(byProj.get('a')?.status).toBe('ok'); // 8 <= 17
    expect(byProj.get('b')?.status).toBe('mismatch'); // 21 > 17
    expect(byProj.get('c')?.status).toBe('ok'); // 18 <= 20
    expect(byProj.get('d')?.status).toBe('missing'); // 本机无 go
  });
});

describe('parseDeclarationFile', () => {
  it('空/无声明文件返回空数组', () => {
    const root = tempRoot();
    write(root, 'pom.xml', '<project></project>');
    write(root, 'package.json', JSON.stringify({ name: 'x' }));
    expect(parseDeclarationFile(path.join(root, 'pom.xml'))).toHaveLength(0);
    expect(parseDeclarationFile(path.join(root, 'package.json'))).toHaveLength(0);
  });
});

describe('scanToolchains 编排', () => {
  it('返回 { declarations, runtimes, matches } 三件套', () => {
    const root = tempRoot();
    write(root, 'svc/pom.xml', `<project><properties><java.version>1.8</java.version></properties></project>`);
    const scan = scanToolchains(root);
    expect(scan.declarations).toHaveLength(1);
    expect(Array.isArray(scan.runtimes)).toBe(true);
    expect(scan.matches).toHaveLength(1);
    expect(scan.matches[0].declaredVersion).toBe('1.8');
    // 本机是否装 JDK 不确定，只校验状态合法 + 有说明
    expect(['ok', 'missing', 'mismatch']).toContain(scan.matches[0].status);
    expect(scan.matches[0].note.length).toBeGreaterThan(0);
  });
});
