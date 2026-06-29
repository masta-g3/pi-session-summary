**Feature:** metadata-004 → Evaluate and refine metadata quality.

## Summary

Implemented a focused metadata quality evaluation path for opt-in debug history logs while preserving privacy and hermetic behavior.

## Changes

- Added prompt rules in `src/summarizer.ts` so `status` prioritizes the latest user-agent exchange, `nextStep` stays tied to explicit evidence, and previous `status`/`nextStep` are not reused without current activity support.
- Added optional `userTurn` correlation to debug metadata history entries and wired it from `before_agent_start` in `src/index.ts`.
- Preserved the hermetic append fix: `appendSessionMetadataLog(entry, undefined)` remains a no-op even when ambient Hub/debug env vars are set.
- Added `src/metadata-quality.ts`, a dependency-free JSONL parser/grouping/evaluator/formatter with a CLI guard.
- Added `npm run metadata:quality -- <metadata-history.jsonl>` for manual quality inspection.
- Added evaluator support for built-in and custom category labels, per-turn final-state checks, conservative privacy marker detection, and malformed JSONL handling.
- Updated README and `docs/STRUCTURE.md` for the new history field and quality command.

## Validation

- `npm test` — 68 passed.
- `npm run check` — passed.
- `npm run metadata:quality -- <temp-jsonl>` — passed.

## Review Notes

Review fixed two evaluator issues before commit:

- Non-object JSONL entries now fail with line-numbered parse errors instead of crashing later.
- Privacy checks now inspect derived metadata text values directly so quoted tool payload markers inside strings are detected.

## Discovered Work

None.
