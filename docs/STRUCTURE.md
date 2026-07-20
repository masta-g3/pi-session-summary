# pi-session-summary Structure

## Vision

`pi-session-summary` provides semantic, glanceable session metadata for Pi coding-agent sessions.

The project solves a supervision problem: deterministic statuses like `running`, `waiting`, or terminal previews do not explain what each agent is trying to accomplish. The extension uses a fast LLM to infer:

- the durable session or workflow-ticket goal
- the latest status in context of that goal
- the next explicit evidenced step
- a broad workflow stage

Target users:

- Pi users who supervise multiple coding-agent sessions.
- Pi Agent Hub users who need dashboard-native semantic status.
- Maintainers who want a focused, lightweight semantic status package.

Core experience:

1. Install or load the Pi extension.
2. Run a Pi session normally.
3. The extension optionally reads compact repo workflow context from `agent-work/features.yaml` and feature plan checklists when present.
4. The extension asynchronously summarizes recent agent activity with a configured fast model.
5. The user sees deterministic phase progress for active plans, or semantic status when no phased plan is available.
6. When running under Pi Agent Hub, the extension writes latest-only structured metadata for dashboard display.
7. When `PI_SESSION_SUMMARY_METADATA_HISTORY=1` is set, successful derivations are also appended as JSONL for debugging.

## Tech Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | Node.js `>=22.19.0` | Matches local Pi `0.78.x` engine requirements. |
| Language | TypeScript, ESM | Pi packages are TypeScript-friendly; strict types keep the small codebase safe. |
| Extension host | `@earendil-works/pi-coding-agent` | Provides Pi lifecycle events, commands, settings, and UI hooks. |
| Model access | `@earendil-works/pi-ai` | LLM completion interface and provider auth handling. |
| TUI helpers | `@earendil-works/pi-tui` | Width-safe rendering for terminal widgets. |
| Tests | Node test runner | Minimal dependency footprint; enough for pure logic and scheduler tests. |
| Workflow | `agent-work/` | Multi-session plans, backlog, history, and temporary ticket artifacts. |

## Architecture

The package is intentionally a standalone Pi extension, not a Pi Agent Hub-only feature. The extension runs inside the Pi session where semantic event context is available. Agent Hub can consume the produced metadata file without owning model calls or scraping terminal output.

```mermaid
flowchart TD
  Session[Pi session] --> Extension[pi-session-summary extension]
  Extension --> Activity[Activity buffer]
  Activity --> Scheduler[One-in-flight summarizer]
  Workflow[Optional agent-work context] --> Scheduler
  Workflow --> Widget[In-session plan/status widget]
  Scheduler --> Model[Fast metadata model]
  Model --> Publish[Sanitize and publish]
  Publish --> Widget
  Publish --> State[Latest metadata JSON]
  Publish --> History[Debug metadata JSONL]
  State --> Hub[Future Pi Agent Hub reader]
```

## Directory Layout

```text
pi-session-summary/
  agent-work/
    features.yaml              # backlog and ticket status
    plans/                     # active implementation plans
    history/                   # archived completed plans
    tickets/                   # temporary validation artifacts
  docs/
    STRUCTURE.md               # living architecture and vision document
  src/
    index.ts                   # Pi lifecycle wiring and /session-summary command
    activity.ts                # compact bounded activity buffer
    summarizer.ts              # throttled model-call scheduler and prompt builder
    models.ts                  # sessionSummary.model setting and auth/model resolution
    naming.ts                  # minimal AI session naming helpers
    workflow.ts                # optional workflow-ticket context reader
    state-output.ts            # atomic Hub metadata writer
    metadata-log.ts            # opt-in debug JSONL derivation history writer
    metadata-quality.ts        # JSONL metadata quality scorecard and CLI
    text.ts                    # sanitization, truncation, JSON parsing helpers
    widget.ts                  # width-safe plan/status widget rendering
  test/
    *.test.ts                  # unit tests for runtime modules
```

## Runtime Modules

```text
src/
  index.ts          # thin Pi adapter; event collection, commands, lifecycle cleanup
  activity.ts       # compact bounded activity buffer
  summarizer.ts     # one-in-flight LLM scheduler and semantic prompt builder
  models.ts         # model preference parsing and auth/model resolution
  naming.ts         # first-prompt/history extraction and session-name generation
  workflow.ts       # optional agent-work feature/plan checklist context
  state-output.ts   # Agent Hub metadata path and atomic latest-only JSON writes
  metadata-log.ts   # opt-in debug metadata history path and JSONL appends
  metadata-quality.ts # metadata history parser, scorecard, and CLI
  text.ts           # sanitization, truncation, metadata JSON parsing helpers
  widget.ts         # width-safe plan/status widget and no-model warning rendering
```

`/session-summary` is the command for status, enable/disable, refresh, and naming actions.

`sessionSummary.model` is the only model setting read by this package. If absent or unauthenticated, the extension tries fast Codex-first defaults.

## Data Flow

