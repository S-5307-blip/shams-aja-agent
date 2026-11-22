// واجهة موحدة للنموذج: chat({ system, messages, tools }) → { content, stop_reason, usage, model }
// الصيغة الداخلية للرسائل والكتل هي صيغة Messages API (text / tool_use / tool_result).
// لإضافة موفّر آخر: أنشئ ملفاً يحوّل من/إلى هذه الصيغة ويصدّر createXProvider(config)، ثم سجّله هنا.
import { createAnthropicProvider } from './anthropic.js';
import { createMockProvider } from './mock.js';
import { OpsError } from '../util.js';

export function createLlm(llmConfig, { script } = {}) {
  switch (llmConfig.provider) {
    case 'anthropic':
      return createAnthropicProvider(llmConfig);
    case 'mock':
      return createMockProvider(script);
    default:
      throw new OpsError('not_configured', `موفّر نموذج غير معروف: ${llmConfig.provider}`);
  }
}

// بعد تحويل الطلب لنموذج احتياطي في منتصف الرد: تُحذف كتل التفكير واستدعاءات الأدوات التي تسبق
// آخر كتلة fallback عند إعادتها في المحادثة، وتبقى كتلة fallback في مكانها.
export function echoableContent(content) {
  const last = content.map((b) => b.type).lastIndexOf('fallback');
  if (last <= 0) return content;
  const DROP = new Set(['thinking', 'redacted_thinking', 'tool_use']);
  return content.filter((b, i) => i >= last || !DROP.has(b.type));
}
