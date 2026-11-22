// تجميع المكونات من الإعدادات (يُستخدم في الخادم والاختبارات والسكربتات).
import { openDb } from './db.js';
import { createStore } from './store.js';
import { loadKnowledge } from './kb/index.js';
import { createChannels } from './channels/index.js';
import { createOps } from './tools/index.js';
import { createLlm } from './llm/index.js';
import { createAgent } from './agent.js';

export function buildRuntime(config, { db, llm, channelOverrides, extraTools, now } = {}) {
  const database = db || openDb(config.dbPath);
  const store = createStore(database);
  const kb = loadKnowledge();
  const channels = createChannels(config, channelOverrides);
  const ops = createOps({ store, kb, config, channels, extraTools, now });
  const model = llm || createLlm(config.llm);
  const agent = createAgent({ store, kb, ops, llm: model, config });
  return { db: database, store, kb, channels, ops, llm: model, agent };
}
