import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createActivityBuffer } from "./activity.js";
import { formatModelPreference, getSummaryModelAuth, resolveInitialModelPreference, type SummaryModelPreference } from "./models.js";
import { appendSessionMetadataLog, metadataLogEntry, sessionMetadataLogPath } from "./metadata-log.js";
import { generateSessionName, getConversationTranscript, getFirstUserMessageText, type SessionEntry } from "./naming.js";
import { createDefaultTimerScheduler, SessionSummarySummarizer, type HubMetadataUpdate, type SessionMetadataUpdate } from "./summarizer.js";
import { HUB_SESSION_ID_ENV, sessionMetadataPath, writeSessionMetadata, type HubSessionMetadataFile } from "./state-output.js";
import { compactUnknown, sanitizeText, type ParsedSessionMetadata } from "./text.js";
import { clearNoModelWarning, clearSessionSummaryWidget, notifyUser, showNoModelWarning, showSessionSummaryWidget } from "./widget.js";
import { extractTicketId, hasWorkflowIntent, readWorkflowContext, workflowSessionName, type WorkflowContext } from "./workflow.js";

const EXTENSION_KEY = Symbol.for("pi-session-summary.extension.loaded");
type SessionSummaryGlobal = typeof globalThis & { [EXTENSION_KEY]?: true };

type MessageEndEvent = { stopReason?: string; message?: unknown };
type MessageUpdateEvent = { message?: unknown; assistantMessageEvent?: { type?: string; delta?: unknown } };
type ToolEvent = { name?: string; toolName?: string; args?: unknown; input?: unknown; result?: unknown; error?: unknown };

interface RuntimeState {
  sessionActive: boolean;
  enabled: boolean;
  configuredModel: SummaryModelPreference | undefined;
  activity: ReturnType<typeof createActivityBuffer>;
  summarizer: SessionSummarySummarizer | undefined;
  outputPath: string | undefined;
  metadataLogPath: string | undefined;
  metadataLogSessionId: string | undefined;
  sequence: number;
  latestMetadata: ParsedSessionMetadata | undefined;
  activeModel: string | undefined;
  namingAttempted: boolean;
  namingInProgress: boolean;
  latestSessionName: string | undefined;
  latestTicketId: string | undefined;
  latestWorkflowIntent: boolean;
  writeChain: Promise<void>;
  logChain: Promise<void>;
  userTurn: number;
  finalFlushState: "waiting" | "complete" | undefined;
}

