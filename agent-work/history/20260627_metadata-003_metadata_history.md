# metadata-003: Metadata derivation history

Implemented opt-in debug logging for successful `pi-session-summary` metadata derivations.

## Result

- Added `PI_SESSION_SUMMARY_METADATA_HISTORY=1` as the explicit debug opt-in.
- When the debug flag plus `PI_AGENT_HUB_DIR` and `PI_AGENT_HUB_SESSION_ID` are present, each successful derived metadata update is appended as JSONL at:

  ```text
  ${PI_AGENT_HUB_DIR}/session-metadata-history/${PI_AGENT_HUB_SESSION_ID}.jsonl
  ```

- The existing latest-only Hub metadata file remains unchanged:

  ```text
  ${PI_AGENT_HUB_DIR}/session-metadata/${PI_AGENT_HUB_SESSION_ID}.json
  ```

## Implementation

- Added `src/metadata-log.ts` with:
  - `METADATA_HISTORY_ENV`
  - `sessionMetadataLogPath()`
  - `metadataLogEntry()`
  - `appendSessionMetadataLog()`
- Wired successful summarizer publishes in `src/index.ts` to append history entries through a serialized `logChain`.
- Captures the history path and raw Hub session id at session start so queued appends cannot drift to a later session.
- Exports `safeSessionId()` from `src/state-output.ts` so latest metadata and history logging use identical filename sanitization.

## Logged fields

Each JSONL entry contains only correlation data and sanitized derived metadata:

```ts
{
  source: "pi-session-summary";
  sessionId: string;
  generatedAt: number;
  activitySequence: number;
  model: string;
  metadata: {
    goal: string;
    status: string;
    stage: SummaryStage;
    nextStep?: string;
    confidence?: number;
  };
}
```

Raw prompts, assistant text, tool arguments/results, workflow plan text, command output, and conversation snippets are not written.

## Tests and validation

- Added `test/metadata-log.test.ts` for:
  - env-var opt-in path resolution
  - missing env no-op behavior
  - unsafe session id filename sanitization
  - JSONL append behavior
  - log entry mapping, including `confidence: 0` preservation and absent `nextStep` omission
- Ran `npm test` — 60 passed.
- Ran `npm run check` — passed.
- Manual ephemeral smoke confirmed disabled env returns no path and enabled env writes JSONL under `session-metadata-history/demo_session.jsonl`.

## Documentation

- Updated `README.md` Agent Hub output section with the debug env var, path, and privacy boundaries.
- Updated `docs/STRUCTURE.md` architecture/data-flow/module docs with the opt-in debug history file and testing pattern.

## Review

- Code review passed; `code-critic` returned LGTM.
- Reflection found no additional durable doc changes needed; `docs-critic` returned LGTM.
