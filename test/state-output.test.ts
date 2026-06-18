import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sessionMetadataPath, writeSessionMetadata } from "../src/state-output.js";

test("resolves generic Agent Hub metadata path", () => {
  assert.equal(sessionMetadataPath({ PI_AGENT_HUB_DIR: "/tmp/hub", PI_AGENT_HUB_SESSION_ID: "abc" }), "/tmp/hub/session-metadata/abc.json");
});

test("returns undefined when Hub env vars are absent", () => {
  assert.equal(sessionMetadataPath({ PI_AGENT_HUB_DIR: "/tmp/hub" }), undefined);
});

test("creates parent directory and writes generic Hub metadata JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-session-summary-"));
  const path = join(dir, "missing", "session.json");
  await writeSessionMetadata({
    source: "pi-session-summary",
    goal: "Define dashboard metadata.",
    status: "Planning semantic status output.",
    stage: "reading",
    nextStep: "Implement parser tests.",
    confidence: 0.86,
    updatedAt: 123,
  }, path);
  const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assert.equal(parsed.status, "Planning semantic status output.");
  assert.equal(parsed.source, "pi-session-summary");
  assert.equal("version" in parsed, false);
  assert.equal("sessionName" in parsed, false);
  assert.equal("model" in parsed, false);
  assert.equal("generatedAt" in parsed, false);
  await rm(dir, { recursive: true, force: true });
});
