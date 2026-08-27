/**
 * DSL 持久化
 *
 * 存储路径：
 *   1. <cwd>/.design-canvas/features/<feature>.json —— 各 feature 历史存档
 *   2. <cwd>/design-canvas.json —— 当前活态 DSL（LLM 和浏览器共享）
 *
 * 双向同步机制：
 *   - LLM 调用 saveDSL → 同时更新 design-canvas.json
 *   - 浏览器启动时 → 读取 design-canvas.json 覆盖本地状态
 *   - 人调整画布 → localStorage 暂存 + 可导出 design-canvas.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DesignDSL } from './dsl/types.js';

/**
 * design-canvas 包根：从模块自身位置（dist/src/storage.js 或 src/storage.ts）
 * 向上找最近的 package.json 且 name==="design-canvas" 的目录。
 *
 * 与 cwd 无关：MCP server / serve / daemon 可能由任意 cwd 拉起
 * （TRAE/Claude 等 client 常以工作区根为用户目录作为 stdio 子进程 cwd），
 * 若 dataHome 裸依赖 process.cwd()，会把 features 存档 + 活态 DSL 错位写到
 * 工作区根，甚至把其它项目的 go-* 文件并进本 feature 的边（"146 条 flows 污染"根因）。
 * 这里自省锚定，保证设计数据永远落在 design-canvas 自身安装根。
 */
export function getPackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (dir !== path.dirname(dir)) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const j = JSON.parse(fs.readFileSync(pkg, 'utf-8')) as { name?: string };
        if (j.name === 'design-canvas') return dir;
      } catch {
        /* 忽略损坏的 package.json */
      }
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

/**
 * 数据主目录：所有持久化路径的根
 *
 * 优先级：
 *   1. DESIGN_CANVAS_HOME（测试/显式覆盖用，最高优先）
 *   2. design-canvas 包根（getPackageRoot，从模块位置自省，cwd 无关，稳定）
 *   3. process.cwd()（自省失败的最末端兜底）
 *
 * 注意：必须在调用时读取 env（不能模块加载时缓存），保证 vitest setup 生效。
 */
export function getDataHome(): string {
  if (process.env.DESIGN_CANVAS_HOME) return process.env.DESIGN_CANVAS_HOME;
  return getPackageRoot();
}

/** 设计存储根目录：<dataHome>/.design-canvas */
export function getStorageRoot(): string {
  return path.join(getDataHome(), '.design-canvas');
}

/** feature 持久化目录：<cwd>/.design-canvas/features */
export function getFeaturesDir(): string {
  return path.join(getStorageRoot(), 'features');
}

/** 活态 DSL 文件：<dataHome>/design-canvas.json */
export function getLiveDslFile(): string {
  return path.join(getDataHome(), 'design-canvas.json');
}

/** 单个 feature 文件路径 */
export function getFeatureFile(feature: string): string {
  // 防止路径穿越：feature 名必须匹配 [a-zA-Z0-9_-]
  if (!/^[a-zA-Z0-9_-]+$/.test(feature)) {
    throw new Error(`非法 feature 名: "${feature}"，必须匹配 ^[a-zA-Z0-9_-]+$`);
  }
  return path.join(getFeaturesDir(), `${feature}.json`);
}

/** 实际 DSL 目录（动态快照）：<dataHome>/.design-canvas/live */
export function getLiveDir(baseDir?: string): string {
  return path.join(baseDir ?? getDataHome(), '.design-canvas', 'live');
}

/** 实际 DSL 文件路径：<dataHome>/.design-canvas/live/<feature>.dsl.json */
export function getLiveFeatureFile(feature: string, baseDir?: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(feature)) {
    throw new Error(`非法 feature 名: "${feature}"，必须匹配 ^[a-zA-Z0-9_-]+$`);
  }
  return path.join(getLiveDir(baseDir), `${feature}.dsl.json`);
}

/** 保存实际 DSL（动态快照，带 _sync 标记；不触发 dslChangeCallback，避免打扰设计视图刷新）
 *  baseDir 可选：指定写入的项目根（默认 dataHome）。watch_project 监听任意项目时传 project_dir，
 *  使实际 DSL 与该项目 cache.db 同目录归位。 */
export function saveLiveFeature(dsl: DesignDSL, baseDir?: string): string {
  const dir = getLiveDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = getLiveFeatureFile(dsl.feature, baseDir);
  const data = {
    ...dsl,
    _sync: { saved_at: new Date().toISOString(), source: 'live', feature: dsl.feature },
  };
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  return file;
}

/** 读取实际 DSL，不存在返回 null */
export function getLiveFeature(feature: string, baseDir?: string): DesignDSL | null {
  const file = getLiveFeatureFile(feature, baseDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as DesignDSL;
  } catch {
    return null;
  }
}

/** 确保 features 目录存在 */
function ensureFeaturesDir(): void {
  fs.mkdirSync(getFeaturesDir(), { recursive: true });
}

/** DSL 变更回调（serve.ts 注册后，saveDSL 会触发） */
type DslChangeCallback = (feature: string, source: string) => void;
let dslChangeCallback: DslChangeCallback | null = null;

/** 注册 DSL 变更回调（serve.ts 调用） */
export function onDslChange(cb: DslChangeCallback): void {
  dslChangeCallback = cb;
}

/** 保存 DSL（覆盖），同时同步到活态文件
 *  source: 'mcp'（LLM 工具调用）| 'browser'（浏览器端保存）
 *  传入 source 决定 SSE 广播的来源标记，浏览器据此跳过自身触发的刷新
 *  base_dsl_rev 可选乐观锁：非 undefined 时要求磁盘当前 rev === base_dsl_rev，
 *  否则视为并发冲突抛错（最后写者胜 → 拒绝，防多会话丢改动）。
 *  省略则不做校验（保留旧直写语义，兼容既有 30 处调用）。
 */