export default function sessionSummary(pi: ExtensionAPI) {
  const globalState = globalThis as SessionSummaryGlobal;
  if (globalState[EXTENSION_KEY]) return;
  globalState[EXTENSION_KEY] = true;

  const state: RuntimeState = {
    sessionActive: false,
    enabled: true,
    activity: createActivityBuffer(),
    summarizer: undefined,
    outputPath: sessionMetadataPath(process.env),
    metadataLogPath: undefined,
    metadataLogSessionId: undefined,
    sequence: 0,
    configuredModel: undefined,
    latestMetadata: undefined,
    activeModel: undefined,
    namingAttempted: false,
    namingInProgress: false,
    latestSessionName: undefined,
    latestTicketId: undefined,
    latestWorkflowIntent: false,
    writeChain: Promise.resolve(),
    logChain: Promise.resolve(),
    userTurn: 0,
    finalFlushState: undefined,
  };

  registerCommand(pi, state);

  pi.on("session_start", (_event, ctx) => {
    state.sessionActive = true;
    state.enabled = true;
    state.outputPath = sessionMetadataPath(process.env);
    state.metadataLogPath = sessionMetadataLogPath(process.env);
    state.metadataLogSessionId = state.metadataLogPath ? process.env[HUB_SESSION_ID_ENV] : undefined;
    state.configuredModel = resolveInitialModelPreference(ctx.cwd);
    state.activity.reset();
    clearSessionSummaryWidget(ctx);
    clearNoModelWarning(ctx);
    state.summarizer = createSummarizer(ctx, state);
    state.namingAttempted = false;
    state.namingInProgress = false;
    state.latestSessionName = pi.getSessionName() || undefined;
    state.latestTicketId = undefined;
    state.latestWorkflowIntent = false;
    state.latestMetadata = undefined;
    state.userTurn = 0;
    state.finalFlushState = undefined;
    void publishMetadata(ctx, state);
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!state.sessionActive || !state.enabled) return;
    state.userTurn += 1;
    state.finalFlushState = undefined;
    state.activity.reset();
    state.summarizer?.reset({ keepMetadata: true });
    const prompt = (event as { prompt?: unknown }).prompt;
    const promptText = compactUnknown(prompt, 1_500);
    const promptTicketId = extractTicketId(promptText);
    const promptWorkflowIntent = hasWorkflowIntent(promptText);
    state.latestTicketId = promptTicketId ?? (promptWorkflowIntent ? state.latestTicketId : undefined);
    state.latestWorkflowIntent = Boolean(promptTicketId) || promptWorkflowIntent;
    state.activity.record("user", prompt);
    clearSessionSummaryWidget(ctx);
    state.summarizer?.schedule("initial", "running");
    void attemptAutoName(pi, ctx, state, promptText);
  });

  pi.on("message_update", (event, _ctx) => {
    if (!state.sessionActive || !state.enabled) return;
    const text = assistantUpdateText(event as MessageUpdateEvent);
    if (state.activity.recordAssistantUpdate(text)) state.summarizer?.schedule("normal", "running");
  });

  pi.on("tool_execution_start", (event, _ctx) => {
    if (!state.sessionActive || !state.enabled) return;
    state.activity.record("tool", compactToolEvent(event as ToolEvent, "started"));
    state.summarizer?.schedule("normal", "running");
  });

  pi.on("tool_execution_end", (event, _ctx) => {
    if (!state.sessionActive || !state.enabled) return;
    state.activity.record("result", compactToolEvent(event as ToolEvent, "finished"));
    state.summarizer?.schedule("normal", "running");
  });

  pi.on("message_end", (event, _ctx) => {
    if (!state.sessionActive || !state.enabled) return;
    const messageEnd = event as MessageEndEvent;
    if (!isAssistantMessage(messageEnd.message)) return;
    const stopReason = messageEnd.stopReason ?? messageStopReason(messageEnd.message);
    if (stopReason === "toolUse" || hasToolUse(messageEnd.message)) return;
    const text = finalMessageText(messageEnd.message) ?? compactUnknown(messageEnd.message, 900);
    if (text) state.activity.record(stopReason === "error" ? "error" : "final", text);
    state.finalFlushState = "complete";
    state.summarizer?.schedule("final", "complete");
  });

  pi.on("agent_end", (_event, _ctx) => {
    if (!state.sessionActive || !state.enabled) return;
    state.finalFlushState ??= "waiting";
    state.summarizer?.schedule("final", state.finalFlushState);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (state.finalFlushState) await state.summarizer?.flushPending(state.finalFlushState);
    const keepFinalMetadata = state.finalFlushState !== undefined && state.latestMetadata?.stage === state.finalFlushState;
    state.sessionActive = false;
    state.summarizer?.reset();
    state.summarizer = undefined;
    state.activity.reset();
    clearSessionSummaryWidget(ctx);
    clearNoModelWarning(ctx);
    state.latestMetadata = undefined;
    state.latestTicketId = undefined;
    state.latestWorkflowIntent = false;
    state.metadataLogPath = undefined;
    state.metadataLogSessionId = undefined;
    state.userTurn = 0;
    state.finalFlushState = undefined;
    if (!keepFinalMetadata) await publishMetadata(ctx, state);
    await state.logChain;
    delete globalState[EXTENSION_KEY];
  });
}

function registerCommand(pi: ExtensionAPI, state: RuntimeState): void {
  const handler = async (args: string, ctx: ExtensionContext) => {
    const action = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!action || action === "help" || action === "status") {
      await notifyStatus(ctx, state);
      return;
    }
    if (action === "off") {
      state.enabled = false;
      state.latestMetadata = undefined;
      state.summarizer?.setEnabled(false);
      clearSessionSummaryWidget(ctx);
      clearNoModelWarning(ctx);
      await publishMetadata(ctx, state);
      notifyUser(ctx, "pi-session-summary disabled");
      return;
    }
    if (action === "on") {
      state.enabled = true;
      state.summarizer ??= createSummarizer(ctx, state);
      state.summarizer.setEnabled(true);
      state.summarizer.schedule("forced", "running");
      notifyUser(ctx, "pi-session-summary enabled");
      return;
    }
    if (action === "refresh") {
      state.summarizer?.schedule("forced", "running");
      notifyUser(ctx, "pi-session-summary refresh scheduled");
      return;
    }
    if (action === "name") {
      await nameFromHistory(pi, ctx, state);
      return;
    }
    notifyUser(ctx, "Use /session-summary [status|on|off|refresh|name]", "error");
  };

  pi.registerCommand("session-summary", {
    description: "pi-session-summary status and controls",
    handler,
  });
}

