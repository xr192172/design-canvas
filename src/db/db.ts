/**
 * cache.db 打开与初始化
 *
 * 选型：node:sqlite（Node 22 内置 DatabaseSync）
 *   - 零新增依赖：design-canvas 作为 npm 分发的 MCP server，
 *     不引入 better-sqlite3 这类原生编译模块（Windows 用户无构建工具即安装失败）
 *   - 实测（scripts 探针，2026-07-29）：SQLite 3.50.2，FTS5 + trigram + 触发器 + WAL 全可用
 *   - 代价：启动时 stderr 有一条 ExperimentalWarning（不影响 stdio JSON-RPC，可接受）
 *
 * 存储位置：<dataHome>/.design-canvas/cache.db（.design-canvas/ 已在 .gitignore）
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { getStorageRoot } from '../storage.js';
import { SCHEMA_SQL } from './schema.js';

// node:sqlite 用 createRequire 运行时加载而非静态 import：
// vitest 1.x 自带的 Vite 5 内建模块清单不认识 node:sqlite（Node 22.5 才加入），
// 静态 import 会被它剥掉 node: 前缀当文件路径解析而报错；
// createRequire 绕过静态分析，tsc 构建产物与运行时行为完全一致。
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (dbFile: string) => DatabaseSyncType;
};

/** 统一 re-export，调用方从本模块取类型，绕不开 Vite 的静态 import 问题 */
export type Database = DatabaseSyncType;

export const SCHEMA_VERSION = 2;

/** 默认 db 文件路径：<dataHome>/.design-canvas/cache.db */
export function getDbFile(): string {
  return path.join(getStorageRoot(), 'cache.db');
}

/**
 * 打开（必要时创建）cache.db 并应用 schema。
 * schema 全部 IF NOT EXISTS，重复打开幂等。
 *
 * 迁移策略：缓存是派生物，不做保留式迁移——版本落后即清空业务表，
 * 下次 sync 全量重建。（v1→v2 新增 imports 表：旧 files 行没有原始
 * import 数据，留着会让 import_project 缓存路径静默丢包导入依赖边，
 * 必须失效重建。）
 */
export function openDb(dbFile: string = getDbFile()): Database {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  const v = db.prepare('SELECT MAX(version) v FROM schema_versions').get() as { v: number | null };
  if (v.v !== null && v.v < SCHEMA_VERSION) {
    db.exec('DELETE FROM files; DELETE FROM nodes; DELETE FROM edges; DELETE FROM unresolved_refs;');
  }
  db.prepare(
    'INSERT OR IGNORE INTO schema_versions(version, applied_at, description) VALUES (?, ?, ?)',
  ).run(SCHEMA_VERSION, Date.now(), 'v2: +imports 表（原始 import 记录，import_project 缓存读取源）');
  return db;
}
