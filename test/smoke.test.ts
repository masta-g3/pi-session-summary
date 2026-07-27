import assert from "node:assert/strict";
import { mkdir, readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sessionSummary from "../src/index.js";

const EXTENSION_KEY = Symbol.for("pi-session-summary.extension.loaded");

function resetExtensionSingleton(): void {
  delete (globalThis as { [key: symbol]: unknown })[EXTENSION_KEY];
}

async function readJsonWhenReady(path: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function readJsonUntil(
  path: string,
  predicate: (value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  let latest: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 40; attempt++) {
    latest = await readJsonWhenReady(path);
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`metadata did not reach expected state: ${JSON.stringify(latest)}`);
}

test("exports a Pi extension factory", () => {
  assert.equal(typeof sessionSummary, "function");
});

test("registers only the session-summary command", () => {
  resetExtensionSingleton();
  const commands = new Map<string, { description: string; handler: unknown }>();
  const shortcuts = new Map<string, { description: string; handler: unknown }>();
  const events = new Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>();
  sessionSummary({
    registerCommand(name: string, command: { description: string; handler: unknown }) {
      commands.set(name, command);
    },
    registerShortcut(key: string, shortcut: { description: string; handler: unknown }) {
      shortcuts.set(key, shortcut);
    },
    on(name: string, handler: (event: unknown, ctx: unknown) => void) {
      events.set(name, handler);
    },
    getSessionName() {
      return undefined;
    },
  } as never);

  assert.equal(typeof commands.get("session-summary")?.handler, "function");
  assert.deepEqual([...commands.keys()], ["session-summary"]);
  assert.equal(typeof shortcuts.get("ctrl+alt+t")?.handler, "function");
  assert.ok(events.has("session_start"));

  events.get("session_shutdown")?.({}, { cwd: process.cwd(), hasUI: false } as never);
});

test("opens, refreshes, toggles, and cleans up the plan todo overlay", async () => {
  resetExtensionSingleton();
  const dir = await mkdtemp(join(tmpdir(), "pi-session-summary-todos-"));
  await mkdir(join(dir, "agent-work", "plans"), { recursive: true });
  await writeFile(join(dir, "agent-work", "features.yaml"), `
- id: metadata-005
  status: in_progress
  description: "Plan todo overlay"
  plan_file: agent-work/plans/metadata-005.md
`, "utf8");
  const planPath = join(dir, "agent-work", "plans", "metadata-005.md");
  await writeFile(planPath, `
### Phase 1: Implement
- [x] Parse tasks
### Phase 2: Verify
- [ ] Open the drawer
`, "utf8");

  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const shortcuts = new Map<string, { handler: (ctx: unknown) => Promise<void> }>();
  const events = new Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>();
  const notifications: string[] = [];
  const customCalls: Array<{ component: { render(width: number): string[]; handleInput?(data: string): void }; options: unknown }> = [];
  const ctx = {
    cwd: dir,
    hasUI: true,
    ui: {
      setWidget() {},
      notify(message: string) { notifications.push(message); },
      custom(factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => { render(width: number): string[]; handleInput?(data: string): void }, options: unknown) {
        return new Promise<void>((resolve) => {
          const component = factory(
            { terminal: { rows: 24 }, requestRender() {} },
            { fg: (_token: string, text: string) => text, bold: (text: string) => text, strikethrough: (text: string) => text },
            {},
            resolve,
          );
          customCalls.push({ component, options });
        });
      },
    },
    sessionManager: { getBranch: () => [] },
    modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: false }) },
  };

  try {
    sessionSummary({
      registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, command); },
      registerShortcut(key: string, shortcut: { handler: (ctx: unknown) => Promise<void> }) { shortcuts.set(key, shortcut); },
      on(name: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) { events.set(name, handler); },
      getSessionName() { return "Plan todo overlay"; },
    } as never);

    await events.get("session_start")?.({}, ctx as never);
    const command = commands.get("session-summary")?.handler;
    const shortcut = shortcuts.get("ctrl+alt+t")?.handler;
    assert.ok(command && shortcut);

    const firstOpen = command("todos", ctx);
    events.get("tool_execution_end")?.({ name: "read", result: "concurrent lifecycle refresh" }, ctx as never);
    for (let attempt = 0; attempt < 20 && customCalls.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(customCalls.length, 1);
    assert.deepEqual(customCalls[0]?.options, {
      overlay: true,
      overlayOptions: { anchor: "right-center", width: 54, minWidth: 36, maxHeight: "80%", margin: { right: 1 } },
    });
    assert.match(customCalls[0]?.component.render(54).join("\n") ?? "", /Open the drawer/);
    customCalls[0]?.component.handleInput?.("\x1b\x14");
    await firstOpen;

    await writeFile(planPath, `
### Phase 1: Implement
- [x] Parse tasks
### Phase 2: Verify
- [x] Open the drawer
- [ ] Confirm fresh content
`, "utf8");
    const secondOpen = shortcut(ctx);
    for (let attempt = 0; attempt < 20 && customCalls.length < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.match(customCalls[1]?.component.render(54).join("\n") ?? "", /Confirm fresh content/);

    const duplicateToggle = command("todos", ctx);
    await Promise.all([secondOpen, duplicateToggle]);
    assert.equal(customCalls.length, 2);

    const thirdOpen = command("todos", ctx);
    for (let attempt = 0; attempt < 20 && customCalls.length < 3; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    const disable = command("off", ctx);
    await Promise.all([thirdOpen, disable]);
    assert.equal(customCalls.length, 3);

    await command("on", ctx);
    const fourthOpen = command("todos", ctx);
    for (let attempt = 0; attempt < 20 && customCalls.length < 4; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    await events.get("session_shutdown")?.({}, ctx as never);
    await fourthOpen;
    assert.equal(customCalls.length, 4);
    assert.equal(notifications.some((message) => message.includes("disabled")), true);
  } finally {
    resetExtensionSingleton();
    await rm(dir, { recursive: true, force: true });
  }
});

test("does not open an empty, ambiguous, or non-UI todo overlay", async () => {
  resetExtensionSingleton();
  const dir = await mkdtemp(join(tmpdir(), "pi-session-summary-no-todos-"));
  await mkdir(join(dir, "agent-work", "plans"), { recursive: true });
  await writeFile(join(dir, "agent-work", "features.yaml"), `
- id: metadata-005
  status: in_progress
  plan_file: agent-work/plans/metadata-005.md
- id: package-001
  status: in_progress
`, "utf8");
  await writeFile(join(dir, "agent-work", "plans", "metadata-005.md"), "# No checklist\n", "utf8");

  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const events = new Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>();
  let customCalls = 0;
  const notifications: string[] = [];
  const ctx = {
    cwd: dir,
    hasUI: true,
    ui: { setWidget() {}, notify(message: string) { notifications.push(message); }, custom() { customCalls += 1; } },
    sessionManager: { getBranch: () => [] },
    modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: false }) },
  };
  try {
    sessionSummary({
      registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, command); },
      registerShortcut() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) { events.set(name, handler); },
      getSessionName() { return "No todos"; },
    } as never);
    await events.get("session_start")?.({}, ctx as never);
    const command = commands.get("session-summary")?.handler;
    assert.ok(command);
    await command("todos", ctx);
    await writeFile(join(dir, "agent-work", "features.yaml"), `
- id: metadata-005
  status: in_progress
  plan_file: agent-work/plans/metadata-005.md
`, "utf8");
    await command("todos", ctx);
    await command("todos", { ...ctx, hasUI: false, ui: { custom() { throw new Error("must not open"); } } });
    assert.equal(customCalls, 0);
    assert.ok(notifications.some((message) => message.includes("No active plan todo list")));
  } finally {
    await events.get("session_shutdown")?.({}, ctx as never);
    resetExtensionSingleton();
    await rm(dir, { recursive: true, force: true });
  }
});

