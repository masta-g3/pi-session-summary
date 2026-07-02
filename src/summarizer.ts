import { complete, type UserMessage } from "@earendil-works/pi-ai";
import { activityLines, type ActivityBuffer } from "./activity.js";
import { formatAuthModel, type SummaryModelAuth } from "./models.js";
import type { HubSessionMetadataFile } from "./state-output.js";
import { parseSessionMetadataJson, type ParsedSessionMetadata } from "./text.js";
import { formatWorkflowContext, type WorkflowContext } from "./workflow.js";

export type SummaryModelCall = typeof complete;
export type AgentState = "running" | "waiting" | "complete" | "blocked";

export interface TimerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SessionMetadataUpdate extends ParsedSessionMetadata {
  model: string;
  generatedAt: number;
  sequence: number;
}

export type HubMetadataUpdate = Partial<HubSessionMetadataFile> & { clear?: boolean };

export interface SessionSummarySummarizerOptions {
  now: () => number;
  scheduler: TimerScheduler;
  activity: ActivityBuffer;
  generate?: SummaryModelCall;
  getAuth: () => Promise<SummaryModelAuth | undefined>;
  getWorkflowContext?: () => Promise<WorkflowContext | undefined>;
  publish: (metadata: SessionMetadataUpdate) => void | Promise<void>;
  publishState: (metadata: HubMetadataUpdate) => void | Promise<void>;
}

const INITIAL_DEBOUNCE_MS = 1_200;
const NORMAL_DEBOUNCE_MS = 2_000;
const MIN_MODEL_INTERVAL_MS = 5_000;
const FINAL_DEBOUNCE_MS = 500;
const FINAL_FLUSH_TIMEOUT_MS = 1_500;
const REQUEST_TIMEOUT_MS = 2_500;
const MAX_METADATA_TOKENS = 220;

