import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNamePrompt, getConversationTranscript, getFirstUserMessageText, sanitizeSessionName } from "../src/naming.js";

test("sanitizes model-generated session names", () => {
  assert.equal(sanitizeSessionName('"Agent Hub Session Summary Extension."'), "Agent Hub Session Summary Extension");
  assert.equal(sanitizeSessionName("Name: Semantic Session Metadata"), "Semantic Session Metadata");
});

test("limits long session names", () => {
  const name = sanitizeSessionName("A".repeat(120));
  assert.equal(name.length, 80);
});

test("extracts first user message from session entries", () => {
  const entries = [
    { type: "message", message: { role: "assistant", content: "Done" } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "Build session summary" }] } },
  ];
  assert.equal(getFirstUserMessageText(entries), "Build session summary");
});

test("builds bounded conversation transcript", () => {
  const transcript = getConversationTranscript([
    { type: "message", message: { role: "assistant", content: "Working" } },
    { type: "message", message: { role: "user", content: "Build session summary" } },
  ]);
  assert.equal(transcript, "User: Build session summary Assistant: Working");
});

test("builds naming prompt", () => {
  const prompt = buildNamePrompt("Build session summary");
  const first = prompt.content[0];
  const text = typeof first === "object" && first?.type === "text" ? first.text : "";
  assert.match(text, /First user message:/);
  assert.match(text, /Build session summary/);
});
