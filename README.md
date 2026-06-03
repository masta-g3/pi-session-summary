# pi-tldr-lite

Lightweight semantic TLDRs for Pi coding-agent sessions.

`pi-tldr-lite` is a Pi extension package that will use a fast LLM to summarize what an agent is currently doing in workflow terms, then render that status in-session and export latest-only structured state for Pi Agent Hub.

## Current status

This repository is scaffolded for implementation. The extension entrypoint loads and cleans up safely, but semantic TLDR generation is not implemented yet.

## Requirements

- Node.js `>=22.19.0`
- npm
- Pi coding agent `0.78.x`

## Setup

```bash
npm install
npm test
```

## Run with Pi

```bash
pi -e ./src/index.ts
```

## Planned configuration

```json
{
  "tldrLite": {
    "model": "openai-codex/gpt-5.4-mini"
  }
}
```

## Workflow

Implementation plans and backlog state live under `agent-work/`.

- `agent-work/features.yaml` — feature backlog
- `agent-work/plans/` — active implementation plans
- `agent-work/history/` — completed plan archives
- `agent-work/tickets/` — temporary ticket artifacts
