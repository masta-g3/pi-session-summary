import assert from "node:assert/strict";
import { test } from "node:test";
import { createActivityBuffer } from "../src/activity.js";
import { SessionSummarySummarizer, type TimerScheduler } from "../src/summarizer.js";

class FakeScheduler implements TimerScheduler {
  timers: { callback: () => void; delayMs: number; active: boolean }[] = [];
  setTimeout(callback: () => void, delayMs: number): unknown {
    const timer = { callback, delayMs, active: true };
    this.timers.push(timer);
    return timer;
  }
  clearTimeout(handle: unknown): void {
    (handle as { active: boolean }).active = false;
  }
  runNext(): void {
    const timer = this.timers.find((item) => item.active);
    assert.ok(timer, "expected active timer");
    timer.active = false;
    timer.callback();
  }
}

function auth() {
  return { model: { provider: "openai-codex", id: "gpt-5.4-mini" }, apiKey: "key" };
}

function metadataJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    goal: "Make subagent display compact by default.",
    status: "Implemented footer-only default and toggle controls.",
    nextStep: "Reload Pi and launch scouts to confirm the UI.",
    stage: "testing",
    confidence: 0.86,
    ...overrides,
  });
}

test("uses initial debounce before first model call", () => {
  const scheduler = new FakeScheduler();
  const activity = createActivityBuffer();
  activity.record("user", "Build session metadata");
  const summarizer = new SessionSummarySummarizer({
    now: () => 0,
    scheduler,
    activity,
    getAuth: async () => auth() as never,
    generate: (async () => ({ stopReason: "stop", content: [{ type: "text", text: metadataJson() }] })) as never,
    publish: () => {},
    publishState: () => {},
  });
  summarizer.schedule("initial", "running");
  assert.equal(scheduler.timers[0]?.delayMs, 1_200);
});

test("publishes parsed model metadata JSON", async () => {
  const scheduler = new FakeScheduler();
  const activity = createActivityBuffer();
  const published: unknown[] = [];
  const states: unknown[] = [];
  activity.record("user", "Build session metadata");
  const summarizer = new SessionSummarySummarizer({
    now: () => 10,
    scheduler,
    activity,
    getAuth: async () => auth() as never,
    generate: (async () => ({ stopReason: "stop", content: [{ type: "text", text: metadataJson() }] })) as never,
    publish: (metadata) => { published.push(metadata); },
    publishState: (state) => { states.push(state); },
  });
  summarizer.schedule("forced", "running");
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((published[0] as { status: string }).status, "Implemented footer-only default and toggle controls.");
  assert.equal((published[0] as { goal: string }).goal, "Make subagent display compact by default.");
  assert.equal((states[0] as { status: string }).status, "Implemented footer-only default and toggle controls.");
  assert.equal("state" in (states[0] as Record<string, unknown>), false);
  assert.equal("model" in (states[0] as Record<string, unknown>), false);
  assert.equal("generatedAt" in (states[0] as Record<string, unknown>), false);
  assert.equal("summary" in (states[0] as Record<string, unknown>), false);
  assert.equal("phase" in (states[0] as Record<string, unknown>), false);
  assert.equal("nextAction" in (states[0] as Record<string, unknown>), false);
});

test("publishes nextStep while actively running", async () => {
  const scheduler = new FakeScheduler();
  const activity = createActivityBuffer();
  const states: unknown[] = [];
  const summarizer = new SessionSummarySummarizer({
    now: () => 10,
    scheduler,
    activity,
    getAuth: async () => auth() as never,
    generate: (async () => ({ stopReason: "stop", content: [{ type: "text", text: metadataJson({ stage: "editing" }) }] })) as never,
    publish: () => {},
    publishState: (state) => { states.push(state); },
  });
  summarizer.schedule("forced", "running");
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((states[0] as { nextStep?: string }).nextStep, "Reload Pi and launch scouts to confirm the UI.");
});

