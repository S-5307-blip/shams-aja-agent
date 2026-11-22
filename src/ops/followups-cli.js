// تشغيل المتابعة الآلية لكل المنشآت (لـ cron أو n8n عبر سطر الأوامر). npm run ops:followups
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createStore } from './store.js';
import { loadKnowledge } from './kb/index.js';
import { createChannels } from './channels/index.js';
import { createOps } from './tools/index.js';
import { runFollowups } from './followups.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const store = createStore(db);
const kb = loadKnowledge();
const ops = createOps({ store, kb, config, channels: createChannels(config) });

for (const { id } of db.prepare('SELECT id FROM tenants').all()) {
  const summary = await runFollowups({ store, kb, ops, config, tenantId: id });
  console.log(JSON.stringify(summary));
}
db.close();
