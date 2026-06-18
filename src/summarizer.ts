import { complete, type UserMessage } from "@earendil-works/pi-ai";
import { activityLines, type ActivityBuffer } from "./activity.js";
import { formatAuthModel, type SummaryModelAuth } from "./models.js";
import type { HubSessionMetadataFile } from "./state-output.js";
import { parseSessionMetadataJson, type ParsedSessionMetadata } from "./text.js";

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
  publish: (metadata: SessionMetadataUpdate) => void | Promise<void>;
  publishState: (metadata: HubMetadataUpdate) => void | Promise<void>;
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
        await this.publishState({ clear: true, updatedAt: this.now() });
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

export const SYSTEM_PROMPT = `Write compact dashboard metadata for a Pi coding-agent session.

Fields:
- goal: stable session/feature/request outcome. Include ticket id/name when present. Target 36 chars; max 48.
- status: stage-specific detail on latest verified progress. Backward-looking. Target 48 chars; max 60.
- nextStep: next distinct action or need. Forward-looking. Target 48 chars; max 60; "" if none.
- stage: current session mode from recent activity + previous metadata.
- confidence: 0 to 1.

Stage values:
- reading: gathering context, inspecting files/docs/logs, planning
- editing: changing code, docs, config, tests
- testing: running checks, debugging failures, reviewing results
- waiting: needs user/external input but can continue once provided
- blocked: cannot proceed due to missing dependency or failure
- complete: task/session goal is done

Rules:
- Use short fragments, not full sentences.
- Preserve goal across workflow steps unless the user clearly changes tasks.
- Keep status and nextStep complementary; do not repeat the same idea.
- Status should extend stage with narrow verified agent progress, not user requests or mechanics.
- If user/external input is needed, use waiting or blocked and make nextStep start with "Needs …".

Examples:
- Good goal: "metadata-001: Hub metadata v2"
- Bad goal: "Run tests for metadata-001"
- Good status: "Checking working-tree status"
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
