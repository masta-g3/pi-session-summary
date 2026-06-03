import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNamePrompt, getConversationTranscript, getFirstUserMessageText, sanitizeSessionName } from "../src/naming.js";

test("sanitizes model-generated session names", () => {
  assert.equal(sanitizeSessionName('"Agent Hub TLDR Extension."'), "Agent Hub TLDR Extension");
  assert.equal(sanitizeSessionName("Name: Semantic Session Metadata"), "Semantic Session Metadata");
});

test("limits long session names", () => {
  const name = sanitizeSessionName("A".repeat(120));
  assert.equal(name.length, 80);
});

test("extracts first user message from session entries", () => {
  const entries = [
    { type: "message", message: { role: "assistant", content: "Done" } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "Build TLDR lite" }] } },
  ];
  assert.equal(getFirstUserMessageText(entries), "Build TLDR lite");
});

test("builds bounded conversation transcript", () => {
  const transcript = getConversationTranscript([
    { type: "message", message: { role: "assistant", content: "Working" } },
    { type: "message", message: { role: "user", content: "Build TLDR lite" } },
  ]);
  assert.equal(transcript, "User: Build TLDR lite Assistant: Working");
});

test("builds naming prompt", () => {
  const prompt = buildNamePrompt("Build TLDR lite");
  const first = prompt.content[0];
  const text = typeof first === "object" && first?.type === "text" ? first.text : "";
  assert.match(text, /First user message:/);
  assert.match(text, /Build TLDR lite/);
});
