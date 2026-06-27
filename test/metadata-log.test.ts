import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendSessionMetadataLog, metadataLogEntry, sessionMetadataLogPath, type SessionMetadataLogEntry } from "../src/metadata-log.js";
import type { SessionMetadataUpdate } from "../src/summarizer.js";

test("resolves metadata history path only when debug env is enabled", () => {
  assert.equal(
    sessionMetadataLogPath({
      PI_SESSION_SUMMARY_METADATA_HISTORY: "1",
      PI_AGENT_HUB_DIR: "/tmp/hub",
      PI_AGENT_HUB_SESSION_ID: "abc/123",
    }),
    "/tmp/hub/session-metadata-history/abc_123.jsonl",
  );

  assert.equal(sessionMetadataLogPath({ PI_AGENT_HUB_DIR: "/tmp/hub", PI_AGENT_HUB_SESSION_ID: "abc" }), undefined);
  assert.equal(sessionMetadataLogPath({ PI_SESSION_SUMMARY_METADATA_HISTORY: "true", PI_AGENT_HUB_DIR: "/tmp/hub", PI_AGENT_HUB_SESSION_ID: "abc" }), undefined);
  assert.equal(sessionMetadataLogPath({ PI_SESSION_SUMMARY_METADATA_HISTORY: "1", PI_AGENT_HUB_SESSION_ID: "abc" }), undefined);
  assert.equal(sessionMetadataLogPath({ PI_SESSION_SUMMARY_METADATA_HISTORY: "1", PI_AGENT_HUB_DIR: "/tmp/hub" }), undefined);
});

test("appends metadata derivation JSONL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-session-summary-log-"));
  const path = join(dir, "history", "session.jsonl");

  await appendSessionMetadataLog(sampleEntry(1), path);
  await appendSessionMetadataLog(sampleEntry(2), path);

  const lines = (await readFile(path, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]!).activitySequence, 1);
  assert.equal(JSON.parse(lines[1]!).activitySequence, 2);
});

test("metadata log append is a no-op without a path", async () => {
  await appendSessionMetadataLog(sampleEntry(1), undefined);
});

test("builds metadata log entries from session metadata updates", () => {
  assert.deepEqual(metadataLogEntry("session/raw", {
    goal: "Debug metadata history",
    status: "Helper tests written",
    nextStep: "Wire runtime append",
    stage: "editing",
    confidence: 0,
    model: "openai-codex/gpt-5.4-mini",
    generatedAt: 123,
    sequence: 7,
  } satisfies SessionMetadataUpdate), {
    source: "pi-session-summary",
    sessionId: "session/raw",
    generatedAt: 123,
    activitySequence: 7,
    model: "openai-codex/gpt-5.4-mini",
    metadata: {
      goal: "Debug metadata history",
      status: "Helper tests written",
      nextStep: "Wire runtime append",
      stage: "editing",
      confidence: 0,
    },
  });

  assert.equal("nextStep" in metadataLogEntry("session", {
    goal: "Debug metadata history",
    status: "Helper tests written",
    stage: "editing",
    model: "openai-codex/gpt-5.4-mini",
    generatedAt: 123,
    sequence: 7,
  }).metadata, false);
});

function sampleEntry(activitySequence: number): SessionMetadataLogEntry {
  return {
    source: "pi-session-summary",
    sessionId: "session/raw",
    generatedAt: 123,
    activitySequence,
    model: "openai-codex/gpt-5.4-mini",
    metadata: {
      goal: "Debug metadata history",
      status: "Helper tests written",
      stage: "editing",
      confidence: 0.8,
    },
  };
}
