// موفّر Claude عبر @anthropic-ai/sdk.
import Anthropic from '@anthropic-ai/sdk';
import { OpsError } from '../util.js';

export function createAnthropicProvider(cfg, { fetch } = {}) {
  // المفتاح من ANTHROPIC_API_KEY في البيئة فقط. fetch قابل للحقن في الاختبارات.
  const client = new Anthropic({ timeout: cfg.timeoutMs, maxRetries: cfg.maxRetries, ...(fetch ? { fetch } : {}) });

  return {
    name: 'anthropic',
    model: cfg.model,
    async chat({ system, messages, tools }) {
      const params = {
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        // التعليمات ثابتة لكل الطلبات → قابلة للتخزين المؤقت (prompt caching)
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools,
        tool_choice: { type: 'auto' },
        messages,
        output_config: { effort: cfg.effort },
      };
      try {
        const res = cfg.refusalFallback === 'default'
          // عند رفض النموذج لأسباب السلامة يعيد الخادم الطلب على نموذج احتياطي تلقائياً
          ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
          : await client.messages.create(params);
        return { content: res.content, stop_reason: res.stop_reason, stop_details: res.stop_details ?? null, usage: res.usage, model: res.model };
      } catch (e) {
        throw mapError(e);
      }
    },
  };
}

function mapError(e) {
  if (e instanceof Anthropic.AuthenticationError) return new OpsError('llm_auth', 'مفتاح Claude API غير صالح أو غير مضبوط (ANTHROPIC_API_KEY).', { retryable: false });
  if (e instanceof Anthropic.PermissionDeniedError) return new OpsError('llm_auth', 'لا يملك المفتاح صلاحية استخدام هذا النموذج.', { retryable: false });
  if (e instanceof Anthropic.NotFoundError) return new OpsError('llm_config', 'النموذج المحدد في LLM_MODEL غير موجود.', { retryable: false });
  if (e instanceof Anthropic.BadRequestError) return new OpsError('llm_bad_request', `طلب غير مقبول لدى النموذج: ${e.message}`, { retryable: false });
  if (e instanceof Anthropic.RateLimitError) return new OpsError('llm_rate_limited', 'تجاوز حد الطلبات لدى مزود النموذج؛ حاول بعد قليل.', { retryable: true });
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new OpsError('llm_timeout', 'انتهت مهلة الاتصال بالنموذج.', { retryable: true });
  if (e instanceof Anthropic.APIConnectionError) return new OpsError('llm_unavailable', 'تعذر الاتصال بمزود النموذج.', { retryable: true });
  if (e instanceof Anthropic.APIError) return new OpsError('llm_unavailable', `خطأ من مزود النموذج (${e.status}).`, { retryable: (e.status ?? 500) >= 500 });
  return e;
}
