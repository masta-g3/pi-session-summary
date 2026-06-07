# pi-session-summary

Semantic session summaries and naming for Pi coding-agent sessions.

`pi-session-summary` is a Pi extension package that uses a fast LLM to summarize what an agent is currently doing in workflow terms, then renders that status in-session and exports latest-only structured state for Pi Agent Hub.

## Main elements

The extension produces four semantic elements:

| Element | Purpose |
| --- | --- |
| Session name | Short title generated from the first prompt or conversation history. |
| Summary | One-sentence description of what the agent is doing now. |
| Stage label | Workflow phase such as `planning`, `implementing`, `testing`, `waiting`, or `blocked`. |
| Next action | Optional guidance only when the session is waiting, blocked, reviewing, or complete. |

Internally, the extension captures bounded activity facts such as user prompts, assistant text, tool starts/results, final messages, and errors. Those activity facts are inputs for the model only; they are not the main product output and are not written to Agent Hub state.

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

The state file uses `"source": "pi-session-summary"`.

Only generated metadata is written: current summary, stage label (`phase`), optional next action for waiting, reviewing, blocked, or complete states, confidence, and model. Raw prompts, tool arguments, command output, and conversation snippets stay out of the state file.

## Privacy and performance

Short recent activity snippets are sent to the configured summary model provider. Model calls are asynchronous, throttled, timeout-bound, no-retry, and never awaited by Pi event handlers.

## Workflow

Implementation plans and backlog state live under `agent-work/`.

- `agent-work/features.yaml` — feature backlog
- `agent-work/plans/` — active implementation plans
- `agent-work/history/` — completed plan archives
- `agent-work/tickets/` — temporary ticket artifacts
