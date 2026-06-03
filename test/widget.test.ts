import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SessionSummaryBox } from "../src/widget.js";

const theme = {
  fg(_token: string, text: string) {
    return text;
  },
};

test("renders a normal session summary box", () => {
  const lines = new SessionSummaryBox(theme as never, "Planning Agent Hub integration.").render(40);
  assert.equal(lines[0]?.startsWith("╭ summary "), true);
  assert.equal(lines.at(-1), "╰──────────────────────────────────────╯");
});

test("uses narrow fallback", () => {
  const lines = new SessionSummaryBox(theme as never, "Planning Agent Hub integration.").render(10);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]?.startsWith("summary"));
});

test("wraps without exceeding visible width", () => {
  const lines = new SessionSummaryBox(theme as never, "Implementing semantic workflow summaries for many Pi Agent Hub sessions.").render(24);
  assert.ok(lines.length > 3);
  for (const line of lines) assert.ok(visibleWidth(line) <= 24, line);
});
