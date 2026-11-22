-- 002: ذاكرة المحادثة. إضافات فقط؛ لا تعديل على بيانات قائمة.
-- المحادثة تخص مستخدماً واحداً داخل منشأته. كل دور يحفظ نص الطلب والإجابة والكيانات المذكورة
-- (عملاء، معاملات، مستندات) حتى يفهم الوكيل الإحالات مثل «هو» و«المعاملة الثانية».

CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  user_id     TEXT NOT NULL,
  title       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(tenant_id, user_id, updated_at);

CREATE TABLE IF NOT EXISTS conversation_turns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  run_id          TEXT,
  user_text       TEXT NOT NULL,
  assistant_text  TEXT NOT NULL,
  entities        TEXT NOT NULL DEFAULT '[]', -- JSON: [{type, id, name}]
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_conversation ON conversation_turns(tenant_id, conversation_id, id);

ALTER TABLE agent_runs ADD COLUMN conversation_id TEXT;