function createSummarizer(ctx: ExtensionContext, state: RuntimeState): SessionSummarySummarizer {
  return new SessionSummarySummarizer({
    now: Date.now,
    scheduler: createDefaultTimerScheduler(),
    activity: state.activity,
    getAuth: async () => {
      const auth = await getSummaryModelAuth(ctx, state.configuredModel);
      state.activeModel = auth ? `${auth.model.provider}/${auth.model.id}` : undefined;
      if (auth) clearNoModelWarning(ctx);
      else showNoModelWarning(ctx);
      return auth;
    },
    getWorkflowContext: () => refreshWorkflowContext(ctx, state),
    publish: (metadata) => {
      state.latestMetadata = {
        goal: metadata.goal,
        status: metadata.status,
        stage: metadata.stage,
        ...(metadata.nextStep ? { nextStep: metadata.nextStep } : {}),
        ...(metadata.confidence !== undefined ? { confidence: metadata.confidence } : {}),
      };
      state.activeModel = metadata.model;
      showSessionSummaryWidget(ctx, metadata.status, metadata.stage);
      logMetadataDerivation(state, metadata);
    },
    publishState: (partial) => publishMetadata(ctx, state, partial),
  });
}

function logMetadataDerivation(state: RuntimeState, metadata: SessionMetadataUpdate): void {
  const path = state.metadataLogPath;
  const sessionId = state.metadataLogSessionId;
  if (!path || !sessionId) return;

  const entry = metadataLogEntry(sessionId, metadata, { userTurn: state.userTurn });
  state.logChain = state.logChain.then(
    () => appendSessionMetadataLog(entry, path).catch(() => {}),
    () => appendSessionMetadataLog(entry, path).catch(() => {}),
  );
}

async function refreshWorkflowContext(ctx: ExtensionContext, state: RuntimeState): Promise<WorkflowContext | undefined> {
  const context = await readWorkflowContext({
    cwd: ctx.cwd,
    ...(state.latestTicketId ? { ticketId: state.latestTicketId } : {}),
    workflowIntent: state.latestWorkflowIntent,
  });
  if (context?.ticketId) state.latestTicketId = context.ticketId;
  return context;
}

async function readOptionalWorkflowContext(ctx: ExtensionContext, state: RuntimeState): Promise<WorkflowContext | undefined> {
  try {
    return await refreshWorkflowContext(ctx, state);
  } catch {
    return undefined;
  }
}

async function attemptAutoName(pi: ExtensionAPI, ctx: ExtensionContext, state: RuntimeState, prompt: string | undefined): Promise<void> {
  if (state.namingAttempted || state.namingInProgress) return;
  if (pi.getSessionName()) return;

  const workflowName = workflowSessionName(await readOptionalWorkflowContext(ctx, state));
  if (workflowName) {
    state.namingAttempted = true;
    pi.setSessionName(workflowName);
    state.latestSessionName = workflowName;
    await publishMetadata(ctx, state);
    notifyUser(ctx, `Session named: ${workflowName}`);
    return;
  }

  const source = prompt ?? getFirstUserMessageText(ctx.sessionManager.getBranch() as SessionEntry[]);
  if (!source) return;

  state.namingAttempted = true;
  await generateAndSetName(pi, ctx, state, source, "first-message", false);
}

async function nameFromHistory(pi: ExtensionAPI, ctx: ExtensionContext, state: RuntimeState): Promise<void> {
  const workflowName = workflowSessionName(await readOptionalWorkflowContext(ctx, state));
  if (workflowName) {
    pi.setSessionName(workflowName);
    state.latestSessionName = workflowName;
    await publishMetadata(ctx, state);
    notifyUser(ctx, `Session named: ${workflowName}`);
    return;
  }

  const transcript = getConversationTranscript(ctx.sessionManager.getBranch() as SessionEntry[]);
  if (!transcript) {
    notifyUser(ctx, "No user/assistant messages available to name this session.", "error");
    return;
  }
  await generateAndSetName(pi, ctx, state, transcript, "history", true);
}

