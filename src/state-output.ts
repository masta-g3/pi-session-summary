import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SummaryStage } from "./text.js";

export interface HubSessionMetadataFile {
  source?: "pi-session-summary";
  goal?: string;
  status?: string;
  nextStep?: string;
  stage?: SummaryStage;
  confidence?: number;
  updatedAt?: number;
}

export const HUB_DIR_ENV = "PI_AGENT_HUB_DIR";
export const HUB_SESSION_ID_ENV = "PI_AGENT_HUB_SESSION_ID";

export function sessionMetadataPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const stateDir = env[HUB_DIR_ENV];
  const sessionId = env[HUB_SESSION_ID_ENV];
  if (!stateDir || !sessionId) return undefined;
  return join(stateDir, "session-metadata", `${safeSessionId(sessionId)}.json`);
}

export async function writeSessionMetadata(metadata: HubSessionMetadataFile, path = sessionMetadataPath()): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
