import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { compactUnknown, sanitizeText } from "./text.js";

export interface WorkflowContextRequest {
  cwd: string;
  ticketId?: string;
  workflowIntent?: boolean;
}

export interface WorkflowContext {
  ticketId?: string;
  description?: string;
  planFile?: string;
  latestCompletedTodo?: string;
  nextOpenTodo?: string;
  evidence?: "explicit-ticket" | "single-in-progress";
}

interface WorkflowFeature {
  id: string;
  status?: string;
  description?: string;
  planFile?: string;
}

const FEATURES_PATH = "agent-work/features.yaml";
const TICKET_PATTERN = /\b([a-z][a-z0-9_]*-\d{3,})\b/i;
const WORKFLOW_INTENT_PATTERN = /\b(execute|review|reflect|commit|next[-\s]?feature|plan[-\s]?md|prime|workflow ticket)\b|\b(?:continue|resume)\b.{0,32}\b(?:active\s+)?(?:plan|ticket|workflow|feature)\b/i;
const MAX_DESCRIPTION_CHARS = 120;
const MAX_TODO_CHARS = 120;
const MAX_PLAN_FILE_CHARS = 160;
const MAX_SESSION_NAME_CHARS = 80;
const MAX_SESSION_SUFFIX_CHARS = 48;
const TITLE_SKIP_WORDS = new Set(["a", "an", "and", "dashboard", "dashboards", "for", "of", "session", "sessions", "supervision", "the", "title", "titles", "to"]);
const UNAVAILABLE_FILE_CODES = new Set(["EACCES", "ENOENT", "ENOTDIR", "EPERM"]);

export function extractTicketId(value: unknown): string | undefined {
  const text = compactUnknown(value, 2_000);
  return text?.match(TICKET_PATTERN)?.[1]?.toLowerCase();
}

export function hasWorkflowIntent(value: unknown): boolean {
  const text = compactUnknown(value, 2_000);
  return Boolean(text && WORKFLOW_INTENT_PATTERN.test(text));
}

export async function readWorkflowContext(request: WorkflowContextRequest): Promise<WorkflowContext | undefined> {
  const features = await readFeatures(request.cwd);
  if (!features.length) return undefined;

  const explicitTicket = request.ticketId?.toLowerCase();
  const feature = explicitTicket
    ? features.find((item) => item.id.toLowerCase() === explicitTicket)
    : request.workflowIntent ? singleInProgress(features) : undefined;
  if (!feature) return undefined;

  const checklist = feature.planFile ? await readPlanChecklist(request.cwd, feature.planFile) : undefined;
  return {
    ticketId: feature.id,
    ...(feature.description ? { description: sanitizeText(feature.description, MAX_DESCRIPTION_CHARS) } : {}),
    ...(feature.planFile ? { planFile: sanitizeText(feature.planFile, MAX_PLAN_FILE_CHARS) } : {}),
    ...(checklist?.latestCompletedTodo ? { latestCompletedTodo: checklist.latestCompletedTodo } : {}),
    ...(checklist?.nextOpenTodo ? { nextOpenTodo: checklist.nextOpenTodo } : {}),
    evidence: explicitTicket ? "explicit-ticket" : "single-in-progress",
  };
}

export function formatWorkflowContext(context: WorkflowContext | undefined): string {
  if (!context) return "none";
  return [
    context.ticketId ? `ticket: ${context.ticketId}` : undefined,
    context.description ? `description: ${context.description}` : undefined,
    context.planFile ? `planFile: ${context.planFile}` : undefined,
    context.latestCompletedTodo ? `latestCompletedTodo: ${context.latestCompletedTodo}` : undefined,
    context.nextOpenTodo ? `nextOpenTodo: ${context.nextOpenTodo}` : undefined,
  ].filter(Boolean).join("\n") || "none";
}

