import assert from "node:assert/strict";
import { test } from "node:test";
import { createActivityBuffer } from "../src/activity.js";
import { SessionSummarySummarizer, type TimerScheduler } from "../src/summarizer.js";
import type { WorkflowContext } from "../src/workflow.js";

class FakeScheduler implements TimerScheduler {
  callback: (() => void) | undefined;
  setTimeout(callback: () => void): unknown { this.callback = callback; return callback; }
  clearTimeout(): void { this.callback = undefined; }
  run(): void { const callback = this.callback; this.callback = undefined; callback?.(); }
}

function auth() {
  return { model: { provider: "openai-codex", id: "gpt-5.4-mini" }, apiKey: "key" };
}

const ticketContext: WorkflowContext = {
  ticketId: "metadata-002",
  description: "Workflow-grounded session metadata and titles for dashboard supervision",
  planFile: "agent-work/plans/metadata-002.md",
  latestCompletedTodo: "Implement workflow context reader",
  nextOpenTodo: "Wire context into summarizer prompt",
  evidence: "explicit-ticket",
};

test("simulates workflow-grounded metadata without leaking raw context", async () => {
  const result = await simulate({
    context: ticketContext,
    activity: [
      ["user", "execute metadata-002"],
      ["assistant", "Implemented workflow context reader and parser tests."],
      ["result", "npm test finished: passing"],
    ],
    response: {
      goal: "metadata-002: Workflow-grounded session metadata and titles for dashboard supervision",
      status: "Workflow context reader tests passing",
      nextStep: "Wire context into summarizer prompt",
      stage: "testing",
      confidence: 0.9,
    },
  });

  assert.match(result.prompt, /ticket: metadata-002/);
  assert.match(result.prompt, /nextOpenTodo: Wire context into summarizer prompt/);
  assert.equal(result.state.goal, "metadata-002: Workflow-grounded session metadata and titles for dashboard supervision");
  assert.equal(result.state.nextStep, "Wire context into summarizer prompt");
  assert.equal("planFile" in result.state, false);
  assert.equal("latestCompletedTodo" in result.state, false);
});

test("simulates non-ticket prompt without inheriting active workflow context", async () => {
  const result = await simulate({
    context: undefined,
    activity: [["user", "explain what this extension does"]],
    response: {
      goal: "Explain pi-session-summary behavior",
      status: "Extension behavior explained",
      stage: "complete",
      confidence: 0.86,
    },
  });

  assert.match(result.prompt, /Workflow context from repo files, if explicit:\nnone/);
  assert.equal(result.state.nextStep, undefined);
  assert.equal(result.state.stage, "complete");
});

test("simulates blocked handoff need as explicit next step", async () => {
  const result = await simulate({
    context: undefined,
    activity: [
      ["user", "Run the browser smoke test"],
      ["result", "browser executable missing"],
      ["final", "Cannot run browser smoke until Playwright browsers are installed."],
    ],
    response: {
      goal: "Run browser smoke test",
      status: "Browser smoke blocked by missing executable",
      nextStep: "Needs Playwright browser install",
      stage: "blocked",
      confidence: 0.9,
    },
  });

  assert.equal(result.state.stage, "blocked");
  assert.equal(result.state.nextStep, "Needs Playwright browser install");
});

test("simulates explicit final attention and strips the same claim mid-turn", async () => {
  for (const item of [
    { kind: "ready", stage: "complete", agentState: "complete", text: "Implementation ready for review" },
    { kind: "question", stage: "waiting", agentState: "waiting", text: "Choose the rollout order" },
    { kind: "blocked", stage: "blocked", agentState: "waiting", text: "Needs production credentials" },
  ] as const) {
    const input = {
      context: ticketContext,
      activity: [["final", item.text]] as ["final", string][],
      response: {
        goal: "workflow-board-001: Attention overlay",
        status: item.text,
        stage: item.stage,
        confidence: 0.9,
        attention: { kind: item.kind, text: item.text },
      },
    };
    const final = await simulate({ ...input, agentState: item.agentState });
    assert.deepEqual(final.state.attention, { kind: item.kind, text: item.text });
    const running = await simulate({ ...input, agentState: "running" });
    assert.equal(running.state.attention, undefined);
  }
});

async function simulate(options: {
  context: WorkflowContext | undefined;
  activity: ["user" | "assistant" | "tool" | "result" | "final" | "error", string][];
  response: Record<string, unknown>;
  agentState?: "running" | "waiting" | "complete" | "blocked";
}): Promise<{ prompt: string; state: Record<string, unknown> }> {
  const scheduler = new FakeScheduler();
  const activity = createActivityBuffer();
  for (const [kind, text] of options.activity) activity.record(kind, text);
  let prompt = "";
  let state: Record<string, unknown> = {};
  const summarizer = new SessionSummarySummarizer({
    now: () => 100,
    scheduler,
    activity,
    getAuth: async () => auth() as never,
    getWorkflowContext: async () => options.context,
    generate: (async (_model: unknown, request: { messages: { content: { text: string }[] }[] }) => {
      prompt = request.messages[0]?.content[0]?.text ?? "";
      return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify(options.response) }] };
    }) as never,
    publish: () => {},
    publishState: (metadata) => { state = metadata as Record<string, unknown>; },
  });
  summarizer.schedule("forced", options.agentState ?? "running");
  scheduler.run();
  await new Promise((resolve) => setImmediate(resolve));
  return { prompt, state };
}
