import assert from "node:assert/strict";
import { test } from "node:test";
import { compactUnknown, parseSessionMetadataJson, sanitizeText } from "../src/text.js";

test("sanitizes controls, ANSI, and whitespace", () => {
  assert.equal(sanitizeText("\u001b[31m hello\n\tworld \u001b[0m"), "hello world");
});

test("truncates with an ellipsis", () => {
  assert.equal(sanitizeText("abcdef", 4), "abc…");
});

test("compacts unknown values as bounded JSON", () => {
  assert.equal(compactUnknown({ a: 1 }), "{\"a\":1}");
});

test("parses session metadata JSON from model output", () => {
  assert.deepEqual(parseSessionMetadataJson('{"goal":"Make subagent display compact by default.","status":"Implemented footer-only default and toggle controls.","nextStep":"Reload Pi and launch scouts to confirm the UI.","stage":"testing","confidence":0.86}'), {
    goal: "Make subagent display compact by default.",
    status: "Implemented footer-only default and toggle controls.",
    nextStep: "Reload Pi and launch scouts to confirm the UI.",
    stage: "testing",
    confidence: 0.86,
  });
});

test("rejects invalid session metadata JSON", () => {
  assert.equal(parseSessionMetadataJson("not json"), undefined);
  assert.equal(parseSessionMetadataJson('{"stage":"planning","status":"Planning."}'), undefined);
  assert.equal(parseSessionMetadataJson('{"stage":"planning","goal":"Plan metadata."}'), undefined);
});

test("normalizes invalid stage and confidence", () => {
  assert.deepEqual(parseSessionMetadataJson('{"goal":"Plan metadata.","status":"Checking schema.","stage":"inventing","confidence":2}'), {
    goal: "Plan metadata.",
    status: "Checking schema.",
    stage: "unknown",
    confidence: 1,
  });
});

test("parses stage-compatible explicit attention", () => {
  for (const [kind, stage] of [["ready", "complete"], ["question", "waiting"], ["blocked", "blocked"]] as const) {
    assert.deepEqual(parseSessionMetadataJson(JSON.stringify({
      goal: "Ship attention metadata",
      status: "Final handoff published",
      stage,
      confidence: 0.9,
      attention: { kind, text: "Needs a human response" },
    }))?.attention, { kind, text: "Needs a human response" });
  }
});

test("omits invalid or uncertain attention without dropping semantic metadata", () => {
  const invalid = [
    { kind: "ready", text: "Mismatched", stage: "waiting", confidence: 0.9 },
    { kind: "review", text: "Unknown", stage: "complete", confidence: 0.9 },
    { kind: "ready", text: "   ", stage: "complete", confidence: 0.9 },
    { kind: "ready", text: "Uncertain", stage: "complete", confidence: 0.49 },
  ];
  for (const candidate of invalid) {
    const parsed = parseSessionMetadataJson(JSON.stringify({
      goal: "Ship attention metadata",
      status: "Semantic metadata remains",
      stage: candidate.stage,
      confidence: candidate.confidence,
      attention: { kind: candidate.kind, text: candidate.text },
    }));
    assert.equal(parsed?.status, "Semantic metadata remains");
    assert.equal(parsed?.attention, undefined);
  }
});

test("sanitizes and truncates metadata fields independently", () => {
  const long = "x".repeat(220);
  const parsed = parseSessionMetadataJson(JSON.stringify({
    goal: `\u001b[31m${long}\u001b[0m`,
    status: long,
    nextStep: long,
    stage: "testing",
  }));
  assert.equal(parsed?.goal.length, 96);
  assert.equal(parsed?.status.length, 60);
  assert.equal(parsed?.nextStep?.length, 48);
  const attention = parseSessionMetadataJson(JSON.stringify({
    goal: "Bound attention",
    status: "Checking bounds",
    stage: "blocked",
    confidence: 1,
    attention: { kind: "blocked", text: long },
  }))?.attention;
  assert.equal(attention?.text.length, 96);
  assert.equal(attention?.text.endsWith("…"), true);
  assert.equal(parsed?.goal.endsWith("…"), true);
  assert.equal(parsed?.status.endsWith("…"), true);
  assert.equal(parsed?.nextStep?.endsWith("…"), true);
});
