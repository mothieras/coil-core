# AGENTS.md

Operating instructions for AI coding agents working in coil-core. Project-specific
rules here override general defaults when they conflict.

## Product Direction

coil-core is an embeddable, local-first coding agent engine: a small trusted core,
real MCP, concurrent subagents, observable execution, session persistence, and reports.
The engine lives under `src/core/` (zero UI dependencies); `src/tui/` is an Ink/React
consumer; `examples/` shows headless embedding. Model access goes through pi-ai
(`src/core/providers/`); the public documentation is `README.md` and this file only.

## Commands

- Use `pnpm` only; `packageManager` is `pnpm@11.0.9`.
- TUI entry: `pnpm dev` (`src/main.ts → runTui`); hot reload `pnpm dev:watch`; compiled run `pnpm build` then `pnpm start`.
- Tests: `pnpm test` (one file: `pnpm exec tsx --test tests/<file>.test.ts`).
- Typecheck without writing `dist`: `pnpm exec tsc --noEmit` (src) or `pnpm typecheck:tests` (tests). `pnpm build` compiles only `src/**/*` and does not typecheck `tests/`.

## Runtime Constraints

- `src/core/config/index.ts` resolves model config **lazily** — importing it never
  validates model settings. `getModel()` throws if both `MODEL_ID` and `ANTHROPIC_MODEL`
  are missing; `createDefaultProvider()` resolves the model when called. pi-ai checks
  credentials on model requests. `main.ts` catches setup errors from TUI startup.
- ESM with `module`/`moduleResolution: NodeNext`; source imports use the `.js` suffix
  even when importing `.ts` files (`./foo.js` → `./foo.ts`).
- Tests use `node:test` + `node:assert/strict` through `tsx`; model-loop tests inject a
  scripted `Provider` (`tests/helpers/pi.ts`) into the `Agent` instead of patching a client.
- `src/core/providers/` is the only layer with runtime imports from pi-ai; other core
  modules may use `import type` for its message, model, and tool types. Do not import vendor SDKs
  (`@anthropic-ai/sdk`, `openai`, ...) elsewhere. Provider failures must throw
  `ProviderRequestError` with the HTTP status and `retry-after` preserved, because
  `loop/recovery.ts` classifies on those fields.

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
8. Agent context is pi-ai's `Message[]`; tools are pi-ai `Tool` with `parameters`.
   Persisted `lead-messages.json` uses that format; legacy Anthropic transcripts are
   converted on load by `session/store/legacyMessages.ts`.

## Session and async-work contracts

- `SessionController` owns lead-turn admission and wake coalescing. Headless hosts
  call `handleAutoWake()` explicitly; it may return `undefined`. Pending async work
  includes both active work and deliverable results. Keep these rules in core.
- Subagent capacity remains occupied until actual execution settles, including
  unconfirmed stops. Full capacity rejects new work; do not add an implicit queue.
- Persisted side effects require awaited intent and result checkpoints through the
  injected `RuntimeCheckpointSink`. Lifecycle observation cannot confirm a save.
- `events.jsonl` checkpoints and their referenced private context slots are recovery
  authority; `snapshot.json` and `lead-messages.json` are derived views. Retain failed
  batches and block new dispatch after authority-write failure. Unknown outcomes
  require `resolveRecovery()`; never replay them automatically.
- `AsyncWorkInbox` owns result identity and delivery state. In managed sessions,
  acknowledge injected results only after their matching message checkpoint commits.
  Suppressed or delivered results remain inspectable; cancellation must not delete them.

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
