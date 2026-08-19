/**
 * coil-core public API surface.
 *
 * Everything an embedder needs to run the agent loop headlessly lives here:
 * provider abstraction, agent identity, the loop, session orchestration, the
 * tool registry/runtime, permission pipeline, hooks, and prompt assembly.
 *
 * The TUI (src/tui) is a separate consumer of this core and is not re-exported.
 */
export * from "./agent/index.js";
export * from "./app/index.js";
export * from "./async/index.js";
export * from "./context/index.js";
export * from "./hooks/index.js";
export * from "./loop/index.js";
export * from "./permission/index.js";
export * from "./providers/index.js";
export * from "./services/index.js";
export * from "./session/index.js";
export * from "./state/index.js";
export * from "./tools/index.js";
