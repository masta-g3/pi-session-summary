import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extractTicketId, formatWorkflowContext, hasWorkflowIntent, readWorkflowContext, readWorkflowSnapshot, sessionPlanSummary, workflowSessionName } from "../src/workflow.js";

test("maps only compact deterministic workflow context to plan metadata", () => {
  assert.deepEqual(sessionPlanSummary({
    ticketId: "workflow-board-001",
    title: "Rich workflow board",
    description: "Replace stages with a responsive workflow board.",
    planFile: "agent-work/plans/workflow-board-001.md",
    latestCompletedTodo: "Add producer types",
    nextOpenTodo: "Refresh after checklist edits",
    planProgress: {
      phaseIndex: 2,
      phaseCount: 4,
      title: "Publish plan metadata",
      completed: 2,
      total: 5,
    },
  }), {
    feature: "Rich workflow board",
    phase: { title: "Publish plan metadata", index: 2, count: 4 },
    tasks: { completed: 2, total: 5 },
    nextStep: "Refresh after checklist edits",
  });
  assert.deepEqual(sessionPlanSummary({ title: "Flat checklist", description: "Long feature prose", nextOpenTodo: "Run checks" }), {
    feature: "Flat checklist",
    nextStep: "Run checks",
  });
  assert.deepEqual(sessionPlanSummary({ description: "Long feature prose", nextOpenTodo: "Run checks" }), {
    nextStep: "Run checks",
  });
  assert.equal(sessionPlanSummary({ ticketId: "workflow-board-001" }), undefined);
  assert.equal(sessionPlanSummary(undefined), undefined);
});

test("extracts ticket ids from prompt text", () => {
  assert.equal(extractTicketId("please execute Metadata-002 now"), "metadata-002");
  assert.equal(extractTicketId("execute workflow-board-001"), "workflow-board-001");
  assert.equal(extractTicketId("no ticket here"), undefined);
});

test("detects workflow intent without treating all prompts as workflow", () => {
  assert.equal(hasWorkflowIntent("execute metadata-002"), true);
  assert.equal(hasWorkflowIntent("please continue the active plan"), true);
  assert.equal(hasWorkflowIntent("resume the feature"), true);
  assert.equal(hasWorkflowIntent("continue explaining what this extension does"), false);
  assert.equal(hasWorkflowIntent("explain what this extension does"), false);
});

test("missing workflow files return no context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-summary-workflow-"));
  assert.equal(await readWorkflowContext({ cwd: dir, ticketId: "metadata-002", workflowIntent: true }), undefined);
});

test("selects explicit ticket and reads plan checklist", async () => {
  const dir = await workflowRepo(`
- id: metadata-001
  status: done
  description: "Old metadata work"
- id: metadata-002
  status: pending
  title: "Compact metadata titles"
  description: "Workflow-grounded session metadata and titles for dashboard supervision"
  plan_file: agent-work/plans/metadata-002.md
`, `
# Plan

- [x] Add workflow parser tests
- [x] Implement workflow context reader
- [ ] Wire context into summarizer prompt
- [ ] Add dashboard metadata simulations
`);

  assert.deepEqual(await readWorkflowContext({ cwd: dir, ticketId: "metadata-002", workflowIntent: false }), {
    ticketId: "metadata-002",
    title: "Compact metadata titles",
    description: "Workflow-grounded session metadata and titles for dashboard supervision",
    planFile: "agent-work/plans/metadata-002.md",
    latestCompletedTodo: "Implement workflow context reader",
    nextOpenTodo: "Wire context into summarizer prompt",
    evidence: "explicit-ticket",
  });
});

test("reads quoted and plain feature titles", async () => {
  const quoted = await workflowRepo(`
- id: metadata-002
  status: in_progress
  title: "Compact metadata titles"
  description: "Full model context remains available"
`, "");
  assert.deepEqual(await readWorkflowContext({ cwd: quoted, ticketId: "metadata-002" }), {
    ticketId: "metadata-002",
    title: "Compact metadata titles",
    description: "Full model context remains available",
    evidence: "explicit-ticket",
  });

  const plain = await workflowRepo(`
- id: metadata-002
  title: Plain workflow title
  status: in_progress
`, "");
  assert.equal((await readWorkflowContext({ cwd: plain, ticketId: "metadata-002" }))?.title, "Plain workflow title");
});

