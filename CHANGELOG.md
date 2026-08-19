# Changelog

All notable changes to coil-core are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/) — note that the public
API is not yet frozen during `0.x`.

## [0.1.0] — 2026-08-19

Initial public release. coil-core is the engine extracted from the `coil`
prototype, restructured for embedding and open-source.

### Added

- Embeddable engine core under `src/core/` (zero UI dependencies): agent identity
  with `AsyncLocalStorage`-bound `currentAgent`, UI-agnostic `agentLoop`, event-sourced
  session persistence (`events.jsonl` + pure snapshot + view events), tool registry/runtime
  with permission pipeline, hook bus, context management with auto/micro/force compaction.
- `Provider` abstraction (`src/core/providers/`) with a default Anthropic implementation;
  the loop calls an injected provider, never the config module directly.
- Real MCP support: stdio clients register as `mcp__server__tool` through the normal
  registry with no special-case dispatch.
- Concurrent subagents with narrowed tool scopes and async-work auto-wake.
- Ink/React TUI consumer under `src/tui/` (the only `.tsx` surface).
- Headless embedding examples (`examples/headless-agent.ts`, `examples/custom-tool.ts`).
- GitHub Actions CI (typecheck, test, build, lint).

### Notes

- Public API surface is not yet frozen; expect breaking changes within `0.x`.
- Local runtime state lives under `.coil/state/` (never committed); shared config such
  as MCP registration lives under `.coil/config/` (committable).
