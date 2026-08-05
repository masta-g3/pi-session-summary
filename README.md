# pi-session-summary (retired)

`pi-session-summary` is retired. It no longer provides a Pi extension or runtime commands.

Session metadata ownership moved to the packages that own each concern:

| Former responsibility | Current owner |
| --- | --- |
| Session naming and exact or generated renames | Rules, using Pi's native session name |
| Workflow ticket and plan progress | Rules workflow runtime |
| In-Pi progress widget and todo drawer | Rules (`/wf-todos` and `Ctrl+Alt+T`) |
| Final-turn human attention | Rules |
| Dashboard context and display | Rules generic Pi context → Pi Agent Hub heartbeat |
| Process liveness and dashboard grouping | Pi Agent Hub |

Continuous semantic `goal`, `status`, `nextStep`, and broad `stage` generation were removed. They have no compatibility replacement. The `session-metadata/<id>.json` sidecar, debug-history writer, metadata quality CLI, model setting, and `/session-summary` command were also removed.

## Migration

1. Remove `pi-session-summary` from active Pi package or extension configuration.
2. Install or sync the current Rules workflow runtime and Pi Agent Hub by following their repository instructions.
3. Use `/session-name refresh` for generated name refreshes and `/wf-todos` for the workflow checklist.
4. Reload Pi.

Pi Agent Hub owns stale latest-sidecar cleanup after its old reader is removed. Existing opt-in debug-history files remain user-owned and are not deleted by this migration.

This repository remains available to preserve implementation history. It contains no no-op compatibility extension.
