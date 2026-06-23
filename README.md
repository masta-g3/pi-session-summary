# pi-session-summary

Semantic session metadata and naming for Pi coding-agent sessions.

`pi-session-summary` is a Pi extension package that uses a fast LLM to infer what an agent session is trying to accomplish, what changed most recently, and what should happen next. It renders a compact in-session status and exports latest-only structured metadata for Pi Agent Hub or dashboard views.

When a repo uses Pi's lightweight `agent-work/` workflow files, the extension also uses that context to ground ticket dashboards: session names can become `ticket-id: abbreviated objective`, `goal` uses the tracked ticket objective, and `nextStep` prefers the next explicit unchecked plan item. This remains optional; the extension works normally without workflow files.

## Main elements

The extension produces dashboard-oriented semantic metadata:

| Element | Purpose |
| --- | --- |
| Session name | Ticket title when workflow context exists; otherwise short title generated from the first prompt or conversation history. |
| Goal | Durable user-facing objective for the session or workflow ticket. |
| Status | Terse latest verified progress achieved by the main agent. |
| Next step | Short explicit planned action or need, when evidenced. |
| Stage | Current mode: `reading`, `editing`, `testing`, `waiting`, `blocked`, or `complete`. |

The in-session UI intentionally shows only the **status** widget above the editor. The fuller semantic set exists for session-management dashboards or Agent Hub views where many sessions need compact goal, status, stage, and next-step display.

Internally, the extension captures bounded activity facts such as user prompts, assistant text, tool starts/results, final messages, and errors. Those activity facts are inputs for the model only; they are not the product output and are not written to Agent Hub state.

If `agent-work/features.yaml` and a feature `plan_file` are present, the extension reads only compact workflow evidence: ticket id, description, latest checked checklist item, and next unchecked checklist item. It does not mutate workflow files, does not require Hub, and does not write raw plan contents to metadata.

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

The same model is used for optional session naming. The extension auto-names unnamed non-workflow sessions from the first user prompt, and `/session-summary name` refreshes the name from conversation history.

For workflow-ticket sessions, naming is deterministic when context is available: `ticket-id: abbreviated objective`. Pi Agent Hub can display that name through its existing Pi-name sync actions or shortcuts; the metadata file itself does not contain a session-name field.

## Agent Hub output

When running inside a Pi Agent Hub managed session, the extension writes latest-only metadata to Hub's generic metadata path:

```text
${PI_AGENT_HUB_DIR}/session-metadata/${PI_AGENT_HUB_SESSION_ID}.json
```

```ts
interface HubSessionMetadataFile {
  source?: "pi-session-summary";
  goal?: string;
  status?: string;
  nextStep?: string;
  stage?: "reading" | "editing" | "testing" | "waiting" | "complete" | "blocked" | "unknown";
  confidence?: number;
  updatedAt?: number;
}
```

Hub displays metadata when at least one of `goal`, `status`, `nextStep`, or `stage` exists and `confidence` is missing or at least `0.5`. `stage` is the model-inferred semantic workflow stage; Hub process liveness comes from Hub, not this file. Raw prompts, tool arguments, command output, plan text, and conversation snippets stay out of the metadata file.

## Privacy and performance

Short recent activity snippets and compact optional workflow evidence are sent to the configured summary model provider. Model calls are asynchronous, throttled, timeout-bound, no-retry, and never awaited by Pi event handlers. `nextStep` is intended to come from explicit evidence such as a stated plan, unchecked todo, user request, or handoff need, not from summarizer speculation.

## Workflow

Implementation plans and backlog state live under `agent-work/`.

- `agent-work/features.yaml` — feature backlog
- `agent-work/plans/` — active implementation plans
- `agent-work/history/` — completed plan archives
- `agent-work/tickets/` — temporary ticket artifacts
