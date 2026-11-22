import { readFileSync } from 'node:fs';

export const knowledge = JSON.parse(
  readFileSync(new URL('../knowledge.json', import.meta.url), 'utf8')
);

export const fill = (template, vars = {}) =>
  template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
