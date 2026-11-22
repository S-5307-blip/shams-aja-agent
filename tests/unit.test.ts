import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey, KEY_PREFIX, readApiKey } from "@/lib/api-keys";
import { riyadhMonthStart, slugify } from "@/lib/format";
import { costMicroUsd } from "@/lib/models";
import { buildSystem, PLATFORM_RULES, replyText } from "@/lib/prompt";

describe("api keys", () => {
  it("generates unique keys whose hash matches and prefix is displayable", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.key).not.toBe(b.key);
    expect(a.key.startsWith(KEY_PREFIX)).toBe(true);
    expect(a.hash).toBe(hashApiKey(a.key));
    expect(a.key.startsWith(a.prefix)).toBe(true);
    expect(a.hash).not.toContain(a.key.slice(KEY_PREFIX.length));
  });

  it("reads bearer and x-api-key headers and rejects malformed keys", () => {
    const { key } = generateApiKey();
    expect(readApiKey(new Headers({ authorization: `Bearer ${key}` }))).toBe(key);
    expect(readApiKey(new Headers({ "x-api-key": key }))).toBe(key);
    expect(readApiKey(new Headers({ authorization: "Bearer sk-ant-something" }))).toBeNull();
    expect(readApiKey(new Headers({ authorization: `Bearer ${key}x` }))).toBeNull();
    expect(readApiKey(new Headers())).toBeNull();
  });
});

describe("cost", () => {
  it("prices input, output and cache tokens per model", () => {
    // Opus 5.5: $4 in / $20 out per million => 4 and 20 micro-USD per token.
    expect(costMicroUsd("claude-opus-5-5", { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(6000);
    expect(costMicroUsd("claude-opus-5-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1000, cacheWriteTokens: 1000 })).toBe(400 + 5000);
    expect(costMicroUsd("claude-haiku-5-5", { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(100_000);
  });
});

describe("prompt", () => {
  it("puts fixed platform rules first and caches the agent block", () => {
    const system = buildSystem({ name: "A", systemPrompt: "Be helpful.", knowledge: "Price: 100" });
    expect(system[0].text).toBe(PLATFORM_RULES);
    expect(system[0].cache_control).toBeUndefined();
    expect(system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(system[1].text).toContain("<knowledge>\nPrice: 100\n</knowledge>");
  });

  it("omits the knowledge section when empty and reads only text blocks", () => {
    expect(buildSystem({ name: "A", systemPrompt: "x", knowledge: "  " })[1].text).not.toContain("<knowledge>");
    expect(replyText([{ type: "thinking", thinking: "", signature: "s" } as never, { type: "text", text: "Hello", citations: null } as never])).toBe("Hello");
  });
});

describe("helpers", () => {
  it("computes the Riyadh month start", () => {
    // 2026-11-30 22:00 UTC is already 1 December in Riyadh.
    expect(riyadhMonthStart(new Date("2026-11-30T22:00:00Z")).toISOString()).toBe("2026-11-30T21:00:00.000Z");
    expect(riyadhMonthStart(new Date("2026-11-15T10:00:00Z")).toISOString()).toBe("2026-10-31T21:00:00.000Z");
  });

  it("slugifies latin names and falls back for arabic-only names", () => {
    expect(slugify("Acme Trading Co.")).toBe("acme-trading-co");
    expect(slugify("شركة النور")).toMatch(/^client-[a-z0-9]+$/);
  });
});
