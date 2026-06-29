import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { SessionMetadataLogEntry } from "./metadata-log.js";
import { SUMMARY_STAGES, type SummaryStage } from "./text.js";

export type MetadataQualityField = "goal" | "status" | "nextStep" | "stage" | "privacy" | "turn";

export interface MetadataQualityCategory {
  id: string;
  field: MetadataQualityField;
  description?: string;
}

export interface MetadataQualityIssue {
  severity: "info" | "warn" | "fail";
  category: string;
  field?: MetadataQualityField;
  message: string;
  entryIndex: number;
  userTurn?: number;
}

export interface MetadataTurnGroup {
  userTurn: number | "unknown";
  entries: SessionMetadataLogEntry[];
  entryIndexes: number[];
}

export interface MetadataTurnScore {
  userTurn: number | "unknown";
  entryCount: number;
  finalEntryIndex: number;
  issues: MetadataQualityIssue[];
}

export interface MetadataQualityReport {
  entryCount: number;
  turnCount: number;
  categories: MetadataQualityCategory[];
  turns: MetadataTurnScore[];
  issues: MetadataQualityIssue[];
}

const PRIVACY_MARKERS = [
  "\"args\"",
  "\"tool_calls\"",
  "\"tool_use\"",
  "\"command\":\"",
  "Latest activity, newest last:",
  "Workflow context from repo files",
];

export function defaultMetadataQualityCategories(): MetadataQualityCategory[] {
  return [
    { id: "goal", field: "goal" },
    { id: "status", field: "status" },
    { id: "nextStep", field: "nextStep" },
    { id: "stage", field: "stage" },
    { id: "privacy", field: "privacy" },
    { id: "turn", field: "turn" },
  ];
}

export function parseMetadataHistoryJsonl(text: string): SessionMetadataLogEntry[] {
  const entries: SessionMetadataLogEntry[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("entry must be an object");
      entries.push(parsed as SessionMetadataLogEntry);
    } catch (error) {
      throw new Error(`Invalid metadata history JSONL at line ${index + 1}: ${(error as Error).message}`);
    }
  }
  return entries;
}

export function groupMetadataEntriesByTurn(entries: readonly SessionMetadataLogEntry[]): MetadataTurnGroup[] {
  const groups = new Map<number | "unknown", MetadataTurnGroup>();
  entries.forEach((entry, index) => {
    const userTurn = typeof entry.userTurn === "number" ? entry.userTurn : "unknown";
    let group = groups.get(userTurn);
    if (!group) {
      group = { userTurn, entries: [], entryIndexes: [] };
      groups.set(userTurn, group);
    }
    group.entries.push(entry);
    group.entryIndexes.push(index);
  });
  return [...groups.values()];
}

export function evaluateMetadataHistory(
  entries: readonly SessionMetadataLogEntry[],
  options: { categories?: readonly MetadataQualityCategory[] } = {},
): MetadataQualityReport {
  const categories = resolveCategories(options.categories);
  const categoryFor = categoryResolver(categories);
  const issues: MetadataQualityIssue[] = [];

  entries.forEach((entry, index) => {
    issues.push(...shapeIssues(entry, index, categoryFor));
    issues.push(...privacyIssues(entry, index, categoryFor));
  });

  const turns = groupMetadataEntriesByTurn(entries).map((group): MetadataTurnScore => {
    const finalEntry = group.entries.at(-1);
    const finalEntryIndex = group.entryIndexes.at(-1) ?? -1;
    const turnIssues = finalEntry
      ? finalStateIssues(finalEntry, finalEntryIndex, categoryFor)
      : [];
    issues.push(...turnIssues);
    return {
      userTurn: group.userTurn,
      entryCount: group.entries.length,
      finalEntryIndex,
      issues: turnIssues,
    };
  });

  return {
    entryCount: entries.length,
    turnCount: turns.length,
    categories,
    turns,
    issues,
  };
}

export function formatMetadataQualityReport(report: MetadataQualityReport): string {
  const failCount = report.issues.filter((issue) => issue.severity === "fail").length;
  const warnCount = report.issues.filter((issue) => issue.severity === "warn").length;
  const lines = [
    `Metadata quality: ${report.entryCount} entries, ${report.turnCount} turns`,
    `Categories: ${report.categories.map((category) => category.id).join(", ")}`,
    `Issues: ${failCount} fail, ${warnCount} warn`,
  ];

  for (const turn of report.turns) {
    const turnFails = turn.issues.filter((issue) => issue.severity === "fail").length;
    const turnWarns = turn.issues.filter((issue) => issue.severity === "warn").length;
    const status = turnFails ? "fail" : turnWarns ? "warn" : "pass";
    lines.push(`Turn ${turn.userTurn} final: ${status}`);
    for (const issue of turn.issues) lines.push(`  - ${issue.category}: ${issue.message}`);
  }

  const nonTurnIssues = report.issues.filter((issue) => !report.turns.some((turn) => turn.issues.includes(issue)));
  for (const issue of nonTurnIssues) lines.push(`Entry ${issue.entryIndex}: ${issue.category}: ${issue.message}`);

  return `${lines.join("\n")}\n`;
}