test("does not rename a session from inferred workflow context", async () => {
  resetExtensionSingleton();
  const dir = await mkdtemp(join(tmpdir(), "pi-session-summary-inferred-name-"));
  await mkdir(join(dir, "agent-work"), { recursive: true });
  await writeFile(join(dir, "agent-work", "features.yaml"), `
- id: workflow-board-001
  status: in_progress
  title: "Wrong inferred title"
`, "utf8");

  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const events = new Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>();
  let name = "Fix Dashboard Panel Rename Overflow";
  const ctx = {
    cwd: dir,
    hasUI: true,
    ui: { setWidget() {}, notify() {} },
    sessionManager: {
      getBranch: () => [{ type: "message", message: { role: "user", content: "Fix dashboard panel rename overflow" } }],
    },
    modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: false }) },
  };

  try {
    sessionSummary({
      registerCommand(commandName: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(commandName, command); },
      registerShortcut() {},
      on(eventName: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) { events.set(eventName, handler); },
      getSessionName() { return name; },
      setSessionName(next: string) { name = next; },
    } as never);

    events.get("session_start")?.({}, ctx as never);
    events.get("before_agent_start")?.({ prompt: "review this unrelated fix" }, ctx as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await commands.get("session-summary")?.handler("name", ctx);
    assert.equal(name, "Fix Dashboard Panel Rename Overflow");
  } finally {
    await events.get("session_shutdown")?.({}, ctx as never);
    resetExtensionSingleton();
    await rm(dir, { recursive: true, force: true });
  }
});

