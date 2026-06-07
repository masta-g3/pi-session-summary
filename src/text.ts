export interface ParsedSessionMetadata {
  goal: string;
  status: string;
  stage: SummaryStage;
  nextStep?: string;
  confidence?: number;
}

export type SummaryStage =
  | "starting"
  | "planning"
  | "investigating"
  | "implementing"
  | "testing"
  | "debugging"
  | "reviewing"
  | "waiting"
  | "complete"
  | "blocked"
  | "unknown";

export const SUMMARY_STAGES = new Set<SummaryStage>([
  "starting",
  "planning",
  "investigating",
  "implementing",
  "testing",
  "debugging",
  "reviewing",
  "waiting",
  "complete",
  "blocked",
  "unknown",
]);

const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u009b]/g;
const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[PX^_].*?\u001b\\|[@-Z\\-_])/g;
const MAX_GOAL_CHARS = 100;
const MAX_STATUS_CHARS = 110;
const MAX_NEXT_STEP_CHARS = 120;

export function sanitizeText(text: string, maxChars = 800): string {
  const stripped = text
    .replace(ANSI_PATTERN, "")
    .replace(CONTROL_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();

  if (stripped.length <= maxChars) return stripped;
  if (maxChars <= 1) return "…".slice(0, maxChars);
  return `${stripped.slice(0, maxChars - 1).trimEnd()}…`;
}

export function compactUnknown(value: unknown, maxChars = 800): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return sanitizeText(value, maxChars);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return sanitizeText(String(value), maxChars);
  try {
    return sanitizeText(JSON.stringify(value), maxChars);
  } catch {
    return sanitizeText(String(value), maxChars);
  }
}

export function parseSessionMetadataJson(text: string): ParsedSessionMetadata | undefined {
  const clean = sanitizeText(text, 2_000);
  const jsonText = extractJsonObject(clean);
  if (!jsonText) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const goal = typeof record.goal === "string" ? sanitizeText(record.goal, MAX_GOAL_CHARS) : "";
  const status = typeof record.status === "string" ? sanitizeText(record.status, MAX_STATUS_CHARS) : "";
  if (!goal || !status) return undefined;

  const stage = typeof record.stage === "string" && SUMMARY_STAGES.has(record.stage as SummaryStage) ? record.stage as SummaryStage : "unknown";
  const nextStep = typeof record.nextStep === "string" ? sanitizeText(record.nextStep, MAX_NEXT_STEP_CHARS) : "";
  const confidence = typeof record.confidence === "number" && Number.isFinite(record.confidence)
    ? Math.max(0, Math.min(1, record.confidence))
    : undefined;

  return { goal, status, stage, ...(nextStep ? { nextStep } : {}), ...(confidence !== undefined ? { confidence } : {}) };
}

function extractJsonObject(text: string): string | undefined {
  const fenced = /```(?:json)?\s*({[\s\S]*?})\s*```/i.exec(text);
  if (fenced?.[1]) return fenced[1];

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  return text.slice(start, end + 1);
}
