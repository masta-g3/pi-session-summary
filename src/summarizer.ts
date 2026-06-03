import { complete, type UserMessage } from "@earendil-works/pi-ai";
import { activityLines, type ActivityBuffer } from "./activity.js";
import { formatAuthModel, type TldrModelAuth } from "./models.js";
import type { TldrLiteStateFile } from "./state-output.js";
import { parseSummaryJson, sanitizeText, type ParsedSummary } from "./text.js";

export type TldrModelCall = typeof complete;
export type AgentState = "running" | "waiting" | "complete" | "blocked";

export interface TimerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TldrSummaryUpdate extends ParsedSummary {
  model: string;
  generatedAt: number;
  sequence: number;
}

export interface TldrSummarizerOptions {
  now: () => number;
  scheduler: TimerScheduler;
  activity: ActivityBuffer;
  generate?: TldrModelCall;
  getAuth: () => Promise<TldrModelAuth | undefined>;
  publish: (summary: TldrSummaryUpdate) => void | Promise<void>;
  publishState: (state: Partial<TldrLiteStateFile>) => void | Promise<void>;
}

const INITIAL_DEBOUNCE_MS = 1_200;
const NORMAL_DEBOUNCE_MS = 2_000;
const MIN_MODEL_INTERVAL_MS = 5_000;
const FINAL_DEBOUNCE_MS = 500;
const REQUEST_TIMEOUT_MS = 2_500;
const MAX_TLDR_TOKENS = 180;

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

export class TldrSummarizer {
  private readonly now: () => number;
  private readonly scheduler: TimerScheduler;
  private readonly activity: ActivityBuffer;
  private readonly generate: TldrModelCall;
  private readonly getAuth: () => Promise<TldrModelAuth | undefined>;
  private readonly publish: (summary: TldrSummaryUpdate) => void | Promise<void>;
  private readonly publishState: (state: Partial<TldrLiteStateFile>) => void | Promise<void>;
  private runId = 0;
  private enabled = true;
  private pendingTimer?: unknown;
  private inFlight = false;
  private dirtyWhileInFlight = false;
  private lastPublishedAt = Number.NEGATIVE_INFINITY;
  private latestSummary: string | undefined;
  private abortController: AbortController | undefined;
  private agentState: AgentState = "waiting";

  constructor(options: TldrSummarizerOptions) {
    this.now = options.now;
    this.scheduler = options.scheduler;
    this.activity = options.activity;
    this.generate = options.generate ?? complete;
    this.getAuth = options.getAuth;
    this.publish = options.publish;
    this.publishState = options.publishState;
  }

  previousSummary(): string | undefined {
    return this.latestSummary;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  reset(): void {
    this.runId++;
    this.clearTimer();
    this.abortController?.abort();
    this.abortController = undefined;
    this.inFlight = false;
    this.dirtyWhileInFlight = false;
    this.latestSummary = undefined;
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
        maxTokens: MAX_TLDR_TOKENS,
        maxRetries: 0,
        cacheRetention: "none",
        timeoutMs: REQUEST_TIMEOUT_MS,
        signal: abortController.signal,
      });

      if (!this.isCurrent(runId)) return;
      if (response.stopReason !== "stop") return;

      const parsed = parseSummaryJson(extractContentText(response.content));
      if (!parsed) return;

      const update = {
        ...parsed,
        model: formatAuthModel(auth),
        generatedAt: this.now(),
        sequence: this.activity.latestSequence(),
      } satisfies TldrSummaryUpdate;
      this.latestSummary = update.summary;
      this.lastPublishedAt = update.generatedAt;
      await this.publish(update);
      await this.publishState({
        state: phaseToState(update.phase, this.agentState),
        summary: update.summary,
        phase: update.phase,
        ...(shouldPublishNextAction(update.phase, this.agentState, update.nextAction) ? { nextAction: update.nextAction } : {}),
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
      "Current user request and recent activity:",
      ...activityLines(this.activity.all()),
      "",
      "Previous TLDR:",
      this.latestSummary ?? "none",
      "",
      `Agent state: ${this.agentState}`,
      "",
      "Write the dashboard TLDR now.",
    ];
    return { role: "user", content: [{ type: "text", text: lines.join("\n") }], timestamp: Date.now() };
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

export const SYSTEM_PROMPT = `You write concise status summaries for a dashboard that monitors many Pi coding-agent sessions.
Summarize what the agent is doing in the user's task or workflow, not which tools it is using.
Prefer business/domain/workflow language: planning, investigating, implementing, testing, reviewing, debugging, waiting, blocked, complete.
Use tool and file details only as hidden clues unless they are essential to the user-visible task.
Do not mention tool calls, terminal commands, model internals, or implementation mechanics.
Write one current-status sentence under 140 characters.
Return JSON only with keys: summary, phase, nextAction, confidence.
Set nextAction only when the agent is waiting, blocked, reviewing, or complete; otherwise use an empty string.`;

function shouldPublishNextAction(phase: string, agentState: AgentState, nextAction: string | undefined): nextAction is string {
  if (!nextAction) return false;
  return agentState === "waiting" || agentState === "complete" || agentState === "blocked" || phase === "waiting" || phase === "complete" || phase === "blocked" || phase === "reviewing";
}

function phaseToState(phase: string, agentState: AgentState): TldrLiteStateFile["state"] {
  if (phase === "blocked") return "blocked";
  if (phase === "complete") return "complete";
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