test("auto-names unnamed workflow sessions with deterministic ticket title", async () => {
  resetExtensionSingleton();
  const dir = await mkdtemp(join(tmpdir(), "pi-session-summary-name-"));
  await mkdir(join(dir, "agent-work", "plans"), { recursive: true });
  await writeFile(join(dir, "agent-work", "features.yaml"), `
- id: metadata-002
  status: in_progress
  title: "Compact metadata titles"
  description: "Workflow-grounded session metadata and titles for dashboard supervision"
  plan_file: agent-work/plans/metadata-002.md
`, "utf8");
  await writeFile(join(dir, "agent-work", "plans", "metadata-002.md"), "- [ ] Wire context into summarizer prompt\n", "utf8");

  const events = new Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>();
  let name: string | undefined;
  const notifications: string[] = [];
  const ctx = {
    cwd: dir,
    hasUI: true,
    ui: { setWidget() {}, notify(message: string) { notifications.push(message); } },
    sessionManager: { getBranch: () => [] },
    modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: false }) },
  };
  try {
    sessionSummary({
      registerCommand() {},
      registerShortcut() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => void) { events.set(name, handler); },
      getSessionName() { return name; },
      setSessionName(next: string) { name = next; },
    } as never);

    events.get("session_start")?.({}, ctx as never);
    events.get("before_agent_start")?.({ prompt: "execute metadata-002" }, ctx as never);
    for (let attempt = 0; attempt < 20 && (!name || !notifications.some((item) => item.includes("Session named:"))); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(name, "Compact metadata titles");
    assert.ok(notifications.some((item) => item.includes("Session named:")));
  } finally {
    await events.get("session_shutdown")?.({}, ctx as never);
    resetExtensionSingleton();
    await rm(dir, { recursive: true, force: true });
  }
});

test("shows phased plan progress without a summary model", async () => {
  resetExtensionSingleton();
  const dir = await mkdtemp(join(tmpdir(), "pi-session-summary-plan-"));
  await mkdir(join(dir, "agent-work", "plans"), { recursive: true });
  await writeFile(join(dir, "agent-work", "features.yaml"), `
- id: metadata-002
  status: in_progress
  description: "Workflow plan display"
  plan_file: agent-work/plans/metadata-002.md
`, "utf8");
  await writeFile(join(dir, "agent-work", "plans", "metadata-002.md"), `
### Phase 1: Parse progress
- [x] Add parser tests

### Phase 2: Render plan widget
- [x] Add status fallback
- [ ] Show phase progress
- [ ] Refresh after tools
- [ ] Verify behavior
`, "utf8");

  const events = new Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>();
  const widgets = new Map<string, unknown>();
  const ctx = {
    cwd: dir,
    hasUI: true,
    ui: {
      setWidget(key: string, widget: unknown) { widgets.set(key, widget); },
      notify() {},
    },
    sessionManager: { getBranch: () => [] },
    modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: false }) },
  };
  try {
    sessionSummary({
      registerCommand() {},
      registerShortcut() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => void) { events.set(name, handler); },
      getSessionName() { return "Workflow plan display"; },
    } as never);

    events.get("session_start")?.({}, ctx as never);
    events.get("before_agent_start")?.({ prompt: "work on the current task" }, ctx as never);
    events.get("tool_execution_start")?.({ name: "set_workflow_ticket", args: { ticketId: "metadata-002" } }, ctx as never);
    events.get("tool_execution_end")?.({ name: "set_workflow_ticket", result: "Workflow ticket set to metadata-002" }, ctx as never);
    for (let attempt = 0; attempt < 20 && typeof widgets.get("pi-session-summary") !== "function"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const factory = widgets.get("pi-session-summary") as ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
    assert.equal(typeof factory, "function");
    const component = factory?.(undefined, { fg: (_token: string, text: string) => text });
    const rendered = component?.render(60).join("\n") ?? "";
    assert.match(rendered, /Phase 2\/2 · Render plan widget/);
    assert.match(rendered, /✓ 1\/4 tasks · Next: Show phase progress/);

    await writeFile(join(dir, "agent-work", "plans", "metadata-002.md"), `
### Phase 1: Parse progress
- [x] Add parser tests

### Phase 2: Render plan widget
- [x] Add status fallback
- [x] Show phase progress
- [ ] Refresh after tools
- [ ] Verify behavior
`, "utf8");
    events.get("tool_execution_end")?.({ name: "edit", result: "updated plan" }, ctx as never);
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const refreshedFactory = widgets.get("pi-session-summary") as ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
      const refreshed = refreshedFactory?.(undefined, { fg: (_token: string, text: string) => text }).render(60).join("\n") ?? "";
      if (/✓ 2\/4 tasks · Next: Refresh after tools/.test(refreshed)) break;
      if (attempt === 19) assert.fail(`plan widget did not refresh:\n${refreshed}`);
    }

    await writeFile(join(dir, "agent-work", "plans", "metadata-002.md"), "- [ ] Continue with a flat legacy checklist\n", "utf8");
    events.get("tool_execution_end")?.({ name: "edit", result: "removed phased plan" }, ctx as never);
    for (let attempt = 0; attempt < 20 && widgets.get("pi-session-summary") !== undefined; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(widgets.get("pi-session-summary"), undefined);
  } finally {
    await events.get("session_shutdown")?.({}, ctx as never);
    resetExtensionSingleton();
    await rm(dir, { recursive: true, force: true });
  }
});

