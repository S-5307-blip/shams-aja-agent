// حلقة الوكيل: استرجاع المعرفة ← نموذج ← أدوات ← إجابة منظمة.
// الإجراءات المعروضة للمستخدم تؤخذ من سجل المنفّذ (ledger)، لا من نص النموذج.
import { SYSTEM_PROMPT, SUBMIT_TOOL } from './prompt.js';
import { echoableContent } from './llm/index.js';
import { validate } from './validate.js';
import { can } from './permissions.js';
import { audit } from './audit.js';
import { OpsError } from './util.js';
import { formatHijri } from './dates.js';

const WRITE_MODES = new Set(['write', 'approval']);
const CLAIM_SENT = /(تم|تمّ)\s+(إرسال|ارسال|تغيير|تحديث|اعتماد)|أُرسل(ت)?\s/;

export function createAgent({ store, kb, ops, llm, config }) {
  async function ask(user, { request, requestId, conversationId } = {}) {
    if (!can(user.role, 'agent.ask')) throw new OpsError('forbidden', 'ليست لديك صلاحية استخدام الوكيل.');
    if (typeof request !== 'string' || request.trim().length < 2 || request.length > 4000) {
      throw new OpsError('invalid_input', 'نص الطلب مطلوب (حتى ٤٠٠٠ حرف).');
    }
    // منع التكرار: نفس request_id يعيد نفس النتيجة دون تنفيذ جديد
    if (requestId) {
      const prev = store.getRunByRequestId(user.tenant_id, requestId);
      if (prev) return replay(prev);
    }
    // المحادثة تخص المستخدم نفسه داخل منشأته؛ محادثة غيره = غير موجودة
    let conversation;
    if (conversationId) {
      conversation = store.getConversation(user.tenant_id, user.id, conversationId);
      if (!conversation) throw new OpsError('not_found', 'المحادثة غير موجودة.');
    } else {
      conversation = store.createConversation(user.tenant_id, user.id, request);
    }
    let runId;
    try {
      runId = store.createRun(user.tenant_id, { userId: user.id, requestId, request, model: llm.model, conversationId: conversation.id });
    } catch (e) {
      if (requestId && String(e.message).includes('UNIQUE')) return replay(store.getRunByRequestId(user.tenant_id, requestId));
      throw e;
    }
    const ctx = ops.ctxFor(user, { runId });
    ctx.conversationId = conversation.id;
    ctx.request = request;
    audit(store.db, { tenantId: user.tenant_id, userId: user.id, runId, event: 'agent.request', detail: { request } });

    const snippets = kb.search(request, { limit: 5 });
    snippets.forEach((s) => ctx.citable.add(s.id));
    // سياق المحادثة: الأدوار السابقة نصاً (طلب الموظف + إجابة الوكيل + الكيانات المذكورة)
    const history = store.recentTurns(user.tenant_id, conversation.id, config.agent.historyTurns ?? 8);
    const messages = [];
    for (const t of history) {
      messages.push({ role: 'user', content: t.user_text });
      messages.push({ role: 'assistant', content: t.assistant_text + entitiesNote(t.entities) });
    }
    messages.push({ role: 'user', content: [{ type: 'text', text: userMessage(ctx, request, snippets, history.length) }] });
    const tools = [...ops.toolSchemasFor(user.role), SUBMIT_TOOL];
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    let final = null;
    let lastText = '';
    let steps = 0;
    const warnings = [];

    try {
      while (steps < config.agent.maxSteps && !final) {
        steps++;
        const res = await llm.chat({ system: SYSTEM_PROMPT, messages, tools });
        for (const k of Object.keys(usage)) usage[k] += res.usage?.[k] || 0;
        if (res.stop_reason === 'refusal') {
          throw new OpsError('llm_refusal', 'امتنع النموذج عن معالجة هذا الطلب. أعد صياغته أو عالجه يدوياً.');
        }
        const content = echoableContent(res.content);
        messages.push({ role: 'assistant', content });
        const texts = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (texts) lastText = texts;
        const uses = content.filter((b) => b.type === 'tool_use');
        if (!uses.length) {
          if (res.stop_reason === 'max_tokens') warnings.push('انقطع رد النموذج لبلوغ الحد الأقصى للطول.');
          break;
        }
        const results = [];
        for (const u of uses) {
          if (u.name === SUBMIT_TOOL.name) {
            const errs = validate(SUBMIT_TOOL.input_schema, u.input || {});
            if (errs.length) {
              results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: `صيغة غير صالحة: ${errs.join('؛ ')}` });
            } else {
              final = u.input;
              results.push({ type: 'tool_result', tool_use_id: u.id, content: 'استُلمت الإجابة.' });
            }
            continue;
          }
          const r = await ops.executeTool(ctx, u.name, u.input);
          results.push({ type: 'tool_result', tool_use_id: u.id, is_error: !r.ok, content: JSON.stringify(r) });
        }
        messages.push({ role: 'user', content: results });
      }
      if (!final && steps >= config.agent.maxSteps) warnings.push(`توقف الوكيل بعد ${steps} خطوات دون إجابة منظمة.`);
    } catch (e) {
      return fail(ctx, user, runId, e, usage);
    }

    const response = buildResponse(ctx, { final, lastText, warnings, steps, usage });
    // ضمان التحويل: إن قرر الوكيل أن الحالة تحتاج موظفاً ولم يحوّلها فعلاً، نحوّلها برمجياً
    // (إلا إذا كان ينتظر جواب سؤال توضيحي من الموظف نفسه)
    if (response.needs_staff && response.status !== 'needs_clarification' && !ctx.ledger.some((l) => l.tool === 'escalate_to_staff' && l.ok) && can(user.role, 'task.write')) {
      const r = await ops.executeTool(ctx, 'escalate_to_staff', {
        reason: 'other',
        summary: `طلب الموظف: ${request.slice(0, 400)}\nسبب التحويل: ${response.staff_reason || 'غير محدد'}`.slice(0, 1000),
        priority: 'high',
      });
      response.actions = actionsFrom(ctx);
      response.auto_escalated = r.ok;
    }
    rememberTurn(ctx, response);
    store.finishRun(user.tenant_id, runId, { status: 'succeeded', response, usage });
    audit(store.db, { tenantId: user.tenant_id, userId: user.id, runId, event: 'agent.response', detail: { needs_staff: response.needs_staff, actions: response.actions.length, steps } });
    return response;
  }

  function buildResponse(ctx, { final, lastText, warnings, steps, usage }) {
    const cited = final?.sources || [];
    const valid = cited.filter((id) => ctx.citable.has(id));
    const invalid = cited.filter((id) => !ctx.citable.has(id));
    if (invalid.length) warnings.push(`استُبعدت مصادر لم تُسترجع فعلاً: ${invalid.join('، ')}`);
    const answer = final?.answer || lastText || 'لم يُكمل الوكيل إجابة.';
    if (!final) warnings.push('لم يسلّم الوكيل إجابة منظمة؛ يُعرض آخر نص كتبه.');
    const actions = actionsFrom(ctx);
    const confirmed = actions.some((a) => a.ok && a.status === 'done' && a.tool !== 'create_task' && a.tool !== 'escalate_to_staff');
    if (CLAIM_SENT.test(answer) && !confirmed) {
      warnings.push('نص الإجابة يذكر تنفيذ إرسال أو تغيير لم تؤكده الأدوات. المعتمد هو قائمة الإجراءات أدناه.');
    }
    const clarifying = final?.clarifying_question?.trim() || '';
    return {
      run_id: ctx.runId,
      conversation_id: ctx.conversationId,
      status: clarifying ? 'needs_clarification' : 'succeeded',
      today: ctx.today,
      understood_request: final?.understood_request || null,
      answer,
      clarifying_question: clarifying || null,
      assumptions: final?.assumptions || [],
      confidence: final?.confidence || null,
      needs_staff: Boolean(final ? final.needs_staff : true),
      entities: collectEntities(ctx),
      staff_reason: final?.staff_reason || (final ? '' : 'لم تكتمل معالجة الطلب آلياً'),
      missing_info: final?.missing_info || [],
      sources: valid.map((id) => sourceInfo(id)),
      actions,
      pending_approvals: actions.filter((a) => a.status === 'pending_approval').map((a) => ({ action_id: a.refs.action_id, summary: a.refs.summary || a.refs.note, tool: a.tool })),
      errors: ctx.ledger.filter((l) => !l.ok).map((l) => ({ tool: l.tool, code: l.error.code, message: l.error.message })),
      warnings,
      log: ctx.ledger.map((l) => ({ tool: l.tool, ok: l.ok, status: l.status, ms: l.ms, error: l.error?.message })),
      steps,
      model: llm.model,
      usage,
    };
  }

  function sourceInfo(id) {
    const e = kb.get(id);
    return e ? { id, title: e.title, type: e.type, approval: e.approval, source: e.source?.name, url: e.source?.url || null, checked_at: e.checked_at } : { id };
  }

  function actionsFrom(ctx) {
    return ctx.ledger.filter((l) => WRITE_MODES.has(l.mode)).map((l) => ({ tool: l.tool, ok: l.ok, status: l.status, refs: l.refs || {}, error: l.error?.message }));
  }

  async function fail(ctx, user, runId, e, usage) {
    const known = e instanceof OpsError;
    if (!known) console.error('[agent]', e);
    const error = { code: known ? e.code : 'internal_error', message: known ? e.message : 'خطأ داخلي غير متوقع.' };
    // لا يضيع الطلب: مهمة للموظف المختص لمعالجته يدوياً
    let fallbackTask = null;
    if (can(user.role, 'task.write')) {
      const { task } = store.createTask(user.tenant_id, {
        title: 'طلب لم يُعالج آلياً (فشل الوكيل)',
        details: `${error.message}\nالطلب: ${store.getRun(user.tenant_id, runId)?.request?.slice(0, 600)}`,
        priority: 'high', assignee_role: 'manager', source: 'agent', dedupe_key: `run-failed:${runId}`, created_by: user.id,
      });
      fallbackTask = task.id;
    }
    const response = {
      run_id: runId,
      conversation_id: ctx.conversationId,
      status: 'failed',
      today: ctx.today,
      error,
      answer: `تعذر إكمال الطلب: ${error.message}${fallbackTask ? ' أُنشئت مهمة للمدير لمعالجته يدوياً.' : ''}`,
      needs_staff: true,
      missing_info: [],
      sources: [],
      actions: actionsFrom(ctx),
      pending_approvals: [],
      errors: [{ tool: 'llm', ...error }, ...ctx.ledger.filter((l) => !l.ok).map((l) => ({ tool: l.tool, code: l.error.code, message: l.error.message }))],
      warnings: ctx.ledger.some((l) => WRITE_MODES.has(l.mode) && l.ok) ? ['بعض الإجراءات اكتملت قبل الخطأ؛ راجع قائمة الإجراءات.'] : [],
      log: ctx.ledger.map((l) => ({ tool: l.tool, ok: l.ok, status: l.status, ms: l.ms, error: l.error?.message })),
      fallback_task_id: fallbackTask,
      model: llm.model,
      usage,
    };
    rememberTurn(ctx, response);
    store.finishRun(user.tenant_id, runId, { status: 'failed', response, error: error.message, usage });
    audit(store.db, { tenantId: user.tenant_id, userId: user.id, runId, event: 'agent.failed', detail: error });
    return response;
  }

  function rememberTurn(ctx, response) {
    const text = [response.answer, response.clarifying_question ? `سؤالي: ${response.clarifying_question}` : ''].filter(Boolean).join('\n');
    store.addTurn(ctx.tenantId, ctx.conversationId, { runId: ctx.runId, userText: ctx.request, assistantText: text, entities: response.entities || collectEntities(ctx) });
  }

  function replay(run) {
    if (run.status === 'running') return { run_id: run.id, status: 'running', answer: 'هذا الطلب قيد المعالجة بالفعل.', replayed: true, actions: [], sources: [], missing_info: [], errors: [], warnings: [] };
    return { ...run.response, replayed: true };
  }

  return { ask };
}

