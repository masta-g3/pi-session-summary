# pi-session-summary

Semantic session metadata and naming for Pi coding-agent sessions.

`pi-session-summary` is a Pi extension package that uses a fast LLM to infer what an agent session is trying to accomplish, what changed most recently, and what should happen next. It renders compact in-session progress and exports latest-only structured metadata for Pi Agent Hub or dashboard views.

When a repo uses Pi's lightweight `agent-work/` workflow files, the extension also uses that context to ground ticket dashboards and show deterministic plan progress: an authored feature `title` becomes the compact `plan.feature` and explicit workflow session name, `goal` uses the full tracked objective, and deterministic plan `nextStep` uses the next unchecked item. This remains optional; the extension works normally without workflow files.

## Main elements

The extension produces dashboard-oriented semantic metadata and optional in-session plan progress:

| Element | Purpose |
| --- | --- |
| Session name | Authored feature title when a workflow ticket is explicit; otherwise a 2–5-word plain title generated from the first prompt or conversation history. |
| Goal | Durable user-facing objective for the session or workflow ticket. |
| Status | Terse latest verified progress achieved by the main agent. |
| Next step | Short imperative action, when evidenced. |
| Stage | Current mode: `reading`, `editing`, `testing`, `waiting`, `blocked`, or `complete`. |
| Attention | Explicit final `ready`, `question`, or `blocked` reason when human action is useful. |
| Plan progress | Current Markdown phase, completed task count, and next unchecked task in the widget and optional Hub metadata. |
| Plan todo drawer | On-demand read-only view of every executable task in the active repo-local plan. |

For an active phased plan, the in-session widget shows deterministic phase progress and the next unchecked task:

```text
Phase 2/4 · Add skill skeleton
✓ 1/4 tasks · Next: Create routing.md
```

Without one, it falls back to semantic status plus an evidenced next step when available:

```text
EDITING · Updating workflow parser
Next: Add phase parsing tests
```

Run `/session-summary todos` or press `Ctrl+Alt+T` to open a focused right-side drawer containing the full active-plan checklist. Use `Up`/`Down` or `PageUp`/`PageDown` to scroll, then `Esc` or `Ctrl+Alt+T` to close it. The drawer is TUI-only, read-only, hidden by default, and never persisted. It uses Pi 0.78's experimental overlay API.

The fuller semantic set also exists for session-management dashboards or Agent Hub views.

Internally, the extension captures bounded activity facts such as user prompts, assistant text, tool starts/results, final messages, and errors. Those activity facts are inputs for the model only; they are not the product output and are not written to Agent Hub state.

If `agent-work/features.yaml` and a feature `plan_file` are present, the extension derives compact model evidence—ticket id, optional authored `title`, full description, latest checked item, next unchecked item, and progress for numbered `Phase` or `Stage` headings—and a separate local TUI plan snapshot. The authored title supplies `plan.feature`; the description remains model context and is not substituted into that compact field. The drawer shows all checkboxes under populated numbered phases/stages, including checklists below same-level helper headings until the next numbered phase or a higher-level heading, while excluding checkboxes outside those sections. Legacy plans without numbered sections show all flat checklist items. It follows the repo-local `plan_file` and has no dependency on a particular rules repository. Flat checklists do not produce a phase-progress widget, but may publish title and next-task metadata. The extension does not mutate workflow files, require Hub, or send or publish the full checklist.

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
/session-summary todos
```

`Ctrl+Alt+T` toggles the same todo drawer while the TUI is active.

## Configuration

```json
{
  "sessionSummary": {
    "model": "openai-codex/gpt-5.4-mini"
  }
}
```

If `sessionSummary.model` is absent or does not resolve to an authenticated model, the extension tries fast Codex-first defaults.

The same model is used for optional session naming. The extension auto-names unnamed non-workflow sessions from the first user prompt, and `/session-summary name` refreshes the name from conversation history. Generated names use 2–5 plain, concrete words, avoid invented abbreviations, and are capped at 48 characters.

For workflow-ticket sessions, naming is deterministic only when the ticket is explicit in the prompt or `set_workflow_ticket` call. An authored feature `title` is used directly without a ticket prefix; title-less records retain the existing bounded ticket/description fallback. Inferred single-in-progress context can ground metadata and plan progress, but cannot rename a session. Pi Agent Hub can display the resulting name through its existing Pi-name sync actions or shortcuts; the metadata file itself does not contain a session-name field.

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
  attention?: {
    kind: "ready" | "question" | "blocked";
    text: string;
  };
  updatedAt?: number;
  plan?: {
    feature?: string;
    phase?: { title: string; index: number; count: number };
    tasks?: { completed: number; total: number };
    nextStep?: string;
  };
}
```