1. Pi emits lifecycle/activity events.
2. `index.ts` normalizes events into compact facts and stores them in the activity buffer.
3. When workflow intent or an explicit ticket id is present, `workflow.ts` reads compact optional ticket context from repo-local `agent-work/` files.
4. The summarizer schedules work with debounce/rate-limit guards.
5. At most one model request is in flight.
6. The model returns JSON with `goal`, `status`, `nextStep`, `stage`, and `confidence`.
7. Text helpers sanitize and validate the response.
8. The widget displays repo-derived phase progress when available; otherwise it displays semantic status and an evidenced next step.
9. If Agent Hub env vars exist, latest-only JSON is atomically written for the session.
10. If `PI_SESSION_SUMMARY_METADATA_HISTORY=1` and Hub env vars exist, the successful derivation is appended to debug JSONL history.
11. If the session is unnamed, workflow tickets get a deterministic `ticket-id: abbreviated objective` name; otherwise the first user prompt can generate a short session name with the same model path.

## Semantic Outputs vs Activity Inputs

Product-level metadata:

| Element | Runtime representation | Notes |
| --- | --- | --- |
| Session name | Pi/Hub native session name | Deterministic `ticket-id: abbreviated objective` for workflow tickets, otherwise generated from the first prompt or `/session-summary name`; not written to Hub metadata. |
| Goal | `goal` | Stable user-facing session or ticket objective. |
| Status | `status` | Concise latest verified progress achieved by the main agent in context of the goal; shown in-session when phased plan progress is unavailable. |
| Next step | `nextStep` | Short explicit planned action or need toward the goal, when evidenced; shown with semantic status when available. |
| Stage | `stage` | Current mode: `reading`, `editing`, `testing`, `waiting`, `blocked`, or `complete`. |

Activity facts are different: they are compact internal inputs captured from Pi events (`user`, `assistant`, `tool`, `result`, `final`, `error`) so the model can infer the semantic outputs. Activity facts stay bounded in memory and must not be written to structured output.

## Data Models

### Activity Fact

```ts
type ActivityKind = "user" | "assistant" | "tool" | "result" | "final" | "error";

interface ActivityFact {
  sequence: number;
  kind: ActivityKind;
  text: string;
  at: number;
}
```

Activity facts are model input only. They must stay bounded and must never be written to structured output.

### Optional Workflow Context

Workflow context is an optional grounding source, not a dependency. A ticket can come from an explicit prompt, Pi's `set_workflow_ticket` tool, or clear workflow intent when exactly one feature is `in_progress`. The extension may then read:

- `agent-work/features.yaml` for `id`, `description`, `status`, and `plan_file`
- the referenced Markdown plan for checked/unchecked checklist items

The reader returns only compact evidence: ticket id, description, latest checked todo, next unchecked todo, and current progress for Markdown headings shaped like `Phase <number>: <title>` or `Stage <number>: <title>`. It groups standard checkboxes beneath those headings and selects the first incomplete phase, or the final phase when all are complete. Flat checklists remain model context but do not produce phase progress. Checked todos are context for the model, not automatic semantic `status`; recent activity must support that milestone. Missing, ambiguous, or absent workflow files simply produce no context.

This contract is repo-agnostic: resolution starts at the active repository's `agent-work/features.yaml`, follows its `plan_file`, and never reads a shared rules repository at runtime. The plan widget refreshes at turn start and after tool results, including when no summary model is authenticated.

### Session Name

Session naming is intentionally smaller than `pi-session-auto-rename`:

- auto-name unnamed sessions from the first user prompt
- `/session-summary name` manually renames from conversation history
- reuse the summary model/auth resolution
- no separate model picker, config file, or naming preferences

Generated names are sanitized to one 2–6 word-ish title line and capped at 80 characters.

### Session Metadata

```ts
type SummaryStage =
  | "reading"
  | "editing"
  | "testing"
  | "waiting"
  | "complete"
  | "blocked"
  | "unknown";

interface ParsedSessionMetadata {
  goal: string;
  status: string;
  stage: SummaryStage;
  nextStep?: string;
  confidence?: number;
}
```

`goal` should remain stable across workflow steps unless the user clearly changes tasks and should describe the stable session/feature/request outcome. When a ticket concept exists, include its identifier/name, for example `metadata-002: Workflow-grounded session metadata and titles`. `status` should be a terse backward-looking dashboard fragment describing latest verified progress by the main agent, not broad conclusions or read/parse mechanics. `nextStep` should be forward-looking, short, distinct from `status`, and omitted when there is no explicit evidence. Evidence can be an unchecked plan item, a stated main-agent plan, a user request, or a final handoff need. Attention needs should appear through `stage` plus `nextStep` (for example, `Needs API credentials`). Parser caps are `goal` 96 chars, `status` 60 chars, and `nextStep` 60 chars.

### Agent Hub Metadata File

When `PI_AGENT_HUB_DIR` and `PI_AGENT_HUB_SESSION_ID` are set, the extension writes Hub's generic metadata contract:

