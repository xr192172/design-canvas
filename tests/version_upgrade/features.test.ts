/**
 * features：语言特性契约差检测（阶段 B）测试
 *
 * 覆盖：
 *   - Java 特性检测（var / 箭头 case / 文本块 / record / sealed / instanceof 模式匹配）
 *   - 目标版本边界过滤（since > 目标才报告；升到 21 则不报）
 *   - Go 泛型函数、Node 可选链/空值合并
 *   - 同行同特性去重
 */
import { describe, it, expect } from 'vitest';
import { scanFeatureHits, rulesForExt } from '../../src/version_upgrade/features';

const JAVA_SRC = `package com.acme;

public class Demo {
  // 老 JDK 8 目标下，以下现代特性都是"超标需重写"
  public String a() {
    var name = "x";               // JDK 10
    return switch (name) {        // JDK 14
      case "x" -> "y";            // 箭头 case（JDK 14）
      default -> "z";
    };
  }

  public String b() {
    String json = """            // 文本块（JDK 15）
      {"a":1}
      """;
    return json;
  }

  public boolean c(Object o) {
    return o instanceof String s; // instanceof 模式匹配（JDK 16）
  }
}

record Point(int x, int y) {}     // record（JDK 16）
sealed interface Shape permits Circle {} // sealed（JDK 17）
`;

const GO_SRC = `package main

func Map[T any](xs []T, fn func(T) T) []T { // 泛型（Go 1.18）
  out := make([]T, 0, len(xs))
  for _, x := range xs {
    out = append(out, fn(x))
  }
  return out
}
`;

const TS_SRC = `export function greet(name?: string): string {
  const label = name ?? "guest"; // 空值合并（Node 14）
  return label?.toUpperCase();   // 可选链（Node 14）
}
`;

describe('rulesForExt', () => {
  it('按扩展名选择规则集', () => {
    expect(rulesForExt('.java').length).toBeGreaterThan(0);
    expect(rulesForExt('.go').length).toBeGreaterThan(0);
    expect(rulesForExt('.ts').length).toBeGreaterThan(0);
    expect(rulesForExt('.py').length).toBeGreaterThan(0); // Python 适配器已注册
  });
});

describe('scanFeatureHits（Java / 目标 JDK 8）', () => {
  it('报告全部超标现代特性（since > 8），含行号与重写建议', () => {
    const hits = scanFeatureHits([{ path: 'src/Demo.java', content: JAVA_SRC }], 8);
    const byFeature = new Map(hits.map((h) => [h.feature, h]));

    expect(hits.length).toBe(7); // 文本块起始/结束两行的 `"""` 各计一次，其余 5 类各一次
    expect(byFeature.has('var 局部变量')).toBe(true);
    expect(byFeature.has('switch 表达式 / 箭头 case')).toBe(true);
    expect(byFeature.has('文本块')).toBe(true);
    expect(byFeature.has('instanceof 模式匹配')).toBe(true);
    expect(byFeature.has('record 记录类')).toBe(true);
    expect(byFeature.has('sealed 密封类')).toBe(true);

    const rec = byFeature.get('record 记录类')!;
    expect(rec.file).toBe('src/Demo.java');
    expect(rec.since).toBe(16);
    expect(rec.rewrite.length).toBeGreaterThan(0);
    expect(rec.line).toBeGreaterThan(0);
  });
});

describe('scanFeatureHits（目标版本边界）', () => {
  it('目标 JDK 21 时，所有特性都在边界内 → 不报', () => {
    const hits = scanFeatureHits([{ path: 'src/Demo.java', content: JAVA_SRC }], 21);
    expect(hits).toHaveLength(0);
  });

  it('minVersion=-1 时报告全部命中（不限边界）', () => {
    const hits = scanFeatureHits([{ path: 'src/Demo.java', content: JAVA_SRC }], -1);
    expect(hits.length).toBe(7); // 文本块两行各计一次
  });

  it('Go 泛型函数检测（目标 Go 1.16）', () => {
    const hits = scanFeatureHits([{ path: 'main.go', content: GO_SRC }], 16);
    expect(hits).toHaveLength(1);
    expect(hits[0].feature).toBe('泛型函数（类型参数）');
    expect(hits[0].since).toBe(18);
  });

  it('Node 可选链与空值合并检测（目标 Node 12）', () => {
    const hits = scanFeatureHits([{ path: 'src/greet.ts', content: TS_SRC }], 12);
    const names = hits.map((h) => h.feature).sort();
    expect(names).toEqual(['可选链 ?.', '空值合并 ??']);
  });
});

describe('scanFeatureHits（去重与多文件）', () => {
  it('同一行同一特性只记一次', () => {
    const src = `class A {\n  var a = 1; var b = 2;\n}`;
    const hits = scanFeatureHits([{ path: 'A.java', content: src }], 8);
    expect(hits.filter((h) => h.feature === 'var 局部变量')).toHaveLength(1);
  });

  it('多文件独立扫描', () => {
    const a = { path: 'a/A.java', content: 'class A { var x = 1; }' };
    const b = { path: 'b/B.java', content: 'class B { var y = 2; }' };
    const hits = scanFeatureHits([a, b], 8);
    expect(hits).toHaveLength(2);
    expect(new Set(hits.map((h) => h.file)).size).toBe(2);
  });
});