test("publishes, refreshes, and clears deterministic plan metadata without a model", async () => {
  resetExtensionSingleton();
  const dir = await mkdtemp(join(tmpdir(), "pi-session-summary-plan-metadata-"));
  await mkdir(join(dir, "agent-work", "plans"), { recursive: true });
  const featuresPath = join(dir, "agent-work", "features.yaml");
  const planPath = join(dir, "agent-work", "plans", "workflow-board-001.md");
  await writeFile(featuresPath, `
- id: workflow-board-001
  status: in_progress
  title: "Rich workflow board"
  description: "Replace stages with a responsive workflow board."
  plan_file: agent-work/plans/workflow-board-001.md
`, "utf8");
  await writeFile(planPath, `
### Phase 1: Parse the plan
- [x] Read the workflow snapshot

### Phase 2: Publish plan metadata
- [x] Add producer types
- [ ] Refresh after checklist edits
- [ ] Verify clearing behavior
`, "utf8");

  const previousHubDir = process.env.PI_AGENT_HUB_DIR;
  const previousSessionId = process.env.PI_AGENT_HUB_SESSION_ID;
  process.env.PI_AGENT_HUB_DIR = dir;
  process.env.PI_AGENT_HUB_SESSION_ID = "plan-metadata";
  const events = new Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>();
  const ctx = {
    cwd: dir,
    hasUI: false,
    sessionManager: { getBranch: () => [] },
    modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: false }) },
  };

  try {
    sessionSummary({
      registerCommand() {},
      registerShortcut() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) { events.set(name, handler); },
      getSessionName() { return "Workflow board"; },
    } as never);

    await events.get("session_start")?.({}, ctx as never);
    events.get("before_agent_start")?.({ prompt: "execute workflow-board-001" }, ctx as never);
    const statePath = join(dir, "session-metadata", "plan-metadata.json");
    let parsed = await readJsonUntil(statePath, (value) => (value.plan as { tasks?: { completed?: number } } | undefined)?.tasks?.completed === 2);
    assert.deepEqual(parsed.plan, {
      feature: "Rich workflow board",
      phase: { title: "Publish plan metadata", index: 2, count: 2 },
      tasks: { completed: 2, total: 4 },
      phases: [{ completed: 1, total: 1 }, { completed: 1, total: 3 }],
      nextStep: "Refresh after checklist edits",
    });
    assert.equal("goal" in parsed, false);

    events.get("before_agent_start")?.({ prompt: "why do progress labels disappear while this agent runs?" }, ctx as never);
    await new Promise((resolve) => setTimeout(resolve, 30));
    parsed = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(parsed.plan, {
      feature: "Rich workflow board",
      phase: { title: "Publish plan metadata", index: 2, count: 2 },
      tasks: { completed: 2, total: 4 },
      phases: [{ completed: 1, total: 1 }, { completed: 1, total: 3 }],
      nextStep: "Refresh after checklist edits",
    });

    await writeFile(planPath, `
### Phase 1: Parse the plan
- [x] Read the workflow snapshot
- [x] Record the phase snapshot

### Phase 2: Publish plan metadata
- [x] Add producer types
- [ ] Refresh after checklist edits
- [ ] Verify clearing behavior
`, "utf8");
    events.get("tool_execution_end")?.({ name: "edit", result: "updated an earlier phase" }, ctx as never);
    parsed = await readJsonUntil(statePath, (value) => (value.plan as { phases?: Array<{ completed?: number }> } | undefined)?.phases?.[0]?.completed === 2);
    assert.deepEqual(parsed.plan, {
      feature: "Rich workflow board",
      phase: { title: "Publish plan metadata", index: 2, count: 2 },
      tasks: { completed: 3, total: 5 },
      phases: [{ completed: 2, total: 2 }, { completed: 1, total: 3 }],
      nextStep: "Refresh after checklist edits",
    });

    await writeFile(planPath, `
### Phase 1: Parse the plan
- [x] Read the workflow snapshot
- [x] Record the phase snapshot

### Phase 2: Publish plan metadata
- [x] Add producer types
- [x] Refresh after checklist edits
- [ ] Verify clearing behavior
`, "utf8");
    events.get("tool_execution_end")?.({ name: "edit", result: "updated checklist" }, ctx as never);
    parsed = await readJsonUntil(statePath, (value) => (value.plan as { phases?: Array<{ completed?: number }> } | undefined)?.phases?.[1]?.completed === 2);
    assert.deepEqual(parsed.plan, {
      feature: "Rich workflow board",
      phase: { title: "Publish plan metadata", index: 2, count: 2 },
      tasks: { completed: 4, total: 5 },
      phases: [{ completed: 2, total: 2 }, { completed: 2, total: 3 }],
      nextStep: "Verify clearing behavior",
    });

    await writeFile(planPath, "- [x] Publish metadata\n- [ ] Verify flat checklist output\n", "utf8");
    events.get("tool_execution_end")?.({ name: "edit", result: "flattened checklist" }, ctx as never);
    parsed = await readJsonUntil(statePath, (value) => (value.plan as { nextStep?: string } | undefined)?.nextStep === "Verify flat checklist output");
    assert.deepEqual(parsed.plan, {
      feature: "Rich workflow board",
      tasks: { completed: 1, total: 2 },
      phases: [{ completed: 1, total: 2 }],
      nextStep: "Verify flat checklist output",
    });

    await writeFile(featuresPath, "- id: other-001\n  status: in_progress\n", "utf8");
    events.get("tool_execution_end")?.({ name: "edit", result: "removed active ticket" }, ctx as never);
    parsed = await readJsonUntil(statePath, (value) => !("plan" in value));
    assert.equal("plan" in parsed, false);
  } finally {
    await events.get("session_shutdown")?.({}, ctx as never);
    if (previousHubDir === undefined) delete process.env.PI_AGENT_HUB_DIR;
    else process.env.PI_AGENT_HUB_DIR = previousHubDir;
    if (previousSessionId === undefined) delete process.env.PI_AGENT_HUB_SESSION_ID;
    else process.env.PI_AGENT_HUB_SESSION_ID = previousSessionId;
    resetExtensionSingleton();
    await rm(dir, { recursive: true, force: true });
  }
});

