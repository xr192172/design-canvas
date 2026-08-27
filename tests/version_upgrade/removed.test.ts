/**
 * removed：废弃/移除 API 检测（阶段 C）测试
 *
 * 覆盖：
 *   - 按扩展名选择规则集
 *   - Java：声明 JDK 8 时"JDK 11 起移除"的 API 仍在内置 → 不报；
 *     声明 JDK 11 时报移除 API（JAXB/JAX-WS/JAF/公共注解/CORBA）+ 废弃 Observer，
 *     不误报 javax.annotation.processing、不报未到 17 的 SecurityManager；
 *     声明 JDK 21 时 SecurityManager 也报。
 *   - Go：声明 1.16 报 ioutil、不报 rand.Seed；声明 1.21 两者都报。
 *   - Node：声明 6 只报 new Buffer；声明 12 报 new Buffer/createCipher/url.parse。
 *   - 同行同规则去重。
 */
import { describe, it, expect } from 'vitest';
import { scanRemovedApis, removedRulesForExt } from '../../src/version_upgrade/removed';

const JAVA_SRC = `package com.acme;

import javax.xml.bind.JAXBContext;          // 移除(11)
import javax.xml.ws.Endpoint;              // 移除(11)
import javax.activation.DataHandler;       // 移除(11)
import javax.annotation.PostConstruct;     // 移除(11)
import javax.annotation.processing.Processor; // 仍在 JDK，不应命中
import org.omg.CORBA.ORB;                  // 移除(11)

public class App {
  @PostConstruct
  void init() {}

  java.util.Observable ob;                 // 废弃(9)
  java.lang.SecurityManager sm;            // 废弃(17)
}
`;

const GO_SRC = `package main

import (
  "io/ioutil"
  "math/rand"
)

func main() {
  rand.Seed(1)
  _, _ = ioutil.ReadFile("a")
}
`;

const TS_SRC = `import { createCipher } from "crypto";
import { parse } from "url";

const buf = new Buffer("x");
const u = url.parse("https://a.b");
const c = crypto.createCipher("aes-256-gcm", "k");
`;

const apiNames = (hits: Array<{ api: string }>): string[] =>
  [...new Set(hits.map((h) => h.api))].sort();

describe('removedRulesForExt', () => {
  it('按扩展名选择规则集', () => {
    expect(removedRulesForExt('.java').length).toBeGreaterThan(0);
    expect(removedRulesForExt('.go').length).toBeGreaterThan(0);
    expect(removedRulesForExt('.ts').length).toBeGreaterThan(0);
    expect(removedRulesForExt('.py').length).toBe(0);
  });
});

describe('scanRemovedApis（Java）', () => {
  it('声明 JDK 8：JDK 11 起移除的 API 仍在内置 → 不报', () => {
    const hits = scanRemovedApis([{ path: 'src/App.java', content: JAVA_SRC }], 8);
    expect(hits).toHaveLength(0); // 全部 since >= 9 > 8
  });

  it('声明 JDK 11：报全部移除(11) API + 废弃 Observer，不报 processing 与 SecurityManager', () => {
    const hits = scanRemovedApis([{ path: 'src/App.java', content: JAVA_SRC }], 11);
    expect(apiNames(hits)).toEqual([
      'CORBA（javax.rmi / org.omg）',
      'JAF（javax.activation）',
      'JAX-WS（javax.xml.ws）',
      'JAXB（javax.xml.bind）',
      'Observer / Observable',
      '公共注解（javax.annotation）',
    ]);
    // 移除类与废弃类标签正确
    const jaxb = hits.find((h) => h.api === 'JAXB（javax.xml.bind）')!;
    expect(jaxb.kind).toBe('removed');
    expect(jaxb.since).toBe(11);
    expect(jaxb.rewrite.length).toBeGreaterThan(0);
    expect(jaxb.line).toBeGreaterThan(0);
    const obs = hits.find((h) => h.api === 'Observer / Observable')!;
    expect(obs.kind).toBe('deprecated');
    // 不误报 javax.annotation.processing
    expect(hits.some((h) => h.snippet.includes('processing'))).toBe(false);
  });

  it('声明 JDK 21：SecurityManager 也报（since 17 <= 21）', () => {
    const hits = scanRemovedApis([{ path: 'src/App.java', content: JAVA_SRC }], 21);
    const names = apiNames(hits);
    expect(names).toContain('SecurityManager');
    expect(names).toContain('JAXB（javax.xml.bind）');
    expect(names).toContain('Observer / Observable');
  });
});

describe('scanRemovedApis（Go）', () => {
  it('声明 1.16：只报 ioutil（rand.Seed 1.20 > 16 不报）', () => {
    const hits = scanRemovedApis([{ path: 'main.go', content: GO_SRC }], 16);
    expect(apiNames(hits)).toEqual(['io/ioutil']);
  });

  it('声明 1.21：ioutil 与 rand.Seed 都报', () => {
    const hits = scanRemovedApis([{ path: 'main.go', content: GO_SRC }], 21);
    expect(apiNames(hits)).toEqual(['io/ioutil', 'math/rand.Seed']);
  });
});

describe('scanRemovedApis（Node）', () => {
  it('声明 6：只报 new Buffer（createCipher 10 / url.parse 11 > 6 不报）', () => {
    const hits = scanRemovedApis([{ path: 'src/index.ts', content: TS_SRC }], 6);
    expect(apiNames(hits)).toEqual(['new Buffer(...)']);
  });

  it('声明 12：new Buffer / createCipher / url.parse 都报', () => {
    const hits = scanRemovedApis([{ path: 'src/index.ts', content: TS_SRC }], 12);
    expect(apiNames(hits)).toEqual([
      'crypto.createCipher',
      'new Buffer(...)',
      'url.parse（legacy URL）',
    ]);
  });
});

describe('scanRemovedApis（去重）', () => {
  it('同一行同一规则只记一次，跨行各记一次', () => {
    const oneLine = `import javax.xml.bind.JAXBContext; import javax.xml.bind.Marshaller;\n`;
    const hits1 = scanRemovedApis([{ path: 'A.java', content: oneLine }], 11);
    expect(hits1).toHaveLength(1); // 同一行同规则合并

    const twoLine = `import javax.xml.bind.JAXBContext;\nimport javax.xml.bind.Marshaller;\n`;
    const hits2 = scanRemovedApis([{ path: 'A.java', content: twoLine }], 11);
    expect(hits2).toHaveLength(2); // 两行各命中一次
  });
});
