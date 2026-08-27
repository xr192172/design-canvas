import { DatabaseSync } from 'node:sqlite';
const dbFile = 'C:/Users/Admin/Downloads/Browsers/Microsoft Edge/design-canvas-main/design-canvas/.design-canvas/cache.db';
const db = new DatabaseSync(dbFile, { readOnly: true });
console.log('edges by kind:', db.prepare('SELECT kind, COUNT(*) c FROM edges GROUP BY kind').all());
console.log('sample call edges:', db.prepare("SELECT source, target, kind FROM edges WHERE kind='call' LIMIT 5").all());
console.log('nodes for url:', db.prepare("SELECT id, kind, name, qualified_name, file_path FROM nodes WHERE file_path='tests/tools/harvest_from_url.test.ts' LIMIT 30").all());
db.close();
