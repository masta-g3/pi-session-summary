import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatStatusLine, SessionSummaryBox } from "../src/widget.js";

const theme = {
  fg(_token: string, text: string) {
    return text;
  },
};

test("renders semantic status and evidenced next step without a plan", () => {
  const lines = new SessionSummaryBox(theme as never, {
    kind: "status",
    status: "Updating workflow parser",
    stage: "editing",
    nextStep: "Add phase parsing tests",
  }).render(48);

  assert.equal(lines[0]?.startsWith("╭ status "), true);
  assert.match(lines.join("\n"), /EDITING · Updating workflow parser/);
  assert.match(lines.join("\n"), /Next: Add phase parsing tests/);
  assert.equal(lines.at(-1), "╰──────────────────────────────────────────────╯");
});

test("omits the semantic next-step row when it is not evidenced", () => {
  const lines = new SessionSummaryBox(theme as never, {
    kind: "status",
    status: "Explaining extension behavior",
    stage: "complete",
  }).render(40);

  assert.equal(lines.length, 3);
  assert.doesNotMatch(lines.join("\n"), /Next:/);
});

test("renders deterministic phase progress instead of semantic status", () => {
  const lines = new SessionSummaryBox(theme as never, {
    kind: "plan",
    progress: {
      phaseIndex: 2,
      phaseCount: 4,
      title: "Add skill skeleton",
      completed: 1,
      total: 4,
    },
    nextStep: "Create routing.md",
  }).render(48);

  assert.equal(lines[0]?.startsWith("╭ plan "), true);
  assert.match(lines.join("\n"), /Phase 2\/4 · Add skill skeleton/);
  assert.match(lines.join("\n"), /✓ 1\/4 tasks · Next: Create routing\.md/);
});

test("formats stage labels for glanceable status", () => {
  assert.equal(formatStatusLine("Inspecting files.", "reading"), "READING · Inspecting files.");
  assert.equal(formatStatusLine("Needs user decision.", "waiting"), "WAITING · Needs user decision.");
  assert.equal(formatStatusLine("Tests passed.", "complete"), "DONE · Tests passed.");
});

test("uses narrow one-line fallbacks", () => {
  const status = new SessionSummaryBox(theme as never, {
    kind: "status",
    status: "Planning Agent Hub integration.",
    stage: "reading",
  }).render(10);
  const plan = new SessionSummaryBox(theme as never, {
    kind: "plan",
    progress: { phaseIndex: 2, phaseCount: 4, title: "Add plan display", completed: 1, total: 4 },
    nextStep: "Render progress",
  }).render(10);

  assert.equal(status.length, 1);
  assert.ok(status[0]?.startsWith("status"));
  assert.equal(plan.length, 1);
  assert.ok(plan[0]?.startsWith("plan"));
});

test("wraps without exceeding visible width", () => {
  const lines = new SessionSummaryBox(theme as never, {
    kind: "plan",
    progress: {
      phaseIndex: 2,
      phaseCount: 4,
      title: "Implement semantic workflow statuses",
      completed: 1,
      total: 4,
    },
    nextStep: "Render compact progress for every active session",
  }).render(24);

  assert.ok(lines.length > 4);
  for (const line of lines) assert.ok(visibleWidth(line) <= 24, line);
});
