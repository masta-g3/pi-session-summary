import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extractTicketId, hasWorkflowIntent, readWorkflowContext, workflowSessionName } from "../src/workflow.js";

test("extracts ticket ids from prompt text", () => {
  assert.equal(extractTicketId("please execute Metadata-002 now"), "metadata-002");
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
    description: "Workflow-grounded session metadata and titles for dashboard supervision",
    planFile: "agent-work/plans/metadata-002.md",
    latestCompletedTodo: "Implement workflow context reader",
    nextOpenTodo: "Wire context into summarizer prompt",
    evidence: "explicit-ticket",
  });
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

test("formats deterministic workflow session names", () => {
  assert.equal(workflowSessionName({
    ticketId: "metadata-002",
    description: "Workflow-grounded session metadata and titles for dashboard supervision",
  }), "metadata-002: Workflow-grounded metadata");
  assert.equal(workflowSessionName({ description: "No ticket" }), undefined);
  assert.ok((workflowSessionName({ ticketId: "metadata-002", description: "x".repeat(200) })?.length ?? 0) <= 80);
});

async function workflowRepo(features: string, plan: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-summary-workflow-"));
  await mkdir(join(dir, "agent-work", "plans"), { recursive: true });
  await writeFile(join(dir, "agent-work", "features.yaml"), features.trimStart(), "utf8");
  await writeFile(join(dir, "agent-work", "plans", "metadata-002.md"), plan, "utf8");
  return dir;
}