test("reads feature ids regardless of YAML field order", async () => {
  const dir = await workflowRepo(`
- id: metadata-004
  status: done
  plan_file: agent-work/history/metadata-004.md
- epic: metadata
  description: "Plan todo overlay"
  priority: 1
  id: metadata-005
  status: in_progress
  plan_file: agent-work/plans/metadata-002.md
`, "- [ ] Show the active plan");

  const snapshot = await readWorkflowSnapshot({ cwd: dir, workflowIntent: true });
  assert.equal(snapshot?.context.ticketId, "metadata-005");
  assert.equal(snapshot?.context.planFile, "agent-work/plans/metadata-002.md");
  assert.equal(snapshot?.plan?.sections[0]?.tasks[0]?.text, "Show the active plan");
});

test("uses single in-progress ticket only with workflow intent", async () => {
  const dir = await workflowRepo(`
- id: metadata-002
  status: in_progress
  description: "Workflow-grounded session metadata"
  plan_file: agent-work/plans/metadata-002.md
`, `- [ ] Implement workflow context reader`);

  assert.equal(await readWorkflowContext({ cwd: dir, workflowIntent: false }), undefined);
  assert.equal((await readWorkflowContext({ cwd: dir, workflowIntent: true }))?.ticketId, "metadata-002");
});

test("does not guess among multiple in-progress tickets", async () => {
  const dir = await workflowRepo(`
- id: metadata-002
  status: in_progress
  description: "Workflow metadata"
- id: package-001
  status: in_progress
  description: "Package rename"
`, "");

  assert.equal(await readWorkflowContext({ cwd: dir, workflowIntent: true }), undefined);
});

test("returns every executable phased task in a structured snapshot", async () => {
  const dir = await workflowRepo(`
- id: metadata-002
  status: in_progress
  description: "Workflow metadata"
  plan_file: agent-work/plans/metadata-002.md
`, `
## Preparation
- [ ] Do not include background reading

### Phase 1: Define the contract
### Tests first
- [x] Confirm fields
### Smallest passing change
- [x] Document limits

### Phase 2: Empty section

### Stage 3 — Validate behavior
- [ ] Run integration checks
- [ ] Verify Unicode café 漢字

## Appendix
- [ ] Do not include appendix work
`);

  const snapshot = await readWorkflowSnapshot({ cwd: dir, ticketId: "metadata-002" });
  assert.deepEqual(snapshot?.plan, {
    sections: [
      {
        heading: "Phase 1 · Define the contract",
        tasks: [
          { done: true, text: "Confirm fields" },
          { done: true, text: "Document limits" },
        ],
      },
      {
        heading: "Stage 3 · Validate behavior",
        tasks: [
          { done: false, text: "Run integration checks" },
          { done: false, text: "Verify Unicode café 漢字" },
        ],
      },
    ],
    completed: 2,
    total: 4,
    currentSectionIndex: 1,
  });
  assert.equal(snapshot?.context.planProgress?.phaseIndex, 2);
  assert.doesNotMatch(formatWorkflowContext(snapshot?.context), /Confirm fields|Verify Unicode/);
});

test("returns one untitled section for a flat legacy checklist", async () => {
  const dir = await workflowRepo(`
- id: metadata-002
  status: in_progress
  description: "Workflow metadata"
  plan_file: agent-work/plans/metadata-002.md
`, `
# Plan
- [x] Add parser
- [ ] Build drawer
- [ ] Verify package
`);

  const snapshot = await readWorkflowSnapshot({ cwd: dir, ticketId: "metadata-002" });
  assert.deepEqual(snapshot?.plan, {
    sections: [{
      tasks: [
        { done: true, text: "Add parser" },
        { done: false, text: "Build drawer" },
        { done: false, text: "Verify package" },
      ],
    }],
    completed: 1,
    total: 3,
    currentSectionIndex: 0,
  });
  assert.equal(snapshot?.context.planProgress, undefined);
});

