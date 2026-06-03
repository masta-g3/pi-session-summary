# pi-tldr-lite

Lightweight semantic TLDRs for Pi coding-agent sessions.

`pi-tldr-lite` is a Pi extension package that uses a fast LLM to summarize what an agent is currently doing in workflow terms, then renders that status in-session and exports latest-only structured state for Pi Agent Hub.

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
/tldr-lite status
/tldr-lite on
/tldr-lite off
/tldr-lite refresh
/tldr-lite name
```

## Configuration

```json
{
  "tldrLite": {
    "model": "openai-codex/gpt-5.4-mini"
  }
}
```

If `tldrLite.model` is absent, the extension can also read the compatibility setting `tldr.model`. If neither setting resolves to an authenticated model, it tries fast Codex-first defaults.

The same model is used for optional session naming. The extension auto-names unnamed sessions from the first user prompt, and `/tldr-lite name` refreshes the name from conversation history.

## Agent Hub output

When running inside a Pi Agent Hub managed session, the extension writes latest-only state to:

```text
${PI_AGENT_HUB_DIR}/tldr/${PI_AGENT_HUB_SESSION_ID}.json
```

Only summary metadata is written: current summary, phase, optional next action for waiting, reviewing, blocked, or complete states, confidence, and model. Raw prompts, tool arguments, command output, and conversation snippets stay out of the state file.

## Privacy and performance

Short recent activity snippets are sent to the configured TLDR model provider. Model calls are asynchronous, throttled, timeout-bound, no-retry, and never awaited by Pi event handlers.

## Workflow

Implementation plans and backlog state live under `agent-work/`.

- `agent-work/features.yaml` — feature backlog
- `agent-work/plans/` — active implementation plans
- `agent-work/history/` — completed plan archives
- `agent-work/tickets/` — temporary ticket artifacts
