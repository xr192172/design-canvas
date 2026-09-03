/**
 * java spring_mvc_layering（收敛进 Java 重构执行器）测试
 *
 * 覆盖：
 *   - collectJavaFiles：跳过噪音目录，只收 .java
 *   - 注解分层识别：@RestController/@Service/@Repository/@Entity 归属 layer
 *   - buildSpringMvcLayeringPlan：迁移目标包推导 + package 声明改写 + import FQN 改写 + moves
 *   - 已落位（new_pkg === old_pkg）不迁移
 *   - javaVerifyCommands 探测
 *   - Java 执行器被 runRefactorPipeline 拾取
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
  buildSpringMvcLayeringPlan,
  renderLayeringText,
  DEFAULT_ANNOTATION_LAYERS,
} from '../../src/java_refactor/layering.js';
import { javaVerifyCommands, javaExecutor, buildSpringMvcStage } from '../../src/java_refactor/executor.js';
import { runRefactorPipeline } from '../../src/tools/refactor_pipeline';

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
  const dir = path.join(os.tmpdir(), `java-ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

const PJ = (r: string, p: string) => path.posix.join('src', 'main', 'java', 'com', 'app', p);

describe('collectJavaFiles', () => {
  it('只收 .java，跳过 target/build', () => {
    const root = tempRoot();
    write(root, 'src/main/java/com/app/User.java', 'public class User {}\n');
    write(root, 'target/classes/Gen.java', 'class G {}\n');
    const files = collectJavaFiles(root);
    expect(files).toEqual([PJ(root, 'User.java')]);
  });
});

describe('layerForType', () => {
  it('Spring 注解 → 层映射（大小写不敏感）', () => {
    expect(layerForType(['RestController'], DEFAULT_ANNOTATION_LAYERS)).toBe('controller');
    expect(layerForType(['Service'], DEFAULT_ANNOTATION_LAYERS)).toBe('service');
    expect(layerForType(['Mapper'], DEFAULT_ANNOTATION_LAYERS)).toBe('repository');
    expect(layerForType(['Entity'], DEFAULT_ANNOTATION_LAYERS)).toBe('entity');
    expect(layerForType(['Configuration'], DEFAULT_ANNOTATION_LAYERS)).toBe('config');
    expect(layerForType(['Weird'], DEFAULT_ANNOTATION_LAYERS)).toBe('other');
  });
});

describe('inferBasePackage', () => {
  it('共同前缀', () => {
    expect(inferBasePackage(['com.app.user.c', 'com.app.user.s', 'com.app.user'])).toBe('com.app.user');
    expect(inferBasePackage([])).toBe('');
  });
});

describe('planSpringLayering（真实 tree-sitter 解析）', () => {
  it('识别 controller/service/repository/entity', async () => {
    const root = tempRoot();
    write(root, 'src/main/java/com/app/UserController.java', 'package com.app;\n@RestController\npublic class UserController {}\n');
    write(root, 'src/main/java/com/app/UserService.java', 'package com.app;\n@Service\npublic class UserService {}\n');
    write(root, 'src/main/java/com/app/UserRepository.java', 'package com.app;\n@Repository\npublic interface UserRepository {}\n');
    write(root, 'src/main/java/com/app/UserEntity.java', 'package com.app;\n@Entity\npublic class UserEntity {}\n');
    const plan = await planSpringLayering({ project_dir: root });
    expect(plan.total_files).toBe(4);
    expect(plan.classified).toBe(4);
    expect(plan.base_package).toBe('com.app');
  });
});

describe('buildSpringMvcLayeringPlan（落盘计划）', () => {
  it('迁移 controller/service 到 com.app.<layer>，改 package + import FQN，产 moves', async () => {
    const root = tempRoot();
    // controller 里用 service：import com.app.UserService
    write(root, PJ(root, 'UserController.java'), [
      'package com.app;',
      'import org.springframework.web.bind.annotation.RestController;',
      'import com.app.UserService;',
      '@RestController',
      'public class UserController {',
      '  private final UserService svc;',
      '  public UserController(UserService svc) { this.svc = svc; }',
      '}',
    ].join('\n'));
    write(root, PJ(root, 'UserService.java'), [
      'package com.app;',
      'import org.springframework.stereotype.Service;',
      '@Service',
      'public class UserService {}',
    ].join('\n'));
    write(root, PJ(root, 'Plain.java'), 'package com.app;\npublic class Plain {}\n');

    const { plan, run } = await buildSpringMvcLayeringPlan(root, { project_dir: root });
    // controller + service 2 个迁移，Plain 归 other 不动
    expect(plan.classified).toBe(2);
    expect(run.moves ?? []).toHaveLength(2);

    // target 包推断：文件被移动到 <root>/<base>/<layer>/<Type>.java
    const targets = (run.moves ?? []).map((m) => path.relative(root, m.to).split(path.sep).join('/'));
    expect(targets).toEqual([
      'src/main/java/com/app/controller/UserController.java',
      'src/main/java/com/app/service/UserService.java',
    ]);

    // package 声明改写：moved 文件 content 含新包
    const ctrl = run.moves!.find((m) => m.to.endsWith('UserController.java'))!;
    const ctrlContent = run.absToNew.get(ctrl.to)!;
    expect(ctrlContent).toContain('package com.app.controller;');
    // import FQN 改写：UserService 的 import 从 com.app.UserService → com.app.service.UserService
    expect(ctrlContent).toContain('import com.app.service.UserService;');
    expect(ctrlContent).not.toContain('import com.app.UserService;');

    const svc = run.moves!.find((m) => m.to.endsWith('UserService.java'))!;
    expect(run.absToNew.get(svc.to)).toContain('package com.app.service;');
  });

  it('已落位（目标包=当前包）不迁移', async () => {
    const root = tempRoot();
    write(root, PJ(root, 'UserService.java'), 'package com.app.service;\n@Service\npublic class UserService {}\n');
    const { plan, run } = await buildSpringMvcLayeringPlan(root, { project_dir: root, target_base_package: 'com.app' });
    expect(plan.classified).toBe(1);
    expect(run.moves ?? []).toHaveLength(0);
    expect(run.absToNew.size).toBe(0);
  });

  it('同包裸引用（无 import）拆包后自动补 import', async () => {
    const root = tempRoot();
    // controller 用 UserService 但没 import——原来靠同包免 import；迁移后必须补
    write(root, PJ(root, 'UserController.java'), [
      'package com.app;',
      'import org.springframework.web.bind.annotation.RestController;',
      '@RestController',
      'public class UserController {',
      '  private final UserService svc;',
      '  public UserController(UserService svc) { this.svc = svc; }',
      '  public UserService make() { return new UserService(); }',
      '}',
    ].join('\n'));
    write(root, PJ(root, 'UserService.java'), 'package com.app;\n@Service\npublic class UserService {}\n');

    const { run } = await buildSpringMvcLayeringPlan(root, { project_dir: root });
    const ctrl = run.moves!.find((m) => m.to.endsWith('UserController.java'))!;
    const ctrlContent = run.absToNew.get(ctrl.to)!;
    // 补了指向新包的 import
    expect(ctrlContent).toContain('import com.app.service.UserService;');
    expect(ctrlContent).toContain('package com.app.controller;');
  });

  it('迁移文件自身不给自己补 self-import（本文件声明的同名类型跳过）', async () => {
    const root = tempRoot();
    // UserService 自身引用自己的类型（如返回类型）不应注入 `import com.app.service.UserService;`
    write(root, PJ(root, 'UserController.java'), [
      'package com.app;',
      'import org.springframework.web.bind.annotation.RestController;',
      'import com.app.UserService;',
      '@RestController',
      'public class UserController {',
      '  private final UserService svc;',
      '  public UserService get() { return svc; }',
      '}',
    ].join('\n'));
    write(root, PJ(root, 'UserService.java'), [
      'package com.app;',
      'import org.springframework.stereotype.Service;',
      '@Service',
      'public class UserService {',
      '  public UserService self() { return this; }',
      '}',
    ].join('\n'));

    const { run } = await buildSpringMvcLayeringPlan(root, { project_dir: root });
    const svc = run.moves!.find((m) => m.to.endsWith('UserService.java'))!;
    const svcContent = run.absToNew.get(svc.to)!;
    // 自身声明的 UserService 不补 import；也不重复该类型 import
    expect(svcContent).not.toContain('import com.app.service.UserService;');
    const ctrl = run.moves!.find((m) => m.to.endsWith('UserController.java'))!;
    expect(run.absToNew.get(ctrl.to)!).toContain('import com.app.service.UserService;'); // 已 import 的走 FQN 改写，不重复
  });
});

describe('javaVerifyCommands', () => {
  it('pom.xml → mvn compile；无构建文件 → 空', () => {
    const root = tempRoot();
    expect(javaVerifyCommands(root)).toHaveLength(0);
    write(root, 'pom.xml', '<project/>\n');
    const cmds = javaVerifyCommands(root);
    expect(cmds.length).toBe(1);
    expect(cmds[0].cmd).toBe('mvn');
    expect(cmds[0].args).toContain('compile');
  });
});

describe('javaExecutor 收敛', () => {
  it('isSourceFile 识别 .java；stage 含 spring_mvc_layering', () => {
    expect(javaExecutor.isSourceFile('src/a.java')).toBe(true);
    expect(javaExecutor.isSourceFile('src/a.ts')).toBe(false);
    const stage = javaExecutor.stages[0];
    expect(stage.kind).toBe('spring_mvc_layering');
    expect(buildSpringMvcStage().label).toContain('Spring MVC');
  });
});

describe('renderLayeringText', () => {
  it('含层计数与归属', async () => {
    const root = tempRoot();
    write(root, PJ(root, 'C.java'), 'package com.app;\n@RestController\npublic class C {}\n');
    const plan = await planSpringLayering({ project_dir: root });
    const text = renderLayeringText(plan);
    expect(text).toContain('controller');
    expect(text).toContain('C.java');
  });
});

describe('收敛：runRefactorPipeline 拾取 javaExecutor 落盘闭环', () => {
  it('spring_mvc_layering 随 Java 项目被探明触发，物理移动 + package/import 改写真实落盘', async () => {
    const root = tempRoot();
    // 一个 Java 工程：controller 依赖 service，都挂在 com.app 根包下
    write(root, 'src/main/java/com/app/UserController.java', [
      'package com.app;',
      'import org.springframework.web.bind.annotation.RestController;',
      'import com.app.UserService;',
      '@RestController',
      'public class UserController {',
      '  private final UserService svc;',
      '  public UserController(UserService svc) { this.svc = svc; }',
      '}',
    ].join('\n'));
    write(root, 'src/main/java/com/app/UserService.java', [
      'package com.app;',
      'import org.springframework.stereotype.Service;',
      '@Service',
      'public class UserService {}',
    ].join('\n'));

    let verifyCalls = 0;
    const verifyImpl = () => {
      verifyCalls++;
      return { status: 'pass' as const, at: 't' };
    };

    const res = await runRefactorPipeline({
      project_dir: root,
      steps: { spring_mvc_layering: { enabled: true } },
      verify: true,
      verifyImpl,
    });

    // 只命中 javaExecutor 的这一个 stage
    const stage = res.stages.find((x) => x.id === 'spring_mvc_layering');
    expect(stage?.outcome).toBe('applied');
    expect(res.total_files_changed).toBe(2);
    expect(verifyCalls).toBe(2); // 基线 + 改后
    expect(res.ok).toBe(true);

    // 物理移动：源文件从 com/app 移入对应 layer 子目录
    expect(fs.existsSync(path.join(root, ...'src/main/java/com/app/controller/UserController.java'.split('/')))).toBe(true);
    expect(fs.existsSync(path.join(root, ...'src/main/java/com/app/service/UserService.java'.split('/')))).toBe(true);
    // 旧位置已不存在
    expect(fs.existsSync(path.join(root, 'src', 'main', 'java', 'com', 'app', 'UserController.java'))).toBe(false);

    // 落盘内容：controller 改 package + import FQN
    const moved = fs.readFileSync(path.join(root, ...'src/main/java/com/app/controller/UserController.java'.split('/')), 'utf-8');
    expect(moved).toContain('package com.app.controller;');
    expect(moved).toContain('import com.app.service.UserService;');
    expect(moved).not.toContain('import com.app.UserService;');
  });

  it('空 / 非 Java 项目不探测出 spring_mvc_layering，不断言任何 stage', async () => {
    const root = tempRoot();
    write(root, 'a.ts', 'const x = 1;\n');
    const res = await runRefactorPipeline({
      project_dir: root,
      steps: { spring_mvc_layering: { enabled: true } },
      verify: false,
    });
    expect(res.stages.find((x) => x.id === 'spring_mvc_layering')).toBeUndefined();
    expect(res.planned_steps).toBe(0);
  });
});