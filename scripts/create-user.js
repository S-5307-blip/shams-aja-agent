// إنشاء منشأة و/أو مستخدم في بيئة الإنتاج. يطبع الرمز مرة واحدة فقط (يُخزَّن مُجزّأً).
// منشأة جديدة مع مالك:   node scripts/create-user.js --tenant-name "شمس أجا" --name "اسم المالك" --role owner
// مستخدم لمنشأة قائمة:   node scripts/create-user.js --tenant ten_xxx --name "موظف" --role staff
// رمز n8n:               node scripts/create-user.js --tenant ten_xxx --name "n8n" --role automation
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/ops/config.js';
import { openDb } from '../src/ops/db.js';
import { createStore } from '../src/ops/store.js';
import { ROLES } from '../src/ops/permissions.js';

const { values } = parseArgs({ options: { tenant: { type: 'string' }, 'tenant-name': { type: 'string' }, name: { type: 'string' }, role: { type: 'string' } } });
if (!values.name || !ROLES.includes(values.role) || (!values.tenant && !values['tenant-name'])) {
  console.error(`الاستخدام: --name <الاسم> --role <${ROLES.join('|')}> (--tenant <id> | --tenant-name <اسم منشأة جديدة>)`);
  process.exit(1);
}
const config = loadConfig();
const store = createStore(openDb(config.dbPath));
const tenant = values.tenant ? store.getTenant(values.tenant) : store.createTenant({ name: values['tenant-name'], timezone: config.timezone });
if (!tenant) { console.error('المنشأة غير موجودة.'); process.exit(1); }
const { user, token } = store.createUser({ tenantId: tenant.id, name: values.name, role: values.role });
console.log(JSON.stringify({ tenant_id: tenant.id, tenant: tenant.name, user_id: user.id, role: user.role, token }, null, 2));
console.log('احفظ الرمز الآن؛ لا يمكن استرجاعه لاحقاً.');
