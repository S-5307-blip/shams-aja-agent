import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS seen (wa_id TEXT PRIMARY KEY, ts INTEGER);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, role TEXT, text TEXT, ts INTEGER
);
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, customer_text TEXT,
  reply TEXT, analysis TEXT, status TEXT DEFAULT 'pending', ts INTEGER
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS optout (phone TEXT PRIMARY KEY, ts INTEGER);
`);

// true إذا كانت الرسالة جديدة (لمنع معالجة نفس الرسالة مرتين)
export const markSeen = (id) =>
  db.prepare('INSERT OR IGNORE INTO seen (wa_id, ts) VALUES (?, ?)').run(id, Date.now()).changes === 1;

export const addMessage = (phone, role, text) =>
  db.prepare('INSERT INTO messages (phone, role, text, ts) VALUES (?, ?, ?, ?)').run(phone, role, text, Date.now());

export const history = (phone, limit = 12) =>
  db.prepare('SELECT role, text FROM messages WHERE phone = ? ORDER BY id DESC LIMIT ?')
    .all(phone, limit)
    .reverse();

export const createDraft = (phone, customerText, reply, analysis) =>
  Number(
    db.prepare('INSERT INTO drafts (phone, customer_text, reply, analysis, ts) VALUES (?, ?, ?, ?, ?)')
      .run(phone, customerText, reply, JSON.stringify(analysis), Date.now()).lastInsertRowid
  );

export const getDraft = (id) => db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
export const setDraftStatus = (id, status) => db.prepare('UPDATE drafts SET status = ? WHERE id = ?').run(status, id);

export const kvGet = (k) => db.prepare('SELECT v FROM kv WHERE k = ?').get(k)?.v ?? null;
export const kvSet = (k, v) => db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
export const kvDel = (k) => db.prepare('DELETE FROM kv WHERE k = ?').run(k);

export const optOut = (phone) => db.prepare('INSERT OR REPLACE INTO optout (phone, ts) VALUES (?, ?)').run(phone, Date.now());
export const isOptedOut = (phone) => !!db.prepare('SELECT 1 FROM optout WHERE phone = ?').get(phone);
