# Contributing to coil-core

Thanks for helping. This guide gets a change from clone to merged.

## Setup

```bash
pnpm install              # pnpm@11 (see package.json packageManager)
cp .env.example .env       # fill ANTHROPIC_API_KEY + MODEL_ID for local runs
```

Node ≥ 22 is required (the TUI and tests use `tsx` on modern Node).

## Before you push

All of these must pass:

```bash
pnpm typecheck            # tsc --noEmit on src/
pnpm typecheck:tests      # tsc -p tsconfig.test.json
pnpm test                 # node:test suite (222+ tests)
pnpm lint                 # ESLint + Prettier
pnpm build                # tsc -> dist/
```

CI runs the same four on every push.

## Repository layout

```
src/core/   the engine — no UI imports allowed here
src/tui/    Ink/React consumer of core; the only place .tsx lives
tests/      node:test via tsx; model-loop tests monkey-patch the provider
examples/   headless embedding demos
```

## Conventions

- **ESM + NodeNext.** Source imports use the `.js` suffix even when importing a `.ts` file (`import { x } from "./foo.js"` resolves to `./foo.ts`). This is mandatory, not stylistic.
- **Barrels.** Every directory under `src/core/` has an `index.ts` that re-exports only that module's public API — internal implementation details stay unexported. `src/core/index.ts` is the library's public surface (the `package.json` `exports` entry).
- **`.tsx` only in `src/tui/`.** The engine is plain `.ts`; JSX exists solely because Ink renders React.
- **One tool per file** under `src/core/tools/<group>/`, each `createXTool(deps) → RegisteredTool`, aggregated by the group `index.ts`; manifest + order in `builtins.ts`.
- **Strict TS.** `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on. Optional fields that allow explicit `undefined` use `field?: T | undefined`.

## Adding a tool

1. Create `src/core/tools/<group>/<name>.ts` exporting `create<Name>Tool(deps): RegisteredTool`.
2. Aggregate it in the group's `index.ts`.
3. Register it in `src/core/tools/builtins.ts` if it should be model-facing.
4. If subagents may use it, allow it in `src/core/tools/profiles.ts` (subagents only narrow).
5. Add a test under `tests/`.

## Testing model calls

Model-loop tests patch the provider's `messages.create` and restore in `finally`. Tests obtain the shared client via `getClient()` from `src/core/config/index.js` (lazily resolved from env, never throws at import). Never call the real API from tests.
