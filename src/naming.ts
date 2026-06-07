import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { SummaryModelAuth } from "./models.js";
import { sanitizeText } from "./text.js";

export const MAX_SESSION_NAME_LENGTH = 80;
const NAME_MAX_TOKENS = 64;
const NAME_TIMEOUT_MS = 2_500;

export type MessageContent = string | Array<{ type: string; text?: string }>;
export type SessionEntry = {
  type: string;
  message?: {
    role?: string;
    content?: MessageContent;
  };
};

export const NAMING_SYSTEM_PROMPT = "You create short, descriptive Pi coding-agent session names. Use 2-6 words in Title Case. Respond with only the name, no quotes or punctuation.";

export function extractTextFromContent(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
}

export function getFirstUserMessageText(entries: readonly SessionEntry[]): string | undefined {
  const ordered = [...entries].reverse();
  for (const entry of ordered) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message || message.role !== "user" || message.content === undefined) continue;
    const text = sanitizeText(extractTextFromContent(message.content), 1_500);
    if (text) return text;
  }
  return undefined;
}

export function getConversationTranscript(entries: readonly SessionEntry[], maxChars = 4_000): string {
  const ordered = [...entries].reverse();
  const lines: string[] = [];
  for (const entry of ordered) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message || message.content === undefined) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = sanitizeText(extractTextFromContent(message.content), 1_000);
    if (!text) continue;
    lines.push(`${message.role === "user" ? "User" : "Assistant"}: ${text}`);
  }
  return sanitizeText(lines.join("\n\n"), maxChars);
}

export function sanitizeSessionName(raw: string): string {
  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "";

  let name = firstLine.replace(/^```(?:text)?\s*/i, "").replace(/^[-*•\d.)\s]+/, "");
  name = name.replace(/^title:\s*/i, "");
  name = name.replace(/^name:\s*/i, "");
  name = name.replace(/^['"`]+|['"`]+$/g, "");
  name = name.replace(/[.!?:;]+$/g, "").replace(/\s+/g, " ").trim();
  if (name.length > MAX_SESSION_NAME_LENGTH) name = name.slice(0, MAX_SESSION_NAME_LENGTH).trimEnd();
  return name;
}

export function buildNamePrompt(source: string, mode: "first-message" | "history" = "first-message"): UserMessage {
  const label = mode === "history" ? "Conversation history" : "First user message";
  return {
    role: "user",
    content: [{ type: "text", text: `Create a session name for this Pi coding-agent session.\n\n${label}:\n${sanitizeText(source, 4_000)}` }],
    timestamp: Date.now(),
  };
}

export async function generateSessionName(auth: SummaryModelAuth, source: string, mode: "first-message" | "history" = "first-message"): Promise<string | undefined> {
  const response = await complete(auth.model, {
    systemPrompt: NAMING_SYSTEM_PROMPT,
    messages: [buildNamePrompt(source, mode)],
  }, {
    apiKey: auth.apiKey,
    ...(auth.headers ? { headers: auth.headers } : {}),
    maxTokens: NAME_MAX_TOKENS,
    maxRetries: 0,
    cacheRetention: "none",
    timeoutMs: NAME_TIMEOUT_MS,
  });

  if (response.stopReason !== "stop") return undefined;
  const rawName = Array.isArray(response.content)
    ? response.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n")
    : "";
  return sanitizeSessionName(rawName) || undefined;
}
