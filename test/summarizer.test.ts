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

test("uses initial debounce before first model call", () => {
  const scheduler = new FakeScheduler();
  const activity = createActivityBuffer();
  activity.record("user", "Build session summaries");
  const summarizer = new SessionSummarySummarizer({
    now: () => 0,
    scheduler,
    activity,
    getAuth: async () => auth() as never,
    generate: (async () => ({ stopReason: "stop", content: [{ type: "text", text: '{"summary":"Planning semantic summaries.","phase":"planning","confidence":0.9}' }] })) as never,
    publish: () => {},
    publishState: () => {},
  });
  summarizer.schedule("initial", "running");
  assert.equal(scheduler.timers[0]?.delayMs, 1_200);
});

test("publishes parsed model JSON", async () => {
  const scheduler = new FakeScheduler();
  const activity = createActivityBuffer();
  const published: unknown[] = [];
  const states: unknown[] = [];
  activity.record("user", "Build session summaries");
  const summarizer = new SessionSummarySummarizer({
    now: () => 10,
    scheduler,
    activity,
    getAuth: async () => auth() as never,
    generate: (async () => ({ stopReason: "stop", content: [{ type: "text", text: '{"summary":"Planning semantic summaries.","phase":"planning","confidence":0.9}' }] })) as never,
    publish: (summary) => { published.push(summary); },
    publishState: (state) => { states.push(state); },
  });
  summarizer.schedule("forced", "running");
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((published[0] as { summary: string }).summary, "Planning semantic summaries.");
  assert.equal((states[0] as { state: string }).state, "running");
});

test("omits nextAction while actively running", async () => {
  const scheduler = new FakeScheduler();
  const activity = createActivityBuffer();
  const states: unknown[] = [];
  const summarizer = new SessionSummarySummarizer({
    now: () => 10,
    scheduler,
    activity,
    getAuth: async () => auth() as never,
    generate: (async () => ({ stopReason: "stop", content: [{ type: "text", text: '{"summary":"Implementing semantic summaries.","phase":"implementing","nextAction":"Keep implementing the extension."}' }] })) as never,
    publish: () => {},
    publishState: (state) => { states.push(state); },
  });
  summarizer.schedule("forced", "running");
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal("nextAction" in (states[0] as Record<string, unknown>), false);
});

test("publishes nextAction when waiting or complete", async () => {
  const scheduler = new FakeScheduler();
  const activity = createActivityBuffer();
  const states: unknown[] = [];
  const summarizer = new SessionSummarySummarizer({
    now: () => 10,
    scheduler,
    activity,
    getAuth: async () => auth() as never,
    generate: (async () => ({ stopReason: "stop", content: [{ type: "text", text: '{"summary":"Completed session-summary validation.","phase":"complete","nextAction":"Run review before reflection."}' }] })) as never,
    publish: () => {},
    publishState: (state) => { states.push(state); },
  });
  summarizer.schedule("forced", "complete");
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((states[0] as { nextAction?: string }).nextAction, "Run review before reflection.");
});

test("publishes no_model state without fake summary", async () => {
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
    publish: (summary) => { published.push(summary); },
    publishState: (state) => { states.push(state); },
  });
  summarizer.schedule("forced");
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(published.length, 0);
  assert.equal((states[0] as { state: string }).state, "no_model");
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
  resolveGenerate?.({ stopReason: "stop", content: [{ type: "text", text: '{"summary":"Testing follow-up scheduling.","phase":"testing"}' }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.timers.filter((timer) => timer.active).length, 1);
});
