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

export const SCHEMA_VERSION = 7;

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
  // v3 增列：旧库的 nodes 表已存在，CREATE TABLE IF NOT EXISTS 不会补 sym_hash 列，
  // 显式 ALTER（新库建表已含该列，重复加列报错吞掉）
  try {
    db.exec('ALTER TABLE nodes ADD COLUMN sym_hash TEXT');
  } catch {
    /* 列已存在 */
  }
  // v4 增列：files.norm_hash + symbol_diffs.norm_from/norm_to（文件级归一化全文 hash，
  // 捕捉符号提取覆盖不到的变更——常量值/字符串/顶层表达式）
  // v5 增列：imports.type_only（TS `import type` 运行时擦除——依赖图/闭包不算边）
  for (const ddl of [
    'ALTER TABLE files ADD COLUMN norm_hash TEXT',
    "ALTER TABLE symbol_diffs ADD COLUMN norm_from TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE symbol_diffs ADD COLUMN norm_to TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE imports ADD COLUMN type_only INTEGER NOT NULL DEFAULT 0',
  ]) {
    try {
      db.exec(ddl);
    } catch {
      /* 列已存在 */
    }
  }
  const v = db.prepare('SELECT MAX(version) v FROM schema_versions').get() as { v: number | null };
  if (v.v !== null && v.v < SCHEMA_VERSION) {
    // imports 一并清（v5 前的旧行没有 type_only 语义，且此前清库遗漏 imports 表——
    // 删除的文件会在 imports 留残行；缓存是派生物，全清重建）
    db.exec('DELETE FROM files; DELETE FROM nodes; DELETE FROM edges; DELETE FROM unresolved_refs; DELETE FROM symbol_diffs; DELETE FROM imports;');
  }
  db.prepare(
    'INSERT OR IGNORE INTO schema_versions(version, applied_at, description) VALUES (?, ?, ?)',
  ).run(SCHEMA_VERSION, Date.now(), 'v7: 嵌套符号 qualified_name 全链化（类方法体内嵌套符号 prepare.run → NodeSqliteAdapter.prepare.run，与 calls/type_refs 提取器对齐——qn 漂移曾致 FK 炸库整文件丢符号；清库重解析）');
  return db;
}

// ─────────────────────────────────────────────────────────────
// 项目级缓存连接池（MCP 长进程内跨工具调用复用）
// ─────────────────────────────────────────────────────────────

const projectCachePool = new Map<string, Database>();

/**
 * 打开（并复用）目标项目的符号缓存：<projectRoot>/.design-canvas/cache.db
 * 缓存跟着被分析的项目走（内容是该项目源文件的派生物，相对路径键才不撞车），
 * 与 getDbFile() 的数据主目录缓存是两个独立用途。
 * 失败（只读目录 / 无写权限）会抛错——调用方应 catch 后按无缓存退化。
 * 进程退出无需显式 close：WAL 模式崩溃安全。
 */
export function getProjectCacheDb(projectRoot: string): Database {
  const key = path.resolve(projectRoot);
  let db = projectCachePool.get(key);
  if (!db) {
    db = openDb(path.join(key, '.design-canvas', 'cache.db'));
    projectCachePool.set(key, db);
  }
  return db;
}

/** 关闭全部项目缓存连接（测试隔离用；生产进程退出时 OS 回收即可） */
export function closeAllProjectCacheDbs(): void {
  for (const db of projectCachePool.values()) {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
  }
  projectCachePool.clear();
}

/** 关闭单个项目的池化缓存连接（harvest_from_url 收尾删临时目录前释放文件句柄，Windows EBUSY） */
export function closeProjectCacheDb(projectRoot: string): void {
  const key = path.resolve(projectRoot);
  const db = projectCachePool.get(key);
  if (db) {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
    projectCachePool.delete(key);
  }
}