export function createDefaultTimerScheduler(): TimerScheduler {
  return {
    setTimeout(callback, delayMs) {
      return setTimeout(callback, delayMs);
    },
    clearTimeout(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}

export class SessionSummarySummarizer {
  private readonly now: () => number;
  private readonly scheduler: TimerScheduler;
  private readonly activity: ActivityBuffer;
  private readonly generate: SummaryModelCall;
  private readonly getAuth: () => Promise<SummaryModelAuth | undefined>;
  private readonly getWorkflowContext: () => Promise<WorkflowContext | undefined>;
  private readonly publish: (metadata: SessionMetadataUpdate) => void | Promise<void>;
  private readonly publishState: (metadata: HubMetadataUpdate) => void | Promise<void>;
  private runId = 0;
  private enabled = true;
  private pendingTimer?: unknown;
  private inFlight = false;
  private dirtyWhileInFlight = false;
  private lastPublishedAt = Number.NEGATIVE_INFINITY;
  private latestMetadata: ParsedSessionMetadata | undefined;
  private abortController: AbortController | undefined;
  private agentState: AgentState = "waiting";
  private idleWaiters: Array<() => void> = [];

  constructor(options: SessionSummarySummarizerOptions) {
    this.now = options.now;
    this.scheduler = options.scheduler;
    this.activity = options.activity;
    this.generate = options.generate ?? complete;
    this.getAuth = options.getAuth;
    this.getWorkflowContext = options.getWorkflowContext ?? (async () => undefined);
    this.publish = options.publish;
    this.publishState = options.publishState;
  }

  previousMetadata(): ParsedSessionMetadata | undefined {
    return this.latestMetadata;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  reset(options: { keepMetadata?: boolean } = {}): void {
    this.runId++;
    this.clearTimer();
    this.abortController?.abort();
    this.abortController = undefined;
    this.inFlight = false;
    this.dirtyWhileInFlight = false;
    this.resolveIdleWaiters();
    if (!options.keepMetadata) this.latestMetadata = undefined;
    this.lastPublishedAt = Number.NEGATIVE_INFINITY;
    this.agentState = "waiting";
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.reset();
  }

  schedule(reason: "initial" | "normal" | "final" | "forced", agentState: AgentState = this.agentState): void {
    this.agentState = agentState;
    if (!this.enabled) return;
    if (this.inFlight) {
      this.dirtyWhileInFlight = true;
      return;
    }

    const delay = this.delayFor(reason);
    this.clearTimer();
    this.pendingTimer = this.scheduler.setTimeout(() => {
      this.pendingTimer = undefined;
      void this.runRequest(this.runId);
    }, delay);
  }

  async flushPending(agentState: AgentState = this.agentState, timeoutMs = FINAL_FLUSH_TIMEOUT_MS): Promise<void> {
    this.agentState = agentState;
    if (!this.enabled) return;
    const deadline = Date.now() + timeoutMs;

    if (this.inFlight) {
      this.dirtyWhileInFlight = true;
      await this.withTimeout(this.waitForIdle(), timeoutMs);
    }
    if (!this.enabled || this.inFlight || this.pendingTimer === undefined) return;

    this.clearTimer();
    await this.withTimeout(this.runRequest(this.runId), Math.max(0, deadline - Date.now()));
  }

  private delayFor(reason: "initial" | "normal" | "final" | "forced"): number {
    if (reason === "forced") return 0;
    if (reason === "initial") return INITIAL_DEBOUNCE_MS;
    if (reason === "final") return FINAL_DEBOUNCE_MS;
    const intervalRemaining = Math.max(0, MIN_MODEL_INTERVAL_MS - (this.now() - this.lastPublishedAt));
    return Math.max(NORMAL_DEBOUNCE_MS, intervalRemaining);
  }

  private async runRequest(runId: number): Promise<void> {
    if (this.inFlight || !this.enabled || runId !== this.runId) return;
    this.inFlight = true;
    this.dirtyWhileInFlight = false;
    let abortController: AbortController | undefined;

    try {
      const auth = await this.getAuth();
      if (!this.isCurrent(runId)) return;
      if (!auth) {
        await this.publishState({ clear: true, updatedAt: this.now() });
        return;
      }

      const workflowContext = await this.readOptionalWorkflowContext();
      if (!this.isCurrent(runId)) return;

      abortController = new AbortController();
      this.abortController = abortController;
      const response = await this.generate(auth.model, {
        systemPrompt: SYSTEM_PROMPT,
        messages: [this.prompt(workflowContext)],
      }, {
        apiKey: auth.apiKey,
        ...(auth.headers ? { headers: auth.headers } : {}),
        maxTokens: MAX_METADATA_TOKENS,
        maxRetries: 0,
        cacheRetention: "none",
        timeoutMs: REQUEST_TIMEOUT_MS,
        signal: abortController.signal,
      });

      if (!this.isCurrent(runId)) return;
      if (response.stopReason !== "stop") return;

      const parsed = parseSessionMetadataJson(extractContentText(response.content));
      if (!parsed) return;

      const update = {
        ...parsed,
        model: formatAuthModel(auth),
        generatedAt: this.now(),
        sequence: this.activity.latestSequence(),
      } satisfies SessionMetadataUpdate;
      this.latestMetadata = parsed;
      this.lastPublishedAt = update.generatedAt;
      await this.publish(update);
      await this.publishState({
        goal: update.goal,
        status: update.status,
        stage: update.stage,
        ...(update.nextStep ? { nextStep: update.nextStep } : {}),
        ...(update.confidence !== undefined ? { confidence: update.confidence } : {}),
        updatedAt: this.now(),
      });
    } catch (error) {
      if (this.isCurrent(runId)) {
        await this.publishState({ clear: true, updatedAt: this.now() });
      }
    } finally {
      if (abortController && this.abortController === abortController) this.abortController = undefined;
      if (this.isCurrent(runId)) {
        this.inFlight = false;
        if (this.dirtyWhileInFlight) this.schedule("normal", this.agentState);
        this.resolveIdleWaiters();
      }
    }
  }

  private waitForIdle(): Promise<void> {
    if (!this.inFlight) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private resolveIdleWaiters(): void {
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private async readOptionalWorkflowContext(): Promise<WorkflowContext | undefined> {
    try {
      return await this.getWorkflowContext();
    } catch {
      return undefined;
    }
  }

  private async withTimeout(task: Promise<void>, timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) {
      await task;
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        task,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private prompt(workflowContext?: WorkflowContext): UserMessage {
    const lines = [
      "Latest activity, newest last:",
      ...activityLines(this.activity.all()),
      "",
      "Workflow context from repo files, if explicit:",
      formatWorkflowContext(workflowContext),
      "",
      "Previous metadata, for continuity:",
      this.formatPreviousMetadata(),
      "",
      `Agent state: ${this.agentState}`,
      "",
      "Update the metadata for what is happening now.",
    ];
    return { role: "user", content: [{ type: "text", text: lines.join("\n") }], timestamp: Date.now() };
  }

  private formatPreviousMetadata(): string {
    if (!this.latestMetadata) return "none";
    const parts = [
      `goal: ${this.latestMetadata.goal}`,
      `status: ${this.latestMetadata.status}`,
      this.latestMetadata.nextStep ? `nextStep: ${this.latestMetadata.nextStep}` : undefined,
      `stage: ${this.latestMetadata.stage}`,
    ];
    return parts.filter(Boolean).join("\n");
  }

  private isCurrent(runId: number): boolean {
    return this.enabled && runId === this.runId;
  }

  private clearTimer(): void {
    if (this.pendingTimer === undefined) return;
    this.scheduler.clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
  }
}

export const SYSTEM_PROMPT = `Write compact dashboard metadata for a Pi coding-agent session.

Fields:
- goal: stable ticket/session/request objective. Include ticket id when present. Target 72 chars; max 96.
- status: latest explicit completed or verified progress milestone by the main agent. Backward-looking. Target 48 chars; max 60.
- nextStep: next explicit plan/todo/user-requested action or handoff need. Forward-looking. Target 48 chars; max 60; "" if not evidenced.
- stage: current session mode from recent activity + previous metadata.
- confidence: 0 to 1.

Stage values:
- reading: gathering context, inspecting files/docs/logs, planning
- editing: changing code, docs, config, tests
- testing: running checks, debugging failures, reviewing results
- waiting: answered/handoff done; needs user choice, approval, commit, or external validation
- blocked: cannot proceed due to missing dependency or failure
- complete: task/session goal is done

Rules:
- Use short fragments, not full sentences.
- Preserve goal across workflow steps unless the user clearly changes tasks.
- Previous metadata is continuity context only. Preserve prior goal when still relevant, but do not reuse previous status or nextStep unless latest activity independently supports it.
- For workflow tickets, make goal the ticket objective, not the current sub-step.
- Prefer Workflow context for ticket id, objective, checked plan context, and next open todo when relevant.
- Keep status and nextStep complementary; do not repeat the same idea.
- For status, prioritize the latest user-agent exchange and report only verified main-agent progress.
- Status should extend stage with narrow verified agent progress, not user requests or mechanics.
- Do not convert an unchecked todo into status; it can only be nextStep.
- Use a checked todo as status only when recent activity supports that the main agent just completed/verified it.
- For nextStep, prioritize the latest explicit user request, stated plan, unchecked todo, or handoff need.
- Derive nextStep only from explicit evidence: an unchecked todo, stated plan, user request, or final handoff need. Do not speculate.
- If final answer leaves a decision, commit, validation, or unavailable external tool, use waiting/blocked and nextStep "Needs …".

Examples:
- Good goal: "metadata-001: Hub metadata v2"
- Bad goal: "Run tests for metadata-001"
- Good status: "Parser tests passing"
- Bad status: "User asked for uncommitted file check"
- Good nextStep: "Commit remaining hardening diffs"
- Bad nextStep: "Commit and push remaining wf/social hardening diffs".

Return JSON only with keys: goal, status, nextStep, stage, confidence.`;

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") return (part as { text: string }).text;
    return "";
  }).join("\n");
}