async function generateAndSetName(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: RuntimeState,
  source: string,
  mode: "first-message" | "history",
  force: boolean,
): Promise<void> {
  if (state.namingInProgress) return;
  if (!force && pi.getSessionName()) return;

  state.namingInProgress = true;
  try {
    const auth = await getSummaryModelAuth(ctx, state.configuredModel);
    if (!auth) {
      notifyUser(ctx, "No authenticated model available for session naming.", "error");
      return;
    }
    const name = await generateSessionName(auth, source, mode);
    if (!name) {
      notifyUser(ctx, "Session naming produced no usable name.", "error");
      return;
    }
    if (!force && pi.getSessionName()) return;
    pi.setSessionName(name);
    state.latestSessionName = name;
    await publishMetadata(ctx, state);
    notifyUser(ctx, `Session named: ${name}`);
  } catch (error) {
    notifyUser(ctx, `Session naming failed: ${sanitizeText(error instanceof Error ? error.message : String(error), 160)}`, "error");
  } finally {
    state.namingInProgress = false;
  }
}

async function publishMetadata(_ctx: ExtensionContext, state: RuntimeState, partial: HubMetadataUpdate = {}): Promise<void> {
  state.sequence += 1;
  const latest = partial.clear ? undefined : state.latestMetadata;
  const output: HubSessionMetadataFile = {
    source: "pi-session-summary",
    updatedAt: partial.updatedAt ?? Date.now(),
    ...(latest?.goal ? { goal: latest.goal } : {}),
    ...(latest?.status ? { status: latest.status } : {}),
    ...(latest?.stage ? { stage: latest.stage } : {}),
    ...(latest?.nextStep ? { nextStep: latest.nextStep } : {}),
    ...(latest?.confidence !== undefined ? { confidence: latest.confidence } : {}),
    ...(partial.goal ? { goal: partial.goal } : {}),
    ...(partial.status ? { status: partial.status } : {}),
    ...(partial.stage ? { stage: partial.stage } : {}),
    ...(partial.nextStep ? { nextStep: partial.nextStep } : {}),
    ...(partial.confidence !== undefined ? { confidence: partial.confidence } : {}),
  };
  state.writeChain = state.writeChain.then(
    () => writeSessionMetadata(output, state.outputPath).catch(() => {}),
    () => writeSessionMetadata(output, state.outputPath).catch(() => {}),
  );
  await state.writeChain;
}

async function notifyStatus(ctx: ExtensionContext, state: RuntimeState): Promise<void> {
  notifyUser(ctx, [
    "pi-session-summary",
    `enabled: ${state.enabled ? "yes" : "no"}`,
    `selected model: ${formatModelPreference(state.configuredModel)}`,
    `active model: ${state.activeModel ?? "unknown"}`,
    `latest goal: ${state.latestMetadata?.goal ?? "none"}`,
    `latest status: ${state.latestMetadata?.status ?? "none"}`,
    `latest stage: ${state.latestMetadata?.stage ?? "none"}`,
    `latest next step: ${state.latestMetadata?.nextStep ?? "none"}`,
    `latest name: ${state.latestSessionName ?? "none"}`,
    `output path: ${state.outputPath ?? "none"}`,
    "commands: /session-summary [status|on|off|refresh|name]",
  ].join("\n"));
}

function assistantUpdateText(event: MessageUpdateEvent): unknown {
  const accumulatedText = messageContentText(event.message);
  if (accumulatedText) return accumulatedText;
  return event.assistantMessageEvent?.type === "text_delta" ? event.assistantMessageEvent.delta : undefined;
}

function compactToolEvent(event: ToolEvent, status: string): string {
  const name = event.name ?? event.toolName ?? "tool";
  const detail = compactUnknown(event.error ?? event.result ?? event.args ?? event.input, 240);
  return sanitizeText(`${name} ${status}${detail ? `: ${detail}` : ""}`, 320);
}

function isAssistantMessage(message: unknown): boolean {
  return Boolean(message && typeof message === "object" && (message as Record<string, unknown>).role === "assistant");
}

function hasToolUse(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  if (Array.isArray(record.toolCalls) && record.toolCalls.length > 0) return true;
  if (Array.isArray(record.content)) return record.content.some((part) => {
    if (!part || typeof part !== "object") return false;
    const type = (part as Record<string, unknown>).type;
    return type === "tool_use" || type === "toolCall";
  });
  return false;
}

function messageStopReason(message: unknown): string | undefined {
  return message && typeof message === "object" && typeof (message as Record<string, unknown>).stopReason === "string"
    ? (message as { stopReason: string }).stopReason
    : undefined;
}

function finalMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const record = message as Record<string, unknown>;
  if (typeof record.errorMessage === "string") return sanitizeText(record.errorMessage, 900);
  return messageContentText(message);
}

function messageContentText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return sanitizeText(content, 900) || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const value = (part as Record<string, unknown>).text;
    return typeof value === "string" ? [value] : [];
  }).join("\n");
  return sanitizeText(text, 900) || undefined;
}
