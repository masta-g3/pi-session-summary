# pi-session-summary Structure

## Status

This repository is retired. It contains no runtime source, Pi extension registration, commands, tests, TypeScript build, or model configuration.

Git history preserves the former implementation. The repository now keeps only:

```text
pi-session-summary/
  agent-work/         # historical feature and implementation records
  docs/STRUCTURE.md   # this retirement note
  LICENSE
  package.json        # private retirement metadata; no Pi extension entry
  package-lock.json
  README.md           # migration map
```

## Current ownership

- **Pi** owns the canonical native session name.
- **Rules** owns ticket-based and generated naming, workflow plan progress, the Pi widget, the `/wf-todos` drawer, and bounded final-turn attention.
- **Pi Agent Hub** consumes generic context through Pi custom entries and heartbeat. It owns dashboard rendering and process liveness.

The old continuous summarizer and its activity buffer, semantic fields, model setting, metadata sidecar, debug history, and quality CLI were removed rather than retained as a no-op compatibility runtime.

See the root [README](../README.md) for migration steps.
