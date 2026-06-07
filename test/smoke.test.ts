import assert from "node:assert/strict";
import { test } from "node:test";
import sessionSummary from "../src/index.js";

test("exports a Pi extension factory", () => {
  assert.equal(typeof sessionSummary, "function");
});

test("registers only the session-summary command", () => {
  const commands = new Map<string, { description: string; handler: unknown }>();
  const events: string[] = [];
  sessionSummary({
    registerCommand(name: string, command: { description: string; handler: unknown }) {
      commands.set(name, command);
    },
    on(name: string) {
      events.push(name);
    },
  } as never);

  assert.equal(typeof commands.get("session-summary")?.handler, "function");
  assert.deepEqual([...commands.keys()], ["session-summary"]);
  assert.ok(events.includes("session_start"));
});
