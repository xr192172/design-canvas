/**
 * spring_mvc_layering —— 按 Spring MVC 分层（Java 归属识别 + 计划）测试
 *
 * 覆盖：
 *   - collectJavaFiles：跳过 target/build 等噪音目录，只收 .java
 *   - extractJavaTypes → planSpringLayering：@RestController/@Service/@Repository/@Entity 识别为对应层
 *   - layerForType：自定义映射覆盖 / 未命中归 other
 *   - inferBasePackage：多包取最长共同前缀
 *   - renderLayeringText：含各层计数与归属清单
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import {
  collectJavaFiles,
  layerForType,
  inferBasePackage,
  planSpringLayering,
  renderLayeringText,
  DEFAULT_ANNOTATION_LAYERS,
  LAYER_ORDER,
} from '../../src/tools/spring_mvc_layering';

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
  const dir = path.join(os.tmpdir(), `springmvc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

describe('collectJavaFiles', () => {
  it('只收 .java，跳过 target/build 噪音目录', () => {
    const root = tempRoot();
    write(root, 'src/main/java/com/app/User.java', 'public class User {}\n');
    write(root, 'src/main/java/com/app/ctrl/UserController.java', 'class C {}\n');
    write(root, 'target/classes/Gen.java', 'class G {}\n'); // 噪音
    write(root, 'build/generated/G2.java', 'class G2 {}\n'); // 噪音
    write(root, 'README.md', '# x\n');

    const files = collectJavaFiles(root);
    expect(files.sort()).toEqual([path.posix.join('src', 'main', 'java', 'com', 'app', 'User.java'), path.posix.join('src', 'main', 'java', 'com', 'app', 'ctrl', 'UserController.java')]);
  });
});

describe('layerForType', () => {
  it('Spring 注解 → 层映射（大小写不敏感）', () => {
    expect(layerForType(['RestController'], DEFAULT_ANNOTATION_LAYERS)).toBe('controller');
    expect(layerForType(['Controller'], DEFAULT_ANNOTATION_LAYERS)).toBe('controller');
    expect(layerForType(['Service'], DEFAULT_ANNOTATION_LAYERS)).toBe('service');
    expect(layerForType(['Repository'], DEFAULT_ANNOTATION_LAYERS)).toBe('repository');
    expect(layerForType(['Mapper'], DEFAULT_ANNOTATION_LAYERS)).toBe('repository');
    expect(layerForType(['Entity'], DEFAULT_ANNOTATION_LAYERS)).toBe('entity');
    expect(layerForType(['Configuration'], DEFAULT_ANNOTATION_LAYERS)).toBe('config');
  });

  it('未命中注解 → other；自定义映射可覆盖', () => {
    expect(layerForType(['SuperVisible'], DEFAULT_ANNOTATION_LAYERS)).toBe('other');
    const custom = { ...DEFAULT_ANNOTATION_LAYERS, supervisible: 'service' };
    expect(layerForType(['SuperVisible'], custom)).toBe('service');
  });
});

describe('inferBasePackage', () => {
  it('多包取最长共同前缀；空返回空串', () => {
    expect(inferBasePackage(['com.app.user.controller', 'com.app.user.service', 'com.app.user']) ).toBe('com.app.user');
    expect(inferBasePackage([])).toBe('');
  });
});

describe('planSpringLayering（真实 tree-sitter 解析）', () => {
  it('识别 controller/service/repository/entity 并统计层', async () => {
    const root = tempRoot();
    write(root, 'src/main/java/com/app/UserController.java', [
      'package com.app;',
      'import org.springframework.web.bind.annotation.RestController;',
      '@RestController',
      'public class UserController {',
      '}',
    ].join('\n'));
    write(root, 'src/main/java/com/app/UserService.java', [
      'package com.app;',
      'import org.springframework.stereotype.Service;',
      '@Service',
      'public class UserService {',
      '}',
    ].join('\n'));
    write(root, 'src/main/java/com/app/UserRepository.java', [
      'package com.app;',
      'import org.springframework.stereotype.Repository;',
      '@Repository',
      'public interface UserRepository {',
      '}',
    ].join('\n'));
    write(root, 'src/main/java/com/app/UserEntity.java', [
      'package com.app;',
      'import jakarta.persistence.Entity;',
      '@Entity',
      'public class UserEntity {',
      '}',
    ].join('\n'));
    write(root, 'src/main/java/com/app/Plain.java', 'package com.app;\npublic class Plain {}\n');

    const plan = await planSpringLayering({ project_dir: root });
    expect(plan.total_files).toBe(5);
    expect(plan.classified).toBe(4);
    expect(plan.other).toBe(1);
    expect(plan.layer_counts['controller']).toBe(1);
    expect(plan.layer_counts['service']).toBe(1);
    expect(plan.layer_counts['repository']).toBe(1);
    expect(plan.layer_counts['entity']).toBe(1);
    expect(plan.base_package).toBe('com.app');

    const byFile = new Map(plan.assignments.map((a) => [a.file, a.layer]));
    expect(byFile.get(path.posix.join('src', 'main', 'java', 'com', 'app', 'UserController.java'))).toBe('controller');
    expect(byFile.get(path.posix.join('src', 'main', 'java', 'com', 'app', 'UserService.java'))).toBe('service');
    expect(byFile.get(path.posix.join('src', 'main', 'java', 'com', 'app', 'UserRepository.java'))).toBe('repository');
    expect(byFile.get(path.posix.join('src', 'main', 'java', 'com', 'app', 'UserEntity.java'))).toBe('entity');
    expect(byFile.get(path.posix.join('src', 'main', 'java', 'com', 'app', 'Plain.java'))).toBe('other');
  });

  it('显式 target_base_package 覆盖推断；无 java 文件给 limitations', async () => {
    const root = tempRoot();
    write(root, 'src/main/java/com/app/U.java', '@RestController\npublic class U {}\n');
    const plan = await planSpringLayering({ project_dir: root, target_base_package: 'com.acme.app' });
    expect(plan.base_package).toBe('com.acme.app');

    const empty = tempRoot();
    write(empty, 'readme.txt', 'x');
    const plan2 = await planSpringLayering({ project_dir: empty });
    expect(plan2.total_files).toBe(0);
    expect(plan2.limitations.some((l) => l.includes('未发现 .java'))).toBe(true);
  });
});

describe('renderLayeringText', () => {
  it('含层计数与归属行', async () => {
    const root = tempRoot();
    write(root, 'src/main/java/com/app/C.java', 'package com.app;\n@RestController\npublic class C {}\n');
    const plan = await planSpringLayering({ project_dir: root });
    expect(LAYER_ORDER).toContain('controller');
    const text = renderLayeringText(plan);
    expect(text).toContain('controller');
    expect(text).toContain('C.java');
    expect(plan.base_package).toBe('com.app');
  });
});