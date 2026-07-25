import assert from "node:assert/strict";
import { test } from "node:test";
import { createActivityBuffer } from "../src/activity.js";
import { SessionSummarySummarizer, SYSTEM_PROMPT, type TimerScheduler } from "../src/summarizer.js";

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

test("prompt guides status and nextStep toward latest exchange evidence", () => {
  assert.match(SYSTEM_PROMPT, /For status, prioritize the latest user-agent exchange/);
  assert.match(SYSTEM_PROMPT, /For nextStep, prioritize the latest explicit user request/);
  assert.match(SYSTEM_PROMPT, /do not reuse previous status or nextStep unless latest activity independently supports it/);
});

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

test("flushes pending final metadata without waiting for debounce", async () => {
  const scheduler = new FakeScheduler();
  const activity = createActivityBuffer();
  const states: unknown[] = [];
  let calls = 0;
  activity.record("final", "Explained metadata quality behavior.");
  const summarizer = new SessionSummarySummarizer({
    now: () => 10,
    scheduler,
    activity,
    getAuth: async () => auth() as never,
    generate: (async (_model: unknown, request: { messages: { content: { text: string }[] }[] }) => {
      calls++;
      assert.match(request.messages[0]?.content[0]?.text ?? "", /Agent state: complete/);
      return { stopReason: "stop", content: [{ type: "text", text: metadataJson({ stage: "complete", status: "Metadata quality behavior explained", nextStep: "" }) }] };
    }) as never,
    publish: () => {},
    publishState: (state) => { states.push(state); },
  });
  summarizer.schedule("final", "complete");
  assert.equal(scheduler.timers[0]?.delayMs, 500);

  await summarizer.flushPending("complete");

  assert.equal(calls, 1);
  assert.equal(scheduler.timers.some((timer) => timer.active), false);
  assert.equal((states[0] as { stage: string }).stage, "complete");
});

test("flush waits for in-flight metadata before final follow-up", async () => {
  const scheduler = new FakeScheduler();
  const activity = createActivityBuffer();
  const states: unknown[] = [];
  let resolveGenerate: ((value: unknown) => void) | undefined;
  let calls = 0;
  const prompts: string[] = [];
  activity.record("user", "Explain metadata history.");
  const summarizer = new SessionSummarySummarizer({
    now: () => 10,
    scheduler,
    activity,
    getAuth: async () => auth() as never,
    generate: ((_: unknown, request: { messages: { content: { text: string }[] }[] }) => {
      calls++;
      prompts.push(request.messages[0]?.content[0]?.text ?? "");
      if (calls === 1) return new Promise((resolve) => { resolveGenerate = resolve; });
      return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: metadataJson({
        stage: "complete",
        status: "Metadata history explained",
        nextStep: "",
        attention: { kind: "ready", text: "Metadata history ready for review" },
      }) }] });
    }) as never,
    publish: () => {},
    publishState: (state) => { states.push(state); },
  });
  summarizer.schedule("forced", "running");
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));

  activity.record("final", "Metadata history explained.");
  const flush = summarizer.flushPending("complete", 1_000);
  resolveGenerate?.({ stopReason: "stop", content: [{ type: "text", text: metadataJson({
    stage: "complete",
    status: "Premature completion claim",
    attention: { kind: "ready", text: "Must be stripped from running request" },
  }) }] });
  await flush;

  assert.equal(calls, 2);
  assert.match(prompts[1] ?? "", /Agent state: complete/);
  assert.equal((states[0] as { attention?: unknown }).attention, undefined);
  assert.deepEqual((states.at(-1) as { attention?: unknown }).attention, { kind: "ready", text: "Metadata history ready for review" });
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

test("retains attention only after the agent yields", async () => {
  for (const item of [
    { agentState: "complete", stage: "complete", kind: "ready" },
    { agentState: "waiting", stage: "waiting", kind: "question" },
    { agentState: "waiting", stage: "blocked", kind: "blocked" },
  ] as const) {
    const scheduler = new FakeScheduler();
    const activity = createActivityBuffer();
    const published: unknown[] = [];
    const states: unknown[] = [];
    const summarizer = new SessionSummarySummarizer({
      now: () => 10,
      scheduler,
      activity,
      getAuth: async () => auth() as never,
      generate: (async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: metadataJson({
          stage: item.stage,
          attention: { kind: item.kind, text: "Human action needed" },
        }) }],
      })) as never,
      publish: (metadata) => { published.push(metadata); },
      publishState: (state) => { states.push(state); },
    });
    summarizer.schedule("forced", item.agentState);
    scheduler.runNext();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual((published[0] as { attention?: unknown }).attention, { kind: item.kind, text: "Human action needed" });
    assert.deepEqual((states[0] as { attention?: unknown }).attention, { kind: item.kind, text: "Human action needed" });
    assert.deepEqual(summarizer.previousMetadata()?.attention, { kind: item.kind, text: "Human action needed" });
  }
});

test("strips model attention from every running metadata copy", async () => {
  const scheduler = new FakeScheduler();
  const activity = createActivityBuffer();
  const published: unknown[] = [];
  const states: unknown[] = [];
  const summarizer = new SessionSummarySummarizer({
    now: () => 10,
    scheduler,
    activity,
    getAuth: async () => auth() as never,
    generate: (async () => ({
      stopReason: "stop",
      content: [{ type: "text", text: metadataJson({
        stage: "complete",
        attention: { kind: "ready", text: "Should not leak mid-turn" },
      }) }],
    })) as never,
    publish: (metadata) => { published.push(metadata); },
    publishState: (state) => { states.push(state); },
  });
  summarizer.schedule("forced", "running");
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((published[0] as { attention?: unknown }).attention, undefined);
  assert.equal((states[0] as { attention?: unknown }).attention, undefined);
  assert.equal(summarizer.previousMetadata()?.attention, undefined);
});

