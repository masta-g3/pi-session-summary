export interface ParsedSummary {
  summary: string;
  phase: TldrPhase;
  nextAction?: string;
  confidence?: number;
}

export type TldrPhase =
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

export const TLDR_PHASES = new Set<TldrPhase>([
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

export function parseSummaryJson(text: string): ParsedSummary | undefined {
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
  const summary = typeof record.summary === "string" ? sanitizeText(record.summary, 180) : "";
  if (!summary) return undefined;

  const phase = typeof record.phase === "string" && TLDR_PHASES.has(record.phase as TldrPhase) ? record.phase as TldrPhase : "unknown";
  const nextAction = typeof record.nextAction === "string" ? sanitizeText(record.nextAction, 180) : "";
  const confidence = typeof record.confidence === "number" && Number.isFinite(record.confidence)
    ? Math.max(0, Math.min(1, record.confidence))
    : undefined;

  return { summary, phase, ...(nextAction ? { nextAction } : {}), ...(confidence !== undefined ? { confidence } : {}) };
}

function extractJsonObject(text: string): string | undefined {
  const fenced = /```(?:json)?\s*({[\s\S]*?})\s*```/i.exec(text);
  if (fenced?.[1]) return fenced[1];

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  return text.slice(start, end + 1);
}
