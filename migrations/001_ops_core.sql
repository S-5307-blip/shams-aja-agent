-- 001: الجداول الأساسية لوكيل عمليات المكتب.
-- كل جدول بيانات يحمل tenant_id لعزل المنشآت. لا يلمس جداول وكيل واتساب (messages, drafts, ...).

CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  timezone    TEXT NOT NULL DEFAULT 'Asia/Riyadh',
  settings    TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('owner','manager','staff','viewer','automation')),
  token_hash  TEXT NOT NULL UNIQUE,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);

CREATE TABLE IF NOT EXISTS clients (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  kind              TEXT NOT NULL CHECK (kind IN ('individual','business')),
  name              TEXT NOT NULL,
  phone             TEXT,
  email             TEXT,
  id_last4          TEXT,              -- آخر ٤ أرقام من الهوية/الإقامة فقط (تقليل البيانات)
  cr_number         TEXT,              -- رقم السجل التجاري للمنشآت
  preferred_channel TEXT NOT NULL DEFAULT 'whatsapp',
  language          TEXT NOT NULL DEFAULT 'ar',
  opt_out_reminders INTEGER NOT NULL DEFAULT 0,
  notes             TEXT,
  external_ref      TEXT,              -- معرّف العميل في النظام المصدر (مثل زد) عند الربط
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clients_tenant ON clients(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_clients_phone ON clients(tenant_id, phone) WHERE phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS documents (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  client_id       TEXT NOT NULL REFERENCES clients(id),
  doc_type        TEXT NOT NULL,       -- مفتاح من knowledge/document-types.json
  label           TEXT,                -- وصف حر مثل «إقامة العامل أحمد»
  holder_name     TEXT,                -- صاحب المستند إن كان غير العميل (عامل لدى منشأة)
  number_last4    TEXT,
  expiry_date     TEXT,                -- ميلادي YYYY-MM-DD (المصدر الوحيد للحساب)
  expiry_original TEXT,                -- التاريخ كما أُدخل (قد يكون هجرياً)
  expiry_calendar TEXT NOT NULL DEFAULT 'gregorian' CHECK (expiry_calendar IN ('gregorian','hijri')),
  status          TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','expiring','expired','renewal_in_progress','archived')),
  data_source     TEXT NOT NULL DEFAULT 'manual', -- مصدر التاريخ: manual | absher | muqeem | qiwa | client
  verified_at     TEXT,                -- آخر تحقق من التاريخ من مصدره
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_tenant_expiry ON documents(tenant_id, expiry_date);
CREATE INDEX IF NOT EXISTS idx_documents_client ON documents(client_id);

CREATE TABLE IF NOT EXISTS transactions (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  client_id      TEXT NOT NULL REFERENCES clients(id),
  service_id     TEXT,                 -- معرّف الخدمة من قاعدة المعرفة
  title          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'new',
  assigned_to    TEXT,
  due_date       TEXT,
  received_docs  TEXT NOT NULL DEFAULT '[]', -- JSON: المتطلبات المستلمة (نصوص مطابقة لمتطلبات الخدمة)
  office_fee     REAL,                 -- أتعاب المكتب (تُعتمد يدوياً)
  gov_fees       REAL,                 -- الرسوم الحكومية (منفصلة)
  external_ref   TEXT,                 -- رقم الطلب في النظام المصدر (مثل زد)
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transactions_tenant_status ON transactions(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_transactions_client ON transactions(client_id);

CREATE TABLE IF NOT EXISTS transaction_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id      TEXT NOT NULL,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  kind           TEXT NOT NULL,        -- status_change | note | outcome | document_received
  from_status    TEXT,
  to_status      TEXT,
  note           TEXT,
  actor          TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_events ON transaction_events(tenant_id, transaction_id);

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  client_id      TEXT,
  transaction_id TEXT,
  document_id    TEXT,
  title          TEXT NOT NULL,
  details        TEXT,
  due_date       TEXT,
  priority       TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  assignee_role  TEXT,
  source         TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','agent','automation')),
  dedupe_key     TEXT,
  created_by     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_dedupe ON tasks(tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_tenant_status ON tasks(tenant_id, status);

CREATE TABLE IF NOT EXISTS actions (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  tool            TEXT NOT NULL,
  input           TEXT NOT NULL,       -- JSON
  summary         TEXT,                -- وصف مفهوم للمعتمِد
  status          TEXT NOT NULL CHECK (status IN ('proposed','pending_approval','executing','succeeded','failed','rejected')),
  requested_by    TEXT,
  decided_by      TEXT,
  result          TEXT,                -- JSON
  error           TEXT,
  idempotency_key TEXT,
  run_id          TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_actions_idem ON actions(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_actions_tenant_status ON actions(tenant_id, status);

CREATE TABLE IF NOT EXISTS reminders (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  client_id           TEXT NOT NULL,
  document_id         TEXT,
  transaction_id      TEXT,
  kind                TEXT NOT NULL CHECK (kind IN ('renewal','missing_documents','followup')),
  channel             TEXT NOT NULL,
  template            TEXT,
  template_params     TEXT,            -- JSON
  message             TEXT NOT NULL,
  scheduled_for       TEXT NOT NULL,   -- YYYY-MM-DD
  status              TEXT NOT NULL CHECK (status IN ('pending_approval','sending','sent','queued_manual','failed','cancelled','skipped')),
  dedupe_key          TEXT,
  action_id           TEXT,
  provider_message_id TEXT,
  error               TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reminders_dedupe ON reminders(tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reminders_tenant_status ON reminders(tenant_id, status);

CREATE TABLE IF NOT EXISTS agent_runs (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  request_id  TEXT,                    -- مفتاح منع التكرار من الواجهة
  request     TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  response    TEXT,                    -- JSON
  error       TEXT,
  model       TEXT,
  usage       TEXT,
  created_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_runs_request ON agent_runs(tenant_id, request_id) WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT,
  user_id    TEXT,
  run_id     TEXT,
  event      TEXT NOT NULL,
  tool       TEXT,
  detail     TEXT,                     -- JSON بعد إخفاء البيانات الحساسة
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_log(tenant_id, id);
