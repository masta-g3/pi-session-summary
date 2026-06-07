import assert from "node:assert/strict";
import { test } from "node:test";
import { activityLines, createActivityBuffer } from "../src/activity.js";

test("records a user request", () => {
  const buffer = createActivityBuffer(12, 700, () => 10);
  const activity = buffer.record("user", "Build the session summary extension");
  assert.deepEqual(activity, { sequence: 1, kind: "user", text: "Build the session summary extension", at: 10 });
});

test("throttles tiny assistant updates", () => {
  const buffer = createActivityBuffer(12, 700);
  assert.ok(buffer.recordAssistantUpdate("Thinking", 0));
  assert.equal(buffer.recordAssistantUpdate("Thinking.", 100), undefined);
  assert.ok(buffer.recordAssistantUpdate("Thinking after a pause", 1_100));
});

test("bounds retained activity", () => {
  const buffer = createActivityBuffer(2, 700);
  buffer.record("user", "one", 1);
  buffer.record("tool", "two", 2);
  buffer.record("result", "three", 3);
  assert.deepEqual(buffer.all().map((activity) => activity.text), ["two", "three"]);
});

test("resets retained activity without resetting sequence", () => {
  const buffer = createActivityBuffer();
  buffer.record("user", "one");
  buffer.reset();
  buffer.record("user", "two");
  assert.equal(buffer.all()[0]?.sequence, 2);
});

test("formats activity lines for prompts", () => {
  const buffer = createActivityBuffer();
  buffer.record("user", "Plan semantic summaries");
  assert.deepEqual(activityLines(buffer.all()), ["- user: Plan semantic summaries"]);
});
