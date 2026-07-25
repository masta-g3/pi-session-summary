import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  evaluateMetadataHistory,
  formatMetadataQualityReport,
  groupMetadataEntriesByTurn,
  parseMetadataHistoryJsonl,
  runMetadataQualityCli,
  type MetadataQualityCategory,
} from "../src/metadata-quality.js";
import type { SessionMetadataLogEntry } from "../src/metadata-log.js";

const CUSTOM_CATEGORIES: MetadataQualityCategory[] = [
  { field: "goal", id: "goal stability" },
  { field: "status", id: "status freshness" },
  { field: "nextStep", id: "next action evidence" },
  { field: "stage", id: "stage fit" },
  { field: "attention", id: "attention evidence" },
  { field: "privacy", id: "privacy leakage" },
  { field: "turn", id: "turn grouping" },
];

test("parses metadata history JSONL with line-numbered errors", () => {
  const parsed = parseMetadataHistoryJsonl(`${JSON.stringify(entry({ activitySequence: 1 }))}\n\n${JSON.stringify(entry({ activitySequence: 2 }))}\n`);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1]?.activitySequence, 2);

  assert.throws(
    () => parseMetadataHistoryJsonl(`${JSON.stringify(entry())}\nnot-json\n`),
    /line 2/,
  );
  assert.throws(
    () => parseMetadataHistoryJsonl("null\n"),
    /line 1: entry must be an object/,
  );
});

test("groups metadata entries by optional user turn", () => {
  const groups = groupMetadataEntriesByTurn([
    entry({ userTurn: 1, activitySequence: 1 }),
    entry({ userTurn: 1, activitySequence: 2 }),
    entry({ userTurn: 2, activitySequence: 3 }),
    entry({ activitySequence: 4 }),
  ]);

  assert.deepEqual(groups.map((group) => group.userTurn), [1, 2, "unknown"]);
  assert.deepEqual(groups.map((group) => group.entryIndexes), [[0, 1], [2], [3]]);
});

test("scores final entries per turn without penalizing transient in-progress entries", () => {
  const report = evaluateMetadataHistory([
    entry({ userTurn: 1, activitySequence: 1, stage: "reading", status: "Inspecting README" }),
    entry({ userTurn: 1, activitySequence: 2, stage: "complete", status: "README metadata behavior explained" }),
    entry({ userTurn: 2, activitySequence: 3, stage: "reading", status: "README metadata behavior explained" }),
    entry({ userTurn: 2, activitySequence: 4, stage: "testing", status: "Tests passed" }),
  ]);

  assert.equal(report.turnCount, 2);
  assert.equal(report.turns[0]?.finalEntryIndex, 1);
  assert.equal(report.turns[1]?.finalEntryIndex, 3);
  assert.deepEqual(report.issues, []);
});

test("detects privacy markers in derived metadata only", () => {
  const report = evaluateMetadataHistory([
    entry({ status: "Latest activity, newest last: raw prompt leaked" }),
    entry({ status: "Leaked tool payload {\"args\":{\"path\":\"x\"},\"command\":\"npm test\"}" }),
  ]);

  assert.ok(report.issues.every((issue) => issue.field === "privacy"));
  assert.ok(report.issues.every((issue) => issue.severity === "fail"));
  assert.ok(report.issues.some((issue) => issue.message.includes("Latest activity")));
  assert.ok(report.issues.some((issue) => issue.message.includes("\"args\"")));
  assert.ok(report.issues.some((issue) => issue.message.includes("\"command\":\"")));
});

test("uses freeform quality categories in report output", () => {
  const report = evaluateMetadataHistory([
    entry({ stage: "editing", nextStep: "" }),
  ], { categories: CUSTOM_CATEGORIES });
  const output = formatMetadataQualityReport(report);

  assert.match(output, /Categories: goal stability, status freshness, next action evidence, stage fit, attention evidence, privacy leakage, turn grouping/);
  assert.match(output, /next action evidence: final in-progress entry has no evidenced nextStep/);
});

test("flags invalid attention claims in sampled metadata", () => {
  const mismatch = entry({ stage: "waiting" });
  mismatch.metadata.attention = { kind: "ready", text: "Ready for review" };
  const uncertain = entry({ stage: "complete", confidence: 0.4 });
  uncertain.metadata.attention = { kind: "ready", text: "Ready for review" };

  const report = evaluateMetadataHistory([mismatch, uncertain]);

  assert.ok(report.issues.some((issue) => issue.field === "attention" && issue.message.includes("does not match stage")));
  assert.ok(report.issues.some((issue) => issue.field === "attention" && issue.message.includes("confidence")));
});

test("warns on final-state quality problems", () => {
  const report = evaluateMetadataHistory([
    entry({ userTurn: 1, stage: "reading", status: "Tests passed", nextStep: "" }),
    entry({ userTurn: 2, stage: "editing", status: "Update metadata quality evaluator", nextStep: "Update metadata quality evaluator" }),
  ]);

  assert.ok(report.issues.some((issue) => issue.field === "stage" && issue.message.includes("still reading")));
  assert.ok(report.issues.some((issue) => issue.field === "nextStep" && issue.message.includes("repeats status")));
});

test("CLI evaluates a metadata history JSONL file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-session-summary-quality-"));
  const path = join(dir, "history.jsonl");
  await writeFile(path, `${JSON.stringify(entry({ userTurn: 1 }))}\n`, "utf8");

  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    assert.equal(await runMetadataQualityCli([path]), 0);
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.match(output, /Metadata quality: 1 entries, 1 turns/);
});

function entry(overrides: Partial<SessionMetadataLogEntry & SessionMetadataLogEntry["metadata"]> = {}): SessionMetadataLogEntry {
  const metadata = {
    goal: overrides.goal ?? "Improve metadata quality",
    status: overrides.status ?? "Evaluator tests passing",
    stage: overrides.stage ?? "complete",
    ...(overrides.nextStep !== undefined && overrides.nextStep !== "" ? { nextStep: overrides.nextStep } : {}),
    ...(overrides.confidence !== undefined ? { confidence: overrides.confidence } : {}),
  };
  return {
    source: overrides.source ?? "pi-session-summary",
    sessionId: overrides.sessionId ?? "session/raw",
    generatedAt: overrides.generatedAt ?? 123,
    activitySequence: overrides.activitySequence ?? 1,
    ...(overrides.userTurn !== undefined ? { userTurn: overrides.userTurn } : {}),
    model: overrides.model ?? "openai-codex/gpt-5.4-mini",
    metadata,
  };
}
