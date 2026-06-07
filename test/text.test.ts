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

test("sanitizes and truncates metadata fields independently", () => {
  const long = "x".repeat(220);
  const parsed = parseSessionMetadataJson(JSON.stringify({
    goal: `\u001b[31m${long}\u001b[0m`,
    status: "Implemented\nstatus",
    nextStep: "Reload\tPi",
    stage: "testing",
  }));
  assert.equal(parsed?.goal.length, 100);
  assert.equal(parsed?.goal.endsWith("…"), true);
  assert.equal(parsed?.status, "Implemented status");
  assert.equal(parsed?.nextStep, "Reload Pi");
});
