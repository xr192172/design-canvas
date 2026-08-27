'use strict';
const assert = require('node:assert');
const { findUser } = require('./src/service');

// 场景：查询结果为空 → findUser 应安全返回 null（而非抛 TypeError）
const db = { query: () => undefined };
assert.strictEqual(findUser(db, 1), null);
console.log('PASS: findUser 对空结果安全返回 null');
