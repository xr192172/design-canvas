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
import type { DesignDSL } from './dsl/types.js';

/**
 * 数据主目录：所有持久化路径的根
 *
 * 默认 = process.cwd()。测试通过 DESIGN_CANVAS_HOME 指向临时目录，
 * 避免 saveDSL / renderDsl 覆盖项目根目录的活态 design-canvas.json。
 * 注意：必须在调用时读取 env（不能模块加载时缓存），保证 vitest setup 生效。
 */
export function getDataHome(): string {
  return process.env.DESIGN_CANVAS_HOME || process.cwd();
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
 */
export function saveDSL(dsl: DesignDSL, source: string = 'mcp'): string {
  ensureFeaturesDir();
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

/** 列出所有已保存的 feature，按 feature 名升序 */
export function listFeatures(): DesignDSL[] {
  const dir = getFeaturesDir();
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
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

/** 清空所有 feature（用于测试清理） */
export function clearAllFeatures(): void {
  const dir = getFeaturesDir();
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.json')) fs.unlinkSync(path.join(dir, f));
  }
}
