// إعدادات وكيل العمليات. مستقلة عن src/config.js (وكيل واتساب) حتى لا تتطلب مفاتيح Meta.
const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const num = (k, d) => Number(env(k, d));

export function loadConfig(overrides = {}) {
  return {
    port: Number(env('OPS_PORT', env('PORT', 3100))),
    dbPath: env('OPS_DB_PATH', './data/ops.db'),
    timezone: env('OPS_TIMEZONE', 'Asia/Riyadh'),
    // ===== النموذج =====
    llm: {
      provider: env('LLM_PROVIDER', 'anthropic'), // anthropic | mock
      model: env('LLM_MODEL', 'claude-opus-5-5'),
      effort: env('LLM_EFFORT', 'medium'), // low | medium | high | xhigh | max
      timeoutMs: num('LLM_TIMEOUT_MS', 90_000),
      maxRetries: num('LLM_MAX_RETRIES', 2),
      maxTokens: num('LLM_MAX_TOKENS', 16_000),
      refusalFallback: env('LLM_REFUSAL_FALLBACK', 'default'), // default | off
    },
    agent: {
      maxSteps: num('AGENT_MAX_STEPS', 8),
      toolTimeoutMs: num('TOOL_TIMEOUT_MS', 15_000),
      historyTurns: num('AGENT_HISTORY_TURNS', 8),
    },
    // ===== القنوات =====
    channels: {
      default: env('REMINDER_CHANNEL', 'manual'), // manual | whatsapp
      whatsapp: {
        accessToken: env('WA_ACCESS_TOKEN', ''),
        phoneNumberId: env('WA_PHONE_NUMBER_ID', ''),
        graphVersion: env('GRAPH_API_VERSION', 'v24.0'),
        templateLanguage: env('WA_TEMPLATE_LANG', 'ar'),
      },
    },
    // أسماء قوالب واتساب المعتمدة في Meta لكل نوع تذكير (فارغ = لا يوجد قالب، يُرسل يدوياً)
    channelTemplates: {
      renewal: env('WA_RENEWAL_TEMPLATE', 'renewal_reminder'),
      missingDocs: env('WA_MISSING_DOCS_TEMPLATE', null),
      followup: env('WA_FOLLOWUP_TEMPLATE', null),
    },
    automation: {
      staleTransactionDays: num('STALE_TRANSACTION_DAYS', 5),
    },
    ...overrides,
  };
}