```text
${PI_AGENT_HUB_DIR}/session-metadata/${PI_AGENT_HUB_SESSION_ID}.json
```

Schema:

```ts
interface HubSessionMetadataFile {
  source?: "pi-session-summary";
  goal?: string;
  status?: string;
  stage?: SummaryStage;
  nextStep?: string;
  confidence?: number;
  updatedAt?: number;
}
```

Hub displays metadata when at least one of `goal`, `status`, `nextStep`, or `stage` exists and `confidence` is missing or at least `0.5`. Hub ignores package-specific fields such as `version`, `sessionName`, `model`, and `generatedAt`, so the producer does not write them. `stage` is semantic workflow classification; process liveness belongs to Hub, not this file. Raw prompts, tool arguments, command output, and conversation snippets do not.

### Debug Metadata History File

When `PI_SESSION_SUMMARY_METADATA_HISTORY=1`, `PI_AGENT_HUB_DIR`, and `PI_AGENT_HUB_SESSION_ID` are set, each successful model-derived metadata update is appended to:

```text
${PI_AGENT_HUB_DIR}/session-metadata-history/${PI_AGENT_HUB_SESSION_ID}.jsonl
```

Each JSONL entry includes `source`, raw Hub `sessionId`, `generatedAt`, `activitySequence`, optional `userTurn`, `model`, and a nested `metadata` object containing only sanitized derived `goal`, `status`, `stage`, optional `nextStep`, and optional `confidence`. The filename uses the same sanitized session-id behavior as latest metadata output; the `sessionId` field remains raw for correlation with Hub logs. Clear/no-model/shutdown/name-only updates are not logged.

`userTurn` increments on each `before_agent_start` and groups multiple metadata updates caused by one user request. Entries without `userTurn` are grouped as `unknown` by the quality tool.

`src/metadata-quality.ts` can parse this JSONL, group entries by turn, score final entries more strictly than transient updates, and report issues by category. Use it for debugging prompt/metadata quality, not as a CI gate for real model behavior.

## Key Patterns

### Minimal extension adapter

`src/index.ts` should remain a thin adapter around pure modules. Pi lifecycle handlers should enqueue work and return quickly.

### One-in-flight scheduler

Use one pending timer, one in-flight model request, and one dirty flag. Do not introduce a queue or accepted-checkpoint system.

```text
activity -> schedule timer -> model call in flight
            ^                |
            | dirty flag     v
            +--- follow-up if needed
```

Each new user turn resets the bounded activity buffer, but keeps the latest metadata for prompt continuity. Clear metadata only on session-level resets, disable, or shutdown so `goal` stays stable across turns.

### Best-effort model calls

Model calls must be:

- asynchronous and never awaited by core Pi event handling
- debounce/rate-limited
- timeout-bound
- no-retry by default
- abortable on shutdown or reset

If no authenticated model is available, publish `no_model` state and show a small warning instead of fabricating metadata.

### Atomic latest-only state

Structured output should be written only on meaningful changes. Use temp-file + rename and create the parent directory before writing.

### Opt-in debug history

Derivation history is append-only JSONL and must stay debug opt-in through `PI_SESSION_SUMMARY_METADATA_HISTORY=1`. History append failures should be swallowed like latest metadata write failures so debugging output never breaks widget or Hub latest-state updates.

### Privacy and data minimization

The model prompt may include short recent snippets to infer semantics. Keep snippets small, avoid storing them outside memory, and never write raw snippets to Agent Hub state or metadata history.

## Testing Approach

Use TDD for implementation work:

- text sanitization and JSON parsing tests
- activity-buffer retention and compaction tests
- model-setting resolution tests
- fake-timer scheduler tests
- Hub metadata path and atomic write tests
- opt-in metadata history path, entry mapping, and JSONL append tests
- metadata quality parser/grouping/scorecard tests
- width-safe plan/status widget rendering tests
- repo-local phased-plan parsing and refresh tests
- representative prompt-evaluation artifacts under `agent-work/tickets/`

## Development Commands

```bash
npm install
npm run check
npm test
npm run metadata:quality -- <metadata-history.jsonl>
npm run pack:dry-run
pi -e ./src/index.ts
```

## Future Pi Agent Hub Integration

Agent Hub should remain the consumer, not the metadata generator. The Pi extension renders phased plan progress in-session when available and semantic status otherwise; dashboard integrations should consume the structured metadata file for high-level session management. Future work can read the metadata file during dashboard refresh and display:

- session name as the main row title
- goal in details or expanded row context
- status as recent progress
- optional stage badge or row suffix
- next step in details only when present

Agent Hub remains the source of truth for process liveness (`running`, `waiting`, `stopped`, `error`). `pi-session-summary` should not duplicate those signals with `needsAttention`, `waitingOn`, or separate status lights.

This preserves a clean boundary:

```text
Pi extension = semantic producer
Agent Hub    = dashboard consumer
```
