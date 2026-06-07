import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SummaryStage } from "./text.js";

export interface SessionSummaryStateFile {
  version: 2;
  source: "pi-session-summary";
  sessionId?: string;
  cwd: string;
  state: "starting" | "running" | "waiting" | "complete" | "blocked" | "disabled" | "no_model" | "error" | "shutdown";
  sessionName?: string;
  goal?: string;
  status?: string;
  stage?: SummaryStage;
  nextStep?: string;
  confidence?: number;
  model?: string;
  sequence: number;
  updatedAt: number;
  generatedAt?: number;
  error?: string;
}

export const HUB_DIR_ENV = "PI_AGENT_HUB_DIR";
export const HUB_SESSION_ID_ENV = "PI_AGENT_HUB_SESSION_ID";

export function sessionSummaryStatePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const stateDir = env[HUB_DIR_ENV];
  const sessionId = env[HUB_SESSION_ID_ENV];
  if (!stateDir || !sessionId) return undefined;
  return join(stateDir, "session-summary", `${safeSessionId(sessionId)}.json`);
}

export async function writeSessionSummaryState(state: SessionSummaryStateFile, path = sessionSummaryStatePath()): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
