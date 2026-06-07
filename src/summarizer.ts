import { complete, type UserMessage } from "@earendil-works/pi-ai";
import { activityLines, type ActivityBuffer } from "./activity.js";
import { formatAuthModel, type SummaryModelAuth } from "./models.js";
import type { SessionSummaryStateFile } from "./state-output.js";
import { parseSessionMetadataJson, sanitizeText, type ParsedSessionMetadata } from "./text.js";

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

export interface SessionSummarySummarizerOptions {
  now: () => number;
  scheduler: TimerScheduler;
  activity: ActivityBuffer;
  generate?: SummaryModelCall;
  getAuth: () => Promise<SummaryModelAuth | undefined>;
  publish: (metadata: SessionMetadataUpdate) => void | Promise<void>;
  publishState: (state: Partial<SessionSummaryStateFile>) => void | Promise<void>;
}

const INITIAL_DEBOUNCE_MS = 1_200;
const NORMAL_DEBOUNCE_MS = 2_000;
const MIN_MODEL_INTERVAL_MS = 5_000;
const FINAL_DEBOUNCE_MS = 500;
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
  private readonly publish: (metadata: SessionMetadataUpdate) => void | Promise<void>;
  private readonly publishState: (state: Partial<SessionSummaryStateFile>) => void | Promise<void>;
  private runId = 0;
  private enabled = true;
  private pendingTimer?: unknown;
  private inFlight = false;
  private dirtyWhileInFlight = false;
  private lastPublishedAt = Number.NEGATIVE_INFINITY;
  private latestMetadata: ParsedSessionMetadata | undefined;
  private abortController: AbortController | undefined;
  private agentState: AgentState = "waiting";

  constructor(options: SessionSummarySummarizerOptions) {
    this.now = options.now;
    this.scheduler = options.scheduler;
    this.activity = options.activity;
    this.generate = options.generate ?? complete;
    this.getAuth = options.getAuth;
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
        await this.publishState({ state: "no_model", sequence: this.activity.latestSequence(), updatedAt: this.now() });
        return;
      }

      abortController = new AbortController();
      this.abortController = abortController;
      const response = await this.generate(auth.model, {
        systemPrompt: SYSTEM_PROMPT,
        messages: [this.prompt()],
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
        state: stageToState(update.stage, this.agentState),
        goal: update.goal,
        status: update.status,
        stage: update.stage,
        ...(update.nextStep ? { nextStep: update.nextStep } : {}),
        ...(update.confidence !== undefined ? { confidence: update.confidence } : {}),
        model: update.model,
        sequence: update.sequence,
        generatedAt: update.generatedAt,
        updatedAt: this.now(),
      });
    } catch (error) {
      if (this.isCurrent(runId)) {
        await this.publishState({ state: "error", error: sanitizeText(error instanceof Error ? error.message : String(error), 160), sequence: this.activity.latestSequence(), updatedAt: this.now() });
      }
    } finally {
      if (abortController && this.abortController === abortController) this.abortController = undefined;
      if (this.isCurrent(runId)) {
        this.inFlight = false;
        if (this.dirtyWhileInFlight) this.schedule("normal", this.agentState);
      }
    }
  }

  private prompt(): UserMessage {
    const lines = [
      "Latest activity, newest last:",
      ...activityLines(this.activity.all()),
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

export const SYSTEM_PROMPT = `You write dashboard metadata for a Pi coding-agent session.
Infer:
- goal: the stable, high-level user-facing outcome of the session, not implementation details.
- status: the latest meaningful progress or current action in context of that goal.
- nextStep: the next useful step toward the goal. Use an empty string only if complete or unknowable.
- stage: one of starting, planning, investigating, implementing, testing, debugging, reviewing, waiting, complete, blocked, unknown.
Preserve the previous goal unless the user clearly changes the task. Keep goal outcome-oriented, like "Make subagent status easier to monitor".
Use workflow/domain language, not tool mechanics.
Do not mention raw commands, files, tools, model internals, or terminal output unless essential to the user-visible task.
Keep goal under 90 characters, status under 110 characters, and nextStep under 120 characters.
Return JSON only with keys: goal, status, nextStep, stage, confidence.`;

function stageToState(stage: string, agentState: AgentState): SessionSummaryStateFile["state"] {
  if (stage === "blocked") return "blocked";
  if (stage === "complete") return "complete";
  if (agentState === "complete") return "complete";
  if (agentState === "waiting") return "waiting";
  return "running";
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") return (part as { text: string }).text;
    return "";
  }).join("\n");
}
