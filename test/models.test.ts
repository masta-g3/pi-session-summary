import assert from "node:assert/strict";
import { test } from "node:test";
import { FAST_MODEL_CANDIDATES, formatModelPreference, getTldrModelAuth, parseModelSpec, parseSettings } from "../src/models.js";

test("parses provider/model strings", () => {
  assert.deepEqual(parseModelSpec("openai-codex/gpt-5.4-mini"), { provider: "openai-codex", id: "gpt-5.4-mini" });
  assert.equal(parseModelSpec("auto"), undefined);
  assert.equal(parseModelSpec("bad"), undefined);
});

test("prefers sessionSummary.model over legacy model settings", () => {
  assert.equal(formatModelPreference(parseSettings({
    sessionSummary: { model: "openai-codex/gpt-5.4-mini" },
    tldrLite: { model: "anthropic/claude-haiku-4-5" },
    tldr: { model: "anthropic/claude-haiku-4-5-20251001" },
  })), "openai-codex/gpt-5.4-mini");
});

test("falls back to legacy tldrLite.model before tldr.model", () => {
  assert.equal(formatModelPreference(parseSettings({
    tldrLite: { model: "anthropic/claude-haiku-4-5" },
    tldr: { model: "anthropic/claude-haiku-4-5-20251001" },
  })), "anthropic/claude-haiku-4-5");
});

test("auto candidate order starts with Codex models", () => {
  assert.deepEqual(FAST_MODEL_CANDIDATES.slice(0, 2).map(formatModelPreference), [
    "openai-codex/gpt-5.4-mini",
    "openai-codex/gpt-5.3-codex-spark",
  ]);
});

test("falls back from missing configured auth to auto candidate", async () => {
  const models = new Map([
    ["openai-codex/gpt-5.4-mini", { provider: "openai-codex", id: "gpt-5.4-mini" }],
    ["missing/model", { provider: "missing", id: "model" }],
  ]);
  const ctx = {
    modelRegistry: {
      find(provider: string, id: string) {
        return models.get(`${provider}/${id}`);
      },
      async getApiKeyAndHeaders(model: { provider: string; id: string }) {
        return model.provider === "missing" ? { ok: false } : { ok: true, apiKey: "key" };
      },
    },
  };
  const auth = await getTldrModelAuth(ctx as never, { provider: "missing", id: "model" });
  assert.equal(auth?.model.provider, "openai-codex");
});
