# AGENTS.md

Operating instructions for AI coding agents working in coil-core. Project-specific
rules here override general defaults when they conflict.

## Product Direction

coil-core is an embeddable, local-first coding agent engine: a small trusted core,
real MCP, concurrent subagents, observable execution, session persistence, and reports.
The engine lives under `src/core/` (zero UI dependencies); `src/tui/` is an Ink/React
consumer; `examples/` shows headless embedding. This is a fresh `coil-core` repository.

## Commands

- Use `pnpm` only; `packageManager` is `pnpm@11.0.9`.
- TUI entry: `pnpm dev` (`src/main.ts → runTui`); hot reload `pnpm dev:watch`; compiled run `pnpm build` then `pnpm start`.
- Tests: `pnpm test` (one file: `pnpm exec tsx --test tests/<file>.test.ts`).
- Typecheck without writing `dist`: `pnpm exec tsc --noEmit` (src) or `pnpm typecheck:tests` (tests). `pnpm build` compiles only `src/**/*` and does not typecheck `tests/`.

## Runtime Constraints

- `src/core/config/index.ts` resolves provider env **lazily** — importing it never throws;
  `getClient()`/`getModel()` throw on first use if env is missing. `main.ts` still wraps
  the TUI import in a try/catch to render a setup guide on failure.
- ESM with `module`/`moduleResolution: NodeNext`; source imports use the `.js` suffix
  even when importing `.ts` files (`./foo.js` → `./foo.ts`).
- Tests use `node:test` + `node:assert/strict` through `tsx`; model-loop tests patch
  `getClient().messages.create` (the shared cached client), restored in `finally`.

## Architecture Invariants (do not break)

1. `agentLoop` is the **only** place that binds `currentAgent` (`AsyncLocalStorage<Agent>`).
   Do not bind agent identity elsewhere.
2. Dependency direction is one-way: `Agent → ToolRuntime`. `ToolRuntime`, `ToolRegistry`,
   and tools must not import `Agent` or `Session`.
3. The loop is UI-agnostic: it only orchestrates model calls, recovery, hooks, and
   `ToolRuntime.invokeTool()`. Do not add TUI, MCP, builtin-tool, or subagent special
   cases there.
4. Single event funnel: `SessionProjectionStore.record` → `events.jsonl` + pure snapshot
   - view events.
5. The TUI never calls the loop directly — only through `SessionController` + structured
   view events.
6. Pure TS: `.tsx` is confined to `src/tui/`; zero hand-written `.js`; `.js` appears only
   as NodeNext ESM import specifiers.
7. Every directory under `src/core/` has an `index.ts` barrel re-exporting only that
   module's public API; `src/core/index.ts` is the library's public surface.

## Tools, State, and Docs

- Builtin tools live one per file under `src/core/tools/<group>/`, return
  `RegisteredTool` via `createXTool(deps)`, and are aggregated by the group `index.ts`;
  manifest and order are in `src/core/tools/builtins.ts`.
- `src/core/tools/profiles.ts` controls which tools subagents may use (subagents only narrow).
- `src/core/tools/mcp/` exposes a mock client and a real stdio client behind `McpClient`;
  `.coil/config/mcp.json` registers them as `mcp__server__tool` without changing dispatch.
- `src/core/services/` holds `memory` and `skill` (non-model-facing services, wired in `app/context.ts`).
- Local runtime state lives under `.coil/state/` (`sessions/`, `tasks/`, `memory/`, `transcripts/`)
  and is never committed; shared config (e.g. `.coil/config/mcp.json`) may be committed.
