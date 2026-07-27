import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { SessionPlanSummary } from "./state-output.js";
import { compactUnknown, sanitizeText } from "./text.js";

export interface WorkflowContextRequest {
  cwd: string;
  ticketId?: string;
  workflowIntent?: boolean;
}

export interface PlanProgress {
  phaseIndex: number;
  phaseCount: number;
  title: string;
  completed: number;
  total: number;
}

export interface WorkflowContext {
  ticketId?: string;
  title?: string;
  description?: string;
  planFile?: string;
  latestCompletedTodo?: string;
  nextOpenTodo?: string;
  planProgress?: PlanProgress;
  evidence?: "explicit-ticket" | "single-in-progress";
}

export interface WorkflowPlanTask {
  done: boolean;
  text: string;
}

export interface WorkflowPlanSection {
  heading?: string;
  tasks: WorkflowPlanTask[];
}

export interface WorkflowPlan {
  sections: WorkflowPlanSection[];
  completed: number;
  total: number;
  currentSectionIndex: number;
}

export interface WorkflowSnapshot {
  context: WorkflowContext;
  plan?: WorkflowPlan;
}

interface WorkflowFeature {
  id: string;
  status?: string;
  title?: string;
  description?: string;
  planFile?: string;
}

const FEATURES_PATH = "agent-work/features.yaml";
const TICKET_PATTERN = /\b([a-z][a-z0-9_-]*-\d{3,})\b/i;
const WORKFLOW_INTENT_PATTERN = /\b(execute|review|reflect|commit|next[-\s]?feature|plan[-\s]?md|prime|workflow ticket)\b|\b(?:continue|resume)\b.{0,32}\b(?:active\s+)?(?:plan|ticket|workflow|feature)\b/i;
const MAX_TITLE_CHARS = 80;
const MAX_DESCRIPTION_CHARS = 120;
const MAX_TODO_CHARS = 120;
const MAX_PHASE_TITLE_CHARS = 80;
const MAX_PLAN_FILE_CHARS = 160;
const MAX_SESSION_NAME_CHARS = 48;
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

export async function readWorkflowSnapshot(request: WorkflowContextRequest): Promise<WorkflowSnapshot | undefined> {
  const features = await readFeatures(request.cwd);
  if (!features.length) return undefined;

  const explicitTicket = request.ticketId?.toLowerCase();
  const feature = explicitTicket
    ? features.find((item) => item.id.toLowerCase() === explicitTicket)
    : request.workflowIntent ? singleInProgress(features) : undefined;
  if (!feature) return undefined;

  const checklist = feature.planFile ? await readPlanChecklist(request.cwd, feature.planFile) : undefined;
  const context: WorkflowContext = {
    ticketId: feature.id,
    ...(feature.title ? { title: sanitizeText(feature.title, MAX_TITLE_CHARS) } : {}),
    ...(feature.description ? { description: sanitizeText(feature.description, MAX_DESCRIPTION_CHARS) } : {}),
    ...(feature.planFile ? { planFile: sanitizeText(feature.planFile, MAX_PLAN_FILE_CHARS) } : {}),
    ...(checklist?.latestCompletedTodo ? { latestCompletedTodo: checklist.latestCompletedTodo } : {}),
    ...(checklist?.nextOpenTodo ? { nextOpenTodo: checklist.nextOpenTodo } : {}),
    ...(checklist?.planProgress ? { planProgress: checklist.planProgress } : {}),
    evidence: explicitTicket ? "explicit-ticket" : "single-in-progress",
  };
  return { context, ...(checklist?.plan ? { plan: checklist.plan } : {}) };
}

export async function readWorkflowContext(request: WorkflowContextRequest): Promise<WorkflowContext | undefined> {
  return (await readWorkflowSnapshot(request))?.context;
}

export function sessionPlanSummary(context: WorkflowContext | undefined, workflowPlan?: WorkflowPlan): SessionPlanSummary | undefined {
  if (!context) return undefined;
  const progress = context.planProgress;
  const plan: SessionPlanSummary = {
    ...(context.title ? { feature: context.title } : {}),
    ...(progress ? {
      phase: { title: progress.title, index: progress.phaseIndex, count: progress.phaseCount },
      tasks: workflowPlan
        ? { completed: workflowPlan.completed, total: workflowPlan.total }
        : { completed: progress.completed, total: progress.total },
    } : workflowPlan ? {
      tasks: { completed: workflowPlan.completed, total: workflowPlan.total },
    } : {}),
    ...(workflowPlan ? {
      phases: workflowPlan.sections.slice(0, 12).map((section) => ({
        completed: section.tasks.filter((task) => task.done).length,
        total: section.tasks.length,
      })),
    } : {}),
    ...(context.nextOpenTodo ? { nextStep: context.nextOpenTodo } : {}),
  };
  return Object.keys(plan).length ? plan : undefined;
}

export function formatWorkflowContext(context: WorkflowContext | undefined): string {
  if (!context) return "none";
  return [
    context.ticketId ? `ticket: ${context.ticketId}` : undefined,
    context.title ? `title: ${context.title}` : undefined,
    context.description ? `description: ${context.description}` : undefined,
    context.planFile ? `planFile: ${context.planFile}` : undefined,
    context.latestCompletedTodo ? `latestCompletedTodo: ${context.latestCompletedTodo}` : undefined,
    context.nextOpenTodo ? `nextOpenTodo: ${context.nextOpenTodo}` : undefined,
    context.planProgress ? `planPhase: ${context.planProgress.phaseIndex}/${context.planProgress.phaseCount} ${context.planProgress.title}` : undefined,
    context.planProgress ? `phaseProgress: ${context.planProgress.completed}/${context.planProgress.total}` : undefined,
  ].filter(Boolean).join("\n") || "none";
}

