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
  const events = new Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>();
  sessionSummary({
    registerCommand(name: string, command: { description: string; handler: unknown }) {
      commands.set(name, command);
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
  assert.ok(events.has("session_start"));

  events.get("session_shutdown")?.({}, { cwd: process.cwd(), hasUI: false } as never);
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