export function saveDSL(dsl: DesignDSL, source: string = 'mcp', base_dsl_rev?: number): string {
  ensureFeaturesDir();
  // 乐观锁：读当前 rev 对比 base
  if (base_dsl_rev !== undefined) {
    const cur = currentDslRev(dsl.feature);
    if (cur !== base_dsl_rev) {
      throw new Error(
        `DSL 冲突：feature "${dsl.feature}" 已被他人更新（当前 rev ${cur}，你的 base rev ${base_dsl_rev}）。` +
          `请重新 get_dsl 拉取最新，在最新基础上重做你的改动，勿直接覆盖。`,
      );
    }
  }
  // 自增 rev（权威写经此落盘）
  const nextRev = (base_dsl_rev ?? currentDslRev(dsl.feature)) + 1;
  dsl._dsl_rev = nextRev;
  const file = getFeatureFile(dsl.feature);
  fs.writeFileSync(file, JSON.stringify(dsl, null, 2), 'utf-8');

  // 同步到活态文件（带时间戳，方便 diff）
  const liveFile = getLiveDslFile();
  const liveData = {
    ...dsl,
    _sync: {
      saved_at: new Date().toISOString(),
      source: source,
      feature: dsl.feature,
    },
  };
  fs.writeFileSync(liveFile, JSON.stringify(liveData, null, 2), 'utf-8');

  // 触发 SSE 通知（用传入的 source，避免浏览器保存被误判为 mcp 触发 reload）
  if (dslChangeCallback) {
    try { dslChangeCallback(dsl.feature, source); } catch { /* ignore */ }
  }

  return file;
}

/** 当前磁盘 rev：优先活态文件，回退 feature 存档，缺失为 0 */
function currentDslRev(feature: string): number {
  return getDSL(feature)?._dsl_rev ?? 0;
}

/** 读取 DSL，不存在返回 null。优先读取活态文件 */
export function getDSL(feature: string): DesignDSL | null {
  // 优先读取活态文件（LLM 最新修改）
  const liveFile = getLiveDslFile();
  if (fs.existsSync(liveFile)) {
    try {
      const liveContent = fs.readFileSync(liveFile, 'utf-8');
      const liveData = JSON.parse(liveContent);
      if (liveData.feature === feature) {
        return liveData as DesignDSL;
      }
    } catch {
      // 活态文件损坏，回退到 feature 文件
    }
  }

  // 回退到 feature 存档文件
  const file = getFeatureFile(feature);
  if (!fs.existsSync(file)) return null;
  const content = fs.readFileSync(file, 'utf-8');
  return JSON.parse(content) as DesignDSL;
}

/** 视图层级：design=设计视图（活态文件+存档），live=实际视图（代码快照，只读） */
export type DSLView = 'design' | 'live';

/**
 * 按视图统一读取 DSL 入口（收敛 Step 2.5 视图分层护栏）
 * - design：走 getDSL（活态文件 + feature 存档），即现状默认路径
 * - live：走 getLiveFeature（实际代码快照，只读），用于对比"设计 vs 代码现状"
 */
export function getDSLByView(feature: string, view: DSLView = 'design'): DesignDSL | null {
  return view === 'live' ? getLiveFeature(feature) : getDSL(feature);
}

/** 列出所有已保存的 feature，按 feature 名升序 */
export function listFeatures(): DesignDSL[] {
  const dir = getFeaturesDir();
  if (!fs.existsSync(dir)) return [];
  // 排除 overlay 覆盖文件（<feature>.overlay.json 非完整 DSL，无 id/status，混入会被当成幽灵 feature）
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.overlay.json'));
  const dsls: DesignDSL[] = [];
  for (const f of files) {
    try {
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      dsls.push(JSON.parse(content) as DesignDSL);
    } catch {
      // 跳过无法解析的文件
    }
  }
  return dsls.sort((a, b) => a.feature.localeCompare(b.feature));
}

/** 删除 feature（用于测试清理） */
export function deleteDSL(feature: string): void {
  const file = getFeatureFile(feature);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

/**
 * 完整删除 feature（manage_feature action=delete 用）：
 * 1. 删 feature 存档文件
 * 2. 删该 feature 的实际代码快照（live/<f>.dsl.json）
 * 3. 若活态文件（design-canvas.json）当前对应此 feature，一并删除，避免残留陈旧活态视图
 */
export function deleteFeature(feature: string): void {
  const file = getFeatureFile(feature);
  if (fs.existsSync(file)) fs.unlinkSync(file);

  // 连带删除该 feature 的 overlay 覆盖文件，避免删除后残留陈旧 overlay
  const overlayFile = path.join(getFeaturesDir(), `${feature}.overlay.json`);
  if (fs.existsSync(overlayFile)) fs.unlinkSync(overlayFile);

  const liveFile = getLiveFeatureFile(feature);
  if (fs.existsSync(liveFile)) fs.unlinkSync(liveFile);

  const liveDsl = getLiveDslFile();
  if (fs.existsSync(liveDsl)) {
    try {
      const data = JSON.parse(fs.readFileSync(liveDsl, 'utf-8'));
      if (data.feature === feature) fs.unlinkSync(liveDsl);
    } catch {
      // 活态文件损坏则忽略，不阻塞删除主流程
    }
  }
}

/** 清空所有 feature（用于测试清理） */
export function clearAllFeatures(): void {
  const dir = getFeaturesDir();
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.json')) fs.unlinkSync(path.join(dir, f));
  }
}
