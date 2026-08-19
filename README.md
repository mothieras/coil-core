# coil-core

An embeddable, local-first coding agent engine — a small trusted core, real MCP, concurrent subagents, observable execution, session persistence, and reports. Ships with an Ink/React TUI; the engine itself has zero UI dependencies and can be embedded headlessly.

> **Status:** `v0.1.0` — early public release. The engine is functionally complete; the public API surface is not yet frozen.

## Why

Most coding agents are black boxes wired to a single cloud model. `coil-core` is the opposite: a small engine you can run locally, observe turn-by-turn, extend with your own tools or MCP servers, and embed inside your own CLI, TUI, or backend.

- **Small trusted core.** One loop, one agent identity, one tool runtime. No UI in the engine, no special-case dispatch.
- **Observable.** Every run is event-sourced: a single funnel writes `events.jsonl` + a pure snapshot + view events. Replay any session.
- **Real MCP.** Stdio MCP clients register as `mcp__server__tool` through the normal registry — no special dispatch path.
- **Concurrent subagents.** Fork agents with narrowed tool scopes; completions auto-wake the lead.
- **Provider-agnostic.** The loop talks to a `Provider` interface; the default is Anthropic. Inject your own to route elsewhere.

## Quickstart (TUI)

```bash
pnpm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY + MODEL_ID
pnpm dev               # launch the Ink TUI
```

## Embed headlessly

```bash
pnpm build
tsx examples/headless-agent.ts "explain this repo's entry point"
```

```ts
import { createAppContext, createAnthropicProvider, Agent, agentLoop } from "coil-core";

const app = createAppContext(process.cwd(), {});
const agent = new Agent({
  system: "You are a concise coding agent.",
  workspaceRoot: process.cwd(),
  toolRuntime: app.toolRuntime,
  provider: createAnthropicProvider(),
  hooks: app.hooks,
  messages: [{ role: "user", content: prompt }],
});
const result = await agentLoop(agent, {});
```

See `examples/` for a runnable one-shot agent and a custom-tool registration demo.

## Architecture

```
src/
  core/     engine — zero UI deps (agent, loop, context, session, tools, services, permission, hooks, providers, config, state)
  tui/      Ink/React consumer of core
  main.ts   TUI entrypoint
```

**Invariants the structure enforces:**

1. `agentLoop` is the only place that binds `currentAgent` (`AsyncLocalStorage<Agent>`).
2. Dependency direction is one-way: `Agent → ToolRuntime`. Tools never import `Agent`/`Session`.
3. The loop is UI-agnostic: it only orchestrates model calls, recovery, hooks, and `ToolRuntime.invokeTool()`.
4. One event funnel (`SessionProjectionStore.record`) → `events.jsonl` + pure snapshot + view events.
5. The TUI never calls the loop directly — only through `SessionController` + structured view events.
6. Pure TS: source is `.ts`/`.tsx` only, zero hand-written `.js`; `.tsx` is confined to `src/tui/` (Ink/React); `.js` appears only as NodeNext ESM import specifiers.

## Development

| Command                | What it does              |
| ---------------------- | ------------------------- |
| `pnpm dev`             | Run the TUI via `tsx`     |
| `pnpm test`            | Run the `node:test` suite |
| `pnpm typecheck`       | `tsc --noEmit` on `src/`  |
| `pnpm typecheck:tests` | typecheck `tests/`        |
| `pnpm build`           | `tsc` → `dist/`           |
| `pnpm lint`            | ESLint + Prettier check   |

See `CONTRIBUTING.md` for structure conventions and `AGENTS.md` for the invariants agents must preserve.

## License

MIT © coil-core contributors