The optional `plan` object is mapped from the same cached workflow context used by the widget; it does not trigger another plan read. `plan.feature` is the authored short feature title, not the full description. It is published even when no summary model is available and is independent of semantic `confidence`. Once a prompt or `set_workflow_ticket` call explicitly selects a ticket, that ticket remains attached across ordinary follow-up turns instead of letting running work clear its plan. A new explicit ticket replaces it. Checklist refreshes update the cache at turn start, after every tool result, and before each authenticated semantic-summary model call; each changed projection uses the serialized atomic write path. Later resolution with no mapped title, phase, task, or next-step data removes `plan`. Deterministic checklist actions retain their existing sanitized 120-character bound; semantic model `nextStep` is capped at 48 characters.

Hub displays general semantic metadata when at least one of `goal`, `status`, `nextStep`, or `stage` exists and `confidence` is missing or at least `0.5`; valid deterministic plan data remains separately displayable. Attention is stricter: it requires confidence of at least `0.5`, nonblank text, and `ready/complete`, `question/waiting`, or `blocked/blocked` agreement. The summarizer retains it only for requests launched after the agent has yielded; running requests strip it before either metadata copy is updated. At `before_agent_start`, both the latest-file source and previous-metadata prompt continuity are cleared and the file is rewritten before later model, plan, naming, no-model, or failure paths.

`stage` is model-inferred semantic activity, attention is an explicit human-action claim, and Hub process liveness is authoritative separately. Ordinary waiting does not imply attention. Hub renders the attention reason only in its `v` board for waiting/idle Active rows; canonical workflow metadata is not required because non-workflow Active sessions render in `OTHER ACTIVE`. Groups view does not show the marker. Raw prompts, tool arguments, command output, the full checklist, completion evidence/usage telemetry, and conversation snippets stay out of the metadata file.

For debugging, set `PI_SESSION_SUMMARY_METADATA_HISTORY=1` to append each successful metadata derivation as JSONL:

```text
${PI_AGENT_HUB_DIR}/session-metadata-history/${PI_AGENT_HUB_SESSION_ID}.jsonl
```

Each line includes the Hub session id, generated timestamp, activity sequence, optional `userTurn` correlation number, model id, and sanitized derived metadata including accepted attention. The quality report checks attention shape, confidence, and stage agreement so sampled false claims can be inspected. Raw prompts, tool arguments/results, workflow plan text, and conversation snippets are not written to the history log.

To inspect a captured history file, run:

```bash
npm run metadata:quality -- ${PI_AGENT_HUB_DIR}/session-metadata-history/${PI_AGENT_HUB_SESSION_ID}.jsonl
```

## Privacy and performance

Short recent activity snippets and compact optional workflow evidence are sent to the configured summary model provider. Model calls are asynchronous, throttled, timeout-bound, no-retry, and never awaited by Pi event handlers: turn start schedules after 1.2 seconds, activity/tool updates debounce for at least 2 seconds and respect a 5-second minimum model interval, and final output schedules after 0.5 seconds. Tool completion separately refreshes deterministic plan data immediately, so checkbox progress does not wait for the model. Hub rereads the latest metadata file on its approximately one-second dashboard refresh loop. Semantic `nextStep` is an imperative action, ideally 2–7 words and at most 48 characters, grounded in a stated plan, unchecked todo, user request, or explicit handoff. Passive state such as “Awaiting reflection handoff” belongs in status or attention rather than `nextStep`. Attention is omission-biased: ambiguous completion, uncertainty, or work that can continue produces no attention object.

## Workflow

Implementation plans and backlog state live under `agent-work/`.

- `agent-work/features.yaml` — feature backlog
- `agent-work/plans/` — active implementation plans
- `agent-work/history/` — completed plan archives
- `agent-work/tickets/` — temporary ticket artifacts
