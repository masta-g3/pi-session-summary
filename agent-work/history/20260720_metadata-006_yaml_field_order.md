**Feature:** metadata-006 → Parse workflow feature IDs regardless of YAML field order
**Discovered from:** metadata-005

## Outcome

Updated the minimal `agent-work/features.yaml` reader so a root sequence item may place `id` after fields such as `epic`, `description`, or `priority`. This matches the repository helper's emitted YAML and prevents a newly appended feature from overwriting the previously parsed feature in memory.

## Verification

- Added a regression fixture with `metadata-005` using non-leading `id` order after a completed `metadata-004` item.
- Confirmed workflow selection returns `metadata-005` and follows its own `plan_file`.
- Focused workflow and smoke tests pass.
- `npm run check` passes.
