import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionMetadataUpdate } from "./summarizer.js";
import { HUB_DIR_ENV, HUB_SESSION_ID_ENV, safeSessionId } from "./state-output.js";
import type { SummaryStage } from "./text.js";

export const METADATA_HISTORY_ENV = "PI_SESSION_SUMMARY_METADATA_HISTORY";

export interface SessionMetadataLogEntry {
  source: "pi-session-summary";
  sessionId: string;
  generatedAt: number;
  activitySequence: number;
  userTurn?: number;
  model: string;
  metadata: {
    goal: string;
    status: string;
    stage: SummaryStage;
    nextStep?: string;
    confidence?: number;
  };
}

export function sessionMetadataLogPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env[METADATA_HISTORY_ENV] !== "1") return undefined;
  const stateDir = env[HUB_DIR_ENV];
  const sessionId = env[HUB_SESSION_ID_ENV];
  if (!stateDir || !sessionId) return undefined;
  return join(stateDir, "session-metadata-history", `${safeSessionId(sessionId)}.jsonl`);
}

export function metadataLogEntry(sessionId: string, metadata: SessionMetadataUpdate, options: { userTurn?: number } = {}): SessionMetadataLogEntry {
  return {
    source: "pi-session-summary",
    sessionId,
    generatedAt: metadata.generatedAt,
    activitySequence: metadata.sequence,
    ...(options.userTurn !== undefined ? { userTurn: options.userTurn } : {}),
    model: metadata.model,
    metadata: {
      goal: metadata.goal,
      status: metadata.status,
      stage: metadata.stage,
      ...(metadata.nextStep ? { nextStep: metadata.nextStep } : {}),
      ...(metadata.confidence !== undefined ? { confidence: metadata.confidence } : {}),
    },
  };
}

export async function appendSessionMetadataLog(entry: SessionMetadataLogEntry, path?: string): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}
