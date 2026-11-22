/**
 * Models an agent may run on, with list prices (USD per million tokens) used for the
 * estimated cost shown in the dashboard and enforced against each tenant's monthly cap.
 * Cache writes (5-minute) cost 1.25x input; cache reads 0.1x input.
 * Check https://platform.claude.com/docs/en/about-claude/pricing when prices change.
 */
export const MODELS = {
  "claude-opus-5-5": { label: "Claude Opus 5.5 — الأقوى (افتراضي)", input: 4, output: 20 },
  "claude-sonnet-5-5": { label: "Claude Sonnet 5.5 — متوازن", input: 2, output: 10 },
  "claude-haiku-5-5": { label: "Claude Haiku 5.5 — الأسرع والأرخص", input: 0.1, output: 0.5 },
} as const;

export type ModelId = keyof typeof MODELS;
export const DEFAULT_MODEL: ModelId = "claude-opus-5-5";
export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];
export const EFFORT_LABELS: Record<Effort, string> = { low: "منخفض — ردود سريعة", medium: "متوسط", high: "عالٍ — تفكير أعمق" };

export function isModelId(value: string): value is ModelId {
  return Object.hasOwn(MODELS, value);
}

export function isEffort(value: string): value is Effort {
  return (EFFORTS as readonly string[]).includes(value);
}

export type TokenUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

/** Estimated cost in micro-USD (1e-6 dollars). Unknown models are priced as the default model. */
export function costMicroUsd(model: string, usage: TokenUsage) {
  const price = MODELS[isModelId(model) ? model : DEFAULT_MODEL];
  const micro = usage.inputTokens * price.input + usage.cacheWriteTokens * price.input * 1.25 + usage.cacheReadTokens * price.input * 0.1 + usage.outputTokens * price.output;
  return Math.ceil(micro);
}

export const USD_TO_SAR = 3.75;

export function formatUsd(micro: number) {
  return `$${(micro / 1_000_000).toFixed(micro < 10_000_000 ? 4 : 2)}`;
}

export function formatSar(micro: number) {
  return `${((micro / 1_000_000) * USD_TO_SAR).toFixed(2)} ر.س`;
}