test("uses a response budget large enough for bounded attention metadata", async () => {
  const scheduler = new FakeScheduler();
  const activity = createActivityBuffer();
  let maxTokens = 0;
  const summarizer = new SessionSummarySummarizer({
    now: () => 10,
    scheduler,
    activity,
    getAuth: async () => auth() as never,
    generate: (async (_model: unknown, _request: unknown, options: { maxTokens: number }) => {
      maxTokens = options.maxTokens;
      return { stopReason: "stop", content: [{ type: "text", text: metadataJson() }] };
    }) as never,
    publish: () => {},
    publishState: () => {},
  });
  summarizer.schedule("forced", "running");
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxTokens, 320);
});

test("includes workflow context in prompt at request time", async () => {
  const scheduler = new FakeScheduler();
  const activity = createActivityBuffer();
  const prompts: string[] = [];
  let contextCalls = 0;
  const summarizer = new SessionSummarySummarizer({
    now: () => 10,
    scheduler,
    activity,
    getAuth: async () => auth() as never,
    getWorkflowContext: async () => {
      contextCalls++;
      return {
        ticketId: "metadata-002",
        description: "Workflow-grounded session metadata",
        planFile: "agent-work/plans/metadata-002.md",
        latestCompletedTodo: "Implement workflow context reader",
        nextOpenTodo: "Wire context into summarizer prompt",
        planProgress: {
          phaseIndex: 2,
          phaseCount: 4,
          title: "Integrate workflow context",
          completed: 1,
          total: 3,
        },
        evidence: "explicit-ticket",
      };
    },
    generate: (async (_model: unknown, request: { messages: { content: { text: string }[] }[] }) => {
      prompts.push(request.messages[0]?.content[0]?.text ?? "");
      return { stopReason: "stop", content: [{ type: "text", text: metadataJson() }] };
    }) as never,
    publish: () => {},
    publishState: () => {},
  });
  summarizer.schedule("forced", "running");
  assert.equal(contextCalls, 0);
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(contextCalls, 1);
  assert.match(prompts[0] ?? "", /Workflow context from repo files, if explicit:/);
  assert.match(prompts[0] ?? "", /ticket: metadata-002/);
  assert.match(prompts[0] ?? "", /nextOpenTodo: Wire context into summarizer prompt/);
  assert.match(prompts[0] ?? "", /planPhase: 2\/4 Integrate workflow context/);
  assert.match(prompts[0] ?? "", /phaseProgress: 1\/3/);
});

test("formats absent workflow context as none", async () => {
  const scheduler = new FakeScheduler();
  const activity = createActivityBuffer();
  let prompt = "";
  const summarizer = new SessionSummarySummarizer({
    now: () => 10,
    scheduler,
    activity,
    getAuth: async () => auth() as never,
    getWorkflowContext: async () => undefined,
    generate: (async (_model: unknown, request: { messages: { content: { text: string }[] }[] }) => {
      prompt = request.messages[0]?.content[0]?.text ?? "";
      return { stopReason: "stop", content: [{ type: "text", text: metadataJson() }] };
    }) as never,
    publish: () => {},
    publishState: () => {},
  });
  summarizer.schedule("forced", "running");
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(prompt, /Workflow context from repo files, if explicit:\nnone/);
});

test("treats workflow context failures as absent context", async () => {
  const scheduler = new FakeScheduler();
  const activity = createActivityBuffer();
  let prompt = "";
  const states: unknown[] = [];
  const summarizer = new SessionSummarySummarizer({
    now: () => 10,
    scheduler,
    activity,
    getAuth: async () => auth() as never,
    getWorkflowContext: async () => { throw new Error("unreadable workflow file"); },
    generate: (async (_model: unknown, request: { messages: { content: { text: string }[] }[] }) => {
      prompt = request.messages[0]?.content[0]?.text ?? "";
      return { stopReason: "stop", content: [{ type: "text", text: metadataJson() }] };
    }) as never,
    publish: () => {},
    publishState: (state) => { states.push(state); },
  });
  summarizer.schedule("forced", "running");
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(prompt, /Workflow context from repo files, if explicit:\nnone/);
  assert.equal((states[0] as { status: string }).status, "Implemented footer-only default and toggle controls.");
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

test("per-turn reset preserves narrative metadata but clears attention continuity", async () => {
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
      return { stopReason: "stop", content: [{ type: "text", text: metadataJson({
        stage: "complete",
        attention: { kind: "ready", text: "Ready for review" },
      }) }] };
    }) as never,
    publish: () => {},
    publishState: () => {},
  });
  summarizer.schedule("forced", "complete");
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(summarizer.previousMetadata()?.attention?.kind, "ready");

  summarizer.reset({ keepMetadata: true, clearAttention: true });
  assert.equal(summarizer.previousMetadata()?.attention, undefined);
  summarizer.schedule("forced", "running");
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(prompts[1] ?? "", /goal: Make subagent display compact by default\./);
  assert.doesNotMatch(prompts[1] ?? "", /Ready for review|attention:/);
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
