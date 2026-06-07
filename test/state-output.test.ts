import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sessionSummaryStatePath, writeSessionSummaryState } from "../src/state-output.js";

test("resolves Agent Hub state path", () => {
  assert.equal(sessionSummaryStatePath({ PI_AGENT_HUB_DIR: "/tmp/hub", PI_AGENT_HUB_SESSION_ID: "abc" }), "/tmp/hub/session-summary/abc.json");
});

test("returns undefined when Hub env vars are absent", () => {
  assert.equal(sessionSummaryStatePath({ PI_AGENT_HUB_DIR: "/tmp/hub" }), undefined);
});

test("creates parent directory and writes latest v2 state JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-session-summary-"));
  const path = join(dir, "missing", "session.json");
  await writeSessionSummaryState({
    version: 2,
    source: "pi-session-summary",
    cwd: dir,
    state: "running",
    sessionName: "Metadata Schema",
    goal: "Define dashboard metadata.",
    status: "Planning semantic status output.",
    stage: "planning",
    nextStep: "Implement parser tests.",
    sequence: 1,
    updatedAt: 123,
  }, path);
  const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assert.equal(parsed.version, 2);
  assert.equal(parsed.status, "Planning semantic status output.");
  assert.equal(parsed.source, "pi-session-summary");
  assert.equal("summary" in parsed, false);
  assert.equal("phase" in parsed, false);
  assert.equal("nextAction" in parsed, false);
  await rm(dir, { recursive: true, force: true });
});
