import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tldrStatePath, writeTldrState } from "../src/state-output.js";

test("resolves Agent Hub state path", () => {
  assert.equal(tldrStatePath({ PI_AGENT_HUB_DIR: "/tmp/hub", PI_AGENT_HUB_SESSION_ID: "abc" }), "/tmp/hub/tldr/abc.json");
});

test("returns undefined when Hub env vars are absent", () => {
  assert.equal(tldrStatePath({ PI_AGENT_HUB_DIR: "/tmp/hub" }), undefined);
});

test("creates parent directory and writes latest state JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tldr-lite-"));
  const path = join(dir, "missing", "session.json");
  await writeTldrState({
    version: 1,
    source: "pi-tldr-lite",
    cwd: dir,
    state: "running",
    summary: "Planning semantic status output.",
    sequence: 1,
    updatedAt: 123,
  }, path);
  const parsed = JSON.parse(await readFile(path, "utf8")) as { summary: string };
  assert.equal(parsed.summary, "Planning semantic status output.");
  await rm(dir, { recursive: true, force: true });
});