export function workflowSessionName(context: Pick<WorkflowContext, "ticketId" | "title" | "description" | "nextOpenTodo" | "latestCompletedTodo" | "evidence"> | undefined): string | undefined {
  if (!context?.ticketId || context.evidence !== "explicit-ticket") return undefined;
  if (context.title) return sanitizeText(context.title, MAX_SESSION_NAME_CHARS);
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
    if (/^-\s+/.test(line)) {
      if (current?.id) features.push(current as WorkflowFeature);
      current = {};
    }
    if (!current) continue;

    const field = /^(?:-\s+|\s+)([a-zA-Z_]+):\s*(.*?)\s*$/.exec(line);
    if (!field) continue;
    const key = field[1];
    const value = unquote(field[2] ?? "");
    if (key === "id") current.id = value.toLowerCase();
    else if (key === "status") current.status = value;
    else if (key === "title") current.title = value;
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

interface PlanPhase {
  headingLevel: number;
  heading: string;
  title: string;
  items: WorkflowPlanTask[];
}

interface ParsedPhaseHeading {
  heading: string;
  title: string;
}

interface PlanChecklist {
  latestCompletedTodo?: string;
  nextOpenTodo?: string;
  planProgress?: PlanProgress;
  plan?: WorkflowPlan;
}

async function readPlanChecklist(cwd: string, planFile: string): Promise<PlanChecklist | undefined> {
  const path = safeProjectPath(cwd, planFile);
  if (!path) return undefined;

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isUnavailableFile(error)) return undefined;
    throw error;
  }

  const allItems: WorkflowPlanTask[] = [];
  const phases: PlanPhase[] = [];
  let activePhase: PlanPhase | undefined;
  let openFence: { marker: "`" | "~"; length: number } | undefined;

  for (const line of text.split(/\r?\n/)) {
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    const delimiter = fence?.[1];
    const marker = delimiter?.startsWith("`") ? "`" : delimiter ? "~" : undefined;
    if (openFence) {
      const closesFence = marker === openFence.marker
        && (delimiter?.length ?? 0) >= openFence.length
        && !(fence?.[2] ?? "").trim();
      if (closesFence) openFence = undefined;
      continue;
    }
    if (marker && delimiter) {
      openFence = { marker, length: delimiter.length };
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const phaseHeading = parsePhaseHeading(heading[2] ?? "");
      if (phaseHeading) {
        activePhase = { headingLevel: heading[1]?.length ?? 1, ...phaseHeading, items: [] };
        phases.push(activePhase);
      } else if (activePhase && (heading[1]?.length ?? 1) < activePhase.headingLevel) {
        activePhase = undefined;
      }
      continue;
    }

    const match = /^\s*-\s+\[([ xX])]\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const item = { done: match[1]?.toLowerCase() === "x", text: sanitizeText(match[2] ?? "", MAX_TODO_CHARS) };
    allItems.push(item);
    activePhase?.items.push(item);
  }

  const populatedPhases = phases.filter((phase) => phase.items.length > 0);
  const phaseItems = populatedPhases.flatMap((phase) => phase.items);
  const items = phaseItems.length ? phaseItems : allItems;
  const latestDoneIndex = findLastIndex(items, (item) => item.done);
  const latestCompletedTodo = latestDoneIndex >= 0 ? items[latestDoneIndex]?.text : undefined;
  const nextOpenTodo = phaseItems.length
    ? items.find((item) => !item.done)?.text
    : items.slice(Math.max(0, latestDoneIndex + 1)).find((item) => !item.done)?.text
      ?? items.find((item) => !item.done)?.text;
  const currentPhaseIndex = populatedPhases.findIndex((phase) => phase.items.some((item) => !item.done));
  const selectedPhaseIndex = currentPhaseIndex >= 0 ? currentPhaseIndex : populatedPhases.length - 1;
  const selectedPhase = populatedPhases[selectedPhaseIndex];
  const planProgress = selectedPhase ? {
    phaseIndex: selectedPhaseIndex + 1,
    phaseCount: populatedPhases.length,
    title: selectedPhase.title,
    completed: selectedPhase.items.filter((item) => item.done).length,
    total: selectedPhase.items.length,
  } satisfies PlanProgress : undefined;
  const sections: WorkflowPlanSection[] = phaseItems.length
    ? populatedPhases.map((phase) => ({ heading: phase.heading, tasks: phase.items }))
    : allItems.length ? [{ tasks: allItems }] : [];
  const plan = sections.length ? {
    sections,
    completed: items.filter((item) => item.done).length,
    total: items.length,
    currentSectionIndex: phaseItems.length ? Math.max(0, selectedPhaseIndex) : 0,
  } satisfies WorkflowPlan : undefined;

  return {
    ...(latestCompletedTodo ? { latestCompletedTodo } : {}),
    ...(nextOpenTodo ? { nextOpenTodo } : {}),
    ...(planProgress ? { planProgress } : {}),
    ...(plan ? { plan } : {}),
  };
}

function parsePhaseHeading(value: string): ParsedPhaseHeading | undefined {
  const match = /^(phase|stage)\s+(\d+)\s*(?::|[-–—])\s*(.+)$/i.exec(value.trim());
  const title = sanitizeText(match?.[3] ?? "", MAX_PHASE_TITLE_CHARS);
  if (!match || !title) return undefined;
  const kind = match[1]?.toLowerCase() === "stage" ? "Stage" : "Phase";
  return { heading: `${kind} ${match[2]} · ${title}`, title };
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
