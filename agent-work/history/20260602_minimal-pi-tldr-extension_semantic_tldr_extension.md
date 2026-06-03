# minimal-pi-tldr-extension

Implemented `pi-tldr-lite`, a lightweight Pi extension that generates semantic session TLDRs with a fast LLM, renders them in-session, and writes latest-only structured state for future Pi Agent Hub dashboard consumption.

## Implemented

- TypeScript Pi extension package scaffold with strict ESM config and Node test runner.
- `/tldr-lite` command with `status`, `on`, `off`, `refresh`, and `name` actions.
- Bounded activity buffer for compact user, assistant, tool, result, final, and error facts.
- Codex-first model selection using `tldrLite.model`, compatibility fallback to `tldr.model`, and fast auto candidates.
- One-in-flight semantic summarizer with debounce, minimum interval, timeout, no retries, abort/reset handling, and dirty follow-up scheduling.
- Dashboard-oriented JSON model output parsing: `summary`, `phase`, optional gated `nextAction`, and `confidence`.
- `nextAction` is exported only for waiting, reviewing, blocked, or complete contexts to avoid noisy guidance during active work.
- Width-safe in-session TLDR widget and no-model warning widget.
- Latest-only Agent Hub state export to `${PI_AGENT_HUB_DIR}/tldr/${PI_AGENT_HUB_SESSION_ID}.json` using serialized atomic writes.
- Minimal AI session naming: auto-name unnamed sessions from the first user prompt and `/tldr-lite name` from conversation history, reusing the TLDR model/auth path.
- Durable README and `docs/STRUCTURE.md` updates documenting package use, architecture, state schema, privacy/performance, and Agent Hub boundary.

## Key Design Decisions

- Keep Agent Hub as a consumer, not the TLDR generator.
- Do not write into Agent Hub heartbeat files; use a separate `tldr/<session-id>.json` state file.
- Do not duplicate Agent Hub liveness/status with `needsAttention`, `waitingOn`, or extra status lights.
- Treat the Pi/Hub session title as the durable mission/deliverable; do not add a separate `deliverable` field.
- Keep naming smaller than `pi-session-auto-rename`: no separate picker, config file, or persistent naming preference.
- Preserve lightweight behavior over rich live terminal progress tracking: no accepted-checkpoint queue, progress groups, or long raw activity history.

## Validation

- `npm run check`
- `npm test` — 32 passing tests
- `npm run pack:dry-run`
- `pi -e ./src/index.ts --version`

## Follow-up

- Pending ticket `package-001`: decide and implement package identity rename, likely to `pi-session-summary`, including metadata/docs/state/command compatibility choices.
