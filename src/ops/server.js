// تشغيل خادم وكيل العمليات: npm run ops:dev
import { loadConfig } from './config.js';
import { buildRuntime } from './runtime.js';
import { createApp } from './app.js';

const config = loadConfig();
const runtime = buildRuntime(config);
const app = createApp({ ...runtime, config });
app.listen(config.port, () => {
  console.log(`وكيل عمليات شمس أجا يعمل: http://localhost:${config.port}/ops/  (النموذج: ${runtime.llm.name}/${runtime.llm.model})`);
});