export async function runMetadataQualityCli(args = process.argv.slice(2)): Promise<number> {
  const path = args[0];
  if (!path) {
    console.error("Usage: metadata-quality <metadata-history.jsonl>");
    return 1;
  }
  try {
    const text = await readFile(path, "utf8");
    const report = evaluateMetadataHistory(parseMetadataHistoryJsonl(text));
    process.stdout.write(formatMetadataQualityReport(report));
    return 0;
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
}

function resolveCategories(categories: readonly MetadataQualityCategory[] | undefined): MetadataQualityCategory[] {
  const defaults = defaultMetadataQualityCategories();
  if (!categories?.length) return defaults;
  const byField = new Map<MetadataQualityField, MetadataQualityCategory>();
  for (const category of defaults) byField.set(category.field, category);
  for (const category of categories) byField.set(category.field, category);
  return [...byField.values()];
}

function categoryResolver(categories: readonly MetadataQualityCategory[]): (field: MetadataQualityField) => string {
  const byField = new Map(categories.map((category) => [category.field, category.id]));
  return (field) => byField.get(field) ?? field;
}

function shapeIssues(
  entry: SessionMetadataLogEntry,
  entryIndex: number,
  categoryFor: (field: MetadataQualityField) => string,
): MetadataQualityIssue[] {
  const issues: MetadataQualityIssue[] = [];
  const add = (field: MetadataQualityField, message: string) => issues.push(issue("fail", field, message, entryIndex, categoryFor, entry));

  if (entry.source !== "pi-session-summary") add("goal", "source is not pi-session-summary");
  if (!entry.sessionId) add("turn", "sessionId is missing");
  if (typeof entry.generatedAt !== "number") add("turn", "generatedAt is not numeric");
  if (typeof entry.activitySequence !== "number") add("turn", "activitySequence is not numeric");
  if (entry.userTurn !== undefined && typeof entry.userTurn !== "number") add("turn", "userTurn is not numeric");
  if (!entry.model) add("turn", "model is missing");
  if (!entry.metadata?.goal) add("goal", "goal is missing");
  if (!entry.metadata?.status) add("status", "status is missing");
  if (!isStage(entry.metadata?.stage)) add("stage", "stage is invalid");

  return issues;
}

function privacyIssues(
  entry: SessionMetadataLogEntry,
  entryIndex: number,
  categoryFor: (field: MetadataQualityField) => string,
): MetadataQualityIssue[] {
  const serialized = JSON.stringify(entry);
  const metadataTexts = [entry.metadata?.goal, entry.metadata?.status, entry.metadata?.nextStep]
    .filter((value): value is string => typeof value === "string");
  return PRIVACY_MARKERS
    .filter((marker) => serialized.includes(marker) || metadataTexts.some((text) => text.includes(marker)))
    .map((marker) => issue("fail", "privacy", `privacy marker detected: ${marker}`, entryIndex, categoryFor, entry));
}

function finalStateIssues(
  entry: SessionMetadataLogEntry,
  entryIndex: number,
  categoryFor: (field: MetadataQualityField) => string,
): MetadataQualityIssue[] {
  const issues: MetadataQualityIssue[] = [];
  const status = entry.metadata?.status ?? "";
  const nextStep = entry.metadata?.nextStep ?? "";
  const stage = entry.metadata?.stage;

  if (stage === "reading" && /tests? pass(?:ed|ing)|checks? pass(?:ed|ing)|final answer/i.test(status)) {
    issues.push(issue("warn", "stage", "final entry is still reading after validation or final-response evidence", entryIndex, categoryFor, entry));
  }

  if (nextStep && substantiallyRepeats(status, nextStep)) {
    issues.push(issue("warn", "nextStep", "nextStep substantially repeats status", entryIndex, categoryFor, entry));
  }

  if (!nextStep && stage && !["complete", "waiting", "blocked"].includes(stage) && !isPassingValidationFinal(stage, status)) {
    issues.push(issue("warn", "nextStep", "final in-progress entry has no evidenced nextStep", entryIndex, categoryFor, entry));
  }

  return issues;
}

function isStage(value: unknown): value is SummaryStage {
  return typeof value === "string" && SUMMARY_STAGES.has(value as SummaryStage);
}

function isPassingValidationFinal(stage: SummaryStage, status: string): boolean {
  return stage === "testing" && /tests? pass(?:ed|ing)|checks? pass(?:ed|ing)|npm (?:test|run check) pass(?:ed|ing)/i.test(status);
}

function substantiallyRepeats(status: string, nextStep: string): boolean {
  const left = normalizedWords(status);
  const right = normalizedWords(nextStep);
  if (left.length < 3 || right.length < 3) return false;
  const leftSet = new Set(left);
  const shared = right.filter((word) => leftSet.has(word)).length;
  return shared / Math.min(left.length, right.length) >= 0.75;
}

function normalizedWords(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g)?.filter((word) => word.length > 2) ?? [];
}

function issue(
  severity: MetadataQualityIssue["severity"],
  field: MetadataQualityField,
  message: string,
  entryIndex: number,
  categoryFor: (field: MetadataQualityField) => string,
  entry: SessionMetadataLogEntry,
): MetadataQualityIssue {
  return {
    severity,
    category: categoryFor(field),
    field,
    message,
    entryIndex,
    ...(typeof entry.userTurn === "number" ? { userTurn: entry.userTurn } : {}),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runMetadataQualityCli();
}
