import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TodoPanel } from "../src/todo-panel.js";
import type { WorkflowPlan } from "../src/workflow.js";

function theme(calls: string[] = []) {
  return {
    fg(token: string, text: string) {
      calls.push(`fg:${token}:${text}`);
      return text;
    },
    bold(text: string) {
      calls.push(`bold:${text}`);
      return text;
    },
    strikethrough(text: string) {
      calls.push(`strike:${text}`);
      return text;
    },
  } as never;
}

function tui(rows = 30) {
  let renders = 0;
  return {
    terminal: { rows },
    requestRender() { renders += 1; },
    renders: () => renders,
  };
}

const phasedPlan: WorkflowPlan = {
  sections: [
    {
      heading: "Phase 1 · Parse tasks",
      tasks: [
        { done: true, text: "Add parser tests" },
        { done: true, text: "Return structured tasks" },
      ],
    },
    {
      heading: "Stage 3 · Render drawer",
      tasks: [
        { done: false, text: "Show every open task" },
        { done: false, text: "Support scrolling" },
      ],
    },
  ],
  completed: 2,
  total: 4,
  currentSectionIndex: 1,
};

test("renders phased hierarchy, completion state, and semantic theme roles", () => {
  const calls: string[] = [];
  const lines = new TodoPanel(tui() as never, theme(calls), "metadata-005", phasedPlan, () => {}).render(54);
  const output = lines.join("\n");

  assert.match(output, /Plan · metadata-005/);
  assert.match(output, /Phase 1 · Parse tasks/);
  assert.match(output, /Stage 3 · Render drawer/);
  assert.match(output, /☑ Add parser tests/);
  assert.match(output, /☐ Show every open task/);
  assert.match(output, /2\/4 done/);
  assert.ok(calls.some((call) => call.startsWith("fg:accent:Stage 3")));
  assert.ok(calls.some((call) => call.startsWith("fg:success:☑")));
  assert.equal(calls.some((call) => call.startsWith("strike:")), false);
  assert.ok(calls.some((call) => call.startsWith("fg:muted:Add parser tests")));
});

test("renders a flat checklist under Tasks and keeps all-complete plans at the top", () => {
  const plan: WorkflowPlan = {
    sections: [{ tasks: [{ done: true, text: "Ship package" }, { done: true, text: "Tag release" }] }],
    completed: 2,
    total: 2,
    currentSectionIndex: 0,
  };
  const output = new TodoPanel(tui(8) as never, theme(), "package-001", plan, () => {}).render(44).join("\n");

  assert.match(output, /Tasks/);
  assert.match(output, /☑ Ship package/);
  assert.match(output, /2\/2 done/);
});

test("wraps long and Unicode tasks without exceeding the supplied width", () => {
  const plan: WorkflowPlan = {
    sections: [{
      heading: "Phase 2 · Render",
      tasks: [{ done: false, text: "Render café 漢字 status across a deliberately narrow terminal without hiding words" }],
    }],
    completed: 0,
    total: 1,
    currentSectionIndex: 0,
  };
  const lines = new TodoPanel(tui() as never, theme(), "metadata-005", plan, () => {}).render(26);

  assert.ok(lines.length > 5);
  assert.match(lines.join("\n"), /terminal without/);
  assert.match(lines.join("\n"), /hiding words/);
  for (const line of lines) assert.ok(visibleWidth(line) <= 26, `${visibleWidth(line)}: ${line}`);
  for (const line of new TodoPanel(tui() as never, theme(), "metadata-005", plan, () => {}).render(3)) {
    assert.ok(visibleWidth(line) <= 3, line);
  }
});

test("initially keeps the current section's first incomplete task visible", () => {
  const plan: WorkflowPlan = {
    sections: [
      { heading: "Phase 1 · Complete", tasks: Array.from({ length: 8 }, (_, index) => ({ done: true, text: `Earlier ${index + 1}` })) },
      {
        heading: "Phase 2 · Current",
        tasks: [
          ...Array.from({ length: 7 }, (_, index) => ({ done: true, text: `Current complete ${index + 1}` })),
          { done: false, text: "Start here" },
          { done: false, text: "Then continue" },
        ],
      },
    ],
    completed: 15,
    total: 17,
    currentSectionIndex: 1,
  };
  const output = new TodoPanel(tui(10) as never, theme(), "metadata-005", plan, () => {}).render(46).join("\n");

  assert.match(output, /Start here/);
  assert.doesNotMatch(output, /Earlier 1/);
});

test("scrolls by rows and pages, clamps boundaries, and closes from both controls", () => {
  const plan: WorkflowPlan = {
    sections: [{ tasks: Array.from({ length: 14 }, (_, index) => ({ done: false, text: `Task ${index + 1}` })) }],
    completed: 0,
    total: 14,
    currentSectionIndex: 0,
  };
  const host = tui(10);
  let closes = 0;
  const panel = new TodoPanel(host as never, theme(), "metadata-005", plan, () => { closes += 1; });
  const first = panel.render(40).join("\n");
  assert.match(first, /Task 1/);
  assert.doesNotMatch(first, /Task 5/);

  panel.handleInput("\x1b[B");
  assert.equal(host.renders(), 1);
  assert.match(panel.render(40).join("\n"), /Task 5/);

  panel.handleInput("\x1b[6~");
  const paged = panel.render(40).join("\n");
  assert.match(paged, /Task 7|Task 8|Task 9/);

  for (let index = 0; index < 30; index++) panel.handleInput("\x1b[B");
  const atEnd = host.renders();
  panel.handleInput("\x1b[B");
  assert.equal(host.renders(), atEnd);
  assert.match(panel.render(40).join("\n"), /Task 14/);

  panel.handleInput("\x1b");
  panel.handleInput("\x1b\x14");
  assert.equal(closes, 1);

  const shortcutPanel = new TodoPanel(tui() as never, theme(), "metadata-005", plan, () => { closes += 1; });
  shortcutPanel.handleInput("\x1b\x14");
  assert.equal(closes, 2);
});
