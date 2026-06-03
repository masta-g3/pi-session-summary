import assert from "node:assert/strict";
import { test } from "node:test";
import { compactUnknown, parseSummaryJson, sanitizeText } from "../src/text.js";

test("sanitizes controls, ANSI, and whitespace", () => {
  assert.equal(sanitizeText("\u001b[31m hello\n\tworld \u001b[0m"), "hello world");
});

test("truncates with an ellipsis", () => {
  assert.equal(sanitizeText("abcdef", 4), "abc…");
});

test("compacts unknown values as bounded JSON", () => {
  assert.equal(compactUnknown({ a: 1 }), "{\"a\":1}");
});

test("parses summary JSON from model output", () => {
  assert.deepEqual(parseSummaryJson('{"summary":"Planning Agent Hub output.","phase":"planning","nextAction":"Confirm the dashboard schema.","confidence":0.8}'), {
    summary: "Planning Agent Hub output.",
    phase: "planning",
    nextAction: "Confirm the dashboard schema.",
    confidence: 0.8,
  });
});

test("rejects invalid summary JSON", () => {
  assert.equal(parseSummaryJson("not json"), undefined);
  assert.equal(parseSummaryJson('{"phase":"planning"}'), undefined);
});
