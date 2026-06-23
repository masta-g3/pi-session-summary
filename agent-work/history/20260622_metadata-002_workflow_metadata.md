# metadata-002: Workflow-grounded session metadata and titles

## Summary

Implemented optional workflow-ticket grounding for `pi-session-summary` so dashboard metadata and Pi session names can use explicit `agent-work/` evidence while preserving standalone operation and the generic Pi Agent Hub metadata contract.

## Implemented

- Added `src/workflow.ts` as a small optional reader for repo-local workflow context:
  - extracts explicit ticket ids from prompts
  - detects narrow workflow intent
  - reads compact fields from `agent-work/features.yaml`
  - reads checked/unchecked Markdown checklist items from a ticket plan
  - avoids guessing when multiple tickets are active
  - sanitizes/caps extracted fields and prevents plan paths from escaping the repo root
  - degrades absent/unreadable workflow files to no context
- Wired workflow context into metadata generation:
  - `SessionSummarySummarizer` accepts an optional `getWorkflowContext` callback
  - prompts include compact workflow evidence or `none`
  - prompt rules require evidence-only `nextStep` and prevent unchecked todos from becoming `status`
- Added deterministic workflow session naming:
  - workflow sessions prefer `ticket-id: abbreviated objective`
  - non-workflow sessions keep existing LLM-based first-prompt/history naming
  - Hub metadata remains generic and does not include a session-name field
- Increased metadata `goal` cap from 48 to 96 chars so ticket objectives fit dashboard rows better.
- Updated README and `docs/STRUCTURE.md` to document optional workflow grounding, evidence-only next steps, naming behavior, and the producer/consumer boundary with Pi Agent Hub.

## Tests Added/Updated

- `test/workflow.test.ts` covers ticket extraction, workflow intent, feature/plan parsing, ambiguity handling, sanitization, safe plan paths, and deterministic ticket names.
- `test/summarizer.test.ts` covers workflow prompt context, absent context, workflow lookup failure degradation, and existing metadata behavior.
- `test/smoke.test.ts` covers deterministic auto-naming for unnamed workflow sessions.
- `test/metadata-simulation.test.ts` covers representative workflow/non-workflow/blocked metadata flows with fake model responses.
- `test/text.test.ts` covers the expanded goal cap.

## Verification

- `npm run check`
- `npm test` — 56 passing
- `npm run pack:dry-run`
- `git diff --check`
- Code review and docs review completed; follow-up cleanup issues were fixed.

## Notes

- Workflow files are optional context only; the extension does not mutate workflow state or require Agent Hub.
- `nextStep` is intended to come from explicit evidence: an unchecked plan item, stated main-agent plan, user request, or handoff need.
- Raw prompts, tool output, full plan text, and session names are not written to Hub metadata.
