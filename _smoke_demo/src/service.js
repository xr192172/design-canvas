'use strict';

/** 从数据库按 id 查用户并返回名字。row 可能为空。 */
function findUser(db, id) {
  const row = db.query('SELECT * FROM users WHERE id = ' + id);
  return row ? row.name : null;
}

module.exports = { findUser };
