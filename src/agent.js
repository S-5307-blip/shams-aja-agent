import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { buildSystemPrompt } from './prompt.js';
import { history } from './db.js';

const client = new Anthropic({ apiKey: config.anthropicKey });

const proposeTool = {
  name: 'propose_reply',
  description: 'يسلّم الرد المقترح للعميل مع تحليل الرسالة لمراجعة المالك.',
  input_schema: {
    type: 'object',
    properties: {
      reply: { type: 'string', description: 'نص الرد المقترح للعميل، بلغة العميل' },
      language: { type: 'string', description: 'لغة العميل، مثل ar أو en أو ur' },
      customer_type: { type: 'string', enum: ['individual', 'business', 'unknown'] },
      intent: { type: 'string', description: 'مثل: استفسار سعر، طلب خدمة، متابعة طلب، شكوى، أخرى' },
      service_id: { type: 'string', description: 'معرّف الخدمة من قاعدة المعرفة، أو نص فارغ' },
      urgency: { type: 'string', enum: ['low', 'normal', 'high'] },
      missing_info: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'number', description: 'من 0 إلى 1' },
      handoff: { type: 'boolean', description: 'هل تجب إحالة المحادثة للمالك فوراً' },
      handoff_reason: { type: 'string' },
      summary: { type: 'string', description: 'ملخص قصير بالعربية للمالك' },
      next_action: { type: 'string' },
    },
    required: ['reply', 'language', 'customer_type', 'intent', 'confidence', 'handoff', 'summary'],
  },
};

// يدمج الرسائل المتتالية من نفس الطرف ويضمن أن تبدأ المحادثة برسالة من العميل
function toMessages(rows) {
  const out = [];
  for (const row of rows) {
    const role = row.role === 'customer' ? 'user' : 'assistant';
    if (out.length === 0 && role === 'assistant') continue;
    if (out.at(-1)?.role === role) out.at(-1).content += `\n${row.text}`;
    else out.push({ role, content: row.text });
  }
  return out;
}

export async function proposeReply(phone) {
  const messages = toMessages(history(phone, 12));
  if (messages.at(-1)?.role !== 'user') throw new Error('آخر رسالة ليست من العميل');

  const res = await client.messages.create({
    model: config.model,
    max_tokens: 1000,
    system: [{ type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } }],
    tools: [proposeTool],
    tool_choice: { type: 'tool', name: 'propose_reply' },
    messages,
  });

  const block = res.content.find((b) => b.type === 'tool_use');
  if (!block) throw new Error('لم يُرجع النموذج رداً منظماً');
  return block.input;
}
