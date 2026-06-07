**Feature:** metadata-001 → Dashboard session metadata v2

## Summary

Replaced the old session-summary output contract with clean v2 dashboard metadata. The extension now produces `goal`, `status`, `nextStep`, and `stage`, plus an optional mirrored `sessionName`, and writes Agent Hub state files with `version: 2` only.

## Implemented

- Updated parser/types from v1 summary fields to `ParsedSessionMetadata` and `SummaryStage`.
- Updated the summarizer prompt and publish path to infer short, outcome-oriented dashboard metadata.
- Preserved latest metadata across per-turn activity resets so `goal` remains stable while new activity is summarized.
- Updated state output to remove legacy `summary`, `phase`, and `nextAction` fields.
- Mirrored generated/existing session names into state when available.
- Updated the in-session widget to display only `status`.
- Updated `/session-summary status` output for the new metadata fields.
- Added parser, scheduler, runtime smoke, state-output, and widget tests for v2 behavior.
- Captured sanitized before/after prompt evidence under `agent-work/tickets/metadata-001/`.
- Updated README and structure docs for the final schema, dashboard semantics, and prompt-continuity rule.

## Validation

- `npm run check`
- `npm test`
- `npm run pack:dry-run`
- `git diff --check`

## Notes

- Agent Hub dashboard reader work was intentionally not implemented.
- Raw prompts, tool arguments, terminal output, and conversation snippets remain out of state files.
- v1 compatibility fields were deliberately not preserved.
