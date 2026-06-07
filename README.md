# pi-session-summary

Semantic session metadata and naming for Pi coding-agent sessions.

`pi-session-summary` is a Pi extension package that uses a fast LLM to infer what an agent session is trying to accomplish, what changed most recently, and what should happen next. It renders a compact in-session status and exports latest-only structured metadata for Pi Agent Hub or dashboard views.

## Main elements

The extension produces dashboard-oriented semantic metadata:

| Element | Purpose |
| --- | --- |
| Session name | Short dashboard title generated from the first prompt or conversation history. |
| Goal | Short durable user-facing outcome for the session. |
| Status | Concise latest progress or current action in context of the goal. |
| Next step | Short next useful step toward the goal, when known. |
| Stage | Broad workflow stage such as `planning`, `implementing`, `testing`, `waiting`, or `blocked`. |

The in-session UI intentionally shows only the **status** widget above the editor. The fuller semantic set exists for session-management dashboards or Agent Hub views where many sessions need compact goal, status, stage, and next-step display.

Internally, the extension captures bounded activity facts such as user prompts, assistant text, tool starts/results, final messages, and errors. Those activity facts are inputs for the model only; they are not the product output and are not written to Agent Hub state.

## Requirements

- Node.js `>=22.19.0`
- npm
- Pi coding agent `0.78.x`

## Setup

```bash
npm install
npm test
```

## Run with Pi

```bash
pi -e ./src/index.ts
```

## Commands

```text
/session-summary status
/session-summary on
/session-summary off
/session-summary refresh
/session-summary name
```

## Configuration

```json
{
  "sessionSummary": {
    "model": "openai-codex/gpt-5.4-mini"
  }
}
```

If `sessionSummary.model` is absent or does not resolve to an authenticated model, the extension tries fast Codex-first defaults.

The same model is used for optional session naming. The extension auto-names unnamed sessions from the first user prompt, and `/session-summary name` refreshes the name from conversation history.

## Agent Hub output

When running inside a Pi Agent Hub managed session, the extension writes latest-only state to:

```text
${PI_AGENT_HUB_DIR}/session-summary/${PI_AGENT_HUB_SESSION_ID}.json
```

The state file uses `"source": "pi-session-summary"` and `"version": 2`.

```ts
interface SessionSummaryStateFile {
  version: 2;
  source: "pi-session-summary";
  sessionId?: string;
  cwd: string;
  state: "starting" | "running" | "waiting" | "complete" | "blocked" | "disabled" | "no_model" | "error" | "shutdown";
  sessionName?: string;
  goal?: string;
  status?: string;
  stage?: "starting" | "planning" | "investigating" | "implementing" | "testing" | "debugging" | "reviewing" | "waiting" | "complete" | "blocked" | "unknown";
  nextStep?: string;
  confidence?: number;
  model?: string;
  sequence: number;
  updatedAt: number;
  generatedAt?: number;
  error?: string;
}
```

`state` is extension/liveness state. `stage` is the model-inferred semantic workflow stage. Raw prompts, tool arguments, command output, and conversation snippets stay out of the state file.

## Privacy and performance

Short recent activity snippets are sent to the configured summary model provider. Model calls are asynchronous, throttled, timeout-bound, no-retry, and never awaited by Pi event handlers.

## Workflow

Implementation plans and backlog state live under `agent-work/`.

- `agent-work/features.yaml` — feature backlog
- `agent-work/plans/` — active implementation plans
- `agent-work/history/` — completed plan archives
- `agent-work/tickets/` — temporary ticket artifacts
