// تشغيل التقييم من سطر الأوامر (تكلفة فعلية على حساب Claude API).
// node --env-file=.env scripts/run-evals.js [--only id1,id2]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/ops/config.js';
import { runEvalSuite } from '../src/ops/evals.js';

const { values } = parseArgs({ options: { only: { type: 'string' }, 'allow-mock': { type: 'boolean' } } });
const config = loadConfig();
if (config.llm.provider === 'mock' && !values['allow-mock']) {
  console.error('LLM_PROVIDER=mock: التقييم يحتاج النموذج الحقيقي (ANTHROPIC_API_KEY و LLM_PROVIDER=anthropic).');
  process.exit(1);
}
const result = await runEvalSuite({
  config,
  only: values.only?.split(','),
  onCase: (e) => console.log(`${e.pass ? '✓' : '✗'} ${e.id} (${e.skill})${e.pass ? '' : `\n    ${e.fails.join('\n    ')}\n    الإجابة: ${e.answers.at(-1).answer?.slice(0, 200)}`}`),
});
const u = result.usage;
console.log(`\nالنتيجة: ${result.pass}/${result.total} — ${result.model} (جهد ${result.effort}) — رموز: إدخال ${u.input_tokens}، إخراج ${u.output_tokens}، من الذاكرة المؤقتة ${u.cache_read_input_tokens}`);
const out = path.resolve('data', `eval-report-${Date.now()}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(result, null, 2));
console.log(`التقرير: ${out}`);
