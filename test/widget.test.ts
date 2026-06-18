import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatStatusLine, SessionSummaryBox } from "../src/widget.js";

const theme = {
  fg(_token: string, text: string) {
    return text;
  },
};

test("renders a normal session status box", () => {
  const lines = new SessionSummaryBox(theme as never, "Updated dashboard metadata.", "editing").render(40);
  assert.equal(lines[0]?.startsWith("╭ status "), true);
  assert.match(lines.join("\n"), /EDITING: Updated dashboard metadata\./);
  assert.equal(lines.at(-1), "╰──────────────────────────────────────╯");
});

test("formats stage labels for glanceable status", () => {
  assert.equal(formatStatusLine("Inspecting files.", "reading"), "READING: Inspecting files.");
  assert.equal(formatStatusLine("Needs user decision.", "waiting"), "WAITING: Needs user decision.");
  assert.equal(formatStatusLine("Tests passed.", "complete"), "DONE: Tests passed.");
});

test("uses narrow status fallback", () => {
  const lines = new SessionSummaryBox(theme as never, "Planning Agent Hub integration.", "reading").render(10);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]?.startsWith("status"));
});

test("wraps without exceeding visible width", () => {
  const lines = new SessionSummaryBox(theme as never, "Implementing semantic workflow statuses for many Pi Agent Hub sessions.", "editing").render(24);
  assert.ok(lines.length > 3);
  for (const line of lines) assert.ok(visibleWidth(line) <= 24, line);
});
