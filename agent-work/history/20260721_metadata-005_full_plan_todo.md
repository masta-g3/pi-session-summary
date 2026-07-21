**Feature:** metadata-005 → Add a toggleable full-plan todo overlay
**Status:** Completed

## Outcome

Added an on-demand, focused right-side TUI drawer that shows every executable checkbox from the active repository plan while preserving the existing compact plan/status widget. The drawer opens with `/session-summary todos` or `Ctrl+Alt+T`, scrolls with arrow and page keys, and closes with `Esc` or the same shortcut.

The drawer is read-only, hidden by default, and runtime-only. It performs a fresh repo read whenever opened and does not persist visibility, edit Markdown, watch files, or introduce fallback layouts.

## Implementation

### Workflow snapshot

`src/workflow.ts` now derives two projections from one fence-aware Markdown parse:

- `WorkflowContext`: compact ticket, phase progress, latest-completed, and next-open evidence used by the summarizer, naming, and compact widget.
- `WorkflowPlan`: sanitized section headings, task states, completion totals, and current-section index used only by the local TUI drawer.

Numbered `Phase` and `Stage` sections expose tasks only from populated sections and preserve normalized source labels such as `Stage 3 · Validate`. Legacy flat plans expose all checkboxes under a synthetic `Tasks` heading. Fenced examples, unsafe paths, missing files, and task-length limits retain the existing behavior.

### Todo panel

`src/todo-panel.ts` implements one Pi `Component` using the official focused overlay API:

```ts
{
  overlay: true,
  overlayOptions: {
    anchor: "right-center",
    width: 54,
    minWidth: 36,
    maxHeight: "80%",
    margin: { right: 1 },
  },
}
```

Rows are rebuilt for the supplied terminal width with Pi's ANSI-aware wrapping and truncation helpers. Scrolling is bounded by visual rows, the first incomplete task remains visible on initial open, and all-complete plans start at the top. Completed tasks use a themed `☑` marker and muted text; open tasks use `☐` and normal text.

### Lifecycle and privacy

`src/index.ts` registers the `todos` action and `Ctrl+Alt+T` shortcut through one toggle path. Independent panel request/session/ticket guards prevent stale or duplicate openings without interfering with the existing workflow cache generation. Disable, session replacement, and shutdown close the active panel and clear panel-local state.

Full checklist content remains local to runtime memory and the overlay. It is not included in summary-model prompts, Agent Hub metadata, session entries, naming, or settings.

## Verification

- `npm run check` passed.
- All 89 automated tests passed.
- `npm run pack:dry-run` included `src/todo-panel.ts` and created no package artifact.
- `git diff --check` passed.
- Real Pi TUI testing confirmed command and shortcut toggles, arrow/page scrolling, narrow-pane wrapping, focus restoration, and `metadata-005` ticket labeling.
- Review fixed an initial-position edge case where many completed tasks in the current section could hide its first incomplete task.

## Documentation

- `README.md` documents controls, plan compatibility, read-only/TUI-only behavior, and the Pi 0.78 experimental-overlay caveat.
- `docs/STRUCTURE.md` documents the compact-context/full-plan boundary, component ownership, lifecycle guards, and privacy constraints.

## Discovered Work

`metadata-006` fixed the minimal feature parser to recognize IDs regardless of YAML field order. The repository helper can emit `id` after fields such as `epic` and `description`; the old parser incorrectly merged such entries into the preceding feature. The fix and regression coverage are summarized in `agent-work/history/20260720_metadata-006_yaml_field_order.md`.