test("writes generic Hub metadata file without ignored display fields", async () => {
  resetExtensionSingleton();
  const dir = await mkdtemp(join(tmpdir(), "pi-session-summary-smoke-"));
  const previousHubDir = process.env.PI_AGENT_HUB_DIR;
  const previousSessionId = process.env.PI_AGENT_HUB_SESSION_ID;
  process.env.PI_AGENT_HUB_DIR = dir;
  process.env.PI_AGENT_HUB_SESSION_ID = "runtime-metadata";

  const events = new Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>();
  const ctx = { cwd: process.cwd(), hasUI: false };
  try {
    sessionSummary({
      registerCommand() {},
      registerShortcut() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => void) {
        events.set(name, handler);
      },
      getSessionName() {
        return "Metadata Dashboard";
      },
    } as never);

    events.get("session_start")?.({}, ctx as never);
    const statePath = join(dir, "session-metadata", "runtime-metadata.json");
    const parsed = await readJsonWhenReady(statePath);
    assert.equal(parsed.source, "pi-session-summary");
    assert.equal(typeof parsed.updatedAt, "number");
    assert.equal("version" in parsed, false);
    assert.equal("sessionName" in parsed, false);
    assert.equal("model" in parsed, false);
    assert.equal("generatedAt" in parsed, false);

    await events.get("session_shutdown")?.({}, ctx as never);
  } finally {
    if (previousHubDir === undefined) delete process.env.PI_AGENT_HUB_DIR;
    else process.env.PI_AGENT_HUB_DIR = previousHubDir;
    if (previousSessionId === undefined) delete process.env.PI_AGENT_HUB_SESSION_ID;
    else process.env.PI_AGENT_HUB_SESSION_ID = previousSessionId;
    resetExtensionSingleton();
    await rm(dir, { recursive: true, force: true });
  }
});
