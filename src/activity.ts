import { compactUnknown, sanitizeText } from "./text.js";

export type ActivityKind = "user" | "assistant" | "tool" | "result" | "final" | "error";

export interface ActivityFact {
  sequence: number;
  kind: ActivityKind;
  text: string;
  at: number;
}

export interface ActivityBuffer {
  record(kind: ActivityKind, text: unknown, at?: number): ActivityFact | undefined;
  recordAssistantUpdate(text: unknown, at?: number): ActivityFact | undefined;
  all(): ActivityFact[];
  reset(): void;
  latestSequence(): number;
}

const DEFAULT_LIMIT = 12;
const DEFAULT_FACT_CHARS = 700;
const ASSISTANT_UPDATE_MIN_DELTA = 80;
const ASSISTANT_UPDATE_MIN_INTERVAL_MS = 1_000;

export function createActivityBuffer(limit = DEFAULT_LIMIT, maxFactChars = DEFAULT_FACT_CHARS, now: () => number = Date.now): ActivityBuffer {
  let sequence = 0;
  let activities: ActivityFact[] = [];
  let lastAssistantUpdate = "";
  let lastAssistantUpdateAt = Number.NEGATIVE_INFINITY;

  function push(kind: ActivityKind, raw: unknown, at = now()): ActivityFact | undefined {
    const text = compactUnknown(raw, maxFactChars);
    if (!text) return undefined;
    const activity = { sequence: ++sequence, kind, text, at } satisfies ActivityFact;
    activities.push(activity);
    if (activities.length > limit) activities = activities.slice(-limit);
    return activity;
  }

  return {
    record: push,
    recordAssistantUpdate(text, at = now()) {
      const clean = sanitizeText(compactUnknown(text, maxFactChars) ?? "", maxFactChars);
      if (!clean) return undefined;
      const changedEnough = Math.abs(clean.length - lastAssistantUpdate.length) >= ASSISTANT_UPDATE_MIN_DELTA || !clean.startsWith(lastAssistantUpdate);
      const waitedEnough = at - lastAssistantUpdateAt >= ASSISTANT_UPDATE_MIN_INTERVAL_MS;
      if (!changedEnough && !waitedEnough) return undefined;
      lastAssistantUpdate = clean;
      lastAssistantUpdateAt = at;
      return push("assistant", clean, at);
    },
    all() {
      return [...activities];
    },
    reset() {
      activities = [];
      lastAssistantUpdate = "";
      lastAssistantUpdateAt = Number.NEGATIVE_INFINITY;
    },
    latestSequence() {
      return sequence;
    },
  };
}

export function activityLines(activities: readonly ActivityFact[]): string[] {
  return activities.map((activity) => `- ${activity.kind}: ${activity.text}`);
}