test("sanitizes snapshot tasks and excludes fenced examples", async () => {
  const longTask = `Ship ${"carefully ".repeat(30)}`;
  const dir = await workflowRepo(`
- id: metadata-002
  status: in_progress
  description: "Workflow metadata"
  plan_file: agent-work/plans/metadata-002.md
`, `
~~~~md
\`\`\`md
### Phase 9: Example
- [ ] Do not include this
\`\`\`
~~~~

### Phase 4: Real work
- [x] Finished task
- [ ] ${longTask}
`);

  const plan = (await readWorkflowSnapshot({ cwd: dir, ticketId: "metadata-002" }))?.plan;
  assert.equal(plan?.total, 2);
  assert.equal(plan?.sections[0]?.heading, "Phase 4 · Real work");
  assert.equal(plan?.sections[0]?.tasks[1]?.text.endsWith("…"), true);
  assert.equal(plan?.sections[0]?.tasks[1]?.text.length, 120);
  assert.equal((await readWorkflowContext({ cwd: dir, ticketId: "metadata-002" }))?.nextOpenTodo?.length, 120);
  assert.doesNotMatch(JSON.stringify(plan), /Do not include/);
});

test("keeps all-complete snapshots and omits unavailable or unsafe plans", async () => {
  const completeDir = await workflowRepo(`
- id: metadata-002
  status: in_progress
  plan_file: agent-work/plans/metadata-002.md
`, `
### Phase 1: Implement
- [x] Add parser
### Phase 2: Verify
- [x] Run tests
`);
  const complete = await readWorkflowSnapshot({ cwd: completeDir, ticketId: "metadata-002" });
  assert.deepEqual(complete?.plan && {
    completed: complete.plan.completed,
    total: complete.plan.total,
    currentSectionIndex: complete.plan.currentSectionIndex,
  }, { completed: 2, total: 2, currentSectionIndex: 1 });

  const missingDir = await workflowRepo(`
- id: metadata-002
  status: in_progress
  plan_file: agent-work/plans/missing.md
`, "");
  assert.equal((await readWorkflowSnapshot({ cwd: missingDir, ticketId: "metadata-002" }))?.plan, undefined);

  const unsafeDir = await workflowRepo(`
- id: metadata-002
  status: in_progress
  plan_file: ../outside.md
`, "");
  assert.equal((await readWorkflowSnapshot({ cwd: unsafeDir, ticketId: "metadata-002" }))?.plan, undefined);
});

test("reads current progress from phased plan checklists", async () => {
  const dir = await workflowRepo(`
- id: metadata-002
  status: in_progress
  description: "Workflow metadata"
  plan_file: agent-work/plans/metadata-002.md
`, `
## Implementation Phases

### Phase 1: Define the contract

- [x] Confirm the display fields
- [x] Define parser behavior

### Phase 2: Add plan display

- [x] Add parser tests
- [ ] Parse phase progress
- [ ] Render the plan widget
- [ ] Refresh after tool results

### Phase 3: Verify behavior

- [ ] Run the full test suite
`);

  const context = await readWorkflowContext({ cwd: dir, ticketId: "metadata-002" });
  assert.deepEqual(context?.planProgress, {
    phaseIndex: 2,
    phaseCount: 3,
    title: "Add plan display",
    completed: 1,
    total: 4,
  });
  assert.equal(context?.latestCompletedTodo, "Add parser tests");
  assert.equal(context?.nextOpenTodo, "Parse phase progress");
});

test("ignores phase examples inside fenced code blocks", async () => {
  const dir = await workflowRepo(`
- id: metadata-002
  status: in_progress
  description: "Workflow metadata"
  plan_file: agent-work/plans/metadata-002.md
`, `
\`\`\`\`md
\`\`\`md
### Phase 1: Example only
- [ ] Do not count this
\`\`\`
\`\`\`\`

### Phase 1: Implement
- [x] Add parser

### Phase 2: Verify
- [ ] Run tests
`);

  const context = await readWorkflowContext({ cwd: dir, ticketId: "metadata-002" });
  assert.deepEqual(context?.planProgress, {
    phaseIndex: 2,
    phaseCount: 2,
    title: "Verify",
    completed: 0,
    total: 1,
  });
  assert.equal(context?.nextOpenTodo, "Run tests");
});

