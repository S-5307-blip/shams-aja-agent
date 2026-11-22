// موفّر محاكاة للاختبارات والتطوير دون مفتاح. script: دالة تستقبل { messages, tools, step }
// وترجع كتل المحتوى (أو ترمي خطأ لمحاكاة فشل النموذج).
export function createMockProvider(script) {
  let step = 0;
  return {
    name: 'mock',
    model: 'mock',
    calls: [],
    async chat({ system, messages, tools }) {
      this.calls.push({ messages: structuredClone(messages), tools: tools.map((t) => t.name) });
      const out = await (script || defaultScript)({ system, messages, tools, step: step++ });
      const content = Array.isArray(out) ? out : out.content;
      return {
        content,
        stop_reason: out.stop_reason || (content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'),
        usage: { input_tokens: 0, output_tokens: 0 },
        model: 'mock',
      };
    },
  };
}

let n = 0;
export const toolUse = (name, input) => ({ type: 'tool_use', id: `toolu_mock_${++n}`, name, input });
export const text = (t) => ({ type: 'text', text: t });

// سيناريو افتراضي للتشغيل التجريبي دون مفتاح: يبحث في المعرفة ثم يسلّم إجابة توضّح أنه وضع محاكاة
async function defaultScript({ messages }) {
  const last = messages.at(-1);
  const isToolResult = Array.isArray(last.content) && last.content[0]?.type === 'tool_result';
  const current = messages.findLast((m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'text');
  const request = current?.content[0].text || '';
  const query = (request.split('طلب الموظف:')[1] || request).trim().slice(0, 150) || 'خدمات';
  if (!isToolResult) return [toolUse('search_knowledge', { query })];
  const results = JSON.parse(last.content[0].content).data?.results || [];
  return [toolUse('submit_answer', {
    understood_request: query,
    answer: `[وضع المحاكاة — لا يوجد اتصال بنموذج حقيقي] أقرب نتائج قاعدة المعرفة: ${results.map((r) => r.title).join('، ') || 'لا نتائج'}.`,
    sources: results.slice(0, 3).map((r) => r.id),
    missing_info: [],
    needs_staff: results.length === 0,
    staff_reason: results.length ? '' : 'لا توجد معلومة في قاعدة المعرفة',
  })];
}