test("publishes blocked and complete stages as metadata", async () => {
  for (const stage of ["blocked", "complete"] as const) {
    const scheduler = new FakeScheduler();
    const activity = createActivityBuffer();
    const states: unknown[] = [];
    const summarizer = new SessionSummarySummarizer({
      now: () => 10,
      scheduler,
      activity,
      getAuth: async () => auth() as never,
      generate: (async () => ({ stopReason: "stop", content: [{ type: "text", text: metadataJson({ stage }) }] })) as never,
      publish: () => {},
      publishState: (state) => { states.push(state); },
    });
    summarizer.schedule("forced", "running");
    scheduler.runNext();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((states[0] as { stage: string }).stage, stage);
    assert.equal("state" in (states[0] as Record<string, unknown>), false);
  }
});

test("includes previous metadata in follow-up prompt", async () => {
  const scheduler = new FakeScheduler();
  const activity = createActivityBuffer();
  const prompts: string[] = [];
  let call = 0;
  const summarizer = new SessionSummarySummarizer({
    now: () => call * 10,
    scheduler,
    activity,
    getAuth: async () => auth() as never,
    generate: (async (_model: unknown, request: { messages: { content: { text: string }[] }[] }) => {
      prompts.push(request.messages[0]?.content[0]?.text ?? "");
      call++;
      return { stopReason: "stop", content: [{ type: "text", text: metadataJson({ status: call === 1 ? "Planning compact subagent display." : "Testing compact subagent display." }) }] };
    }) as never,
    publish: () => {},
    publishState: () => {},
  });
  summarizer.schedule("forced", "running");
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  summarizer.schedule("forced", "running");
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(prompts[1] ?? "", /Previous metadata, for continuity:/);
  assert.match(prompts[1] ?? "", /goal: Make subagent display compact by default\./);
  assert.match(prompts[1] ?? "", /status: Planning compact subagent display\./);
});

test("can preserve previous metadata across per-turn reset", async () => {
  const scheduler = new FakeScheduler();
  const activity = createActivityBuffer();
  const prompts: string[] = [];
  let call = 0;
  const summarizer = new SessionSummarySummarizer({
    now: () => call * 10,
    scheduler,
    activity,
    getAuth: async () => auth() as never,
    generate: (async (_model: unknown, request: { messages: { content: { text: string }[] }[] }) => {
      prompts.push(request.messages[0]?.content[0]?.text ?? "");
      call++;
      return { stopReason: "stop", content: [{ type: "text", text: metadataJson() }] };
    }) as never,
    publish: () => {},
    publishState: () => {},
  });
  summarizer.schedule("forced", "running");
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  summarizer.reset({ keepMetadata: true });
  summarizer.schedule("forced", "running");
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(prompts[1] ?? "", /goal: Make subagent display compact by default\./);
});

test("publishes no model without fake metadata fields", async () => {
  const scheduler = new FakeScheduler();
  const activity = createActivityBuffer();
  const published: unknown[] = [];
  const states: unknown[] = [];
  const summarizer = new SessionSummarySummarizer({
    now: () => 0,
    scheduler,
    activity,
    getAuth: async () => undefined,
    generate: (async () => assert.fail("model should not be called")) as never,
    publish: (metadata) => { published.push(metadata); },
    publishState: (state) => { states.push(state); },
  });
  summarizer.schedule("forced");
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(published.length, 0);
  assert.equal((states[0] as { clear?: boolean }).clear, true);
  assert.equal(typeof (states[0] as { updatedAt?: unknown }).updatedAt, "number");
});

test("marks dirty in-flight activity for one follow-up", async () => {
  const scheduler = new FakeScheduler();
  const activity = createActivityBuffer();
  let resolveGenerate: ((value: unknown) => void) | undefined;
  const summarizer = new SessionSummarySummarizer({
    now: () => 0,
    scheduler,
    activity,
    getAuth: async () => auth() as never,
    generate: (() => new Promise((resolve) => { resolveGenerate = resolve; })) as never,
    publish: () => {},
    publishState: () => {},
  });
  summarizer.schedule("forced");
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  summarizer.schedule("normal");
  summarizer.schedule("normal");
  resolveGenerate?.({ stopReason: "stop", content: [{ type: "text", text: metadataJson() }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.timers.filter((timer) => timer.active).length, 1);
});
