import assert from "node:assert/strict";
import { readFile, rm, mkdtemp } from "node:fs/promises";
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