test("accepts generic Stage headings and ignores checklists outside staged work", async () => {
  const dir = await workflowRepo(`
- id: metadata-002
  status: in_progress
  description: "Workflow metadata"
  plan_file: agent-work/plans/metadata-002.md
`, `
## Context checklist
- [ ] Optional background reading

### Stage 1 — Build
- [x] Implement parser

### Stage 2 — Validate
- [ ] Run integration checks
`);

  const context = await readWorkflowContext({ cwd: dir, ticketId: "metadata-002" });
  assert.deepEqual(context?.planProgress, {
    phaseIndex: 2,
    phaseCount: 2,
    title: "Validate",
    completed: 0,
    total: 1,
  });
  assert.equal(context?.latestCompletedTodo, "Implement parser");
  assert.equal(context?.nextOpenTodo, "Run integration checks");
});

test("reports the final phase when every phased task is complete", async () => {
  const dir = await workflowRepo(`
- id: metadata-002
  status: in_progress
  description: "Workflow metadata"
  plan_file: agent-work/plans/metadata-002.md
`, `
### Phase 1: Implement
- [x] Add parser

### Phase 2: Verify
- [x] Run tests
- [x] Check package
`);

  const context = await readWorkflowContext({ cwd: dir, ticketId: "metadata-002" });
  assert.deepEqual(context?.planProgress, {
    phaseIndex: 2,
    phaseCount: 2,
    title: "Verify",
    completed: 2,
    total: 2,
  });
  assert.equal(context?.nextOpenTodo, undefined);
});

test("uses first unchecked plan item when nothing is checked", async () => {
  const dir = await workflowRepo(`
- id: metadata-002
  status: pending
  description: "Workflow metadata"
  plan_file: agent-work/plans/metadata-002.md
`, `
- [ ] Add workflow parser tests
- [ ] Implement workflow context reader
`);

  assert.equal((await readWorkflowContext({ cwd: dir, ticketId: "metadata-002" }))?.nextOpenTodo, "Add workflow parser tests");
});

test("sanitizes context fields and rejects plan paths outside repo", async () => {
  const dir = await workflowRepo(`
- id: metadata-002
  status: pending
  description: "${"long ".repeat(40)}"
  plan_file: ../outside.md
`, "");

  const context = await readWorkflowContext({ cwd: dir, ticketId: "metadata-002" });
  assert.equal(context?.description?.endsWith("…"), true);
  assert.equal(context?.planFile, "../outside.md");
  assert.equal(context?.nextOpenTodo, undefined);
});

test("formats session names only for explicit workflow tickets", () => {
  assert.equal(workflowSessionName({
    ticketId: "metadata-002",
    title: "Compact metadata titles",
    description: "Workflow-grounded session metadata and titles for dashboard supervision",
    evidence: "explicit-ticket",
  }), "Compact metadata titles");
  assert.equal(workflowSessionName({
    ticketId: "metadata-002",
    description: "Workflow-grounded session metadata and titles for dashboard supervision",
    evidence: "explicit-ticket",
  }), "metadata-002: Workflow-grounded metadata");
  assert.equal(workflowSessionName({
    ticketId: "metadata-002",
    title: "Wrong inferred title",
    evidence: "single-in-progress",
  }), undefined);
  assert.equal(workflowSessionName({ description: "No ticket" }), undefined);
  assert.ok((workflowSessionName({ ticketId: "metadata-002", description: "x".repeat(200), evidence: "explicit-ticket" })?.length ?? 0) <= 80);
});

async function workflowRepo(features: string, plan: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-summary-workflow-"));
  await mkdir(join(dir, "agent-work", "plans"), { recursive: true });
  await writeFile(join(dir, "agent-work", "features.yaml"), features.trimStart(), "utf8");
  await writeFile(join(dir, "agent-work", "plans", "metadata-002.md"), plan, "utf8");
  return dir;
}
