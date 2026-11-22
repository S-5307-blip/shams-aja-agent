import { loadConfig } from './config.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { migrate } from './db.js';

const { dbPath } = loadConfig();
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
if (fs.existsSync(dbPath)) {
  const backup = `${dbPath}.bak-${Date.now()}`;
  fs.copyFileSync(dbPath, backup);
  console.log(`نسخة احتياطية قبل الترحيل: ${backup}`);
}
const db = new Database(dbPath);
const done = migrate(db);
console.log(done.length ? `طُبّقت الترحيلات: ${done.join(', ')}` : 'لا توجد ترحيلات جديدة.');
db.close();
