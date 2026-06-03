import assert from "node:assert/strict";
import { test } from "node:test";
import sessionSummary from "../src/index.js";

test("exports a Pi extension factory", () => {
  assert.equal(typeof sessionSummary, "function");
});

test("registers primary command and legacy alias", () => {
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
  assert.equal(commands.get("tldr-lite")?.handler, commands.get("session-summary")?.handler);
  assert.match(commands.get("tldr-lite")?.description ?? "", /legacy/i);
  assert.ok(events.includes("session_start"));
});