function collectEntities(ctx) {
  const map = new Map();
  for (const l of ctx.ledger) for (const e of l.entities || []) if (!map.has(e.id)) map.set(e.id, e);
  return [...map.values()].slice(0, 20);
}

const TYPE_LABEL = { client: 'عميل', transaction: 'معاملة', document: 'مستند', task: 'مهمة' };
function entitiesNote(entities) {
  if (!entities?.length) return '';
  return `\n[الكيانات المذكورة: ${entities.map((e, i) => `${i + 1}) ${TYPE_LABEL[e.type] || e.type}: ${e.name || ''} (${e.id})`).join('، ')}]`;
}

function userMessage(ctx, request, snippets, priorTurns = 0) {
  const kbBlock = snippets.length
    ? snippets.map((s) => JSON.stringify({ id: s.id, type: s.type, approval: s.approval, source: s.source?.name, checked_at: s.checked_at, content: s.content })).join('\n')
    : 'لا توجد نتائج مطابقة في قاعدة المعرفة.';
  return `<context>
اليوم: ${ctx.today} (${formatHijri(ctx.today)}) — المنطقة الزمنية: ${ctx.tenant.timezone}
المنشأة: ${ctx.tenant.name}
المستخدم: ${ctx.user.name} (الدور: ${ctx.user.role})
${priorTurns ? `هذه رسالة متابعة في محادثة سابقة (${priorTurns} دور سابق أعلاه).` : 'بداية محادثة جديدة.'}
</context>
<knowledge_snippets>
${kbBlock}
</knowledge_snippets>
طلب الموظف: ${request}`;
}