export function workflowSessionName(context: Pick<WorkflowContext, "ticketId" | "description" | "nextOpenTodo" | "latestCompletedTodo"> | undefined): string | undefined {
  if (!context?.ticketId) return undefined;
  const suffix = context.description ?? context.nextOpenTodo ?? context.latestCompletedTodo;
  if (!suffix) return sanitizeText(context.ticketId, MAX_SESSION_NAME_CHARS);
  const maxSuffix = Math.min(MAX_SESSION_SUFFIX_CHARS, Math.max(1, MAX_SESSION_NAME_CHARS - context.ticketId.length - 2));
  return sanitizeText(`${context.ticketId}: ${abbreviateTitle(suffix, maxSuffix)}`, MAX_SESSION_NAME_CHARS);
}

async function readFeatures(cwd: string): Promise<WorkflowFeature[]> {
  try {
    return parseFeaturesYaml(await readFile(resolve(cwd, FEATURES_PATH), "utf8"));
  } catch (error) {
    if (isUnavailableFile(error)) return [];
    throw error;
  }
}

function parseFeaturesYaml(text: string): WorkflowFeature[] {
  const features: WorkflowFeature[] = [];
  let current: Partial<WorkflowFeature> | undefined;

  for (const line of text.split(/\r?\n/)) {
    const id = /^-\s+id:\s*(.+?)\s*$/.exec(line);
    if (id) {
      if (current?.id) features.push(current as WorkflowFeature);
      current = { id: unquote(id[1] ?? "").toLowerCase() };
      continue;
    }
    if (!current) continue;

    const field = /^\s+([a-zA-Z_]+):\s*(.*?)\s*$/.exec(line);
    if (!field) continue;
    const key = field[1];
    const value = unquote(field[2] ?? "");
    if (key === "status") current.status = value;
    else if (key === "description") current.description = value;
    else if (key === "plan_file") current.planFile = value;
  }

  if (current?.id) features.push(current as WorkflowFeature);
  return features;
}

function singleInProgress(features: readonly WorkflowFeature[]): WorkflowFeature | undefined {
  const active = features.filter((item) => item.status === "in_progress");
  return active.length === 1 ? active[0] : undefined;
}

async function readPlanChecklist(cwd: string, planFile: string): Promise<{ latestCompletedTodo?: string; nextOpenTodo?: string } | undefined> {
  const path = safeProjectPath(cwd, planFile);
  if (!path) return undefined;

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isUnavailableFile(error)) return undefined;
    throw error;
  }

  const items = text.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*-\s+\[([ xX])]\s+(.+?)\s*$/.exec(line);
    if (!match) return [];
    return [{ done: match[1]?.toLowerCase() === "x", text: sanitizeText(match[2] ?? "", MAX_TODO_CHARS) }];
  });
  const latestDoneIndex = findLastIndex(items, (item) => item.done);
  const nextOpenTodo = items.slice(Math.max(0, latestDoneIndex + 1)).find((item) => !item.done)?.text
    ?? items.find((item) => !item.done)?.text;
  const latestCompletedTodo = latestDoneIndex >= 0 ? items[latestDoneIndex]?.text : undefined;
  return {
    ...(latestCompletedTodo ? { latestCompletedTodo } : {}),
    ...(nextOpenTodo ? { nextOpenTodo } : {}),
  };
}

function safeProjectPath(cwd: string, path: string): string | undefined {
  const root = resolve(cwd);
  const full = resolve(cwd, path);
  return full === root || full.startsWith(`${root}${sep}`) ? full : undefined;
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index] as T)) return index;
  }
  return -1;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed === "null" ? "" : trimmed;
}

function abbreviateTitle(value: string, maxChars: number): string {
  const text = sanitizeText(value, MAX_DESCRIPTION_CHARS);
  if (text.length <= maxChars) return text;
  const words = text.split(/\s+/).filter((word) => !TITLE_SKIP_WORDS.has(word.toLowerCase().replace(/[^a-z0-9-]/g, "")));
  return sanitizeText((words.length ? words : text.split(/\s+/)).slice(0, 5).join(" "), maxChars);
}

function isUnavailableFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && UNAVAILABLE_FILE_CODES.has(error.code);
}
