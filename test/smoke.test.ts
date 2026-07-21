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

test("auto-names unnamed workflow sessions with deterministic ticket title", async () => {
  resetExtensionSingleton();
  const dir = await mkdtemp(join(tmpdir(), "pi-session-summary-name-"));
  await mkdir(join(dir, "agent-work", "plans"), { recursive: true });
  await writeFile(join(dir, "agent-work", "features.yaml"), `
- id: metadata-002
  status: in_progress
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
    for (let attempt = 0; attempt < 20 && !name; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(name, "metadata-002: Workflow-grounded metadata");
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
